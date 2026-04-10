/**
 * notify.test.js — Tests de construcción de mensajes de alerta.
 *
 * alertKenny solo llama a Twilio si KENNY_WHATSAPP está definido.
 * Sin esa variable, podemos testear el comportamiento sin mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Aseguramos que KENNY_WHATSAPP no está set para evitar llamadas reales
delete process.env.KENNY_WHATSAPP

import { alertKenny } from '../src/notify.js'

describe('alertKenny: no lanza cuando KENNY_WHATSAPP no está configurado', () => {
  beforeEach(() => {
    delete process.env.KENNY_WHATSAPP
  })

  it('no lanza en tipo error', async () => {
    await expect(
      alertKenny({
        type: 'error',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'mensaje de prueba',
        error: new Error('timeout'),
      })
    ).resolves.toBeUndefined()
  })

  it('no lanza en tipo handoff', async () => {
    await expect(
      alertKenny({
        type: 'handoff',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'quiero hablar con alguien',
      })
    ).resolves.toBeUndefined()
  })

  it('no lanza en tipo limit_warning', async () => {
    await expect(
      alertKenny({
        type: 'limit_warning',
        clientSlug: 'autana',
        count: 240,
        limit: 300,
      })
    ).resolves.toBeUndefined()
  })

  it('no lanza en tipo limit_reached', async () => {
    await expect(
      alertKenny({
        type: 'limit_reached',
        clientSlug: 'autana',
        count: 300,
        limit: 300,
      })
    ).resolves.toBeUndefined()
  })
})
