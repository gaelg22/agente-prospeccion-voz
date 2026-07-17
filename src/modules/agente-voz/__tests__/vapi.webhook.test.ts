import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks antes de importar el router ───────────────────────────────────────

// Config mock — necesario porque config.ts hace process.exit() si faltan vars.
// vapi.zod importa assistant.config, que lee PUBLIC_URL y la identidad al cargar.
vi.mock('../../../config', () => ({
  config: {
    NODE_ENV: 'test',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba-exacto',
    PUBLIC_URL: 'https://agente-test.onrender.com',
    AGENTE_NOMBRE: 'Sofía',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
    HORARIO_SEMANAL: '-,10-20,10-20,10-20,10-20,10-20,8-12',
  },
}));

// Mocks de dependencias del webhook
vi.mock('../tool-handlers', () => ({
  TOOL_HANDLERS: {
    registrar_resultado: vi.fn().mockResolvedValue({
      toolCallId: 'tc-001',
      result: JSON.stringify({ ok: true, nuevoStatus: 'acepto' }),
    }),
  },
}));

const mockTranscriptLinea = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({}),
}));
vi.mock('../transcript.schema', () => ({ TranscriptLinea: mockTranscriptLinea }));

// Importar el router DESPUÉS de configurar los mocks
import { vapiWebhookRouter } from '../vapi.webhook';
import { TOOL_HANDLERS } from '../tool-handlers';

// ─── App de prueba ────────────────────────────────────────────────────────────

function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/vapi', vapiWebhookRouter);
  return app;
}

// ─── Tests: verificación de secreto ──────────────────────────────────────────

describe('POST /webhooks/vapi — verificación de secreto', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildTestApp();
  });

  it('responde 401 si no se envía el header x-vapi-secret', async () => {
    const res = await request(app)
      .post('/webhooks/vapi')
      .send({ message: { type: 'call-started' } });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('responde 401 si el secreto es incorrecto', async () => {
    const res = await request(app)
      .post('/webhooks/vapi')
      .set('x-vapi-secret', 'secreto-EQUIVOCADO')
      .send({ message: { type: 'call-started' } });

    expect(res.status).toBe(401);
  });

  it('responde 401 si el secreto tiene el largo correcto pero contenido diferente', async () => {
    // Mismo largo que 'secreto-de-prueba-exacto' (24 chars) pero diferente
    const res = await request(app)
      .post('/webhooks/vapi')
      .set('x-vapi-secret', 'secreto-de-prueba-XXXXX')
      .send({ message: { type: 'call-started' } });

    expect(res.status).toBe(401);
  });

  it('acepta la solicitud con el secreto correcto', async () => {
    const res = await request(app)
      .post('/webhooks/vapi')
      .set('x-vapi-secret', 'secreto-de-prueba-exacto')
      .send({ message: { type: 'call-started' } });

    expect(res.status).toBe(200);
  });
});

// ─── Tests: payloads inválidos ────────────────────────────────────────────────

describe('POST /webhooks/vapi — validación de payload', () => {
  let app: express.Application;
  const HEADERS = { 'x-vapi-secret': 'secreto-de-prueba-exacto' };

  beforeEach(() => {
    app = buildTestApp();
  });

  it('devuelve 200 (no error) para payloads que no cumplen el schema', async () => {
    const res = await request(app)
      .post('/webhooks/vapi')
      .set(HEADERS)
      .send({ foo: 'bar' }); // falta message

    expect(res.status).toBe(200);
  });

  it('devuelve 200 para body vacío', async () => {
    const res = await request(app)
      .post('/webhooks/vapi')
      .set(HEADERS)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(200);
  });
});

// ─── Tests: manejo de tool-calls ─────────────────────────────────────────────

