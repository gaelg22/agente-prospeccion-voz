import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks antes de importar los handlers ────────────────────────────────────
// config.ts hace process.exit() si faltan vars; assistant.config (importado por
// vapi.zod) lee PUBLIC_URL y la identidad al cargar.

vi.mock('../../../config', () => ({
  config: {
    NODE_ENV: 'test',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    PUBLIC_URL: 'https://agente-test.onrender.com',
    AGENTE_NOMBRE: 'Sofía',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
    HORARIO_SEMANAL: '-,10-20,10-20,10-20,10-20,10-20,8-12',
  },
}));

const mockLeadService = vi.hoisted(() => ({
  findById: vi.fn(),
  transition: vi.fn(),
}));
vi.mock('../../leads/lead.service', () => ({ LeadService: mockLeadService }));

const mockColaService = vi.hoisted(() => ({
  scheduleRetry: vi.fn(),
}));
vi.mock('../../cola/cola.service', () => ({ ColaService: mockColaService }));

// Modelo Lead: solo se usa updateOne (flag DNC y notas de agendar_cita).
// Se preserva el resto del módulo (TERMINAL_STATUSES etc. vía lead.transitions).
const mockLeadModel = vi.hoisted(() => ({
  updateOne: vi.fn(),
}));
vi.mock('../../leads/lead.schema', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../leads/lead.schema')>();
  return { ...original, Lead: mockLeadModel };
});

// AgendaService.book — se mockea para simular éxito/fallo de Calendar.
// SlotNoDisponibleError se reimplementa igual que en el módulo real: el
// handler la distingue por `instanceof`, así que el mock debe ser una clase
// real (no un objeto plano) para que esa comprobación siga funcionando.
const mockBook = vi.hoisted(() => vi.fn());
vi.mock('../../agenda/agenda.service', () => ({
  AgendaService: class {
    book = mockBook;
  },
  SlotNoDisponibleError: class SlotNoDisponibleError extends Error {
    slotIso: string;
    constructor(slotIso: string) {
      super(`El slot ${slotIso} ya no está disponible en Calendar`);
      this.name = 'SlotNoDisponibleError';
      this.slotIso = slotIso;
    }
  },
}));

import {
  handleRegistrarResultado,
  handleMarcarNoContactar,
  handleAgendarCita,
} from '../tool-handlers';
import { InvalidTransitionError } from '../../leads/lead.transitions';
import { SlotNoDisponibleError } from '../../agenda/agenda.service';
import type { VapiToolCall } from '../vapi.zod';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolCallRegistrar(desenlace: string, notas?: string): VapiToolCall {
  return {
    id: 'tc-idem-01',
    type: 'function',
    function: {
      name: 'registrar_resultado',
      arguments: notas ? { desenlace, notas } : { desenlace },
    },
  } as VapiToolCall;
}

function toolCallAgendar(extra: Record<string, unknown> = {}): VapiToolCall {
  return {
    id: 'tc-agendar-01',
    type: 'function',
    function: {
      name: 'agendar_cita',
      arguments: { fecha: '2026-08-03', hora: '17:00', modalidad: 'virtual', ...extra },
    },
  } as VapiToolCall;
}

function toolCallDnc(motivo?: string): VapiToolCall {
  return {
    id: 'tc-dnc-01',
    type: 'function',
    function: {
      name: 'marcar_no_contactar',
      arguments: motivo ? { motivo } : {},
    },
  } as VapiToolCall;
}

const CTX = { leadId: 'lead-123', callId: 'call-abc' };

// ─── Tests: idempotencia sobre lead terminal ─────────────────────────────────

