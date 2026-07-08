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
  VAPI_ASSISTANT_ID: z.string().min(1, 'VAPI_ASSISTANT_ID es requerida'),
  VAPI_WEBHOOK_SECRET: z.string().min(1, 'VAPI_WEBHOOK_SECRET es requerida'),

  // ── DENUE / INEGI ────────────────────────────────────────────────────────
  DENUE_TOKEN: z.string().min(1, 'DENUE_TOKEN es requerida'),
  DENUE_BASE_URL: z
    .string()
    .url()
    .default('https://www.inegi.org.mx/app/api/denue/v1/consulta'),

  // ── Anthropic (LLM para el agente) ───────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY es requerida'),

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
