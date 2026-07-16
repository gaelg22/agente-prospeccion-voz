import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import type Agenda from 'agenda';
import type { Job } from 'agenda';

// ─── Mocks (hoisted para poder mutar el flag entre tests) ─────────────────────

const { mockConfig, createCallMock } = vi.hoisted(() => ({
  mockConfig: {
    COLA_ACTIVA: false,
    // Leídas por lib/zona-presencial al calcular la modalidad del lead.
    ASESOR_ESTADO: 'Jalisco',
    ZONA_PRESENCIAL_MUNICIPIOS: 'Guadalajara,Zapopan,Tlaquepaque,Tonalá,Tlajomulco',
  },
  createCallMock: vi.fn(),
}));

vi.mock('../../../../config', () => ({ config: mockConfig }));

vi.mock('../../../../lib/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../lib/calling-window', () => ({
  isInCallingWindow: vi.fn(() => true),
}));

vi.mock('../../../leads/lead.service', () => ({
  LeadService: {
    findNextToCall: vi.fn(),
    findById: vi.fn(),
    transition: vi.fn(),
  },
}));

vi.mock('../../../agente-voz/vapi.client', () => ({
  VapiClient: vi.fn(() => ({ createCall: createCallMock })),
}));

// reintento.job ahora hace Lead.updateOne($unset noLlamarAntesDe) al terminar
vi.mock('../../../leads/lead.schema', () => ({
  Lead: { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }) },
}));

import { defineMarcarLlamadaJob } from '../marcar-llamada.job';
import { defineReintentoJob } from '../reintento.job';
import { LeadService } from '../../../leads/lead.service';
import { VapiClient } from '../../../agente-voz/vapi.client';
import { logger } from '../../../../lib/logger';

// ─── Helper: captura el handler que el job registra en Agenda ─────────────────

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

function makeReintentoJob(leadId: string): Job {
  return {
    attrs: { data: { leadId } },
    schedule: vi.fn(),
    save: vi.fn(),
  } as unknown as Job;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('COLA_ACTIVA=false — los jobs se registran pero no disparan llamadas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.COLA_ACTIVA = false;
    createCallMock.mockResolvedValue({ id: 'call-test' });
  });

  it('marcar-llamada: no consulta leads ni crea llamadas, y lo loguea', async () => {
    const handler = captureHandler(defineMarcarLlamadaJob);

    await handler({} as Job);

    expect(LeadService.findNextToCall).not.toHaveBeenCalled();
    expect(VapiClient).not.toHaveBeenCalled();
    expect(createCallMock).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('COLA_ACTIVA=false'),
    );
  });

  it('reintento-llamada: no consulta leads ni crea llamadas, y lo loguea', async () => {
    const handler = captureHandler(defineReintentoJob);

    await handler(makeReintentoJob(new Types.ObjectId().toString()));

    expect(LeadService.findById).not.toHaveBeenCalled();
    expect(VapiClient).not.toHaveBeenCalled();
    expect(createCallMock).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('COLA_ACTIVA=false'),
    );
  });
});

describe('COLA_ACTIVA=true — los jobs ejecutan el flujo normal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.COLA_ACTIVA = true;
    createCallMock.mockResolvedValue({ id: 'call-test' });
  });

  it('marcar-llamada: dispara la llamada y transiciona a llamado', async () => {
    const lead = {
      _id: new Types.ObjectId(),
      telefono: '+525512345678',
      razonSocial: 'Empresa Test S.A.',
      nombreComercial: 'Consultorio Test',
      actividadEconomica: 'Consultorios de medicina general',
      // Zapopan/Jalisco → zona presencial: la llamada debe llevar esZonaPresencial=true.
      direccion: { municipio: 'Zapopan', estado: 'Jalisco' },
    };
    vi.mocked(LeadService.findNextToCall).mockResolvedValue(lead as never);

    const handler = captureHandler(defineMarcarLlamadaJob);
    await handler({} as Job);

    expect(createCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toNumber: '+525512345678',
        leadId: lead._id.toString(),
        prospectoNombre: 'Consultorio Test',
        especialidad: 'Consultorios de medicina general',
        esZonaPresencial: true,
      }),
    );
    expect(LeadService.transition).toHaveBeenCalledWith(
      lead._id,
      'llamado',
      expect.objectContaining({ vapiCallId: 'call-test' }),
    );
  });

  it('reintento-llamada: dispara la llamada para lead en listo_llamar', async () => {
    const lead = {
      _id: new Types.ObjectId(),
      status: 'listo_llamar',
      telefono: '+525512345678',
      razonSocial: 'Empresa Test S.A.',
      actividadEconomica: 'Consultorios dentales',
      // Monterrey/Nuevo León → fuera de zona: esZonaPresencial=false (virtual).
      direccion: { municipio: 'Monterrey', estado: 'Nuevo León' },
    };
    vi.mocked(LeadService.findById).mockResolvedValue(lead as never);

    const handler = captureHandler(defineReintentoJob);
    await handler(makeReintentoJob(lead._id.toString()));

    expect(createCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toNumber: '+525512345678',
        leadId: lead._id.toString(),
        // sin nombreComercial cae a razonSocial
        prospectoNombre: 'Empresa Test S.A.',
        esZonaPresencial: false,
        metadata: expect.objectContaining({ esReintento: 'true' }),
      }),
    );
    expect(LeadService.transition).toHaveBeenCalledWith(
      lead._id,
      'llamado',
      expect.objectContaining({ vapiCallId: 'call-test' }),
    );
  });
});
