import { z } from 'zod';

// ─── Schema ────────────────────────────────────────────────────────────────────
// Regla: el proceso FALLA al arrancar si falta una variable requerida.
// Las integraciones de Google Calendar y Kapso son opcionales en esta fase.

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Core ─────────────────────────────────────────────────────────────────
  MONGODB_URI: z.string().min(1, 'MONGODB_URI es requerida'),
  API_KEY: z.string().min(32, 'API_KEY debe tener al menos 32 caracteres'),

  // ── Vapi (voz) ───────────────────────────────────────────────────────────
  VAPI_API_KEY: z.string().min(1, 'VAPI_API_KEY es requerida'),
  // Legado: el assistant ahora se manda transient en cada llamada
  // (assistant.config.ts), no se referencia por ID. Se acepta para no romper
  // deploys que aún la definen.
  VAPI_ASSISTANT_ID: z.string().min(1).optional(),
  VAPI_WEBHOOK_SECRET: z.string().min(1, 'VAPI_WEBHOOK_SECRET es requerida'),
  // Número saliente registrado en Vapi. Sin él, Vapi rechaza la creación de
  // llamadas telefónicas; se valida al momento de marcar (no al arrancar)
  // para no bloquear entornos donde la cola está apagada.
  VAPI_PHONE_NUMBER_ID: z.string().min(1).optional(),
  // Modelo LLM del asistente de voz (enum propio de Vapi, provider anthropic).
  VAPI_LLM_MODEL: z.string().min(1).default('claude-sonnet-4-5-20250929'),
  // Voz ElevenLabs del asistente. Default: "sarah" (preset femenino de la
  // librería de ElevenLabs/Vapi; con el modelo multilingüe habla español).
  // Intercambiable por cualquier voiceId de ElevenLabs sin tocar código.
  VAPI_VOICE_ID: z.string().min(1).default('sarah'),
  // Modelo TTS de ElevenLabs. eleven_flash_v2_5 pronuncia mejor el español y
  // tiene menor latencia que eleven_multilingual_v2 (que recortaba "García"
  // a "Garc" en las llamadas de prueba del 11 jul).
  VAPI_VOICE_MODEL: z.string().min(1).default('eleven_flash_v2_5'),
  // Transcriber Deepgram del asistente. es-419 (español latinoamericano) es el
  // enum preferido de Vapi para México — "es" a secas transcribe peor el acento.
  VAPI_TRANSCRIBER_MODEL: z.string().min(1).default('nova-2'),
  VAPI_TRANSCRIBER_LANGUAGE: z.string().min(1).default('es-419'),

  // ── DENUE / INEGI ────────────────────────────────────────────────────────
  DENUE_TOKEN: z.string().min(1, 'DENUE_TOKEN es requerida'),
  DENUE_BASE_URL: z
    .string()
    .url()
    .default('https://www.inegi.org.mx/app/api/denue/v1/consulta'),

  // ── Anthropic (LLM para el agente) ───────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY es requerida'),

  // ── Identidad pública del servicio y del asistente de voz ─────────────────
  // PUBLIC_URL: base para construir el server.url de las tools de Vapi
  // (PUBLIC_URL + /webhooks/vapi). En producción debe ser la URL de Render.
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  AGENTE_NOMBRE: z.string().min(1).default('Sofía'),
  EMPRESA_NOMBRE: z.string().min(1).default('Asesoría de Seguros (prueba)'),
  TELEFONO_OFICIAL: z.string().min(1).default('55 0000 0000'),

  // ── Google Calendar (opcional en esta fase) ───────────────────────────────
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).optional(),

  // ── Kapso WhatsApp (opcional en esta fase) ────────────────────────────────
  KAPSO_API_URL: z.string().url().optional(),
  KAPSO_API_KEY: z.string().min(1).optional(),
  KAPSO_WHATSAPP_TEMPLATE: z.string().default('confirmacion_cita'),

  // ── Agenda (jobs) ─────────────────────────────────────────────────────────
  AGENDA_COLLECTION: z.string().default('agendaJobs'),
  CALL_CADENCE_MINUTES: z.coerce.number().int().positive().default(10),

  // Kill-switch de la cola: los jobs se registran siempre, pero solo disparan
  // llamadas reales cuando COLA_ACTIVA=true. Default apagado por seguridad.
  COLA_ACTIVA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Variables de entorno inválidas — el proceso terminará:\n');
  const fieldErrors = parsed.error.flatten().fieldErrors;
  for (const [field, msgs] of Object.entries(fieldErrors)) {
    console.error(`  ${field}: ${(msgs ?? []).join(', ')}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
