/**
 * sessions.js — Control de sesiones y límites de conversaciones por plan.
 *
 * Definición de "conversación": sesión de 24h.
 * Si el mismo número escribe después de 24h de inactividad → nueva sesión.
 * Cada sesión = 1 conversación a efectos del plan mensual.
 *
 * Schema (ejecutar en Supabase SQL editor):
 *
 * CREATE TABLE sessions (
 *   id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *   phone         TEXT        NOT NULL,
 *   client_slug   TEXT        NOT NULL,
 *   started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 *
 * CREATE INDEX idx_sessions_phone_client
 *   ON sessions(phone, client_slug, last_message_at DESC);
 * CREATE INDEX idx_sessions_client_month
 *   ON sessions(client_slug, started_at DESC);
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const SESSION_WINDOW_HOURS = 24

/**
 * Busca sesión activa (última actividad dentro de las 24h).
 * Devuelve el objeto sesión o null si no existe.
 */
export async function findActiveSession(phone, clientSlug) {
  const windowStart = new Date(
    Date.now() - SESSION_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString()

  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone', phone)
    .eq('client_slug', clientSlug)
    .gte('last_message_at', windowStart)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`[sessions] findActiveSession error: ${error.message}`)
    return null
  }

  return data // null si no hay sesión activa
}

/**
 * Actualiza last_message_at de una sesión existente.
 */
export async function touchSession(sessionId) {
  const { error } = await supabase
    .from('sessions')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) {
    console.error(`[sessions] touchSession error: ${error.message}`)
  }
}

/**
 * Crea una nueva sesión para el número + cliente.
 * Devuelve el objeto sesión o null si falla.
 */
export async function createSession(phone, clientSlug) {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ phone, client_slug: clientSlug })
    .select()
    .single()

  if (error) {
    console.error(`[sessions] createSession error: ${error.message}`)
    return null
  }

  return data
}

/**
 * Cuenta las sesiones del mes en curso para un cliente.
 * Devuelve el número (int) o null si hay error de BD.
 */
export async function getMonthlySessionCount(clientSlug) {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const { count, error } = await supabase
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .eq('client_slug', clientSlug)
    .gte('started_at', monthStart)

  if (error) {
    console.error(`[sessions] getMonthlySessionCount error: ${error.message}`)
    return null
  }

  return count
}