describe('handleRegistrarResultado — idempotencia con lead ya terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no_contactar → registrar_resultado responde éxito sin intentar transición', async () => {
    // Caso exacto de la llamada de validación del 11 jul: marcar_no_contactar
    // ya cerró el lead y el registrar_resultado final fallaba con 409.
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'no_contactar',
      intentos: 1,
    });

    const res = await handleRegistrarResultado(toolCallRegistrar('no_contactar'), CTX);

    const body = JSON.parse(res.result) as {
      ok: boolean;
      nuevoStatus: string;
      nota: string;
      debeReintentar: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('no_contactar');
    expect(body.nota).toBe('lead ya cerrado como no_contactar');
    expect(body.debeReintentar).toBe(false);

    expect(mockLeadService.transition).not.toHaveBeenCalled();
    expect(mockColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('cubre cualquier terminal, sin importar el desenlace reportado', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'no_interesado',
      intentos: 2,
    });

    const res = await handleRegistrarResultado(toolCallRegistrar('error_tecnico'), CTX);

    const body = JSON.parse(res.result) as { ok: boolean; nota: string };
    expect(body.ok).toBe(true);
    expect(body.nota).toBe('lead ya cerrado como no_interesado');
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('con lead NO terminal sigue transicionando normal', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'llamado',
      intentos: 1,
    });
    mockLeadService.transition.mockResolvedValue({});

    const res = await handleRegistrarResultado(toolCallRegistrar('no_interesado'), CTX);

    const body = JSON.parse(res.result) as { ok: boolean; nuevoStatus: string };
    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('no_interesado');
    expect(mockLeadService.transition).toHaveBeenCalledWith(
      'lead-123',
      'no_interesado',
      expect.objectContaining({ nota: expect.stringContaining('no interesado') }),
    );
  });
});

// ─── Tests C1: fallo de book() no vara al lead en acepto ─────────────────────

describe('handleAgendarCita — C1: fallo de Calendar deja al lead recuperable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadModel.updateOne.mockResolvedValue({});
  });

  it('flujo compuesto: acepto interés → book falla → error_tecnico → lead recuperable', async () => {
    // Lead en 'llamado' (aceptó durante la llamada); Calendar caído.
    const lead = { _id: 'lead-123', status: 'llamado', intentos: 1, ultimaLlamada: new Date() };
    mockLeadService.findById.mockResolvedValue(lead);
    mockBook.mockRejectedValue(new Error('Calendar API no disponible'));

    // 1. agendar_cita falla
    const resAgendar = await handleAgendarCita(toolCallAgendar(), CTX);
    const bodyAgendar = JSON.parse(resAgendar.result) as {
      ok: boolean;
      codigo: string;
      error: string;
    };
    expect(bodyAgendar.ok).toBe(false);
    // Falla real de Calendar (no un slot ocupado) → ERROR_TECNICO, el código
    // que dispara la regla de disculpa técnica + colgado en el prompt.
    expect(bodyAgendar.codigo).toBe('ERROR_TECNICO');

    // El handler NO transiciona a 'acepto' por su cuenta — eso ocurre dentro
    // de book() solo después de crear el evento. El lead sigue en 'llamado'.
    expect(mockLeadService.transition).not.toHaveBeenCalled();

    // 2. El agente cierra con registrar_resultado(error_tecnico) en la misma
    //    llamada: el lead va a listo_llamar con reintento programado.
    mockLeadService.transition.mockResolvedValue({});
    const resRegistrar = await handleRegistrarResultado(toolCallRegistrar('error_tecnico'), CTX);
    const bodyRegistrar = JSON.parse(resRegistrar.result) as {
      ok: boolean;
      nuevoStatus: string;
      debeReintentar: boolean;
    };

    expect(bodyRegistrar.ok).toBe(true);
    expect(bodyRegistrar.nuevoStatus).toBe('listo_llamar');
    expect(bodyRegistrar.debeReintentar).toBe(true);
    expect(mockLeadService.transition).toHaveBeenCalledWith(
      'lead-123',
      'listo_llamar',
      expect.anything(),
    );
    expect(mockColaService.scheduleRetry).toHaveBeenCalledWith('lead-123', expect.any(Date));
  });

  it('book exitoso desde llamado: el handler delega la transición a book() y devuelve folio', async () => {
    mockLeadService.findById
      .mockResolvedValueOnce({ _id: 'lead-123', status: 'llamado' })
      .mockResolvedValueOnce({
        _id: 'lead-123',
        status: 'agendado',
        cita: { googleEventId: 'evt-9', meetUrl: null },
      });
    mockBook.mockResolvedValue(undefined);

    const res = await handleAgendarCita(toolCallAgendar(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; folio: string };

    expect(body.ok).toBe(true);
    expect(body.folio).toBe('evt-9');
    // Sin consienteWhatsapp en los argumentos, el default es NO enviar.
    expect(mockBook).toHaveBeenCalledWith('lead-123', '2026-08-03T17:00:00', 'virtual', {
      enviar: false,
    });
    // Toda transición vive en book(); el handler no toca la máquina de estados.
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });
});

