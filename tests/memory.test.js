/**
 * memory.test.js — Tests del ciclo de auto-aprendizaje supervisado.
 *
 * Todos los módulos externos (Supabase, Twilio, Claude) se mockean.
 * No se hacen llamadas reales en ningún test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Mocks de módulos
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/claude.js', () => ({
  callClaudeRaw: vi.fn(),
}))

vi.mock('../src/supabase.js', () => ({
  getSystemPromptOverride: vi.fn(),
  setSystemPromptOverride: vi.fn(),
  insertMemoryProposal: vi.fn(),
  getProposalByShortId: vi.fn(),
  updateProposalStatus: vi.fn(),
  getRecentProposalTexts: vi.fn(),
}))

vi.mock('../src/notify.js', () => ({
  sendKennyProposal: vi.fn(),
  sendTwilioMessage: vi.fn(),
}))

// ─────────────────────────────────────────────────────────────────────────────
// Imports (después de los mocks)
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeHandoff, handleKennyApproval } from '../src/memory.js'
import { callClaudeRaw } from '../src/claude.js'
import {
  getSystemPromptOverride,
  setSystemPromptOverride,
  insertMemoryProposal,
  getProposalByShortId,
  updateProposalStatus,
  getRecentProposalTexts,
} from '../src/supabase.js'
import { sendKennyProposal, sendTwilioMessage } from '../src/notify.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const config = { client_slug: 'autana', business_name: 'Autana' }

const history = [
  { role: 'user', content: '¿Cuánto cuesta el plan básico?' },
  { role: 'assistant', content: 'Déjame pasarte con Kenny.' },
]

// ─────────────────────────────────────────────────────────────────────────────
// analyzeHandoff
// ─────────────────────────────────────────────────────────────────────────────

describe('analyzeHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.KENNY_WHATSAPP = '+34600000001'
    getRecentProposalTexts.mockResolvedValue([])
    insertMemoryProposal.mockResolvedValue({ id: 'abc123', short_id: 'a3f7c2' })
  })

  it('Claude responde "NADA" → no inserta, no envía nada', async () => {
    callClaudeRaw.mockResolvedValue('NADA')

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    expect(insertMemoryProposal).not.toHaveBeenCalled()
    expect(sendKennyProposal).not.toHaveBeenCalled()
  })

  it('Claude responde "nada" (minúsculas) → no inserta', async () => {
    callClaudeRaw.mockResolvedValue('nada')

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    expect(insertMemoryProposal).not.toHaveBeenCalled()
  })

  it('Claude devuelve propuesta → dedup check y luego inserta', async () => {
    callClaudeRaw.mockResolvedValue('El plan básico cuesta 49€/mes.')

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    expect(getRecentProposalTexts).toHaveBeenCalledWith('autana', 5)
    expect(insertMemoryProposal).toHaveBeenCalledOnce()
    expect(sendKennyProposal).toHaveBeenCalledOnce()
  })

  it('propuesta idéntica a una reciente → descartada sin insertar', async () => {
    callClaudeRaw.mockResolvedValue('El plan básico cuesta 49€/mes.')
    getRecentProposalTexts.mockResolvedValue(['El plan básico cuesta 49€/mes.'])

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    expect(insertMemoryProposal).not.toHaveBeenCalled()
    expect(sendKennyProposal).not.toHaveBeenCalled()
  })

  it('dedup es case-insensitive y trim-tolerante', async () => {
    callClaudeRaw.mockResolvedValue('  El Plan Básico cuesta 49€/mes.  ')
    getRecentProposalTexts.mockResolvedValue(['el plan básico cuesta 49€/mes.'])

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    expect(insertMemoryProposal).not.toHaveBeenCalled()
  })

  it('Claude API lanza → no crash, no inserción', async () => {
    callClaudeRaw.mockRejectedValue(new Error('timeout'))

    await expect(
      analyzeHandoff(config, history, '¿Cuánto cuesta?').catch(() => {})
    ).resolves.toBeUndefined()

    expect(insertMemoryProposal).not.toHaveBeenCalled()
  })

  it('sendKennyProposal incluye el shortId generado', async () => {
    callClaudeRaw.mockResolvedValue('El plan básico cuesta 49€/mes.')
    insertMemoryProposal.mockResolvedValue({ id: 'test-id', short_id: 'a3f7c2' })

    await analyzeHandoff(config, history, '¿Cuánto cuesta?')

    const call = sendKennyProposal.mock.calls[0][0]
    expect(call).toMatchObject({
      clientSlug: 'autana',
      proposal: 'El plan básico cuesta 49€/mes.',
    })
    expect(call.shortId).toMatch(/^[a-f0-9]{6}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// handleKennyApproval
// ─────────────────────────────────────────────────────────────────────────────

describe('handleKennyApproval', () => {
  const pendingProposal = {
    id: 'uuid-1234',
    client_slug: 'autana',
    proposal: 'El plan básico cuesta 49€/mes.',
    short_id: 'a3f7c2',
    status: 'pending',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.KENNY_WHATSAPP = '+34600000001'
    getProposalByShortId.mockResolvedValue(pendingProposal)
    getSystemPromptOverride.mockResolvedValue('Eres el asistente de Autana.')
    setSystemPromptOverride.mockResolvedValue()
    updateProposalStatus.mockResolvedValue()
    callClaudeRaw.mockResolvedValue('Eres el asistente de Autana.\nEl plan básico cuesta 49€/mes.')
  })

  it('shortId no encontrado → Kenny recibe mensaje de error', async () => {
    getProposalByShortId.mockResolvedValue(null)

    await handleKennyApproval('aprobar', 'aaaaaa')

    expect(sendTwilioMessage).toHaveBeenCalledOnce()
    const { text } = sendTwilioMessage.mock.calls[0][0]
    expect(text).toMatch(/No encontré ninguna propuesta/)
    expect(setSystemPromptOverride).not.toHaveBeenCalled()
  })

  it('rechazar → status rejected, Kenny recibe confirmación', async () => {
    await handleKennyApproval('rechazar', 'a3f7c2')

    expect(updateProposalStatus).toHaveBeenCalledWith('uuid-1234', 'rejected')
    const { text } = sendTwilioMessage.mock.calls[0][0]
    expect(text).toMatch(/Rechazado/)
    expect(setSystemPromptOverride).not.toHaveBeenCalled()
  })

  it('aprobar con override existente → applyProposal escribe nuevo override', async () => {
    const originalContent = 'Eres el asistente de Autana. ' + 'X'.repeat(100)
    getSystemPromptOverride.mockResolvedValue(originalContent)
    // Respuesta Claude: original + 1 línea nueva (bien dentro del límite 2x)
    callClaudeRaw.mockResolvedValue(originalContent + '\nEl plan básico cuesta 49€/mes.')

    await handleKennyApproval('aprobar', 'a3f7c2')

    expect(callClaudeRaw).toHaveBeenCalledOnce()
    expect(setSystemPromptOverride).toHaveBeenCalledWith(
      'autana',
      expect.stringContaining('Autana')
    )
    const { text } = sendTwilioMessage.mock.calls[0][0]
    expect(text).toMatch(/Aplicado/)
  })

  it('aprobar sin override → fallback a disco (no lanza)', async () => {
    getSystemPromptOverride.mockResolvedValue(null)
    // loadFromDisk fallback — el fichero existe en el repo
    callClaudeRaw.mockResolvedValue('prompt desde disco actualizado')

    await handleKennyApproval('aprobar', 'a3f7c2')

    expect(setSystemPromptOverride).toHaveBeenCalledWith('autana', 'prompt desde disco actualizado')
  })

  it('output de Claude > 2x original → marcado error, Kenny notificado, no escribe override', async () => {
    const shortOriginal = 'Eres el asistente de Autana. ' + 'A'.repeat(50) // ~79 chars
    getSystemPromptOverride.mockResolvedValue(shortOriginal)
    callClaudeRaw.mockResolvedValue('X'.repeat(shortOriginal.length * 3)) // 3x → clearly >2x

    await handleKennyApproval('aprobar', 'a3f7c2')

    expect(setSystemPromptOverride).not.toHaveBeenCalled()
    expect(updateProposalStatus).toHaveBeenCalledWith('uuid-1234', 'error')
    const { text } = sendTwilioMessage.mock.calls[0][0]
    expect(text).toMatch(/creció demasiado|No pude aplicar/)
  })

  it('Supabase falla en lookup → Kenny recibe aviso, no crash', async () => {
    getProposalByShortId.mockRejectedValue(new Error('DB connection failed'))

    await handleKennyApproval('aprobar', 'a3f7c2')

    expect(setSystemPromptOverride).not.toHaveBeenCalled()
    const { text } = sendTwilioMessage.mock.calls[0][0]
    expect(text).toMatch(/Error/)
  })
})
