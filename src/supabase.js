/**
 * supabase.js — Historial de conversación por número de teléfono.
 *
 * Schema esperado (ejecutar en Supabase SQL editor):
 *
 * CREATE TABLE conversations (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   phone TEXT NOT NULL,
 *   client_slug TEXT NOT NULL,
 *   role TEXT NOT NULL,         -- 'user' | 'assistant'
 *   content TEXT NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT now(),
 *   ended_with_booking BOOLEAN DEFAULT false,
 *   ended_with_handoff BOOLEAN DEFAULT false,
 *   error_occurred BOOLEAN DEFAULT false
 * );
 * CREATE INDEX idx_conv_phone_client
 *   ON conversations(phone, client_slug, created_at DESC);
 *
 * -- TTL automático (ejecutar como cron job en Supabase o pg_cron):
 * DELETE FROM conversations WHERE created_at < now() - interval '90 days';
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const MAX_HISTORY_TURNS = 10 // máximo turns a enviar a Claude

/**
 * Recupera el historial reciente de una conversación.
 * Devuelve formato messages[] listo para Claude API.
 */
export async function getHistory(phone, clientSlug) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('phone', phone)
    .eq('client_slug', clientSlug)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_TURNS * 2) // *2 porque cada turn = user + assistant

  if (error) {
    console.error(`[supabase] getHistory error: ${error.message}`)
    return [] // degradación elegante: responde sin historial
  }

  // Supabase devuelve DESC, invertimos para orden cronológico
  return (data || []).reverse()
}

/**
 * Guarda un turn (user o assistant) en el historial.
 */
export async function saveMessage(phone, clientSlug, role, content, meta = {}) {
  const { error } = await supabase.from('conversations').insert({
    phone,
    client_slug: clientSlug,
    role,
    content,
    ended_with_booking: meta.endedWithBooking || false,
    ended_with_handoff: meta.endedWithHandoff || false,
    error_occurred: meta.errorOccurred || false,
  })

  if (error) {
    console.error(`[supabase] saveMessage error: ${error.message}`)
    // No relanzamos — perder un log no debe romper la conversación
  }
}

/**
 * Borra todos los mensajes de un número (derecho de supresión LOPD).
 * Llamado cuando el usuario escribe "borrar mis datos".
 */
export async function deleteUserData(phone, clientSlug) {
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('phone', phone)
    .eq('client_slug', clientSlug)

  if (error) {
    console.error(`[supabase] deleteUserData error: ${error.message}`)
    return false
  }
  return true
}
