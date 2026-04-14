/**
 * memory.js — Ciclo de auto-aprendizaje supervisado.
 *
 * Flujo:
 *   1. Handoff detectado en webhook.js
 *   2. analyzeHandoff(config, fullHistory, lastMessage)
 *      → Claude analiza si el bot podría haber respondido sin escalar
 *      → Si responde "NADA" → fin
 *      → Si propone algo → dedup + insert + sendKennyProposal
 *   3. Kenny responde "aprobar XXXXXX" o "rechazar XXXXXX"
 *   4. handleKennyApproval(action, shortId)
 *      → 'aprobar' → applyProposal → upsert system_prompt_overrides
 *      → 'rechazar' → marcar rejected
 *
 * Diagrama de estado de una propuesta:
 *   pending → approved (applyProposal OK)
 *   pending → rejected (Kenny rechaza)
 *   pending → error   (applyProposal falla o output inválido)
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { callClaudeRaw } from './claude.js'
import { sendTwilioMessage, sendKennyProposal } from './notify.js'
import {
  getSystemPromptOverride,
  setSystemPromptOverride,
  insertMemoryProposal,
  getProposalByShortId,
  updateProposalStatus,
  getRecentProposalTexts,
} from './supabase.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// analyzeHandoff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analiza una conversación que terminó en handoff y propone (o no) una
 * actualización al system-prompt.
 *
 * Fire-and-forget: llamar con .catch(console.error) desde webhook.js.
 * Nunca lanza — todos los errores se absorben internamente.
 *
 * @param {object} config       — config del cliente (client_slug, business_name, etc.)
 * @param {Array}  fullHistory  — [...history, {role:'user',...}, {role:'assistant',...}]
 *                                El turn actual (el que causó el handoff) debe estar incluido.
 * @param {string} lastMessage  — último mensaje del usuario (para trigger_message en BD)
 */
