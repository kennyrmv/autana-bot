/**
 * notify.js — Alertas a Kenny cuando el bot necesita intervención humana.
 *
 * En v1: notificación vía WhatsApp (mensaje al número de Kenny)
 * usando 360dialog. Simple, directo, funciona sin integración extra.
 */

/**
 * Alerta a Kenny de un error o handoff.
 * Fire-and-forget: no lanza aunque falle.
 *
 * @param {object} params
 * @param {string} params.type        - 'error' | 'handoff'
 * @param {string} params.clientSlug  - Slug del cliente
 * @param {string} params.userPhone   - Número del usuario (hasheado en logs)
 * @param {string} params.message     - Último mensaje del usuario
 * @param {Error}  [params.error]     - Error object si type='error'
 * @param {object} [params.dialog360] - { apiKey, channelId, kennyPhone }
 */
export async function alertKenny({ type, clientSlug, userPhone, message, error, dialog360 }) {
  const phoneHash = hashPhone(userPhone)
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })

  let text
  if (type === 'error') {
    text = [
      `⚠️ *Autana Bot — Error técnico*`,
      `Cliente: ${clientSlug}`,
      `Usuario: ${phoneHash}`,
      `Error: ${error?.message || 'desconocido'}`,
      `Hora: ${timestamp}`,
      `Último mensaje: "${message?.slice(0, 100)}"`,
    ].join('\n')
  } else if (type === 'handoff') {
    text = [
      `🤝 *Autana Bot — Escalado a humano*`,
      `Cliente: ${clientSlug}`,
      `Usuario: ${userPhone}`,  // número real para que Kenny pueda responder
      `Hora: ${timestamp}`,
      `Último mensaje: "${message?.slice(0, 200)}"`,
      `\nResponde directamente a ese número de WhatsApp.`,
    ].join('\n')
  }

  // Enviar vía 360dialog al número de Kenny
  if (dialog360?.apiKey && dialog360?.channelId && dialog360?.kennyPhone) {
    try {
      await send360dialogMessage({
        apiKey: dialog360.apiKey,
        channelId: dialog360.channelId,
        to: dialog360.kennyPhone,
        text,
      })
    } catch (err) {
      // Si la alerta falla, al menos lo vemos en logs de Railway
      console.error(`[notify] alertKenny failed: ${err.message}`)
    }
  }

  // Siempre loguear (visible en Railway)
  console.error(`[notify] ${type.toUpperCase()} | ${clientSlug} | ${phoneHash} | ${message?.slice(0, 50)}`)
}

/**
 * Envía un mensaje de texto via 360dialog API.
 * Reutilizado tanto para respuestas al usuario como para alertas a Kenny.
 */
export async function send360dialogMessage({ apiKey, channelId, to, text }) {
  const url = `https://waba.360dialog.io/v1/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'D360-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`360dialog error ${res.status}: ${body}`)
  }

  return res.json()
}

/** Hash del número para logs (no guardamos números en claro en logs) */
function hashPhone(phone) {
  if (!phone) return 'unknown'
  const last4 = phone.slice(-4)
  return `****${last4}`
}
