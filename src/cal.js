/**
 * cal.js — Integración con Cal.com API v2.
 *
 * Cal.com deprecó v1 (410 Gone). Usamos v2:
 *   Base: https://api.cal.com/v2
 *   Auth: Authorization: Bearer {apiKey}
 *   Header: cal-api-version: 2024-09-04
 */

import { createClient } from '@supabase/supabase-js'

const CAL_API_BASE = 'https://api.cal.com/v2'
const CAL_PUBLIC_BASE = 'https://cal.com/api'
const CAL_API_VERSION = '2024-09-04'
const TIMEOUT_MS = 5000
const TIMEZONE = 'Europe/Madrid'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const FALLBACK_SLOTS = {
  available: false,
  fallback: true,
  message: 'No pude consultar la agenda en este momento.',
}

// ─── Helper fetch ─────────────────────────────────────────────────────────────

async function calFetch(apiKey, path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const url = `${CAL_API_BASE}${path}`

  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      ...options,
    })
    clearTimeout(timer)
    return res
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

// ─── get_available_slots ──────────────────────────────────────────────────────

export async function getAvailableSlots(apiKey, eventTypeId, daysAhead = 7) {
  if (!apiKey || !eventTypeId) return FALLBACK_SLOTS

  const startTime = new Date().toISOString()
  const endTime = new Date(Date.now() + daysAhead * 86400000).toISOString()

  const params = new URLSearchParams({
    eventTypeId,
    start: startTime,
    end: endTime,
    timeZone: TIMEZONE,
  })

  try {
    const res = await calFetch(apiKey, `/slots?${params}`)

    if (!res.ok) {
      const body = await res.text()
      console.error(`[cal] get_available_slots error: ${res.status} ${body}`)
      return FALLBACK_SLOTS
    }

    const data = await res.json()
    // Cal v2 devuelve: { data: { "2026-04-10": [{start: "..."}], ... }, status: "success" }
    const slots = data.data || {}

    const formatted = []
    const rawSlots = []
    const minTime = Date.now() + 30 * 60 * 1000 // mínimo 30 min en el futuro

    for (const [date, daySlots] of Object.entries(slots).slice(0, 4)) {
      const times = daySlots
        .filter(s => new Date(s.start || s.time).getTime() > minTime)
        .slice(0, 4)
        .map(s => {
          const iso = s.start || s.time
          rawSlots.push(iso)
          const d = new Date(iso)
          return {
            iso,
            display: d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE }),
          }
        })

      if (times.length > 0) {
        const dateStr = new Date(date).toLocaleDateString('es-ES', {
          weekday: 'long', day: 'numeric', month: 'long', timeZone: TIMEZONE,
        })
        formatted.push({ date: dateStr, slots: times })
      }
    }

    return {
      available: formatted.length > 0,
      slots: formatted,
      rawSlots,
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[cal] get_available_slots timeout')
    } else {
      console.error(`[cal] get_available_slots error: ${err.message}`)
    }
    return FALLBACK_SLOTS
  }
}

// ─── create_booking ───────────────────────────────────────────────────────────