// ─── Bug 21 jul: slot ocupado NO es falla técnica ────────────────────────────

describe('handleAgendarCita — slot ocupado: distinto de una falla técnica real', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadModel.updateOne.mockResolvedValue({});
  });

  it('SlotNoDisponibleError → codigo: SLOT_OCUPADO (no ERROR_TECNICO), lead sin transición', async () => {
    // Antes ambos casos (slot ocupado vs Calendar caído) devolvían el mismo
    // { ok:false, error } genérico y el modelo aplicaba la regla de falla
    // técnica para los dos — colgando cuando en realidad solo debía reofertar.
    const lead = { _id: 'lead-123', status: 'llamado', intentos: 1, ultimaLlamada: new Date() };
    mockLeadService.findById.mockResolvedValue(lead);
    mockBook.mockRejectedValue(new SlotNoDisponibleError('2026-08-03T17:00:00'));

    const res = await handleAgendarCita(toolCallAgendar(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; codigo: string; error: string };

    expect(body.ok).toBe(false);
    expect(body.codigo).toBe('SLOT_OCUPADO');
    expect(body.codigo).not.toBe('ERROR_TECNICO');
    // Igual que con cualquier fallo de book(): el lead no se toca aquí, sigue
    // recuperable en 'llamado' (el modelo debe reofertar, no cerrar la llamada).
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('error genérico de Calendar → codigo: ERROR_TECNICO', async () => {
    mockLeadService.findById.mockResolvedValue({ _id: 'lead-123', status: 'llamado' });
    mockBook.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await handleAgendarCita(toolCallAgendar(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; codigo: string };

    expect(body.ok).toBe(false);
    expect(body.codigo).toBe('ERROR_TECNICO');
  });
});

// ─── Consentimiento WhatsApp y número alterno ────────────────────────────────

describe('handleAgendarCita — consentimiento WhatsApp y número alterno', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadModel.updateOne.mockResolvedValue({});
    mockLeadService.findById
      .mockResolvedValueOnce({ _id: 'lead-123', status: 'llamado' })
      .mockResolvedValueOnce({
        _id: 'lead-123',
        status: 'agendado',
        cita: { googleEventId: 'evt-9', meetUrl: null },
      });
    mockBook.mockResolvedValue(undefined);
  });

  it('sin consentimiento: book recibe enviar:false y el resultado lo refleja', async () => {
    const res = await handleAgendarCita(toolCallAgendar({ consienteWhatsapp: false }), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; whatsappEnviado: boolean };

    expect(body.ok).toBe(true);
    expect(body.whatsappEnviado).toBe(false);
    expect(mockBook).toHaveBeenCalledWith('lead-123', '2026-08-03T17:00:00', 'virtual', {
      enviar: false,
    });
    // El consentimiento (false) se persiste en el lead de todas formas.
    expect(mockLeadModel.updateOne).toHaveBeenCalledWith(
      { _id: 'lead-123' },
      expect.objectContaining({ $set: { consienteWhatsapp: false } }),
    );
  });

  it('consiente al número de la llamada: enviar:true sin destino alterno', async () => {
    const res = await handleAgendarCita(toolCallAgendar({ consienteWhatsapp: true }), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; whatsappEnviado: boolean };

    expect(body.ok).toBe(true);
    expect(body.whatsappEnviado).toBe(true);
    expect(mockBook).toHaveBeenCalledWith('lead-123', '2026-08-03T17:00:00', 'virtual', {
      enviar: true,
    });
  });

  it('alterno válido: se normaliza a E.164, se persiste y se usa como destino', async () => {
    const res = await handleAgendarCita(
      toolCallAgendar({ consienteWhatsapp: true, whatsappAlterno: '492 111 2233' }),
      CTX,
    );
    const body = JSON.parse(res.result) as { ok: boolean; whatsappEnviado: boolean };

    expect(body.ok).toBe(true);
    expect(body.whatsappEnviado).toBe(true);
    expect(mockBook).toHaveBeenCalledWith('lead-123', '2026-08-03T17:00:00', 'virtual', {
      enviar: true,
      destino: '+524921112233',
    });
    expect(mockLeadModel.updateOne).toHaveBeenCalledWith(
      { _id: 'lead-123' },
      expect.objectContaining({
        $set: { consienteWhatsapp: true, whatsappAlterno: '+524921112233' },
      }),
    );
  });

  it('alterno inválido: se ignora con nota y NO se envía nada', async () => {
    const res = await handleAgendarCita(
      toolCallAgendar({ consienteWhatsapp: true, whatsappAlterno: '123' }),
      CTX,
    );
    const body = JSON.parse(res.result) as { ok: boolean; whatsappEnviado: boolean };

    // La cita SÍ se agenda; solo se suprime el envío.
    expect(body.ok).toBe(true);
    expect(body.whatsappEnviado).toBe(false);
    expect(mockBook).toHaveBeenCalledWith('lead-123', '2026-08-03T17:00:00', 'virtual', {
      enviar: false,
    });

    const update = mockLeadModel.updateOne.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
      $push?: { notas?: { $each: string[] } };
    };
    // El alterno inválido NO se persiste como whatsappAlterno…
    expect(update.$set).toEqual({ consienteWhatsapp: true });
    // …y queda nota para que un asesor complete el registro.
    expect(update.$push?.notas?.$each.join(' ')).toContain('WhatsApp alterno inválido');
  });
});

