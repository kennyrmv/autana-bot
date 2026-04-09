/**
 * cal.js — Integración con Cal.com API.
 *
 * Tools disponibles (se activan por feature flags en config.yaml):
 *
 *   cal_read_slots     → get_available_slots   (ya existía)
 *   cal_create_booking → create_booking        (nuevo)
 *   cal_detect_booking → get_user_booking      (nuevo)
 *   cal_cancel_booking → cancel_booking        (nuevo)
 *
 * Timezone: siempre Europe/Madrid (SMBs en España).
 * start_time en create_booking debe ser un valor ISO exacto
 * devuelto por get_available_slots — nunca texto libre.
 */

import { createClient } from '@supabase/supabase-js'

const CAL_API_BASE = 'https://api.cal.com/v1'
const TIMEOUT_MS = 5000
const TIMEZONE = 'Europe/Madrid'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── Fallbacks ────────────────────────────────────────────────────────────────

const FALLBACK_SLOTS = {
  available: false,
  fallback: true,
  message: 'No pude consultar la agenda en este momento.',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildUrl(path, apiKey, params = {}) {
  const url = new URL(`${CAL_API_BASE}${path}`)
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

async function calFetch(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
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

/**
 * Devuelve los próximos slots disponibles formateados para Claude.
 * También devuelve raw ISO strings para que create_booking los use directamente.
 */
export async function getAvailableSlots(apiKey, eventTypeId, daysAhead = 7) {
  if (!apiKey || !eventTypeId) return FALLBACK_SLOTS

  const startTime = new Date().toISOString()
  const endTime = new Date(Date.now() + daysAhead * 86400000).toISOString()

  const url = buildUrl('/slots', apiKey, { eventTypeId, startTime, endTime })

  try {
    const res = await calFetch(url)
    if (!res.ok) {
      console.error(`[cal] get_available_slots error: ${res.status}`)
      return FALLBACK_SLOTS
    }

    const data = await res.json()
    const slots = data.slots || {}

    const formatted = []
    const rawSlots = [] // ISO strings exactos para create_booking

    for (const [date, daySlots] of Object.entries(slots).slice(0, 4)) {
      const times = daySlots.slice(0, 4).map(s => {
        rawSlots.push(s.time) // guardamos el ISO exacto
        const d = new Date(s.time)
        return {
          iso: s.time,
          display: d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        }
      })

      if (times.length > 0) {
        const dateStr = new Date(date).toLocaleDateString('es-ES', {
          weekday: 'long', day: 'numeric', month: 'long',
        })
        formatted.push({
          date: dateStr,
          slots: times,
        })
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

/**
 * Crea una cita en Cal.com y guarda el booking_uid en Supabase.
 * start_time debe ser un ISO string exacto de get_available_slots.
 */
export async function createBooking({ apiKey, eventTypeId, phone, clientSlug, name, email, startTime }) {
  if (!apiKey || !eventTypeId) {
    return { success: false, error: 'Cal no configurado para este cliente.' }
  }

  const url = buildUrl('/bookings', apiKey)

  const body = {
    eventTypeId: Number(eventTypeId),
    start: startTime,
    timeZone: TIMEZONE,
    responses: {
      name,
      email,
      location: { optionValue: '', value: 'inPerson' },
    },
    metadata: { source: 'autana-bot' },
    language: 'es',
  }

  try {
    const res = await calFetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (res.status === 409) {
      return {
        success: false,
        conflict: true,
        error: 'Ese horario acaba de ocuparse. Elige otro.',
      }
    }

    if (!res.ok) {
      const errBody = await res.text()
      console.error(`[cal] create_booking error ${res.status}: ${errBody}`)
      return { success: false, error: 'No pude crear la cita. Inténtalo de nuevo.' }
    }

    const data = await res.json()
    const bookingUid = data.uid

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
      // No fallamos — la cita está creada en Cal aunque no se guardara en Supabase
    }

    return {
      success: true,
      bookingUid,
      startTime,
      attendeeName: name,
      attendeeEmail: email,
    }
  } catch (err) {
    console.error(`[cal] create_booking error: ${err.message}`)
    return { success: false, error: 'Error técnico al crear la cita.' }
  }
}

// ─── get_user_booking ─────────────────────────────────────────────────────────

/**
 * Busca si el usuario (phone) tiene cita activa.
 * Primero busca en Supabase. Si hay UID, verifica estado real en Cal.
 * Si no hay UID en Supabase (reservó directo en Cal), devuelve not_found.
 */
export async function getUserBooking({ phone, clientSlug }) {
  // 1. Buscar en Supabase la cita confirmada más próxima
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

  if (!data) {
    return { found: false }
  }

  return {
    found: true,
    bookingUid: data.booking_uid,
    startTime: data.start_time,
    status: data.status,
  }
}

// ─── cancel_booking ───────────────────────────────────────────────────────────

/**
 * Cancela una cita en Cal.com y actualiza estado en Supabase.
 * Si Cal cancela pero Supabase falla, se reconcilia en el próximo get_user_booking.
 */
export async function cancelBooking({ apiKey, bookingUid, phone, clientSlug }) {
  if (!apiKey) {
    return { success: false, error: 'Cal no configurado para este cliente.' }
  }

  const url = buildUrl(`/bookings/${bookingUid}/cancel`, apiKey)

  try {
    const res = await calFetch(url, { method: 'DELETE' })

    if (res.status === 404) {
      // Ya estaba cancelada — reconciliamos Supabase
      await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('booking_uid', bookingUid)
      return { success: true, alreadyCancelled: true }
    }

    if (!res.ok) {
      console.error(`[cal] cancel_booking error: ${res.status}`)
      return { success: false, error: 'No pude cancelar la cita. Inténtalo de nuevo.' }
    }

    // Actualizar Supabase
    const { error: dbErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('booking_uid', bookingUid)
      .eq('phone', phone)
      .eq('client_slug', clientSlug)

    if (dbErr) {
      console.error(`[cal] cancel_booking supabase error: ${dbErr.message}`)
      // No fallamos — la cancelación en Cal fue exitosa
    }

    return { success: true }
  } catch (err) {
    console.error(`[cal] cancel_booking error: ${err.message}`)
    return { success: false, error: 'Error técnico al cancelar la cita.' }
  }
}

// ─── Tool definitions para Claude API ────────────────────────────────────────

export const calToolReadSlots = {
  name: 'get_available_slots',
  description:
    'Consulta los próximos horarios disponibles para agendar una cita. ' +
    'Úsala cuando el usuario pregunte por disponibilidad, horarios o quiera reservar. ' +
    'Devuelve slots con su ISO string exacto — usa ese ISO en create_booking, nunca texto libre.',
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

export const calToolCreateBooking = {
  name: 'create_booking',
  description:
    'Crea una cita en la agenda. Úsala SOLO cuando el usuario haya confirmado explícitamente ' +
    'el horario exacto Y haya proporcionado su nombre y email. ' +
    'start_time debe ser un ISO string exacto devuelto por get_available_slots.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nombre completo del cliente' },
      email: { type: 'string', description: 'Email del cliente para la confirmación' },
      start_time: {
        type: 'string',
        description: 'ISO 8601 exacto del slot elegido (viene de get_available_slots)',
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
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
}

export const calToolCancelBooking = {
  name: 'cancel_booking',
  description:
    'Cancela la cita activa del usuario. Úsala SOLO después de confirmar con get_user_booking ' +
    'que tiene una cita y el usuario haya confirmado explícitamente que quiere cancelarla.',
  input_schema: {
    type: 'object',
    properties: {
      booking_uid: {
        type: 'string',
        description: 'UID de la cita a cancelar (viene de get_user_booking)',
      },
    },
    required: ['booking_uid'],
  },
}

/**
 * Devuelve el array de tools activas según los feature flags del cliente.
 */
export function buildCalTools(features = {}) {
  const tools = []
  if (features.cal_read_slots) tools.push(calToolReadSlots)
  if (features.cal_create_booking) tools.push(calToolCreateBooking)
  if (features.cal_detect_booking) tools.push(calToolDetectBooking)
  if (features.cal_cancel_booking) tools.push(calToolCancelBooking)
  return tools
}
