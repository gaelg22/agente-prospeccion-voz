import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';

// ─── Mocks antes de importar el router ───────────────────────────────────────

// Passthrough del API key middleware — aquí se prueban transiciones, no auth
vi.mock('../../../middleware/apiKey.middleware', () => ({
  apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../lead.schema', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lead.schema')>();
  return {
    ...original,
    Lead: {
      findById: vi.fn(),
    },
  };
});

import { Lead } from '../lead.schema';
import type { ILead } from '../lead.schema';
import { leadRoutes } from '../lead.routes';
import { errorMiddleware } from '../../../middleware/error.middleware';

// ─── App de prueba ────────────────────────────────────────────────────────────

function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/leads', leadRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<ILead> = {}): ILead & { save: ReturnType<typeof vi.fn> } {
  const lead = {
    _id: new Types.ObjectId(),
    denueId: 'denue-001',
    razonSocial: 'Empresa Test S.A.',
    actividadEconomica: 'Comercio al por menor',
    telefono: '+525512345678',
    telefonoRaw: '5512345678',
    direccion: { municipio: 'Monterrey', estado: 'Nuevo León' },
    status: 'nuevo' as ILead['status'],
    intentos: 0,
    fuente: 'denue',
    fuenteUrl: 'https://example.com',
    capturadasEn: new Date(),
    notas: [] as string[],
    save: vi.fn(),
    ...overrides,
  } as unknown as ILead & { save: ReturnType<typeof vi.fn> };

  lead.save.mockResolvedValue(lead);
  return lead;
}

// ─── Tests: PATCH /leads/:id/status — transiciones ilegales → 409 ─────────────

describe('PATCH /leads/:id/status — leads terminales no regresan a la cola', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildTestApp();
  });

  it('rechaza con 409 no_contactar → listo_llamar y no persiste nada', async () => {
    const lead = makeLead({ status: 'no_contactar' });
    vi.mocked(Lead.findById).mockResolvedValue(lead as unknown as ILead);

    const res = await request(app)
      .patch(`/leads/${lead._id.toString()}/status`)
      .send({ status: 'listo_llamar' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no_contactar → listo_llamar/);
    expect(lead.save).not.toHaveBeenCalled();
  });

  it('rechaza con 409 no_interesado → listo_llamar y no persiste nada', async () => {
    const lead = makeLead({ status: 'no_interesado' });
    vi.mocked(Lead.findById).mockResolvedValue(lead as unknown as ILead);

    const res = await request(app)
      .patch(`/leads/${lead._id.toString()}/status`)
      .send({ status: 'listo_llamar' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no_interesado → listo_llamar/);
    expect(lead.save).not.toHaveBeenCalled();
  });

  it('acepta una transición legal como control: nuevo → listo_llamar', async () => {
    const lead = makeLead({ status: 'nuevo' });
    vi.mocked(Lead.findById).mockResolvedValue(lead as unknown as ILead);

    const res = await request(app)
      .patch(`/leads/${lead._id.toString()}/status`)
      .send({ status: 'listo_llamar' });

    expect(res.status).toBe(200);
    expect(lead.save).toHaveBeenCalled();
  });

  it('rechaza con 422 un status inexistente (validación Zod)', async () => {
    const res = await request(app)
      .patch(`/leads/${new Types.ObjectId().toString()}/status`)
      .send({ status: 'status_inventado' });

    expect(res.status).toBe(422);
  });
});