// ─── Tests A3: DNC forzoso que nunca falla ────────────────────────────────────

describe('handleMarcarNoContactar — A3: DNC forzoso', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadModel.updateOne.mockResolvedValue({});
  });

  it('desde llamado: transiciona a no_contactar y persiste flag + nota', async () => {
    mockLeadService.findById.mockResolvedValue({ _id: 'lead-123', status: 'llamado' });
    mockLeadService.transition.mockResolvedValue({ status: 'no_contactar' });

    const res = await handleMarcarNoContactar(toolCallDnc('no quiere seguros'), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; status: string; noContactar: boolean };

    expect(body.ok).toBe(true);
    expect(body.status).toBe('no_contactar');
    expect(body.noContactar).toBe(true);
    expect(mockLeadModel.updateOne).toHaveBeenCalledWith(
      { _id: 'lead-123' },
      { $set: { noContactar: true }, $push: { notas: 'DNC solicitado: no quiere seguros' } },
    );
  });

  it('desde acepto (transición ilegal): idempotente, flag persistido, responde ok', async () => {
    mockLeadService.findById.mockResolvedValue({ _id: 'lead-123', status: 'acepto' });
    mockLeadService.transition.mockRejectedValue(
      new InvalidTransitionError('acepto', 'no_contactar'),
    );

    const res = await handleMarcarNoContactar(toolCallDnc(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; status: string; noContactar: boolean };

    expect(body.ok).toBe(true);
    expect(body.status).toBe('acepto');
    expect(body.noContactar).toBe(true);
    expect(mockLeadModel.updateOne).toHaveBeenCalledWith(
      { _id: 'lead-123' },
      expect.objectContaining({ $set: { noContactar: true } }),
    );
  });

  it('desde terminal (agendado): idempotente, flag persistido, responde ok', async () => {
    mockLeadService.findById.mockResolvedValue({ _id: 'lead-123', status: 'agendado' });
    mockLeadService.transition.mockRejectedValue(
      new InvalidTransitionError('agendado', 'no_contactar'),
    );

    const res = await handleMarcarNoContactar(toolCallDnc(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; status: string; noContactar: boolean };

    expect(body.ok).toBe(true);
    expect(body.status).toBe('agendado');
    expect(body.noContactar).toBe(true);
    expect(mockLeadModel.updateOne).toHaveBeenCalled();
  });

  it('ya en no_contactar: no reintenta la transición y responde ok', async () => {
    mockLeadService.findById.mockResolvedValue({ _id: 'lead-123', status: 'no_contactar' });

    const res = await handleMarcarNoContactar(toolCallDnc(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; status: string; noContactar: boolean };

    expect(body.ok).toBe(true);
    expect(body.status).toBe('no_contactar');
    expect(body.noContactar).toBe(true);
    expect(mockLeadService.transition).not.toHaveBeenCalled();
    // El flag se persiste de todas formas — marca inequívoca.
    expect(mockLeadModel.updateOne).toHaveBeenCalledWith(
      { _id: 'lead-123' },
      expect.objectContaining({ $set: { noContactar: true } }),
    );
  });
});

// ─── Tests Fix #1: DNC ignorado en agendado ──────────────────────────────────

describe('handleAgendarCita — Fix #1: lead con noContactar=true rechazado sin evento ni WhatsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadModel.updateOne.mockResolvedValue({});
  });

  it('noContactar=true → ok:false, sin llamar a book(), sin evento en Calendar', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'llamado',
      intentos: 1,
      noContactar: true,
    });

    const res = await handleAgendarCita(toolCallAgendar({ consienteWhatsapp: true }), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; error: string };

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/DNC/i);

    // book() no debe haberse llamado — sin evento en Calendar, sin WhatsApp
    expect(mockBook).not.toHaveBeenCalled();
    // La máquina de estados tampoco se toca
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('noContactar=false → flujo normal (book llamado)', async () => {
    mockLeadService.findById
      .mockResolvedValueOnce({ _id: 'lead-123', status: 'llamado', intentos: 1, noContactar: false })
      .mockResolvedValueOnce({ _id: 'lead-123', status: 'agendado', cita: { googleEventId: 'evt-ok', meetUrl: null } });
    mockBook.mockResolvedValue(undefined);

    const res = await handleAgendarCita(toolCallAgendar(), CTX);
    const body = JSON.parse(res.result) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(mockBook).toHaveBeenCalledOnce();
  });
});

