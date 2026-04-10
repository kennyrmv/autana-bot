/**
 * claude.js — Wrapper de Claude API con retry, error handling, y tool_use.
 *
 * Nunca devuelve undefined. Si Claude falla, devuelve FALLBACK_MSG.
 * Así el webhook handler siempre tiene algo que enviar al usuario.
 *
 * Tools activas se determinan por config.features (piezas de lego):
 *   cal_read_slots     → get_available_slots
 *   cal_create_booking → create_booking
 *   cal_detect_booking → get_user_booking
 *   cal_cancel_booking → cancel_booking
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  getAvailableSlots,
  createBooking,
  getUserBooking,
  cancelBooking,
  buildCalTools,
} from './cal.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 1024
const TIMEOUT_MS = 30000

const FALLBACK_MSG =
  'Ahora mismo no puedo responderte bien. ' +
  'Déjame tu pregunta y te respondo en menos de una hora. Perdona las molestias 🙏'

const RATE_LIMIT_MSG = 'Dame un momento... Enseguida te respondo. ⏱️'

const DELETE_KEYWORDS = ['borrar mis datos', 'eliminar mis datos', 'derecho al olvido']

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
 * @param {object} config      - Config del cliente (de config.js)
 * @param {Array}  history     - Historial previo [{role, content}]
 * @param {string} userMessage - Mensaje nuevo del usuario
 * @param {string} userPhone   - Teléfono del usuario (para tools de Cal)
 */
export async function chat(config, history, userMessage, userPhone) {
  const lowerMsg = userMessage.toLowerCase()
  if (DELETE_KEYWORDS.some(kw => lowerMsg.includes(kw))) {
    return {
      text: '¿Quieres que borre todos tus datos de conversación? Responde "sí, borrar" para confirmarlo.',
      meta: { requestingDelete: true },
    }
  }

  const rawPrompt = loadSystemPrompt(config.client_slug)
  const systemPrompt = rawPrompt
    .replace(/\{\{cal_link\}\}/g, config.cal_link || '')
    .replace(/\{\{stripe_link\}\}/g, config.stripe_link || '')
    .replace(/\{\{integrations\}\}/g, buildIntegrationsBlock(config))

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ]

  // Tools activas según feature flags del cliente
  const features = config.features || {}
  const hasCalKey = !!config.cal_api_key
  const hasEventTypeId = !!config.cal_event_type_id
  const calReady = hasCalKey && hasEventTypeId

  const tools = calReady ? buildCalTools(features) : []

  try {
    const response = await callClaudeWithRetry(systemPrompt, messages, tools)
    const { text } = await processResponse(response, config, messages, systemPrompt, tools, userPhone)

    const endedWithHandoff = text.toLowerCase().includes('[handoff]')
    const endedWithBooking = text.includes('[booking]')
    const finalText = text.replace('[handoff]', '').replace('[booking]', '').trim()

    return {
      text: finalText || FALLBACK_MSG,
      meta: { endedWithHandoff, endedWithBooking },
    }
  } catch (err) {
    return handleClaudeError(err)
  }
}

/**
 * Llama a Claude con retry en rate limit (429).
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
 * Procesa la respuesta de Claude.
 * Si hay tool_use, ejecuta la tool correspondiente e inyecta el resultado.
 * Soporta múltiples rondas de tool_use (Claude puede usar varias tools seguidas).
 */
async function processResponse(response, config, messages, systemPrompt, tools, userPhone, depth = 0) {
  // Máximo 5 rondas de tool_use para evitar loops infinitos
  if (depth >= 5 || response.stop_reason !== 'tool_use') {
    return { text: extractText(response) }
  }

  const toolUseBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolUseBlock) return { text: extractText(response) }

  console.log(`[claude] Tool use: ${toolUseBlock.name}`)

  const toolResult = await executeTool(toolUseBlock, config, userPhone)

  const messagesWithTool = [
    ...messages,
    { role: 'assistant', content: response.content },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content: JSON.stringify(toolResult),
      }],
    },
  ]

  const nextResponse = await callClaudeWithRetry(systemPrompt, messagesWithTool, tools)
  return processResponse(nextResponse, config, messagesWithTool, systemPrompt, tools, userPhone, depth + 1)
}

/**
 * Ejecuta la tool que Claude pidió y devuelve el resultado.
 */
async function executeTool(toolUseBlock, config, userPhone) {
  const { name, input } = toolUseBlock
  const { cal_api_key: apiKey, cal_event_type_id: eventTypeId, client_slug: clientSlug } = config

  switch (name) {
    case 'get_available_slots':
      return getAvailableSlots(apiKey, eventTypeId, input?.days_ahead || 7)

    case 'create_booking':
      return createBooking({
        apiKey,
        eventTypeId,
        phone: userPhone,
        clientSlug,
        name: input.name,
        email: input.email,
        startTime: input.start_time,
      })

    case 'get_user_booking':
      return getUserBooking({ phone: userPhone, clientSlug })

    case 'cancel_booking':
      return cancelBooking({
        apiKey,
        bookingUid: input.booking_uid,
        phone: userPhone,
        clientSlug,
      })

    default:
      console.warn(`[claude] Tool desconocida: ${name}`)
      return { error: `Tool desconocida: ${name}` }
  }
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

function buildIntegrationsBlock(config) {
  const features = config.features || {}
  const lines = []

  if (features.cal_create_booking) {
    lines.push('- **Reservas:** Puedes crear citas directamente desde este chat usando las tools disponibles. No necesitas mandar el link — gestiona la reserva aquí.')
  } else if (config.cal_link) {
    lines.push(`- **Reservas:** Puedes enviar este link para que el usuario reserve: ${config.cal_link}`)
  }

  if (config.stripe_link) {
    lines.push(`- **Pago:** Cuando el usuario quiera contratar, envía este link de pago: ${config.stripe_link}`)
  }

  if (lines.length === 0) {
    return '- No hay integraciones activas. Si el usuario quiere reservar o contratar, dile que Kenny le contactará directamente.'
  }

  return lines.join('\n')
}

export { RATE_LIMIT_MSG, FALLBACK_MSG }
