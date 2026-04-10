/**
 * setup.js — Env vars mínimas para que los módulos carguen en tests.
 *
 * Supabase, Twilio, y Anthropic crean clientes a nivel de módulo.
 * Sin estas variables, el import lanza. Los tests unitarios que
 * prueban lógica pura no necesitan valores reales.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key'
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest'
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-token'
