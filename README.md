# Sofía — agente de voz que hace llamadas de prospección

Backend de un agente de voz con IA que **llama por teléfono** a prospectos (principalmente doctores), detecta si les interesa una plática con un asesor financiero y, si dicen que sí, **agenda la cita en el Google Calendar del asesor** y le manda la confirmación por WhatsApp.

Lo desarrollé yo solo durante mis prácticas, para un asesor de seguros. Se probó con llamadas reales.

## Qué hace

1. **Consigue leads** desde la API del DENUE (INEGI): consultorios con teléfono público. Los normaliza, quita duplicados y los mete a la cola.
2. **Marca** a los leads dentro de la ventana de horario permitida (L-V 10–20 h, sáb 8–12 h, hora de México) usando Vapi + Twilio.
3. **Conversa**: Sofía se presenta como asistente virtual, pide permiso, ofrece la cita y maneja objeciones. Si la persona dice "no me interesa" o "no me llamen", lo respeta a la primera.
4. **Agenda** mientras sigue la llamada: el modelo llama herramientas del backend (`verificar_disponibilidad`, `agendar_cita`) que consultan el calendario real. Según el municipio, la cita es presencial (2 h) o por videollamada (1 h).
5. **Registra el desenlace** (aceptó, no interesado, no contactable, número equivocado…) y, si no contestaron, programa un reintento.
6. **Reconcilia**: cada 10 minutos un job revisa las llamadas que se quedaron "colgadas" (porque el webhook nunca llegó) y recupera el resultado consultando la API de Vapi.

## Arquitectura

```
DENUE API ──► ingesta ──► MongoDB (leads) ──► cola (Agenda jobs) ──► Vapi ──► llamada (Twilio)
                               ▲                                        │
                               │        webhooks + tool calls           │
                               └──────────── Express ◄──────────────────┘
                                               │
                                   Google Calendar · WhatsApp (Kapso)
```

Cada lead es una **máquina de estados** (`nuevo → listo_llamar → llamado → acepto → agendado`, más los estados terminales). Las transiciones inválidas se rechazan con 409, así un lead nunca termina en un estado que no tiene sentido.

## Stack

TypeScript · Node.js · Express · MongoDB Atlas (Mongoose) · Agenda (jobs) · Vapi (voz) · Twilio · Google Calendar API · Zod · Pino · Vitest · Render

## Detalles de los que me siento orgulloso

- **Tests**: ~300 tests con Vitest (máquina de estados, slots de calendario, ventana de llamadas, webhooks, tool handlers…). `tsc` y lint en cero.
- **Seguridad**: los webhooks de Vapi se validan con un secreto (comparación en tiempo constante), las rutas admin piden API key y el logger oculta datos sensibles.
- **El prompt como código**: la configuración del asistente (voz, transcriber, herramientas y prompt) está versionada en `assistant.config.ts`, no metida a mano en el dashboard.
- **Zonas horarias**: todo el manejo de fechas está forzado a `America/Mexico_City`, para que una cita no se mueva una hora según dónde corra el servidor.

## Correrlo

```bash
npm install
cp .env.example .env     # Mongo, Vapi, Twilio, Google, API_KEY...
npm run dev              # o npm run dev:tunnel para exponerlo con cloudflared
npm test
```

El prompt completo está en [`docs/system_prompt_vapi_v2.md`](docs/system_prompt_vapi_v2.md).
