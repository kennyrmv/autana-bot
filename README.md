# Autana Bot

Asistente de WhatsApp con IA para negocios de servicios. Multi-cliente, con agendado, pagos, escalado inteligente y auto-aprendizaje supervisado.

**Stack:** Node.js 22 · Fastify · Claude API (`claude-sonnet-4-6`) · Supabase · Twilio WhatsApp · Cal.com · Railway

---

## Qué hace

1. **Atiende mensajes de WhatsApp** vía Twilio, resolviendo dudas con el contexto del negocio
2. **Agenda citas** directamente en Cal.com (consulta disponibilidad, crea, cancela)
3. **Envía links de pago** de Stripe cuando el usuario está listo para contratar
4. **Escala a Kenny** (o al dueño del negocio) con contexto cuando el bot no puede resolver
5. **Aprende de los escalados** — propone mejoras al system-prompt que Kenny puede aprobar por WhatsApp
6. **Gestiona sesiones y cuotas** por plan mensual (esencial / conversión / custom)
7. **Cumple con LOPD** — aviso en primer mensaje, supresión de datos a petición

---

## Arquitectura

```
Twilio WhatsApp
      │
      ▼
  POST /webhook  (Fastify)
      │
      ├── Verifica firma Twilio
      ├── Carga config del cliente (YAML)
      ├── Gestión de sesión 24h + límite mensual
      ├── Aviso LOPD (primer mensaje)
      ├── Guard Kenny (aprobación de mejoras de memoria)
      │
      ▼
  Claude API  ──► Tools: Cal.com, Stripe
      │
      ├── Guarda historial en Supabase
      ├── Detecta [handoff] → alerta Kenny
      │
      └── Si handoff: analyzeHandoff() → propuesta de mejora → aprobación Kenny
                                                                      │
                                                        Supabase (system-prompt override, TTL 5 min)
```

---

## Estructura del proyecto

```
autana-bot/
├── src/
│   ├── server.js          # Servidor Fastify, health check
│   ├── webhook.js         # Handler principal del webhook de Twilio
│   ├── claude.js          # Wrapper de Claude API con retry y tools
│   ├── cal.js             # Integración Cal.com v2 (slots, bookings)
│   ├── sessions.js        # Sesiones 24h y cuotas mensuales
│   ├── memory.js          # Auto-aprendizaje supervisado
│   ├── notify.js          # Envío de mensajes y alertas a Kenny
│   ├── supabase.js        # Historial de conversaciones y DB
│   └── config.js          # Carga de configs YAML por cliente
├── clients/
│   ├── autana/            # Config + system-prompt de Autana
│   └── joyeria-esposa/    # Config + system-prompt de caso demo
├── tests/                 # Vitest — unit tests
├── CLAUDE.md              # Instrucciones para el AI assistant
├── TESTING.md             # Convenciones de testing
├── CHANGELOG.md           # Historial de versiones
└── playbooks/
    └── deploy-new-client.md
```

---

## Config por cliente

Cada cliente vive en `clients/{slug}/` con dos archivos:

**`config.yaml`** — Feature flags, cuotas, integraciones:
```yaml
client_slug: "autana"
business_name: "Autana"
channel_id: "1234567890"           # Routing en producción (360dialog)
cal_event_type_id: "5299248"
stripe_link: "https://buy.stripe.com/..."
handoff_phone: "+34600000000"
plan: "esencial"                   # esencial | conversion | custom
monthly_conversation_limit: 300
features:
  cal_read_slots: true
  cal_create_booking: true
  cal_cancel_booking: true
  stripe_send_link: true
```

**`system-prompt.md`** — Personalidad e instrucciones del bot (con variables `{{cal_link}}`, `{{stripe_link}}`, etc.)

---

## Planes y cuotas

| Plan             | Conversaciones/mes |
|------------------|--------------------|
| Bot Esencial     | 300                |
| Bot Conversión   | 800                |
| Custom           | Sin límite         |

Una conversación = una sesión de 24h. Kenny recibe alertas al llegar al 80% y al 100%.

---

## Sistema de auto-aprendizaje (v1.2.0)

Cuando el bot escala a un humano (`[handoff]`):

1. `analyzeHandoff()` analiza la conversación con Claude y propone una mejora al system-prompt
2. Se envía la propuesta a Kenny por WhatsApp con un código de 6 caracteres
3. Kenny responde `aprobar XXXXXX` o `rechazar XXXXXX`
4. Si se aprueba, el system-prompt override se guarda en Supabase (cache TTL 5 min)
5. El bot mejora sin necesidad de redeploy

---

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Variables de entorno (copiar y rellenar)
cp .env.example .env

# Servidor con hot reload
npm run dev

# Tests
npm test
```

### Variables de entorno necesarias

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=
SANDBOX_CLIENT_SLUG=autana       # Solo en modo sandbox
```

---

## Deploy

Railway auto-deploya al hacer push a `main`. No hay pasos manuales.

```bash
git push origin main   # → Railway detecta el push y despliega
```

**Health check:** `GET /health` → `{ status: "ok" }`

---

## Pendientes

- Migrar de Twilio sandbox a **360dialog** cuando haya Meta Business Verification
- Revisar límite mensual del bot de Autana (demo propio) con datos reales
- Stripe fase 2: cobro embebido (fase 1 = solo link)
- Incluir límites de conversaciones en contratos de cliente

---

## Versiones

| Versión | Fecha      | Cambios principales                                      |
|---------|------------|----------------------------------------------------------|
| 1.2.0   | 2026-04-14 | Auto-aprendizaje supervisado, alertas enriquecidas       |
| 1.1.0   | 2026-04-10 | Stripe fase 1, feature flags, GitHub Actions CI          |
| 1.0.0   | 2026-04-08 | Release inicial: Cal.com, sesiones, LOPD, escalado       |
