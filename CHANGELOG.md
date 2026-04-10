# Changelog

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
