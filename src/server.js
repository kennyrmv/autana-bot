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

// Webhook
registerWebhook(fastify)

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Autana Bot escuchando en puerto ${PORT}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
