/**
 * config.test.js — Tests de carga de configuración de clientes.
 *
 * config.js lee los YAML de clients/{slug}/config.yaml al arrancar.
 * No llama a ninguna API externa — solo fs + js-yaml.
 */
import { describe, it, expect } from 'vitest'
import { getConfigBySlug, getAllConfigs } from '../src/config.js'

describe('config: carga de clientes', () => {
  it('carga el cliente autana desde disco', () => {
    const config = getConfigBySlug('autana')
    expect(config).not.toBeNull()
    expect(config.client_slug).toBe('autana')
  })

  it('autana tiene los campos obligatorios del plan', () => {
    const config = getConfigBySlug('autana')
    expect(config.monthly_conversation_limit).toBe(300)
    expect(config.plan).toBe('esencial')
  })

  it('autana tiene stripe_send_link activado', () => {
    const config = getConfigBySlug('autana')
    expect(config.features.stripe_send_link).toBe(true)
    expect(config.features.stripe_payment).toBe(false)
  })

  it('autana tiene las features de Cal.com activas', () => {
    const config = getConfigBySlug('autana')
    expect(config.features.cal_read_slots).toBe(true)
    expect(config.features.cal_create_booking).toBe(true)
    expect(config.features.cal_detect_booking).toBe(true)
    expect(config.features.cal_cancel_booking).toBe(true)
  })

  it('devuelve null para un slug inexistente', () => {
    expect(getConfigBySlug('cliente-que-no-existe')).toBeNull()
  })

  it('getAllConfigs devuelve al menos un cliente', () => {
    const configs = getAllConfigs()
    expect(configs.length).toBeGreaterThan(0)
  })
})