describe('POST /webhooks/vapi — tool-calls', () => {
  let app: express.Application;
  const HEADERS = { 'x-vapi-secret': 'secreto-de-prueba-exacto' };

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildTestApp();
  });

  it('responde con results en el formato de Vapi', async () => {
    const payload = {
      message: {
        type: 'tool-calls',
        toolCallList: [
          {
            id: 'tc-001',
            type: 'function',
            function: {
              name: 'registrar_resultado',
              arguments: { desenlace: 'acepto' },
            },
          },
        ],
      },
    };

    const res = await request(app)
      .post('/webhooks/vapi')
      .set(HEADERS)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results[0]).toHaveProperty('toolCallId', 'tc-001');
  });

  it('pasa el leadId de call.metadata a los handlers como contexto', async () => {
    const payload = {
      message: {
        type: 'tool-calls',
        call: { id: 'call-abc', metadata: { leadId: 'lead-desde-metadata' } },
        toolCallList: [
          {
            id: 'tc-002',
            type: 'function',
            function: { name: 'registrar_resultado', arguments: { desenlace: 'acepto' } },
          },
        ],
      },
    };

    await request(app).post('/webhooks/vapi').set(HEADERS).send(payload);

    expect(TOOL_HANDLERS['registrar_resultado']).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tc-002' }),
      expect.objectContaining({ leadId: 'lead-desde-metadata', callId: 'call-abc' }),
    );
  });

  it('recupera el leadId también desde call.assistantOverrides.metadata', async () => {
    const payload = {
      message: {
        type: 'tool-calls',
        call: {
          id: 'call-def',
          assistantOverrides: { metadata: { leadId: 'lead-desde-overrides' } },
        },
        toolCallList: [
          {
            id: 'tc-003',
            type: 'function',
            function: { name: 'registrar_resultado', arguments: { desenlace: 'acepto' } },
          },
        ],
      },
    };

    await request(app).post('/webhooks/vapi').set(HEADERS).send(payload);

    expect(TOOL_HANDLERS['registrar_resultado']).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: 'lead-desde-overrides' }),
    );
  });

  it('devuelve error en results para tool no registrado', async () => {
    const payload = {
      message: {
        type: 'tool-calls',
        toolCallList: [
          {
            id: 'tc-999',
            type: 'function',
            function: { name: 'tool_inexistente', arguments: {} },
          },
        ],
      },
    };

    const res = await request(app)
      .post('/webhooks/vapi')
      .set(HEADERS)
      .send(payload);

    expect(res.status).toBe(200);
    const result = JSON.parse(res.body.results[0].result as string) as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

// ─── Tests: transcript → colección transcripts (TTL), nunca a lead.notas ─────

describe('POST /webhooks/vapi — transcript', () => {
  let app: express.Application;
  const HEADERS = { 'x-vapi-secret': 'secreto-de-prueba-exacto' };
  const call = { id: 'call-tr-1', metadata: { leadId: '6a556c0a283075dd579efea7' } };

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildTestApp();
  });

  it('línea final (type "transcript") se guarda en la colección transcripts', async () => {
    const res = await request(app).post('/webhooks/vapi').set(HEADERS).send({
      message: {
        type: 'transcript',
        transcriptType: 'final',
        transcript: 'Sí, me interesa la cita.',
        role: 'user',
        call,
      },
    });

    expect(res.status).toBe(200);
    expect(mockTranscriptLinea.create).toHaveBeenCalledWith({
      leadId: '6a556c0a283075dd579efea7',
      vapiCallId: 'call-tr-1',
      rol: 'user',
      texto: 'Sí, me interesa la cita.',
    });
  });

  it('acepta el type literal transcript[transcriptType="final"] de la suscripción', async () => {
    await request(app).post('/webhooks/vapi').set(HEADERS).send({
      message: {
        type: 'transcript[transcriptType="final"]',
        transcriptType: 'final',
        transcript: 'Perfecto, agendamos.',
        role: 'assistant',
        call,
      },
    });

    expect(mockTranscriptLinea.create).toHaveBeenCalledOnce();
  });

  it('las líneas partial NO se guardan', async () => {
    await request(app).post('/webhooks/vapi').set(HEADERS).send({
      message: {
        type: 'transcript',
        transcriptType: 'partial',
        transcript: 'Sí, me inte',
        role: 'user',
        call,
      },
    });

    expect(mockTranscriptLinea.create).not.toHaveBeenCalled();
  });

  it('sin leadId en metadata no guarda nada (y responde 200)', async () => {
    const res = await request(app).post('/webhooks/vapi').set(HEADERS).send({
      message: {
        type: 'transcript',
        transcriptType: 'final',
        transcript: 'Hola.',
        role: 'user',
        call: { id: 'call-sin-lead' },
      },
    });

    expect(res.status).toBe(200);
    expect(mockTranscriptLinea.create).not.toHaveBeenCalled();
  });
});
