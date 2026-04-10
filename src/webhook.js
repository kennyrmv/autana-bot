/**
 * webhook.js — Webhook handler para Twilio WhatsApp Sandbox.
 *
 * Twilio envía los mensajes como application/x-www-form-urlencoded.
 * Campos principales:
 *   Body      → texto del mensaje
 *   From      → whatsapp:+34600000000
 *   To        → whatsapp:+14155238886 (número sandbox)
 *   MediaUrl0 → si el mensaje tiene imagen/audio
 *
 * Twilio verifica requests con firma HMAC-SHA1 en el header
 * X-Twilio-Signature.
 */

import twilio from 'twilio'
import { getConfigBySlug } from './config.js'
import { getHistory, saveMessage, deleteUserData } from './supabase.js'
import { findActiveSession, touchSession, createSession, getMonthlySessionCount } from './sessions.js'
import { chat } from './claude.js'
import { alertKenny, sendTwilioMessage } from './notify.js'

// En sandbox Twilio, todos los mensajes van al mismo número.
// Usamos el slug de cliente definido en SANDBOX_CLIENT_SLUG.
// Cuando tengas múltiples números reales, esto cambia a routing por número.
const SANDBOX_CLIENT_SLUG = process.env.SANDBOX_CLIENT_SLUG || 'autana'

const NON_TEXT_MSG =
  'Por aquí solo puedo leer mensajes de texto 📝 ' +
  'Escríbeme tu pregunta y te respondo enseguida.'

const DELETE_CONFIRM_MSG =
  '✅ Listo. He borrado todos tus mensajes guardados. ' +
  'Si necesitas algo más, escríbeme de nuevo.'

const FIRST_MESSAGE_LOPD = (privacyUrl) =>
  `Hola 👋 Soy el asistente virtual de Autana.\n\n` +
  `Puedo ayudarte con información sobre nuestros servicios, precios y reservas.\n\n` +
  `Más info: ${privacyUrl || 'autana.es/privacidad'}\n\n` +
  `¿En qué puedo ayudarte?`

export function registerWebhook(fastify) {

  // Health check ya registrado en server.js

  fastify.post('/webhook', async (request, reply) => {

    // 1. Verificar firma de Twilio
    if (!verifyTwilioSignature(request)) {
      fastify.log.warn('Webhook: firma Twilio inválida')
      return reply.status(403).send('Forbidden')
    }

    // Twilio espera respuesta rápida (TwiML o 200 vacío)
    reply.status(200).header('Content-Type', 'text/xml').send('<Response></Response>')

    // 2. Extraer datos del payload de Twilio
    const body = request.body
    const userPhone = body.From?.replace('whatsapp:', '') // → +34600000000
    const userText = body.Body?.trim()
    const hasMedia = !!body.MediaUrl0

    if (!userPhone) return

    // 3. Cargar config del cliente (en sandbox: siempre el mismo slug)
    const config = getConfigBySlug(SANDBOX_CLIENT_SLUG)
    if (!config) {
      fastify.log.error(`Config no encontrada para slug: ${SANDBOX_CLIENT_SLUG}`)
      await safeSend(userPhone, 'Servicio no disponible en este momento.')
      return
    }

    const slug = config.client_slug

    // 4. Mensaje con imagen/audio
    if (hasMedia || !userText) {
      await safeSend(userPhone, NON_TEXT_MSG)
      return
    }

    // 5. Control de sesión y límite de conversaciones del plan
    const activeSession = await findActiveSession(userPhone, slug)

    if (activeSession) {
      // Sesión en curso: actualizar actividad
      await touchSession(activeSession.id)
    } else {
      // Nueva sesión: verificar límite mensual antes de crearla
      const limit = config.monthly_conversation_limit ?? null

      if (limit !== null) {
        const count = await getMonthlySessionCount(slug)

        if (count !== null && count >= limit) {
          // Límite alcanzado — respuesta elegante + alerta Kenny para upgrade
          fastify.log.warn(`[webhook] Límite alcanzado: ${slug} (${count}/${limit})`)
          await createSession(userPhone, slug) // registramos para que Kenny vea quién escribió
          await safeSend(
            userPhone,
            'Ahora mismo estamos gestionando mucha demanda 🙏 Un miembro de nuestro equipo te atenderá personalmente en breve.'
          )
          await alertKenny({ type: 'limit_reached', clientSlug: slug, count, limit })
          return
        }

        // Alerta al cruzar el 80% (>= para no saltar si el count sube de golpe)
        if (count !== null && count >= Math.floor(limit * 0.8)) {
          await alertKenny({ type: 'limit_warning', clientSlug: slug, count: count + 1, limit })
        }
      }

      await createSession(userPhone, slug)
    }

    // 6. Primer mensaje → aviso LOPD
    const history = await getHistory(userPhone, slug)
    const isFirstMessage = history.length === 0

    if (isFirstMessage && config.first_message_lopd) {
      const lopdText = FIRST_MESSAGE_LOPD(config.privacy_url)
      await safeSend(userPhone, lopdText)
      await saveMessage(userPhone, slug, 'user', userText)
      await saveMessage(userPhone, slug, 'assistant', lopdText)
      return
    }

    // 7. Supresión LOPD
    const lowerText = userText.toLowerCase()
    if (lowerText === 'sí, borrar' || lowerText === 'si, borrar') {
      const lastMsg = history[history.length - 1]
      if (lastMsg?.role === 'assistant' && lastMsg.content.includes('¿Quieres que borre')) {
        await deleteUserData(userPhone, slug)
        await safeSend(userPhone, DELETE_CONFIRM_MSG)
        return
      }
    }

    // 8. Claude
    let claudeResult
    try {
      claudeResult = await chat(config, history, userText, userPhone)
    } catch (err) {
      fastify.log.error(`Claude error: ${err.message}`)
      await safeSend(userPhone, 'Lo siento, hay un problema técnico. Volvemos enseguida.')
      await alertKenny({ type: 'error', clientSlug: slug, userPhone, message: userText, error: err })
      return
    }

    const { text: botResponse, meta = {} } = claudeResult

    // 9. Guardar turno
    await saveMessage(userPhone, slug, 'user', userText)
    await saveMessage(userPhone, slug, 'assistant', botResponse, meta)

    // 10. Responder al usuario
    await safeSend(userPhone, botResponse)

    // 11. Handoff
    if (meta.endedWithHandoff) {
      await alertKenny({ type: 'handoff', clientSlug: slug, userPhone, message: userText })
    }
  })
}

function verifyTwilioSignature(request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    // En desarrollo sin token configurado, permitimos
    if (process.env.NODE_ENV !== 'production') return true
    return false
  }

  const signature = request.headers['x-twilio-signature']
  if (!signature) return false

  // URL completa que Twilio usó para hacer el POST
  const url = `https://${request.headers.host}/webhook`
  const params = request.body || {}

  return twilio.validateRequest(authToken, signature, url, params)
}

async function safeSend(to, text) {
  try {
    await sendTwilioMessage({ to, text })
  } catch (err) {
    console.error(`[webhook] safeSend failed: ${err.message}`)
  }
}
