/**
 * claude.test.js — Tests unitarios para lógica pura de claude.js
 *
 * buildIntegrationsBlock construye el bloque de texto que se inyecta
 * en el system prompt para describir las integraciones disponibles.
 * Es lógica pura (sin API calls): string-in, string-out.
 */
import { describe, it, expect } from 'vitest'
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
    // No debe mandar el link cuando hay herramienta activa
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
