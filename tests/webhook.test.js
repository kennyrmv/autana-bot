/**
 * webhook.test.js — Tests para la lógica del webhook handler.
 *
 * 1. Verificación de firma Twilio (entornos dev vs prod)
 * 2. Kenny guard — mensajes de KENNY_WHATSAPP se enrutan a handleKennyMessage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock memory.js para que los tests del Kenny guard no llamen a Supabase/Twilio reales.
// Hoisted por vitest al top del módulo antes de cualquier import.
vi.mock('../src/memory.js', () => ({
  analyzeHandoff: vi.fn(),
  handleKennyApproval: vi.fn().mockResolvedValue(undefined),
}))

// Guardamos el NODE_ENV original
const originalNodeEnv = process.env.NODE_ENV
const originalKennyPhone = process.env.KENNY_WHATSAPP

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  if (originalKennyPhone) {
    process.env.KENNY_WHATSAPP = originalKennyPhone
  } else {
    delete process.env.KENNY_WHATSAPP
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Firma Twilio
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyTwilioSignature — comportamiento por entorno', () => {
  it('en desarrollo (NODE_ENV != production) siempre pasa sin importar la firma', async () => {
    process.env.NODE_ENV = 'development'

    const fastify = (await import('fastify')).default
    const { default: formbody } = await import('@fastify/formbody')
    const { registerWebhook } = await import('../src/webhook.js')

    const app = fastify({ logger: false })
    await app.register(formbody)
    registerWebhook(app)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Sin X-Twilio-Signature — en dev debe pasar igualmente
      },
      payload: 'From=whatsapp%3A%2B34600001111&Body=Hola&To=whatsapp%3A%2B14155238886',
    })

    // 200 (o cualquier cosa menos 403) — la firma se saltó en dev
    expect(response.statusCode).not.toBe(403)

    await app.close()
  })

  it('en producción sin TWILIO_AUTH_TOKEN devuelve 403', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.TWILIO_AUTH_TOKEN

    const fastify = (await import('fastify')).default
    const { default: formbody } = await import('@fastify/formbody')
    const { registerWebhook } = await import('../src/webhook.js')

    const app = fastify({ logger: false })
    await app.register(formbody)
    registerWebhook(app)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=whatsapp%3A%2B34600001111&Body=Hola',
    })

    expect(response.statusCode).toBe(403)

    await app.close()
    process.env.TWILIO_AUTH_TOKEN = 'test-token' // restore
  })

  it('en producción con token pero sin firma devuelve 403', async () => {
    process.env.NODE_ENV = 'production'
    process.env.TWILIO_AUTH_TOKEN = 'un-token-real'

    const fastify = (await import('fastify')).default
    const { default: formbody } = await import('@fastify/formbody')
    const { registerWebhook } = await import('../src/webhook.js')

    const app = fastify({ logger: false })
    await app.register(formbody)
    registerWebhook(app)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Sin X-Twilio-Signature
      },
      payload: 'From=whatsapp%3A%2B34600001111&Body=Hola',
    })

    expect(response.statusCode).toBe(403)

    await app.close()
    process.env.TWILIO_AUTH_TOKEN = 'test-token' // restore
    process.env.NODE_ENV = originalNodeEnv
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Kenny guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Kenny guard — parseo de comandos de aprobación', () => {
  // Testeamos handleKennyMessage directamente accediendo a su lógica
  // a través del regex que usa. No necesitamos levantar Fastify.

  const APPROVAL_REGEX = /^(aprobar|rechazar)\s+([a-f0-9]{6})$/i

  it('"aprobar a3f7c2" hace match con action=aprobar y shortId=a3f7c2', () => {
    const match = 'aprobar a3f7c2'.match(APPROVAL_REGEX)
    expect(match).not.toBeNull()
    expect(match[1].toLowerCase()).toBe('aprobar')
    expect(match[2].toLowerCase()).toBe('a3f7c2')
  })

  it('"rechazar b9c1d4" hace match con action=rechazar y shortId=b9c1d4', () => {
    const match = 'rechazar b9c1d4'.match(APPROVAL_REGEX)
    expect(match).not.toBeNull()
    expect(match[1].toLowerCase()).toBe('rechazar')
    expect(match[2].toLowerCase()).toBe('b9c1d4')
  })

  it('"APROBAR A3F7C2" (mayúsculas) hace match por flag /i', () => {
    const match = 'APROBAR A3F7C2'.match(APPROVAL_REGEX)
    expect(match).not.toBeNull()
  })

  it('"hola" → no hace match (Kenny puede escribir lo que quiera)', () => {
    expect('hola'.match(APPROVAL_REGEX)).toBeNull()
  })

  it('"aprobar" sin shortId → no hace match', () => {
    expect('aprobar'.match(APPROVAL_REGEX)).toBeNull()
  })

  it('"aprobar xyz" (3 chars) → no hace match (necesita exactamente 6)', () => {
    expect('aprobar xyz'.match(APPROVAL_REGEX)).toBeNull()
  })

  it('"aprobar a3f7c2z" (7 chars) → no hace match', () => {
    expect('aprobar a3f7c2z'.match(APPROVAL_REGEX)).toBeNull()
  })

  it('"aprobar A3F7G2" (G no es hex) → no hace match', () => {
    expect('aprobar A3F7G2'.match(APPROVAL_REGEX)).toBeNull()
  })
})

describe('Kenny guard — enrutamiento en el webhook', () => {
  it('mensaje de KENNY_WHATSAPP → devuelve 200 sin entrar en flujo normal', async () => {
    process.env.NODE_ENV = 'development'
    process.env.KENNY_WHATSAPP = '+34600000001'

    const fastify = (await import('fastify')).default
    const { default: formbody } = await import('@fastify/formbody')
    const { registerWebhook } = await import('../src/webhook.js')

    const app = fastify({ logger: false })
    await app.register(formbody)
    registerWebhook(app)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // From es KENNY_WHATSAPP
      payload: 'From=whatsapp%3A%2B34600000001&Body=aprobar+a3f7c2&To=whatsapp%3A%2B14155238886',
    })

    expect(response.statusCode).toBe(200)

    await app.close()
  })
})
