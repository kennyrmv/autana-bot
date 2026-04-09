/**
 * claude.js — Wrapper de Claude API con retry, error handling, y tool_use.
 *
 * Nunca devuelve undefined. Si Claude falla, devuelve FALLBACK_MSG.
 * Así el webhook handler siempre tiene algo que enviar al usuario.
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getAvailableSlots, calTool } from './cal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6' // velocidad > potencia en conversación
const MAX_TOKENS = 1024
const TIMEOUT_MS = 30000

const FALLBACK_MSG =
  'Ahora mismo no puedo responderte bien. ' +
  'Déjame tu pregunta y te respondo en menos de una hora. Perdona las molestias 🙏'

const RATE_LIMIT_MSG =
  'Dame un momento... Enseguida te respondo. ⏱️'

// Keywords que activan el derecho de supresión LOPD
const DELETE_KEYWORDS = ['borrar mis datos', 'eliminar mis datos', 'derecho al olvido']

/**
 * Carga el system prompt de un cliente desde disco.
 * Se cachea en memoria (el archivo solo cambia con deploy).
 */
const promptCache = new Map()

function loadSystemPrompt(slug) {
  if (promptCache.has(slug)) return promptCache.get(slug)

  const promptPath = join(__dirname, '..', 'clients', slug, 'system-prompt.md')
  try {
    const content = readFileSync(promptPath, 'utf8')
    promptCache.set(slug, content)
    return content
  } catch (err) {
    console.error(`[claude] No se encontró system-prompt.md para "${slug}"`)
    return 'Eres un asistente de atención al cliente. Responde de forma amable y concisa.'
  }
}

/**
 * Envía un mensaje a Claude y devuelve la respuesta en texto.
 *
 * @param {object} config - Config del cliente (de config.js)
 * @param {Array}  history - Historial previo [{role, content}]
 * @param {string} userMessage - Mensaje nuevo del usuario
 * @returns {Promise<{text: string, meta: object}>}
 */
export async function chat(config, history, userMessage) {
  // Detectar derecho de supresión LOPD
  const lowerMsg = userMessage.toLowerCase()
  if (DELETE_KEYWORDS.some(kw => lowerMsg.includes(kw))) {
    return {
      text: '¿Quieres que borre todos tus datos de conversación? Responde "sí, borrar" para confirmarlo.',
      meta: { requestingDelete: true },
    }
  }

  const rawPrompt = loadSystemPrompt(config.client_slug)
  const systemPrompt = rawPrompt.replace(/\{\{cal_link\}\}/g, config.cal_link || '')

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ]

  // Tools disponibles para este cliente
  const tools = config.cal_api_key && config.cal_event_type_id ? [calTool] : []

  try {
    const response = await callClaudeWithRetry(systemPrompt, messages, tools)
    const { text, toolResults } = await processResponse(response, config, messages, systemPrompt, tools)

    // Detectar si el bot decidió escalar a humano
    const endedWithHandoff = text.toLowerCase().includes('[handoff]')
    const cleanText = text.replace('[handoff]', '').trim()

    // Detectar si hay una reserva completada (Claude usa [booking] como señal)
    const endedWithBooking = text.includes('[booking]')
    const finalText = cleanText.replace('[booking]', '').trim()

    return {
      text: finalText || FALLBACK_MSG,
      meta: { endedWithHandoff, endedWithBooking },
    }
  } catch (err) {
    return handleClaudeError(err)
  }
}

/**
 * Llama a Claude con retry automático en rate limit (429).
 */
async function callClaudeWithRetry(systemPrompt, messages, tools, attempt = 1) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    }
    if (tools.length > 0) params.tools = tools

    return await client.messages.create(params)
  } catch (err) {
    clearTimeout(timer)

    if (err.status === 429 && attempt < 3) {
      console.warn(`[claude] Rate limit — reintento ${attempt}/2 en 15s`)
      await sleep(15000)
      return callClaudeWithRetry(systemPrompt, messages, tools, attempt + 1)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Procesa la respuesta de Claude, incluyendo tool_use (Cal.com).
 * Si Claude llama a get_available_slots, ejecuta la tool e
 * inyecta el resultado para que Claude genere la respuesta final.
 */
async function processResponse(response, config, messages, systemPrompt, tools) {
  if (response.stop_reason !== 'tool_use') {
    return { text: extractText(response) }
  }

  // Claude quiere usar una tool
  const toolUseBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolUseBlock || toolUseBlock.name !== 'get_available_slots') {
    return { text: extractText(response) }
  }

  console.log(`[claude] Tool use: get_available_slots`)

  // Ejecutar la tool con timeout propio (3s en cal.js)
  const slots = await getAvailableSlots(
    config.cal_api_key,
    config.cal_event_type_id,
    toolUseBlock.input?.days_ahead || 7
  )

  // Inyectar resultado como tool_result y llamar a Claude de nuevo
  const messagesWithTool = [
    ...messages,
    { role: 'assistant', content: response.content },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content: JSON.stringify(slots),
      }],
    },
  ]

  const finalResponse = await callClaudeWithRetry(systemPrompt, messagesWithTool, tools)
  return { text: extractText(finalResponse) }
}

function extractText(response) {
  const block = response.content?.find(b => b.type === 'text')
  return block?.text?.trim() || ''
}

function handleClaudeError(err) {
  if (err.name === 'AbortError' || err.code === 'ETIMEDOUT') {
    console.error('[claude] Timeout >30s')
  } else if (err.status === 529) {
    console.error('[claude] Overloaded')
  } else {
    console.error(`[claude] Error: ${err.status} ${err.message}`)
  }
  return { text: FALLBACK_MSG, meta: { errorOccurred: true } }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { RATE_LIMIT_MSG, FALLBACK_MSG }
