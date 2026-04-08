/**
 * webhook.js — Punto de entrada de todos los mensajes WhatsApp.
 *
 * Flujo:
 *  1. Verificar firma HMAC-SHA256 de 360dialog
 *  2. Extraer número de teléfono y channel_id
 *  3. Cargar config del cliente por channel_id
 *  4. Manejar tipos de mensaje:
 *     - No texto (imagen, audio, sticker) → respuesta informativa
 *     - Texto "borrar mis datos" → flujo LOPD
 *     - Texto normal → Claude
 *  5. Recuperar historial de Supabase
 *  6. Llamar a Claude con historial + mensaje
 *  7. Guardar turno en Supabase
 *  8. Enviar respuesta al usuario vía 360dialog
 *  9. Si handoff: alertar a Kenny
 */

import crypto from 'crypto'
import { getConfigByChannelId } from './config.js'
import { getHistory, saveMessage, deleteUserData } from './supabase.js'
import { chat } from './claude.js'
import { alertKenny, send360dialogMessage } from './notify.js'

// Mensajes predefinidos
const NON_TEXT_MSG =
  'Por aquí solo puedo leer mensajes de texto 📝 ' +
  'Escríbeme tu pregunta y te respondo enseguida.'

const UNKNOWN_CLIENT_MSG =
  'Lo siento, este servicio no está disponible en este momento. ' +
  'Inténtalo más tarde.'

const DELETE_CONFIRM_MSG =
  '✅ Listo. He borrado todos tus mensajes guardados. ' +
  'Si necesitas algo más, escríbeme de nuevo.'

const FIRST_MESSAGE_LOPD = (privacyUrl) =>
  `Hola 👋 Soy un asistente virtual.\n\n` +
  `Puedo ayudarte con precios, disponibilidad y reservas. ` +
  `No accedo ni guardo datos de salud.\n\n` +
  `Más info: ${privacyUrl || 'Política de privacidad disponible en nuestra web'}\n\n` +
  `¿En qué puedo ayudarte?`

/**
 * Registra el webhook handler en la instancia de Fastify.
 */
export function registerWebhook(fastify) {

  // Verification GET (360dialog lo llama al configurar el webhook)
  fastify.get('/webhook', async (request, reply) => {
    const token = request.query['hub.verify_token']
    const challenge = request.query['hub.challenge']

    if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return reply.send(challenge)
    }
    return reply.status(403).send('Forbidden')
  })

  // Mensajes entrantes
  fastify.post('/webhook', {
    config: { rawBody: true }, // Fastify necesita el body raw para HMAC
  }, async (request, reply) => {

    // 1. Verificar firma 360dialog
    if (!verifySignature(request)) {
      fastify.log.warn('Webhook: firma inválida — posible request falso')
      return reply.status(401).send()
    }

    // 360dialog espera 200 rápido. Procesamos en background.
    reply.status(200).send()

    // 2. Extraer datos del payload de 360dialog
    const payload = request.body
    const entry = payload?.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value

    if (!value?.messages?.length) return // ping, status update, etc.

    const msg = value.messages[0]
    const channelId = value.metadata?.phone_number_id
    const userPhone = msg.from

    // 3. Cargar config del cliente
    const config = getConfigByChannelId(channelId)
    if (!config) {
      fastify.log.warn(`Webhook: channel_id desconocido: ${channelId}`)
      await safeSend(null, userPhone, UNKNOWN_CLIENT_MSG)
      return
    }

    const { client_slug: slug, dialog360_api_key: apiKey } = config

    // 4. Manejar tipos de mensaje no-texto
    if (msg.type !== 'text') {
      await safeSend(apiKey, userPhone, NON_TEXT_MSG)
      return
    }

    const userText = msg.text?.body?.trim()
    if (!userText) return

    // 5. Verificar si es el primer mensaje del usuario (LOPD)
    const history = await getHistory(userPhone, slug)
    const isFirstMessage = history.length === 0

    if (isFirstMessage && config.first_message_lopd) {
      await safeSend(apiKey, userPhone, FIRST_MESSAGE_LOPD(config.privacy_url))
      // Guardamos el primer mensaje del usuario para que en el próximo turno ya tenga contexto
      await saveMessage(userPhone, slug, 'user', userText)
      return
    }

    // 6. Flujo de supresión LOPD
    if (userText.toLowerCase() === 'sí, borrar' || userText.toLowerCase() === 'si, borrar') {
      // Verificar que el turno anterior fue la pregunta de confirmación
      const lastMsg = history[history.length - 1]
      if (lastMsg?.role === 'assistant' && lastMsg.content.includes('¿Quieres que borre')) {
        await deleteUserData(userPhone, slug)
        await safeSend(apiKey, userPhone, DELETE_CONFIRM_MSG)
        return
      }
    }

    // 7. Llamar a Claude
    let claudeResult
    try {
      claudeResult = await chat(config, history, userText)
    } catch (err) {
      // Chat tiene su propio error handling, esto es la red de seguridad final
      fastify.log.error(`Claude error para ${slug}: ${err.message}`)
      await safeSend(apiKey, userPhone, 'Lo siento, hay un problema técnico. Volvemos enseguida.')
      await alertKenny({
        type: 'error',
        clientSlug: slug,
        userPhone,
        message: userText,
        error: err,
        dialog360: { apiKey, channelId, kennyPhone: config.handoff_phone },
      })
      return
    }

    const { text: botResponse, meta = {} } = claudeResult

    // 8. Guardar ambos lados del turno
    await saveMessage(userPhone, slug, 'user', userText)
    await saveMessage(userPhone, slug, 'assistant', botResponse, meta)

    // 9. Enviar respuesta al usuario
    await safeSend(apiKey, userPhone, botResponse)

    // 10. Si el bot decidió escalar, alertar a Kenny
    if (meta.endedWithHandoff) {
      await alertKenny({
        type: 'handoff',
        clientSlug: slug,
        userPhone,
        message: userText,
        dialog360: { apiKey, channelId, kennyPhone: config.handoff_phone },
      })
    }
  })
}

/**
 * Verifica la firma HMAC-SHA256 que envía 360dialog en cada request.
 * Sin esto, cualquiera puede enviar mensajes falsos a nuestro webhook.
 */
function verifySignature(request) {
  const secret = process.env.DIALOG360_WEBHOOK_SECRET
  if (!secret) {
    // En desarrollo (sin secret configurado), permitimos el paso
    if (process.env.NODE_ENV !== 'production') return true
    return false
  }

  const signature = request.headers['x-hub-signature-256']
  if (!signature) return false

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(request.rawBody || JSON.stringify(request.body))
    .digest('hex')

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  } catch {
    return false
  }
}

/**
 * Envía un mensaje de texto. Si falla, solo loguea — no rompe el flujo.
 */
async function safeSend(apiKey, to, text) {
  if (!apiKey || !to || !text) return
  try {
    await send360dialogMessage({ apiKey, to, text })
  } catch (err) {
    console.error(`[webhook] safeSend failed to ${to}: ${err.message}`)
  }
}
