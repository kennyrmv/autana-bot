/**
 * webhook.test.js — Tests para la lógica de verificación de firma Twilio.
 *
 * verifyTwilioSignature no está exportada, así que la testeamos
 * inyectando un request falso al webhook handler y verificando
 * que devuelva 403 o 200 según el entorno y la firma.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Guardamos el NODE_ENV original
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
})

describe('verifyTwilioSignature — comportamiento por entorno', () => {
  it('en desarrollo (NODE_ENV != production) siempre pasa sin importar la firma', async () => {
    process.env.NODE_ENV = 'development'

    // Importamos dinámicamente para respetar el env
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
    // Reset modules so webhook picks up new NODE_ENV
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
