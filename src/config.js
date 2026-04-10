/**
 * config.js — Carga y cachea la configuración de cada cliente.
 *
 * Routing: 360dialog envía el channel_id en cada webhook.
 * Aquí mapeamos channel_id → client_slug → config.yaml
 *
 * La config se carga en RAM al arrancar. Si editas un YAML,
 * reinicia el servidor (Railway hace esto automático en cada deploy).
 */

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENTS_DIR = join(__dirname, '..', 'clients')

// Map: channel_id (360dialog) → config object
const byChannelId = new Map()
// Map: slug → config object (para lookup por nombre)
const bySlug = new Map()

function loadClients() {
  const slugs = readdirSync(CLIENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  for (const slug of slugs) {
    const configPath = join(CLIENTS_DIR, slug, 'config.yaml')
    try {
      const raw = readFileSync(configPath, 'utf8')
      const config = yaml.load(raw)

      if (!config.channel_id) {
        console.warn(`[config] Cliente "${slug}" sin channel_id — omitido`)
        continue
      }

      // Inyectar la clave de Cal.com desde env vars (nunca en YAML)
      const calEnvKey = `CAL_API_KEY_${slug.toUpperCase().replace(/-/g, '_')}`
      config.cal_api_key = process.env[calEnvKey] || null

      // Stripe link — puede estar en YAML (es una URL pública) o sobreescribirse con env var
      const stripeLinkEnvKey = `STRIPE_LINK_${slug.toUpperCase().replace(/-/g, '_')}`
      config.stripe_link = process.env[stripeLinkEnvKey] || config.stripe_link || null

      byChannelId.set(config.channel_id, config)
      bySlug.set(slug, config)

      console.log(`[config] Cliente cargado: ${slug} (channel: ${config.channel_id})`)
    } catch (err) {
      console.error(`[config] Error cargando ${slug}: ${err.message}`)
    }
  }

  console.log(`[config] ${byChannelId.size} cliente(s) activo(s)`)
}

export function getConfigByChannelId(channelId) {
  return byChannelId.get(channelId) || null
}

export function getConfigBySlug(slug) {
  return bySlug.get(slug) || null
}

export function getAllConfigs() {
  return [...bySlug.values()]
}

// Cargar al importar el módulo
loadClients()
