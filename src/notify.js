/**
 * notify.js — Envío de mensajes y alertas vía Twilio WhatsApp.
 */

import twilio from 'twilio'

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

/**
 * Envía un mensaje de texto vía Twilio WhatsApp.
 * El número 'to' debe tener formato: whatsapp:+34600000000
 */
export async function sendTwilioMessage({ to, text }) {
  const from = process.env.TWILIO_WHATSAPP_FROM // whatsapp:+14155238886

  // Aseguramos formato correcto
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`

  const client = getTwilioClient()
  await client.messages.create({
    from,
    to: toFormatted,
    body: text,
  })
}

/**
 * Alerta a Kenny en handoff o error.
 */
export async function alertKenny({ type, clientSlug, userPhone, message, error, count, limit }) {
  const phoneHash = hashPhone(userPhone)
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })

  let text
  if (type === 'error') {
    text = [
      `⚠️ Autana Bot — Error técnico`,
      `Cliente: ${clientSlug}`,
      `Usuario: ${phoneHash}`,
      `Error: ${error?.message || 'desconocido'}`,
      `Hora: ${timestamp}`,
      `Último mensaje: "${message?.slice(0, 100)}"`,
    ].join('\n')
  } else if (type === 'handoff') {
    text = [
      `🤝 Autana Bot — Escalado a humano`,
      `Cliente: ${clientSlug}`,
      `Usuario: ${userPhone}`,
      `Hora: ${timestamp}`,
      `Último mensaje: "${message?.slice(0, 200)}"`,
      `Responde directamente a ese número de WhatsApp.`,
    ].join('\n')
  } else if (type === 'limit_warning') {
    text = [
      `⚡ Autana Bot — Aviso de límite al 80%`,
      `Cliente: ${clientSlug}`,
      `Conversaciones este mes: ${count} / ${limit}`,
      `Hora: ${timestamp}`,
      `El cliente se acerca al límite de su plan. Considera contactarle para hacer upgrade.`,
    ].join('\n')
  } else if (type === 'limit_reached') {
    text = [
      `🚫 Autana Bot — Límite mensual alcanzado`,
      `Cliente: ${clientSlug}`,
      `Conversaciones este mes: ${count} / ${limit}`,
      `Hora: ${timestamp}`,
      `Las nuevas conversaciones están bloqueadas hasta el próximo mes o upgrade de plan.`,
    ].join('\n')
  }

  const kennyPhone = process.env.KENNY_WHATSAPP // tu número: +34600000000
  if (kennyPhone) {
    try {
      await sendTwilioMessage({ to: kennyPhone, text })
    } catch (err) {
      console.error(`[notify] alertKenny failed: ${err.message}`)
    }
  }

  console.error(`[notify] ${type.toUpperCase()} | ${clientSlug} | ${phoneHash} | ${message?.slice(0, 50)}`)
}

function hashPhone(phone) {
  if (!phone) return 'unknown'
  return `****${phone.slice(-4)}`
}