export async function createBooking({ apiKey, eventTypeId, phone, clientSlug, name, email, startTime }) {
  if (!eventTypeId) {
    return { success: false, error: 'Cal no configurado para este cliente.' }
  }

  // Validación defensiva: el start_time debe ser un ISO válido y en el futuro.
  // Claude a veces reconstruye la fecha en vez de copiarla de get_available_slots.
  const parsedStart = new Date(startTime)
  if (isNaN(parsedStart.getTime())) {
    console.error(`[cal] create_booking: start_time inválido: ${startTime}`)
    return { success: false, error: 'La fecha del slot no es válida. Usa get_available_slots para obtener los horarios disponibles y copia el campo "iso" exactamente.' }
  }
  if (parsedStart.getTime() < Date.now()) {
    console.error(`[cal] create_booking: start_time en el pasado: ${startTime}`)
    return { success: false, error: 'Ese horario ya pasó. Usa get_available_slots para ver los próximos horarios disponibles.' }
  }

  // Cal.com v2 POST /bookings requiere OAuth. Usamos el endpoint público que funciona con personal API key.
  // Confirmado funcionando: https://cal.com/api/book/event
  // Normalizar a UTC (Z) — Claude a veces pasa +02:00 en vez de Z
  const resolvedStart = parsedStart.toISOString()
  const endTime = new Date(parsedStart.getTime() + 15 * 60 * 1000).toISOString()

  const body = {
    eventTypeId: Number(eventTypeId),
    start: resolvedStart,
    end: endTime,
    timeZone: TIMEZONE,
    language: 'es',
    metadata: { source: 'autana-bot' },
    responses: { name, email },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  console.log(`[cal] create_booking → POST ${CAL_PUBLIC_BASE}/book/event`, JSON.stringify(body))

  try {
    const res = await fetch(`${CAL_PUBLIC_BASE}/book/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (res.status === 409) {
      return { success: false, conflict: true, error: 'Ese horario acaba de ocuparse. Elige otro.' }
    }

    if (!res.ok) {
      const errBody = await res.text()
      console.error(`[cal] create_booking error ${res.status}: ${errBody}`)
      return { success: false, error: 'No pude crear la cita. Inténtalo de nuevo.' }
    }

    const data = await res.json()
    const bookingUid = data.uid || data.data?.uid

    // Guardar en Supabase para detección futura
    const { error: dbErr } = await supabase.from('bookings').insert({
      phone,
      client_slug: clientSlug,
      booking_uid: bookingUid,
      start_time: startTime,
      status: 'confirmed',
    })

    if (dbErr) {
      console.error(`[cal] create_booking supabase error: ${dbErr.message}`)
    }

    return { success: true, bookingUid, startTime, attendeeName: name, attendeeEmail: email }
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      console.error('[cal] create_booking timeout')
    } else {
      console.error(`[cal] create_booking error: ${err.message}`)
    }
    return { success: false, error: 'Error técnico al crear la cita.' }
  }
}

// ─── get_user_booking ─────────────────────────────────────────────────────────

export async function getUserBooking({ phone, clientSlug }) {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('phone', phone)
    .eq('client_slug', clientSlug)
    .eq('status', 'confirmed')
    .order('start_time', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`[cal] get_user_booking supabase error: ${error.message}`)
    return { found: false, error: 'No pude consultar tus citas en este momento.' }
  }

  if (!data) return { found: false }

  return {
    found: true,
    bookingUid: data.booking_uid,
    startTime: data.start_time,
    status: data.status,
  }
}

// ─── cancel_booking ───────────────────────────────────────────────────────────

export async function cancelBooking({ apiKey, bookingUid, phone, clientSlug }) {
  if (!apiKey) {
    return { success: false, error: 'Cal no configurado para este cliente.' }
  }

  try {
    const res = await calFetch(apiKey, `/bookings/${bookingUid}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancellationReason: 'Cancelado por el cliente via WhatsApp' }),
    })

    const resText = await res.text()
    console.log(`[cal] cancel_booking status ${res.status}: ${resText}`)

    if (!res.ok) {
      return { success: false, error: 'No pude cancelar la cita. Inténtalo de nuevo.' }
    }

    await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('booking_uid', bookingUid)
      .eq('phone', phone)
      .eq('client_slug', clientSlug)

    return { success: true }
  } catch (err) {
    console.error(`[cal] cancel_booking error: ${err.message}`)
    return { success: false, error: 'Error técnico al cancelar la cita.' }
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const calToolReadSlots = {
  name: 'get_available_slots',
  description:
    'Consulta los próximos horarios disponibles para agendar una cita. ' +
    'Úsala cuando el usuario pregunte por disponibilidad, horarios o quiera reservar. ' +
    'Devuelve slots con su ISO string exacto — usa ese ISO en create_booking, nunca texto libre.',
  input_schema: {
    type: 'object',
    properties: {
      days_ahead: { type: 'number', description: 'Días hacia adelante a consultar (default: 7)' },
    },
    required: [],
  },
}

export const calToolCreateBooking = {
  name: 'create_booking',
  description:
    'Crea una cita en la agenda. Úsala SOLO cuando el usuario haya confirmado el horario ' +
    'Y haya proporcionado su nombre y email. ' +
    'IMPORTANTE: start_time debe ser COPIADO LITERALMENTE del campo "iso" devuelto por get_available_slots. ' +
    'Nunca construyas ni reformatees la fecha — copia el string exacto tal como vino, incluyendo la Z final.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nombre completo del cliente' },
      email: { type: 'string', description: 'Email del cliente para la confirmación' },
      start_time: {
        type: 'string',
        description:
          'ISO 8601 EXACTO del campo "iso" de get_available_slots. ' +
          'Ejemplo correcto: "2026-04-11T10:00:00.000Z". ' +
          'NUNCA reformatees ni reconstruyas esta fecha.',
      },
    },
    required: ['name', 'email', 'start_time'],
  },
}

export const calToolDetectBooking = {
  name: 'get_user_booking',
  description:
    'Comprueba si el usuario ya tiene una cita agendada. ' +
    'Úsala cuando el usuario pregunte por su cita, quiera cancelar, o mencione que ya tiene reserva.',
  input_schema: { type: 'object', properties: {}, required: [] },
}

export const calToolCancelBooking = {
  name: 'cancel_booking',
  description:
    'Cancela la cita activa del usuario. Úsala SOLO después de confirmar con get_user_booking ' +
    'que tiene cita y el usuario haya confirmado explícitamente que quiere cancelarla.',
  input_schema: {
    type: 'object',
    properties: {
      booking_uid: { type: 'string', description: 'UID de la cita a cancelar (viene de get_user_booking)' },
    },
    required: ['booking_uid'],
  },
}

export function buildCalTools(features = {}) {
  const tools = []
  if (features.cal_read_slots) tools.push(calToolReadSlots)
  if (features.cal_create_booking) tools.push(calToolCreateBooking)
  if (features.cal_detect_booking) tools.push(calToolDetectBooking)
  if (features.cal_cancel_booking) tools.push(calToolCancelBooking)
  return tools
}
