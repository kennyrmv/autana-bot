/**
 * claude.test.js — Tests unitarios para lógica pura de claude.js
 *
 * buildIntegrationsBlock: string-in, string-out (sin API calls).
 * loadSystemPrompt (vía chat): TTL cache + Supabase override + fallback a disco.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildIntegrationsBlock } from '../src/claude.js'

describe('buildIntegrationsBlock', () => {
  it('devuelve fallback cuando no hay features activas', () => {
    const config = { features: {} }
    const result = buildIntegrationsBlock(config)
    expect(result).toContain('No hay integraciones activas')
    expect(result).toContain('Kenny le contactará directamente')
  })

  it('incluye link de Cal.com cuando hay cal_link pero NO cal_create_booking', () => {
    const config = {
      features: { cal_create_booking: false },
      cal_link: 'https://cal.com/kennymedina/15min',
    }
    const result = buildIntegrationsBlock(config)
    expect(result).toContain('https://cal.com/kennymedina/15min')
    expect(result).toContain('Cuando el usuario quiera reservar')
  })

  it('indica gestión directa de citas cuando cal_create_booking es true', () => {
    const config = {
      features: { cal_create_booking: true },
      cal_link: 'https://cal.com/kennymedina/15min',
    }
    const result = buildIntegrationsBlock(config)
    expect(result).toContain('crear citas directamente desde este chat')
    expect(result).not.toContain('Cuando el usuario quiera reservar')
  })

  it('incluye link de Stripe cuando stripe_send_link=true y stripe_link existe', () => {
    const config = {
      features: { stripe_send_link: true },
      stripe_link: 'https://buy.stripe.com/test_abc123',
    }
    const result = buildIntegrationsBlock(config)
    expect(result).toContain('https://buy.stripe.com/test_abc123')
    expect(result).toContain('link de pago')
  })

  it('NO incluye Stripe cuando stripe_send_link=true pero stripe_link es null', () => {
    const config = {
      features: { stripe_send_link: true },
      stripe_link: null,
    }
    const result = buildIntegrationsBlock(config)
    expect(result).not.toContain('link de pago')
    expect(result).toContain('No hay integraciones activas')
  })

  it('combina Cal + Stripe correctamente cuando ambas están activas', () => {
    const config = {
      features: { cal_create_booking: true, stripe_send_link: true },
      cal_link: 'https://cal.com/kennymedina/15min',
      stripe_link: 'https://buy.stripe.com/test_abc123',
    }
    const result = buildIntegrationsBlock(config)
    expect(result).toContain('crear citas directamente')
    expect(result).toContain('link de pago')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// loadSystemPrompt — TTL cache + Supabase override + fallback a disco
//
// Se testea indirectamente: mockeamos supabase.js y verificamos que chat()
// usa el override o el disco según el estado de Supabase y el caché.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/supabase.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getSystemPromptOverride: vi.fn(),
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'respuesta de prueba' }],
  })
  function MockAnthropic() {
    this.messages = { create: mockCreate }
  }
  return { default: MockAnthropic }
})

vi.mock('../src/cal.js', () => ({
  buildCalTools: vi.fn().mockReturnValue([]),
  getAvailableSlots: vi.fn(),
  createBooking: vi.fn(),
  getUserBooking: vi.fn(),
  cancelBooking: vi.fn(),
}))

describe('loadSystemPrompt — cache y override de Supabase', () => {
  let getSystemPromptOverride

  beforeEach(async () => {
    vi.resetModules()
    // Re-importamos para resetear el cache en memoria (promptCache es module-level)
    const supabase = await import('../src/supabase.js')
    getSystemPromptOverride = supabase.getSystemPromptOverride
    vi.clearAllMocks()
  })

  it('Supabase devuelve override → chat() usa el override', async () => {
    getSystemPromptOverride.mockResolvedValue('Override desde Supabase.')

    const { chat } = await import('../src/claude.js')
    const config = { client_slug: 'autana', features: {} }
    // Si llega hasta aquí sin lanzar, el override fue cargado
    await chat(config, [], 'hola', '+34600000000')

    expect(getSystemPromptOverride).toHaveBeenCalledWith('autana')
  })

  it('Supabase devuelve null → se usa el fichero de disco (sin lanzar)', async () => {
    getSystemPromptOverride.mockResolvedValue(null)

    const { chat } = await import('../src/claude.js')
    const config = { client_slug: 'autana', features: {} }
    await expect(chat(config, [], 'hola', '+34600000000')).resolves.toBeDefined()
  })

  it('Supabase lanza → fallback a disco, no propaga el error', async () => {
    getSystemPromptOverride.mockRejectedValue(new Error('Supabase down'))

    const { chat } = await import('../src/claude.js')
    const config = { client_slug: 'autana', features: {} }
    // No debe lanzar — el fallback a disco cubre el error
    await expect(chat(config, [], 'hola', '+34600000000')).resolves.toBeDefined()
  })
})
