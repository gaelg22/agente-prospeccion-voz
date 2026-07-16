import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import type Agenda from 'agenda';
import type { Job } from 'agenda';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { getCallMock } = vi.hoisted(() => ({
  getCallMock: vi.fn(),
}));

vi.mock('../../../../lib/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../leads/lead.service', () => ({
  LeadService: {
    findEstancadosEnLlamado: vi.fn(),
    findAceptoSinCita: vi.fn(),
    transition: vi.fn(),
  },
}));

vi.mock('../../cola.service', () => ({
  ColaService: {
    scheduleRetry: vi.fn(),
  },
}));

vi.mock('../../../agente-voz/vapi.client', () => ({
  VapiClient: vi.fn(() => ({ getCall: getCallMock })),
}));

// assistant.config carga el system prompt y config al importarse — para el job
// solo se ocupa el enum de desenlaces, así que se mockea completo.
vi.mock('../../../agente-voz/assistant.config', () => ({
  DESENLACES_LLAMADA: [
    'acepto',
    'no_interesado',
    'interesado_sin_espacio',
    'no_contactar',
    'buzon',
    'numero_equivocado',
    'error_tecnico',
  ],
}));

import {
  defineReconciliarLlamadasJob,
  extraerDesenlace,
  UMBRAL_VARADO_MINUTOS,
} from '../reconciliar-llamadas.job';
import { LeadService } from '../../../leads/lead.service';
import { ColaService } from '../../cola.service';
import type { ILead } from '../../../leads/lead.schema';
import type { VapiCallResponse } from '../../../agente-voz/vapi.client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeLeadVarado(overrides: Partial<ILead> = {}): ILead {
  return {
    _id: new Types.ObjectId(),
    status: 'llamado',
    intentos: 1,
    vapiCallId: 'call-varado-1',
    ultimaLlamada: new Date('2026-07-11T04:00:00Z'),
    ...overrides,
  } as ILead;
}

function callTerminada(desenlace?: string): VapiCallResponse {
  return {
    id: 'call-varado-1',
    status: 'ended',
    endedReason: 'silence-timed-out',
    messages: desenlace
      ? [
          {
            role: 'tool_calls',
            toolCalls: [
              {
                function: {
                  name: 'registrar_resultado',
                  arguments: JSON.stringify({ desenlace }),
                },
              },
            ],
          },
        ]
      : [{ role: 'bot' }],
  };
}

// ─── extraerDesenlace ─────────────────────────────────────────────────────────

describe('extraerDesenlace — recupera el desenlace del historial de la llamada', () => {
  it('encuentra el desenlace cuando arguments es string JSON', () => {
    expect(extraerDesenlace(callTerminada('no_interesado'))).toBe('no_interesado');
  });

  it('encuentra el desenlace cuando arguments es objeto', () => {
    const call: VapiCallResponse = {
      id: 'c',
      status: 'ended',
      messages: [
        {
          toolCalls: [
            { function: { name: 'registrar_resultado', arguments: { desenlace: 'acepto' } } },
          ],
        },
      ],
    };
    expect(extraerDesenlace(call)).toBe('acepto');
  });

  it('regresa null si no hubo registrar_resultado o el desenlace no es válido', () => {
    expect(extraerDesenlace(callTerminada())).toBeNull();
    expect(extraerDesenlace({ id: 'c', status: 'ended' })).toBeNull();
    expect(extraerDesenlace(callTerminada('desenlace_inventado'))).toBeNull();
  });
});

// ─── Job de reconciliación ────────────────────────────────────────────────────

