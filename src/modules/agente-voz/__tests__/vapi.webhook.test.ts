import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks antes de importar el router ───────────────────────────────────────

// Config mock — necesario porque config.ts hace process.exit() si faltan vars
vi.mock('../../../config', () => ({
  config: {
    NODE_ENV: 'test',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba-exacto',
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

vi.mock('../../leads/lead.schema', () => ({
  Lead: {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));

// Importar el router DESPUÉS de configurar los mocks
import { vapiWebhookRouter } from '../vapi.webhook';

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
              arguments: { leadId: 'lead123', desenlace: 'interesado' },
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