export async function analyzeHandoff(config, fullHistory, lastMessage) {
  const slug = config.client_slug
  const businessName = config.business_name || slug

  // Formatear últimos 4 turns (role + content, truncados a 200 chars)
  const MAX_CHARS = 200
  const turns = fullHistory.slice(-4)
  const historyText = turns
    .map(t => {
      const prefix = t.role === 'user' ? 'Usuario' : 'Bot'
      const content = (t.content || '').slice(0, MAX_CHARS)
      const truncated = (t.content || '').length > MAX_CHARS ? '…' : ''
      return `${prefix}: ${content}${truncated}`
    })
    .join('\n')

  const systemPrompt = `Eres el asistente de configuración del bot de ${businessName}.`

  const userContent = `Esta conversación de WhatsApp terminó con un escalado a humano (handoff).

HISTORIAL:
${historyText}

Tu tarea: identificar qué información debería tener el bot para haber respondido sin escalar. Si el handoff fue correcto (urgencia real, petición de hablar con persona, problema técnico), responde exactamente: NADA

Si el bot podía haber respondido pero le faltaba información, propón UNA actualización concreta para el system-prompt del bot. Máximo 3 líneas. Usa el mismo tono y estilo del system-prompt existente. No incluyas explicaciones, solo la línea a añadir.

IMPORTANTE: No propongas nada si:
- El usuario pidió explícitamente hablar con una persona
- Es una queja grave o urgencia
- El bot actuó correctamente según sus instrucciones`

  let rawResponse
  try {
    rawResponse = await callClaudeRaw(systemPrompt, userContent, 512)
  } catch (err) {
    console.error(`[memory] analyzeHandoff Claude error: ${err.message}`)
    return
  }

  const proposal = rawResponse?.trim()
  if (!proposal || /^nada[.,!?\s]*$/i.test(proposal)) return

  // Deduplicación exacta contra las últimas 5 propuestas del slug
  let recentTexts = []
  try {
    recentTexts = await getRecentProposalTexts(slug, 5)
  } catch (err) {
    console.error(`[memory] analyzeHandoff dedup fetch error: ${err.message}`)
    // Continuar sin dedup antes que perder la propuesta
  }

  const isDuplicate = recentTexts.some(
    t => t.toLowerCase().trim() === proposal.toLowerCase().trim()
  )
  if (isDuplicate) {
    console.log(`[memory] analyzeHandoff: propuesta duplicada descartada para ${slug}`)
    return
  }

  // Generar short_id: primeros 6 chars del UUID sin guiones
  const uuid = randomUUID()
  const shortId = uuid.replace(/-/g, '').slice(0, 6)

  try {
    await insertMemoryProposal({
      clientSlug: slug,
      proposal,
      triggerMessage: lastMessage,
      shortId,
    })
  } catch (err) {
    console.error(`[memory] analyzeHandoff insert error: ${err.message}`)
    return
  }

  try {
    await sendKennyProposal({ clientSlug: slug, proposal, shortId })
  } catch (err) {
    console.error(`[memory] analyzeHandoff sendKennyProposal error: ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleKennyApproval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa la respuesta de Kenny a una propuesta.
 *
 * @param {'aprobar'|'rechazar'} action
 * @param {string}               shortId  — 6 chars hex
 */
export async function handleKennyApproval(action, shortId) {
  const kennyPhone = process.env.KENNY_WHATSAPP

  // Lookup por short_id
  let proposal
  try {
    proposal = await getProposalByShortId(shortId)
  } catch (err) {
    console.error(`[memory] handleKennyApproval lookup error: ${err.message}`)
    if (kennyPhone) {
      await safeSendKenny(`⚠️ Error buscando la propuesta ${shortId}. Inténtalo de nuevo.`)
    }
    return
  }

  if (!proposal) {
    if (kennyPhone) {
      await safeSendKenny(`❌ No encontré ninguna propuesta con ID ${shortId}. ¿Tienes el ID correcto?`)
    }
    return
  }

  if (proposal.status !== 'pending') {
    await safeSendKenny(`⚠️ La propuesta ${shortId} ya fue ${proposal.status}. No se puede procesar de nuevo.`)
    return
  }

  if (action === 'rechazar') {
    try {
      await updateProposalStatus(proposal.id, 'rejected')
    } catch (err) {
      console.error(`[memory] handleKennyApproval reject error: ${err.message}`)
    }
    await safeSendKenny(`❌ Rechazado — ok, descartado.`)
    return
  }

  // action === 'aprobar'
  try {
    await applyProposal(proposal)
    await safeSendKenny(`✅ Aplicado. El bot cargará el nuevo system-prompt en los próximos 5 minutos.`)
  } catch (err) {
    console.error(`[memory] handleKennyApproval apply error: ${err.message}`)
    // applyProposal ya actualizó el status a 'error' y notificó a Kenny internamente
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// applyProposal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Integra una propuesta aprobada en el system-prompt del cliente.
 *
 * Flujo:
 *   1. Leer system-prompt actual (Supabase override → disco como fallback)
 *   2. Claude integra la propuesta en el lugar más coherente
 *   3. Sanity check: output no debe ser >2x el original
 *   4. Guardar previous_content en la propuesta (para rollback manual)
 *   5. Upsert en system_prompt_overrides
 *
 * @param {object} proposal — row de memory_proposals
 */
async function applyProposal(proposal) {
  const { id, client_slug: slug, proposal: proposalText } = proposal

  // 1. Leer system-prompt actual
  let currentContent
  try {
    currentContent = await getSystemPromptOverride(slug)
  } catch (err) {
    console.error(`[memory] applyProposal override fetch error: ${err.message}`)
  }
  if (!currentContent) {
    currentContent = loadFromDisk(slug)
  }

  // 2. Claude integra la propuesta
  const systemPrompt = `Eres un editor del system-prompt de un bot de WhatsApp.
Tu tarea: integrar una nueva línea de conocimiento en el system-prompt existente,
en el lugar más coherente, sin duplicar información existente ni cambiar el tono.

SYSTEM-PROMPT ACTUAL:
${currentContent}

NUEVA INFORMACIÓN A INTEGRAR:
${proposalText}

Devuelve ÚNICAMENTE el system-prompt completo actualizado, sin explicaciones,
sin markdown extra, sin comentarios. Mismo formato que el original.`

  let newContent
  try {
    newContent = await callClaudeRaw(systemPrompt, 'Integra la nueva información.', 2048)
  } catch (err) {
    await markError(id, `Claude API error: ${err.message}`)
    throw err
  }

  newContent = newContent?.trim()
  if (!newContent) {
    await markError(id, 'Claude devolvió una respuesta vacía.')
    throw new Error('[memory] applyProposal: respuesta vacía de Claude')
  }

  // 3. Sanity check: output no debe crecer más del doble
  // Guardar si base estaba vacía — cualquier output superaría el check
  if (!currentContent) {
    await markError(id, 'system-prompt base vacío — no se puede aplicar sin contenido base')
    await safeSendKenny(`⚠️ No se encontró system-prompt base para "${slug}". Crea uno en disco o en Supabase antes de aprobar propuestas.`)
    throw new Error('[memory] applyProposal: currentContent vacío')
  }

  if (newContent.length > currentContent.length * 2) {
    const msg = `⚠️ El system-prompt creció demasiado al integrar la propuesta ${id.slice(0, 8)}. Revisa manualmente.`
    await markError(id, 'output demasiado largo')
    await safeSendKenny(msg)
    throw new Error('[memory] applyProposal: output length sanity check failed')
  }

  // 4. Guardar previous_content para rollback + marcar applied_at
  try {
    await updateProposalStatus(id, 'approved', {
      previous_content: currentContent,
      applied_at: new Date().toISOString(),
    })
  } catch (err) {
    // No crítico — el rollback se pierde pero el override se sigue aplicando
    console.error(`[memory] applyProposal updateProposalStatus error: ${err.message}`)
  }

  // 5. Upsert en system_prompt_overrides
  await setSystemPromptOverride(slug, newContent)
  console.log(`[memory] applyProposal: override aplicado para ${slug}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function markError(proposalId, reason) {
  try {
    await updateProposalStatus(proposalId, 'error')
  } catch (err) {
    console.error(`[memory] markError failed: ${err.message}`)
  }
  await safeSendKenny(`⚠️ No pude aplicar el cambio (${reason}). Revisa manualmente en Supabase.`)
}

async function safeSendKenny(text) {
  const kennyPhone = process.env.KENNY_WHATSAPP
  if (!kennyPhone) return
  try {
    await sendTwilioMessage({ to: kennyPhone, text })
  } catch (err) {
    console.error(`[memory] safeSendKenny failed: ${err.message}`)
  }
}

function loadFromDisk(slug) {
  const promptPath = join(__dirname, '..', 'clients', slug, 'system-prompt.md')
  try {
    return readFileSync(promptPath, 'utf8')
  } catch (err) {
    console.error(`[memory] loadFromDisk: no se encontró system-prompt.md para "${slug}"`)
    return ''
  }
}