describe('reconciliar-llamadas — leads varados en llamado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T05:00:00Z'));
    // El barrido hermano (acepto sin cita) corre en el mismo handler — vacío
    // por default para que estos tests solo ejerciten el barrido de llamado.
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('solo barre leads con más de 15 minutos en llamado — los recientes no se tocan', async () => {
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([]);
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    // El umbral de la consulta es exactamente ahora − 15 min: un lead con
    // ultimaLlamada más reciente queda fuera del barrido por diseño.
    expect(LeadService.findEstancadosEnLlamado).toHaveBeenCalledWith(
      new Date(Date.now() - UMBRAL_VARADO_MINUTOS * 60_000),
    );
    expect(getCallMock).not.toHaveBeenCalled();
    expect(LeadService.transition).not.toHaveBeenCalled();
  });

  it('lead varado con desenlace claro en Vapi: aplica la transición del call-outcome.handler', async () => {
    const lead = makeLeadVarado();
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([lead]);
    getCallMock.mockResolvedValue(callTerminada('no_interesado'));
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(getCallMock).toHaveBeenCalledWith('call-varado-1');
    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'no_interesado', {
      nota: expect.stringContaining('reconciliado desde el API de Vapi'),
    });
    expect(ColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('respuesta de Vapi sin desenlace utilizable: aplica error_tecnico (reintento) con la nota de webhook', async () => {
    const lead = makeLeadVarado({ intentos: 1 });
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([lead]);
    getCallMock.mockResolvedValue(callTerminada());
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    // error_tecnico con intentos=1 → reintento: listo_llamar + retry programado
    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'listo_llamar', {
      nota: expect.stringContaining('reconciliado: webhook nunca llegó'),
    });
    expect(ColaService.scheduleRetry).toHaveBeenCalledWith(
      lead._id.toString(),
      lead.ultimaLlamada,
    );
  });

  it('respuesta sin desenlace en el 2º intento: error_tecnico agota reintentos → no_contactable', async () => {
    const lead = makeLeadVarado({ intentos: 2 });
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([lead]);
    getCallMock.mockResolvedValue(callTerminada());
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'no_contactable', {
      nota: expect.stringContaining('reconciliado: webhook nunca llegó'),
    });
    expect(ColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('llamada que sigue activa en Vapi: se deja para el siguiente barrido', async () => {
    const lead = makeLeadVarado();
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([lead]);
    getCallMock.mockResolvedValue({ id: 'call-varado-1', status: 'in-progress' });
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).not.toHaveBeenCalled();
    expect(ColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('lead sin vapiCallId: no hay nada que consultar → error_tecnico directo', async () => {
    const lead = makeLeadVarado({ vapiCallId: undefined });
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([lead]);
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(getCallMock).not.toHaveBeenCalled();
    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'listo_llamar', {
      nota: expect.stringContaining('reconciliado: webhook nunca llegó'),
    });
  });

  it('un fallo con un lead no frena la reconciliación de los demás', async () => {
    const leadRoto = makeLeadVarado({ vapiCallId: 'call-roto' });
    const leadSano = makeLeadVarado({ vapiCallId: 'call-sano' });
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([leadRoto, leadSano]);
    getCallMock.mockImplementation((callId: string) => {
      if (callId === 'call-roto') return Promise.reject(new Error('Vapi 500'));
      return Promise.resolve({ ...callTerminada('acepto'), id: callId });
    });
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).toHaveBeenCalledTimes(1);
    expect(LeadService.transition).toHaveBeenCalledWith(leadSano._id, 'acepto', {
      nota: expect.stringContaining('reconciliado desde el API de Vapi'),
    });
  });
});

// ─── Barrido hermano: leads en acepto sin cita real ──────────────────────────

describe('reconciliar-llamadas — leads en acepto sin cita', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T05:00:00Z'));
    vi.mocked(LeadService.findEstancadosEnLlamado).mockResolvedValue([]);
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeLeadAcepto(overrides: Partial<ILead> = {}): ILead {
    return makeLeadVarado({ status: 'acepto', ...overrides });
  }

  it('consulta acepto sin cita con el MISMO umbral que el barrido de llamado', async () => {
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.findAceptoSinCita).toHaveBeenCalledWith(
      new Date(Date.now() - UMBRAL_VARADO_MINUTOS * 60_000),
    );
    expect(LeadService.transition).not.toHaveBeenCalled();
  });

  it('acepto envejecido sin folio: error_tecnico → listo_llamar con reintento y nota de reconciliación', async () => {
    const lead = makeLeadAcepto({ intentos: 1 });
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([lead]);
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'listo_llamar', {
      nota: expect.stringContaining('reconciliado: acepto sin cita'),
    });
    expect(ColaService.scheduleRetry).toHaveBeenCalledWith(
      lead._id.toString(),
      lead.ultimaLlamada,
    );
    // No consulta Vapi: el desenlace ya se conoce (aceptó), solo faltó la cita.
    expect(getCallMock).not.toHaveBeenCalled();
  });

  it('acepto sin folio con reintentos agotados (intentos=2): → no_contactable sin retry', async () => {
    const lead = makeLeadAcepto({ intentos: 2 });
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([lead]);
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).toHaveBeenCalledWith(lead._id, 'no_contactable', {
      nota: expect.stringContaining('reconciliado: acepto sin cita'),
    });
    expect(ColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('acepto CON cita real queda intacto: el query lo excluye y el barrido no lo toca', async () => {
    // findAceptoSinCita filtra por cita.googleEventId ausente (ver
    // lead.service.test): un acepto con cita jamás llega al barrido.
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([]);
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).not.toHaveBeenCalled();
    expect(ColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('un fallo con un lead no frena el barrido de los demás', async () => {
    const leadRoto = makeLeadAcepto({ intentos: 1 });
    const leadSano = makeLeadAcepto({ intentos: 1 });
    vi.mocked(LeadService.findAceptoSinCita).mockResolvedValue([leadRoto, leadSano]);
    vi.mocked(LeadService.transition).mockImplementation((id: unknown) => {
      if (id === leadRoto._id) return Promise.reject(new Error('Mongo caído'));
      return Promise.resolve({} as never);
    });
    const handler = captureHandler(defineReconciliarLlamadasJob);

    await handler({} as Job);

    expect(LeadService.transition).toHaveBeenCalledTimes(2);
    expect(ColaService.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(ColaService.scheduleRetry).toHaveBeenCalledWith(
      leadSano._id.toString(),
      leadSano.ultimaLlamada,
    );
  });
});
