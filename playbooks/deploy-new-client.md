# Playbook: Despliegue de nuevo cliente

Tiempo estimado: 1-2 horas (sin contar la verificación de Meta, que es de Meta).

---

## PRE-REQUISITOS

Antes de empezar, el cliente debe haber:
- [ ] Firmado el contrato y realizado el primer pago
- [ ] Completado el intake form de Tally (link: [PENDIENTE])
- [ ] Iniciado el proceso de Meta Business Verification (tú les das el checklist)

---

## PASO 1 — Crear los archivos del cliente (15 min)

```bash
# En el repo autana-bot:
mkdir -p clients/{SLUG}
cp clients/joyeria-esposa/config.yaml clients/{SLUG}/config.yaml
cp clients/joyeria-esposa/system-prompt.md clients/{SLUG}/system-prompt.md
```

Editar `clients/{SLUG}/config.yaml`:
- [ ] `client_slug` → slug del cliente (ej: `clinica-madrid`)
- [ ] `business_name` → nombre real del negocio
- [ ] `channel_id` → PENDING (lo tienes en PASO 3)
- [ ] `cal_link` → link de Cal.com del cliente
- [ ] `cal_event_type_id` → ID del evento en Cal.com
- [ ] `handoff_phone` → WhatsApp del responsable del negocio
- [ ] `handoff_email` → email del responsable
- [ ] `privacy_url` → URL de la política de privacidad del cliente

Editar `clients/{SLUG}/system-prompt.md`:
- [ ] Rellenar todos los secciones marcadas con `<!-- RELLENAR -->`
- [ ] Revisar que los precios son correctos
- [ ] Probar el prompt manualmente en claude.ai antes de desplegar

---

## PASO 2 — Variables de entorno en Railway (5 min)

En el dashboard de Railway → Variables:

```
DIALOG360_API_KEY_{SLUG_UPPER}=<la API key de 360dialog para este canal>
CAL_API_KEY_{SLUG_UPPER}=<la API key de Cal.com del cliente>
```

Ejemplo para `clinica-madrid`:
```
DIALOG360_API_KEY_CLINICA_MADRID=...
CAL_API_KEY_CLINICA_MADRID=...
```

---

## PASO 3 — Configurar 360dialog (30 min, cuando Meta verification esté aprobada)

1. Ir al portal de 360dialog: https://hub.360dialog.com
2. Crear nuevo canal con el número WhatsApp Business del cliente
3. Conectar al Meta Business Manager del cliente
4. Copiar el **Channel ID** y el **API Key** del nuevo canal
5. Pegar el Channel ID en `clients/{SLUG}/config.yaml` → `channel_id`
6. Pegar la API Key en Railway → Variables → `DIALOG360_API_KEY_{SLUG_UPPER}`
7. Configurar el webhook en 360dialog:
   - URL: `https://autana-bot.railway.app/webhook`
   - Secret: el valor de `DIALOG360_WEBHOOK_SECRET` (ya está en Railway)

---

## PASO 4 — Deploy y prueba (15 min)

```bash
# Commit y push — Railway hace deploy automático
git add clients/{SLUG}/
git commit -m "feat: add client {SLUG}"
git push origin main
```

Esperar que Railway haga el deploy (1-2 min).

Verificar que el health check pasa:
```bash
curl https://autana-bot.railway.app/health
# Esperado: {"status":"ok","ts":"..."}
```

---

## PASO 5 — Test manual (20 min)

Desde tu WhatsApp personal, envía al número del cliente:

- [ ] Test 1: Mensaje de texto normal → el bot responde
- [ ] Test 2: Imagen → bot responde "Solo puedo leer texto..."
- [ ] Test 3: Pregunta de precio → bot responde con precios del config
- [ ] Test 4: "¿Tenéis hueco esta semana?" → bot consulta Cal.com y da slots reales
- [ ] Test 5: "Hablar con alguien" → bot escala, Kenny recibe alerta en WhatsApp
- [ ] Test 6: Mensaje con formato largo → bot responde correctamente
- [ ] Test 7: "Borrar mis datos" → bot pide confirmación → "sí, borrar" → confirmación borrado

Si algún test falla, revisar:
1. Railway logs (en el dashboard de Railway → Deploy → Logs)
2. Verificar variables de entorno
3. Verificar que el channel_id en config.yaml coincide con el de 360dialog

---

## PASO 6 — Entrega al cliente (5 min)

Enviar al cliente:
- Confirmación de que el bot está activo
- Cómo iniciar una conversación de prueba
- Qué hacer si el bot falla (te llaman a ti directamente)
- Cuándo recibirán el primer ROI report (primer lunes del mes siguiente)

---

## TROUBLESHOOTING RÁPIDO

| Síntoma | Causa probable | Fix |
|---------|---------------|-----|
| Bot no responde | channel_id incorrecto | Verificar config.yaml vs 360dialog dashboard |
| Bot responde "desconocido" | channel_id no mapeado | Verificar que config está en `clients/` y commitado |
| Error de Cal.com | cal_event_type_id incorrecto | Verificar en Cal.com → Event Types → ID |
| Kenny no recibe alertas | handoff_phone incorrecto | Verificar en config.yaml |
| Bot sin memoria | Supabase caído o credenciales | Verificar SUPABASE_URL y SUPABASE_SERVICE_KEY en Railway |
