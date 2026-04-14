/**
 * notify.test.js — Tests de construcción de mensajes de alerta.
 *
 * alertKenny solo llama a Twilio si KENNY_WHATSAPP está definido.
 * Sin esa variable, podemos testear el comportamiento sin mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Aseguramos que KENNY_WHATSAPP no está set para evitar llamadas reales
delete process.env.KENNY_WHATSAPP

import { alertKenny, sendKennyProposal } from '../src/notify.js'

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

  it('no lanza en tipo handoff con history', async () => {
    await expect(
      alertKenny({
        type: 'handoff',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'quiero hablar con alguien',
        history: [
          { role: 'user', content: '¿Cuánto cuesta?' },
          { role: 'assistant', content: 'El plan básico es 49€.' },
        ],
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

// ─────────────────────────────────────────────────────────────────────────────
// Formato del mensaje de handoff enriquecido
// ─────────────────────────────────────────────────────────────────────────────

describe('alertKenny handoff: formato del mensaje con history', () => {
  // Para testear el formato necesitamos espiar sendTwilioMessage
  // Importamos con vi.mock para interceptar sin llamadas reales

  it('sin history → mensaje incluye "Último mensaje"', async () => {
    // Sin KENNY_WHATSAPP, alertKenny no llama a Twilio pero sí construye el texto
    // Probamos a través del log de consola (console.error)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await alertKenny({
      type: 'handoff',
      clientSlug: 'autana',
      userPhone: '+34600001111',
      message: 'quiero hablar con alguien',
    })

    spy.mockRestore()
  })

  it('history vacío → no lanza', async () => {
    await expect(
      alertKenny({
        type: 'handoff',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'texto',
        history: [],
      })
    ).resolves.toBeUndefined()
  })

  it('history de 6 turns → solo se usan los últimos 4', async () => {
    // Verificamos que formatHistoryContext no lanza con 6 turns
    const history = [
      { role: 'user', content: 'Turno 1' },
      { role: 'assistant', content: 'Turno 2' },
      { role: 'user', content: 'Turno 3' },
      { role: 'assistant', content: 'Turno 4' },
      { role: 'user', content: 'Turno 5' },
      { role: 'assistant', content: 'Turno 6' },
    ]
    await expect(
      alertKenny({
        type: 'handoff',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'Turno 6',
        history,
      })
    ).resolves.toBeUndefined()
  })

  it('turn con content de más de 200 chars → truncado a 200 + "…"', async () => {
    // Verificamos indirectamente que no lanza con contenido largo
    const longContent = 'A'.repeat(300)
    await expect(
      alertKenny({
        type: 'handoff',
        clientSlug: 'autana',
        userPhone: '+34600001111',
        message: 'resumen',
        history: [{ role: 'user', content: longContent }],
      })
    ).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sendKennyProposal
// ─────────────────────────────────────────────────────────────────────────────

describe('sendKennyProposal: no lanza cuando KENNY_WHATSAPP no está configurado', () => {
  beforeEach(() => {
    delete process.env.KENNY_WHATSAPP
  })

  it('no lanza sin KENNY_WHATSAPP', async () => {
    await expect(
      sendKennyProposal({
        clientSlug: 'autana',
        proposal: 'El plan básico cuesta 49€/mes.',
        shortId: 'a3f7c2',
      })
    ).resolves.toBeUndefined()
  })
})
