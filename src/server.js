/**
 * server.js — Punto de entrada del servidor Fastify.
 */

import 'dotenv/config'
import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import { registerWebhook } from './webhook.js'

const PORT = parseInt(process.env.PORT || '3000', 10)

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  },
})

// Parsear application/x-www-form-urlencoded (formato de Twilio)
await fastify.register(formbody)

// Health check
fastify.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

// Diagnóstico — prueba la conexión con Claude API
fastify.get('/debug/claude', async (request, reply) => {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  try {
    const r = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Di solo: ok' }]
    })
    return { ok: true, response: r.content[0].text, model: r.model }
  } catch (e) {
    return reply.status(500).send({ ok: false, error: e.message, status: e.status })
  }
})

// Webhook
registerWebhook(fastify)

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Autana Bot escuchando en puerto ${PORT}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
