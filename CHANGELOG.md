# Changelog

## [1.2.0.0] — 2026-04-14

### Added
- **Memoria persistente — auto-aprendizaje supervisado** (`src/memory.js`): después de cada handoff, Claude analiza la conversación y propone una actualización concreta al system-prompt del cliente. Kenny aprueba o rechaza respondiendo "aprobar XXXXXX" / "rechazar XXXXXX" por WhatsApp al mismo número del bot.
- **Alertas de handoff enriquecidas** (`src/notify.js`): la alerta a Kenny ahora incluye los últimos 4 turnos del historial (role + content, truncados a 200 chars) en lugar de solo el último mensaje.
- **System-prompt overrides en Supabase** (`src/claude.js`, `src/supabase.js`): `loadSystemPrompt` consulta primero la tabla `system_prompt_overrides` con TTL de 5 min antes de leer el fichero de disco. Cuando Kenny aprueba una propuesta, el bot la carga sin redeploy.
- **`callClaudeRaw`** (`src/claude.js`): nuevo export para llamadas Claude sin tools ni historial, con `maxTokens` configurable. Usado por `memory.js` para análisis (512 tokens) e integración de propuestas (2048 tokens).
- **Nuevas tablas Supabase**: `memory_proposals` (propuestas con backup `previous_content` para rollback) y `system_prompt_overrides`.
- **Guard de doble-aprobación**: `handleKennyApproval` bloquea procesar una propuesta que ya no está en estado `pending`.
- **Sanity gate para base vacía**: `applyProposal` devuelve error explícito si no existe system-prompt base, en lugar de fallar silenciosamente.

### Changed
- **Guard de Kenny** en `webhook.js`: mensajes del número `KENNY_WHATSAPP` se enrutan a `handleKennyMessage` antes de cualquier procesamiento de cliente (fire-and-forget con `.catch(console.error)`).
- `analyzeHandoff` recibe `fullHistory` construido en el call site incluyendo el turn actual (`[...history, currentUser, currentBot]`).

### Fixed
- `sendKennyProposal` envuelto en try/catch dentro de `analyzeHandoff` — fallo de Twilio ya no rompe el contrato "nunca lanza".
- Check de respuesta "NADA" mejorado con regex `/^nada[.,!?\s]*$/i` para manejar variantes con puntuación.

## [1.1.0] — 2026-04-10

### Added
- **Stripe Phase 1:** Bot now sends the Stripe payment link when a user wants to sign up for a plan. Gated by `stripe_send_link` feature flag in client config.
- `buildIntegrationsBlock` exported from `claude.js` to enable unit testing.
- `STRIPE_LINK_{SLUG}` env var support in `config.js` — overrides YAML value per-client.
- Vitest test framework with 19 unit tests covering `buildIntegrationsBlock`, client config loading, and `alertKenny` alert types.
- GitHub Actions CI workflow (`test.yml`) running the full test suite on every push and PR.
- `tests/webhook.test.js` — integration tests for `verifyTwilioSignature` (dev bypass + production 403 paths).
- `TESTING.md` with testing conventions.
- `.env.example` updated to document `STRIPE_LINK_AUTANA`.

### Fixed
- `verifyTwilioSignature` in `webhook.js` — now correctly skips signature check in all development environments, regardless of whether `TWILIO_AUTH_TOKEN` is set. Previously, the dev bypass only activated when the token was absent.
- `buildIntegrationsBlock` — Stripe link now only injected when `stripe_send_link` feature flag is `true`. Before this fix, any client with a `stripe_link` in config would get the payment prompt regardless of their feature flags.

### Changed
- `system-prompt.md` — Stripe instruction updated to use the link when available (via "Integraciones disponibles") and fall back to [handoff] when not configured.

## [1.0.0] — 2026-04-08

Initial release. WhatsApp bot with:
- Claude AI (claude-sonnet-4-6) for conversation
- Twilio WhatsApp Sandbox integration
- Supabase for conversation history and session management
- Cal.com integration (get_available_slots, create_booking, get_user_booking, cancel_booking)
- Multi-client YAML config system
- Monthly conversation limits by plan
- LOPD compliance (first-message notice + data deletion)
- Handoff escalation to Kenny
