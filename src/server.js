/**
 * server.js — Punto de entrada del servidor Fastify.
 */

import 'dotenv/config'
import Fastify from 'fastify'
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

// Plugin para acceder al body raw (necesario para verificación HMAC)
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body, done) => {
    req.rawBody = body
    try {
      done(null, JSON.parse(body))
    } catch (err) {
      done(err)
    }
  }
)

// Health check — Railway lo usa para saber que el server está vivo
fastify.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

// Registrar webhook handler
registerWebhook(fastify)

// Arrancar
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Autana Bot escuchando en puerto ${PORT}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
