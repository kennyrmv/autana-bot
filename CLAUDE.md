## Ecosistema Autana

Este repo es el **bot de WhatsApp** (`/Users/lider/autana-bot`).
El otro repo del ecosistema es la **landing de marketing** (`/Users/lider/agencia web`).

Ambos son proyectos separados con git y deploy independientes:
- Bot → Node.js en Railway, conectado a Supabase + Twilio + Claude API
- Landing → estática, sin backend

Cuando el usuario pida algo que afecte a los dos, edita ambos repos.
Cuando mencione "el bot" → trabajar en `/Users/lider/autana-bot`.
Cuando mencione "la landing" o "la web" → trabajar en `/Users/lider/agencia web`.

### Stack de la landing (`/Users/lider/agencia web`)
- HTML + CSS + JS vanilla, sin build step
- Diseño: Plus Jakarta Sans, verde bosque #1B5E42, fondo cálido #F9F8F5
- Sistema de diseño documentado en `DESIGN.md`
- Sin deploy automatizado (estática)

### Stack del bot (`/Users/lider/autana-bot`)
- Node.js 22 + Fastify + ES modules
- Claude API (`claude-sonnet-4-6`) como cerebro del bot
- Supabase (PostgreSQL) para historial (`conversations`) y sesiones (`sessions`)
- Twilio WhatsApp Sandbox (testing) → migrar a 360dialog cuando vaya live
- Deploy: Railway (push a main = auto-deploy)
- Multi-cliente: configuración por YAML en `clients/{slug}/`
- Sistema de sesiones 24h con límite mensual por plan:
  - Bot Esencial: 300 conv/mes
  - Bot Conversión: 800 conv/mes
  - Custom: sin límite

### Flujo de mensaje (bot)
1. Twilio recibe mensaje → POST /webhook
2. Verifica firma Twilio
3. Carga config del cliente (por slug en sandbox, por channel_id en producción)
4. Rechaza media (solo texto)
5. Check sesión activa (24h) → si nueva, verifica límite mensual
6. Primer mensaje → aviso LOPD
7. Supresión LOPD ("sí, borrar")
8. Llama a Claude con historial + tools (Cal.com si configurado)
9. Guarda turno en Supabase
10. Envía respuesta al usuario
11. Si [handoff] → alerta Kenny por WhatsApp

### Pendientes conocidos
- Límite mensual del bot de Autana (demo propio): dejarlo con límite por ahora, revisar con datos reales
- Incluir límites de conversaciones en el contrato de cliente
- Migrar de Twilio sandbox a 360dialog cuando vaya live (requiere Meta Business Verification)

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
