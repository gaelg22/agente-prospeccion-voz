import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';

// ─── Mocks antes de importar las rutas ────────────────────────────────────────

// Config mock — logger la lee al importarse (config.ts hace process.exit si faltan envs)
vi.mock('../../../config', () => ({
  config: { NODE_ENV: 'test', LOG_LEVEL: 'info' },
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
