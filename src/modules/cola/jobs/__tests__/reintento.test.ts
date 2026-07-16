/**
 * Tests C2: reintento.job.ts — verifica que el job limpia el embargo
 * (noLlamarAntesDe) después de colocar la llamada de reintento exitosamente.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import type Agenda from 'agenda';
import type { Job } from 'agenda';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../../lib/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    COLA_ACTIVA: true as boolean,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    ASESOR_ESTADO: 'Jalisco',
    ZONA_PRESENCIAL_MUNICIPIOS: 'Guadalajara',
  },
}));

vi.mock('../../../../config', () => ({ config: mockConfig }));

vi.mock('../../../../lib/calling-window', () => ({
  isInCallingWindow: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../../lib/zona-presencial', () => ({
  esZonaPresencial: vi.fn().mockReturnValue(false),
}));

const { createCallMock } = vi.hoisted(() => ({
  createCallMock: vi.fn(),
}));

vi.mock('../../../agente-voz/vapi.client', () => ({
  VapiClient: vi.fn(() => ({ createCall: createCallMock })),
}));

const { transitionMock, findByIdMock, updateOneMock } = vi.hoisted(() => ({
  transitionMock: vi.fn(),
  findByIdMock: vi.fn(),
  updateOneMock: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
}));

vi.mock('../../../leads/lead.service', () => ({
  LeadService: {
    findById: findByIdMock,
    transition: transitionMock,
  },
}));

vi.mock('../../../leads/lead.schema', () => ({
  Lead: { updateOne: updateOneMock },
}));

import { defineReintentoJob } from '../reintento.job';

// ─── Helper ───────────────────────────────────────────────────────────────────

type JobHandler = (job: Job) => Promise<void>;

function captureHandler(defineFn: (agenda: Agenda) => void): JobHandler {
  let handler: JobHandler | undefined;
  const fakeAgenda = {
    define: (_name: string, _opts: unknown, fn: JobHandler) => {
      handler = fn;
    },
  } as unknown as Agenda;
  defineFn(fakeAgenda);
  if (!handler) throw new Error('El job no registró ningún handler');
  return handler;
}

function makeJob(leadId: string): Job {
  return { attrs: { data: { leadId } } } as unknown as Job;
}

function makeLeadListo(overrides = {}) {
  return {
    _id: new Types.ObjectId(),
    status: 'listo_llamar',
    telefono: '+525512345678',
    razonSocial: 'Test S.A.',
    nombreComercial: null,
    actividadEconomica: 'Consultoría',
    intentos: 1,
    direccion: { municipio: 'Guadalajara', estado: 'Jalisco' },
    noLlamarAntesDe: new Date('2026-07-17T16:00:00Z'), // embargo que se debe limpiar
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reintento.job — C2: limpieza del embargo después del reintento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.COLA_ACTIVA = true; // reset entre tests
    updateOneMock.mockResolvedValue({ modifiedCount: 1 });
  });

  it('limpia noLlamarAntesDe ($unset) después de colocar la llamada exitosamente', async () => {
    const lead = makeLeadListo();
    findByIdMock.mockResolvedValue(lead);
    transitionMock.mockResolvedValue({ ...lead, status: 'llamado' });
    createCallMock.mockResolvedValue({ id: 'call-reintento-001' });

    const handler = captureHandler(defineReintentoJob);
    await handler(makeJob(lead._id.toString()));

    // Debe haber $unset del embargo
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: lead._id },
      { $unset: { noLlamarAntesDe: 1 } },
    );
  });

  it('el $unset ocurre DESPUÉS de la transición a llamado', async () => {
    const lead = makeLeadListo();
    findByIdMock.mockResolvedValue(lead);

    const callOrder: string[] = [];
    transitionMock.mockImplementation(async () => {
      callOrder.push('transition');
      return { ...lead, status: 'llamado' };
    });
    createCallMock.mockResolvedValue({ id: 'call-002' });
    updateOneMock.mockImplementation(async () => {
      callOrder.push('unset');
      return { modifiedCount: 1 };
    });

    const handler = captureHandler(defineReintentoJob);
    await handler(makeJob(lead._id.toString()));

    expect(callOrder).toEqual(['transition', 'unset']);
  });

  it('si COLA_ACTIVA=false, no llama a Vapi ni limpia el embargo', async () => {
    mockConfig.COLA_ACTIVA = false;

    const handler = captureHandler(defineReintentoJob);
    await handler(makeJob('cualquierId'));

    expect(createCallMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();

    mockConfig.COLA_ACTIVA = true; // restore
  });

  it('si el lead no está en listo_llamar, no llama ni limpia el embargo', async () => {
    const lead = makeLeadListo({ status: 'llamado' }); // ya fue llamado por otra vía
    findByIdMock.mockResolvedValue(lead);

    const handler = captureHandler(defineReintentoJob);
    await handler(makeJob(lead._id.toString()));

    expect(createCallMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('si el lead no existe, no llama ni limpia el embargo', async () => {
    findByIdMock.mockResolvedValue(null);

    const handler = captureHandler(defineReintentoJob);
    await handler(makeJob('000000000000000000000000'));

    expect(createCallMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});