// ─── Tests Fix #2: registrar_resultado(acepto) idempotente ───────────────────

describe('handleRegistrarResultado — Fix #2: idempotencia acepto sobre lead ya en acepto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lead ya en acepto + desenlace acepto → ok idempotente, sin transición', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'acepto',
      intentos: 1,
    });

    const res = await handleRegistrarResultado(toolCallRegistrar('acepto'), CTX);
    const body = JSON.parse(res.result) as {
      ok: boolean;
      nuevoStatus: string;
      nota: string;
      debeReintentar: boolean;
    };

    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('acepto');
    expect(body.debeReintentar).toBe(false);

    // NO debe intentar la transición (acepto→acepto no es un edge legal)
    expect(mockLeadService.transition).not.toHaveBeenCalled();
    expect(mockColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('lead en llamado + desenlace acepto → transición normal a acepto', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'llamado',
      intentos: 1,
    });
    mockLeadService.transition.mockResolvedValue({ status: 'acepto' });

    const res = await handleRegistrarResultado(toolCallRegistrar('acepto'), CTX);
    const body = JSON.parse(res.result) as { ok: boolean; nuevoStatus: string };

    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('acepto');
    expect(mockLeadService.transition).toHaveBeenCalledWith(
      'lead-123',
      'acepto',
      expect.anything(),
    );
  });
});

