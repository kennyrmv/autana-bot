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
  const [convResult, bookingsResult] = await Promise.all([
    supabase.from('conversations').delete().eq('phone', phone).eq('client_slug', clientSlug),
    supabase.from('bookings').delete().eq('phone', phone).eq('client_slug', clientSlug),
  ])

  if (convResult.error) {
    console.error(`[supabase] deleteUserData conversations error: ${convResult.error.message}`)
  }
  if (bookingsResult.error) {
    console.error(`[supabase] deleteUserData bookings error: ${bookingsResult.error.message}`)
  }

  return !convResult.error && !bookingsResult.error
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt overrides — memoria persistente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lee el override del system-prompt para un cliente.
 * Devuelve el contenido como string, o null si no existe override.
 */
export async function getSystemPromptOverride(clientSlug) {
  const { data, error } = await supabase
    .from('system_prompt_overrides')
    .select('content')
    .eq('client_slug', clientSlug)
    .maybeSingle()

  if (error) throw new Error(`[supabase] getSystemPromptOverride: ${error.message}`)
  return data?.content ?? null
}

/**
 * Guarda (o actualiza) el override del system-prompt para un cliente.
 */
export async function setSystemPromptOverride(clientSlug, content) {
  const { error } = await supabase
    .from('system_prompt_overrides')
    .upsert(
      { client_slug: clientSlug, content, updated_at: new Date().toISOString() },
      { onConflict: 'client_slug' }
    )

  if (error) throw new Error(`[supabase] setSystemPromptOverride: ${error.message}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory proposals — ciclo de aprendizaje supervisado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inserta una propuesta de mejora pendiente de aprobación.
 * Devuelve el row insertado (incluye id y short_id).
 */
export async function insertMemoryProposal({ clientSlug, proposal, triggerMessage, shortId }) {
  const { data, error } = await supabase
    .from('memory_proposals')
    .insert({
      short_id: shortId,
      client_slug: clientSlug,
      proposal,
      trigger_message: triggerMessage,
      status: 'pending',
    })
    .select()
    .single()

  if (error) throw new Error(`[supabase] insertMemoryProposal: ${error.message}`)
  return data
}

/**
 * Busca una propuesta por su short_id (6 chars hex).
 * Devuelve el row o null si no existe.
 */
export async function getProposalByShortId(shortId) {
  const { data, error } = await supabase
    .from('memory_proposals')
    .select('*')
    .eq('short_id', shortId)
    .maybeSingle()

  if (error) throw new Error(`[supabase] getProposalByShortId: ${error.message}`)
  return data ?? null
}

/**
 * Actualiza el estado de una propuesta.
 * status: 'approved' | 'rejected' | 'error'
 * extra: campos adicionales opcionales (applied_at, previous_content)
 */
export async function updateProposalStatus(id, status, extra = {}) {
  const { error } = await supabase
    .from('memory_proposals')
    .update({ status, ...extra })
    .eq('id', id)

  if (error) throw new Error(`[supabase] updateProposalStatus: ${error.message}`)
}

/**
 * Devuelve los últimos N textos de propuestas para un cliente (para deduplicación).
 */
export async function getRecentProposalTexts(clientSlug, limit = 5) {
  const { data, error } = await supabase
    .from('memory_proposals')
    .select('proposal')
    .eq('client_slug', clientSlug)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error(`[supabase] getRecentProposalTexts error: ${error.message}`)
    return []
  }
  return (data || []).map(r => r.proposal)
}
