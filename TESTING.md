# Testing

100% test coverage is the goal — tests make vibe coding safe. Without them, every deploy is a gamble. With them, it's a superpower.

## Framework

[Vitest](https://vitest.dev/) v4.x — fast, ESM-native, zero config for Node projects.

## Run tests

```bash
npm test               # run all tests once
npx vitest             # watch mode (re-runs on save)
npx vitest --coverage  # coverage report
```

## Test layers

### Unit tests (`tests/`)

Test pure logic and module behavior in isolation. No network, no real DB.

| File | What it tests |
|------|--------------|
| `tests/claude.test.js` | `buildIntegrationsBlock`, `loadSystemPrompt` (Supabase override + TTL cache + disk fallback), `callClaudeRaw` |
| `tests/config.test.js` | YAML config loading, feature flags, plan limits |
| `tests/notify.test.js` | `alertKenny` (all types including enriched handoff with history), `sendKennyProposal` |
| `tests/memory.test.js` | `analyzeHandoff` (NADA detection, dedup, error absorption), `handleKennyApproval` (approve/reject/double-apply guard/sanity gate) |
| `tests/webhook.test.js` | Twilio signature verification, Kenny guard routing, regex parsing |

### Integration / E2E (future)

Planned once a dev server is available in CI:
- Full webhook flow via HTTP (Twilio → Claude → Supabase → response)
- Cal.com booking round-trip
- Stripe link delivery

## Conventions

- Test files: `tests/*.test.js`
- Import from `'vitest'` — no globals
- Env stubs in `tests/setup.js` (loaded via vitest setupFiles)
- Mock external APIs; test real logic
- Name tests in Spanish to match the codebase language

## Expectations

- When writing a new function, write a test for it
- When fixing a bug, write a regression test first
- When adding a conditional branch, test both paths
- When adding a new feature flag, test that the flag gates the feature correctly
- Never commit code that makes existing tests fail
