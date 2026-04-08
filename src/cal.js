/**
 * cal.js — Consulta disponibilidad real en Cal.com.
 *
 * Se usa como tool_use de Claude: cuando el usuario pregunta
 * por horarios disponibles, Claude llama a esta función con
 * los parámetros necesarios y recibe slots reales.
 *
 * Timeout: 3 segundos. Si Cal.com no responde, devolvemos
 * un string de fallback que Claude puede usar para dar una
 * respuesta coherente sin inventar horarios.
 */

const CAL_API_BASE = 'https://api.cal.com/v1'
const TIMEOUT_MS = 3000

const FALLBACK_SLOTS = {
  available: false,
  fallback: true,
  message: 'No pude consultar la agenda en este momento.',
}

/**
 * Obtiene los próximos slots disponibles para un evento Cal.com.
 *
 * @param {string} apiKey - Cal.com API key del cliente
 * @param {string} eventTypeId - ID del tipo de evento (cita, consulta...)
 * @param {number} daysAhead - Cuántos días hacia adelante buscar (default: 7)
 * @returns {object} slots o FALLBACK_SLOTS si Cal.com falla
 */
export async function getAvailableSlots(apiKey, eventTypeId, daysAhead = 7) {
  if (!apiKey || !eventTypeId) return FALLBACK_SLOTS

  const startTime = new Date().toISOString()
  const endTime = new Date(Date.now() + daysAhead * 86400000).toISOString()

  const url = new URL(`${CAL_API_BASE}/slots`)
  url.searchParams.set('apiKey', apiKey)
  url.searchParams.set('eventTypeId', eventTypeId)
  url.searchParams.set('startTime', startTime)
  url.searchParams.set('endTime', endTime)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url.toString(), {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    })

    if (!res.ok) {
      console.error(`[cal] API error: ${res.status}`)
      return FALLBACK_SLOTS
    }

    const data = await res.json()
    const slots = data.slots || {}

    // Formatear slots en texto legible para Claude
    const formatted = []
    for (const [date, daySlots] of Object.entries(slots).slice(0, 3)) {
      const times = daySlots.slice(0, 3).map(s => {
        const d = new Date(s.time)
        return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      })
      if (times.length > 0) {
        const dateStr = new Date(date).toLocaleDateString('es-ES', {
          weekday: 'long', day: 'numeric', month: 'long'
        })
        formatted.push(`${dateStr}: ${times.join(', ')}`)
      }
    }

    return {
      available: formatted.length > 0,
      slots: formatted,
      raw: slots,
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[cal] Timeout — Cal.com no respondió en 3s')
    } else {
      console.error(`[cal] Error: ${err.message}`)
    }
    return FALLBACK_SLOTS
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Definición de la tool para Claude API (tool_use).
 * Incluir en el array `tools` de cada llamada a Claude.
 */
export const calTool = {
  name: 'get_available_slots',
  description:
    'Consulta los próximos horarios disponibles para agendar una cita. ' +
    'Úsala cuando el usuario pregunte por disponibilidad, horarios, o quiera reservar.',
  input_schema: {
    type: 'object',
    properties: {
      days_ahead: {
        type: 'number',
        description: 'Días hacia adelante a consultar (default: 7)',
      },
    },
    required: [],
  },
}
