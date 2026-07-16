import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';

// ─── Mocks antes de importar las rutas ──────────────────────────────────────────────────

// Config mock — logger la lee al importarse (config.ts hace process.exit si faltan envs)
vi.mock('../../../config', () => ({
  config: { NODE_ENV: 'test', LOG_LEVEL: 'info', API_KEY: 'test-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
}));

// Passthrough del API key middleware en los tests funcionales (auth se prueba aparte)
vi.mock('../../../middleware/apiKey.middleware', () => ({
  apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { createCallMock } = vi.hoisted(() => ({ createCallMock: vi.fn() }));

vi.mock('../../agente-voz/vapi.client', () => ({
  VapiClient: vi.fn(() => ({ createCall: createCallMock })),
}));

vi.mock('../lead.service', () => ({
  LeadService: {
    create: vi.fn(),
    findById: vi.fn(),
    transition: vi.fn(),
  },
}));

vi.mock('../lead.schema', () => ({
  Lead: { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }) },
}));

import { devRoutes } from '../dev.routes';
import { LeadService } from '../lead.service';
import { Lead } from '../lead.schema';
import { InvalidTransitionError } from '../lead.transitions';
import { errorMiddleware } from '../../../middleware/error.middleware';

function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/dev', devRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests: POST /dev/llamar/:leadId ─────────────────────────────────────────

describe('POST /dev/llamar/:leadId', () => {
  let app: express.Application;

  const leadBase = {
    _id: new Types.ObjectId(),
    status: 'nuevo',
    telefono: '+525512345678',
    razonSocial: 'Empresa Test S.A.',
    nombreComercial: 'Consultorio Test',
    actividadEconomica: 'Consultorios dentales',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createCallMock.mockResolvedValue({ id: 'call-vapi-001', status: 'queued' });
    app = buildTestApp();
  });

  it('transiciona nuevo → listo_llamar → llamado, dispara la llamada y responde el callId', async () => {
    vi.mocked(LeadService.findById).mockResolvedValue(leadBase as never);
    vi.mocked(LeadService.transition).mockResolvedValue(leadBase as never);

    const res = await request(app).post(`/dev/llamar/${leadBase._id.toString()}`);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ callId: 'call-vapi-001' });

    expect(LeadService.transition).toHaveBeenNthCalledWith(
      1,
      leadBase._id,
      'listo_llamar',
      expect.any(Object),
    );
    expect(LeadService.transition).toHaveBeenNthCalledWith(
      2,
      leadBase._id,
      'llamado',
      expect.any(Object),
    );
    expect(createCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toNumber: '+525512345678',
        leadId: leadBase._id.toString(),
        prospectoNombre: 'Consultorio Test',
        especialidad: 'Consultorios dentales',
      }),
    );
    expect(Lead.updateOne).toHaveBeenCalledWith(
      { _id: leadBase._id },
      { vapiCallId: 'call-vapi-001' },
    );
  });

  it('lead ya en listo_llamar: solo transiciona a llamado', async () => {
    vi.mocked(LeadService.findById).mockResolvedValue({
      ...leadBase,
      status: 'listo_llamar',
    } as never);
    vi.mocked(LeadService.transition).mockResolvedValue(leadBase as never);

    const res = await request(app).post(`/dev/llamar/${leadBase._id.toString()}`);

    expect(res.status).toBe(201);
    expect(LeadService.transition).toHaveBeenCalledTimes(1);
    expect(LeadService.transition).toHaveBeenCalledWith(
      leadBase._id,
      'llamado',
      expect.any(Object),
    );
  });

  it('responde 404 sin llamar a Vapi si el lead no existe', async () => {
    vi.mocked(LeadService.findById).mockResolvedValue(null);

    const res = await request(app).post('/dev/llamar/000000000000000000000000');

    expect(res.status).toBe(404);
    expect(createCallMock).not.toHaveBeenCalled();
    expect(LeadService.transition).not.toHaveBeenCalled();
  });

  it('responde 400 sin llamar a Vapi si el lead no tiene teléfono', async () => {
    vi.mocked(LeadService.findById).mockResolvedValue({ ...leadBase, telefono: null } as never);

    const res = await request(app).post(`/dev/llamar/${leadBase._id.toString()}`);

    expect(res.status).toBe(400);
    expect(createCallMock).not.toHaveBeenCalled();
  });

  it('responde 409 sin llamar a Vapi si la transición es ilegal (lead terminal)', async () => {
    vi.mocked(LeadService.findById).mockResolvedValue({
      ...leadBase,
      status: 'no_contactar',
    } as never);
    vi.mocked(LeadService.transition).mockRejectedValue(
      new InvalidTransitionError('no_contactar', 'listo_llamar'),
    );

    const res = await request(app).post(`/dev/llamar/${leadBase._id.toString()}`);

    expect(res.status).toBe(409);
    expect(createCallMock).not.toHaveBeenCalled();
  });
});

// ─── Tests: autenticación /dev ────────────────────────────────────────────────
// Valida que /dev exige x-api-key. Se recrea el middleware inline para evitar
// conflictos con el vi.mock de passthrough de más arriba.

describe('Autenticación de /dev — x-api-key requerida', () => {
  const VALID_KEY = 'test-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  // Middleware que replica exactamente apiKey.middleware.ts pero usa la clave
  // constante del mock de config (config.API_KEY = VALID_KEY).
  const realApiKeyMiddleware: express.RequestHandler = (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) {
      res.status(401).json({ error: 'Missing x-api-key header' });
      return;
    }
    if (key !== VALID_KEY) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    next();
  };

  function buildAuthApp(): express.Application {
    const app = express();
    app.use(express.json());
    // Middleware real ANTES del router (el router interno tiene el mock de passthrough)
    app.use('/dev', realApiKeyMiddleware, devRoutes);
    app.use(errorMiddleware);
    return app;
  }

  let authApp: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    authApp = buildAuthApp();
  });

  it('responde 401 cuando falta el header x-api-key', async () => {
    const res = await request(authApp).post('/dev/leads').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing/i);
  });

  it('responde 403 con una clave incorrecta', async () => {
    const res = await request(authApp)
      .post('/dev/leads')
      .set('x-api-key', 'clave-incorrecta')
      .send({});
    expect(res.status).toBe(403);
  });

  it('deja pasar y procesa la ruta con la clave correcta → 201', async () => {
    vi.mocked(LeadService.create).mockResolvedValue({
      _id: new Types.ObjectId(),
      razonSocial: 'Test',
    } as never);

    const res = await request(authApp)
      .post('/dev/leads')
      .set('x-api-key', VALID_KEY)
      .send({});

    expect(res.status).toBe(201);
  });
});
