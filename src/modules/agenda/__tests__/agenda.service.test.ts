import { describe, it, expect, vi, beforeEach } from 'vitest';

// config.ts hace process.exit() si faltan envs; calendar.client y kapso.client lo
// leen al importarse. Se mockea con lo mínimo.
vi.mock('../../../config', () => ({
  config: {
    GOOGLE_MEET_ENABLED: false,
    KAPSO_WHATSAPP_TEMPLATE: 'confirmacion_cita',
    HORARIO_SEMANAL: '-,10-20,10-20,10-20,10-20,10-20,8-12',
  },
}));

const mockLeadService = vi.hoisted(() => ({
  findById: vi.fn(),
  transition: vi.fn(),
}));
vi.mock('../../leads/lead.service', () => ({ LeadService: mockLeadService }));

import { AgendaService } from '../agenda.service';
import type { CalendarClient, CalendarEventParams } from '../calendar.client';
import type { NotificacionesService } from '../../notificaciones/notificaciones.service';

const leadAcepto = {
  _id: 'lead-1',
  status: 'acepto',
  razonSocial: 'Empresa Test S.A.',
  actividadEconomica: 'Consultorios dentales',
  telefono: '+525512345678',
  direccion: { municipio: 'Zapopan', estado: 'Jalisco' },
};

function setup(busySlots: Array<{ start: string; end: string }> = []) {
  const createEvent = vi.fn(async (_p: CalendarEventParams) => ({
    eventId: 'evt-1',
    meetUrl: null,
    htmlLink: 'https://cal/evt-1',
  }));
  const getBusySlots = vi.fn(async () => busySlots);
  const sendBookingConfirmation = vi.fn(
    async (..._args: Parameters<NotificacionesService['sendBookingConfirmation']>) => undefined,
  );
  const sendAdvisorNotice = vi.fn(
    async (..._args: Parameters<NotificacionesService['sendAdvisorNotice']>) => undefined,
  );
  const calendar = { createEvent, getBusySlots } as unknown as CalendarClient;
  const notificaciones = {
    sendBookingConfirmation,
    sendAdvisorNotice,
  } as unknown as NotificacionesService;
  const agenda = new AgendaService(calendar, notificaciones);
  return { agenda, createEvent, getBusySlots, sendBookingConfirmation, sendAdvisorNotice };
}

describe('AgendaService.book — duración del evento por modalidad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.findById.mockResolvedValue(leadAcepto);
    mockLeadService.transition.mockResolvedValue({});
  });

  it('virtual (default): evento de 1 h y sí pide Meet', async () => {
    const { agenda, createEvent, sendBookingConfirmation } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', undefined, { enviar: true });

    const params = createEvent.mock.calls[0]?.[0] as CalendarEventParams;
    expect(params.startIso).toBe('2026-08-03T17:00:00');
    expect(params.endIso).toBe('2026-08-03T18:00:00'); // +1 h
    expect(params.withMeet).toBe(true);
    const confirmArgs1 = sendBookingConfirmation.mock.calls[0] as Parameters<typeof sendBookingConfirmation>;
    expect(confirmArgs1[1]).toMatchObject({ modalidad: 'virtual' });
  });

  it('presencial: evento de 2 h y NO pide Meet', async () => {
    const { agenda, createEvent, sendBookingConfirmation } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', 'presencial', { enviar: true });

    const params = createEvent.mock.calls[0]?.[0] as CalendarEventParams;
    expect(params.startIso).toBe('2026-08-03T17:00:00');
    expect(params.endIso).toBe('2026-08-03T19:00:00'); // +2 h
    expect(params.withMeet).toBe(false);
    const confirmArgs2 = sendBookingConfirmation.mock.calls[0] as Parameters<typeof sendBookingConfirmation>;
    expect(confirmArgs2[1]).toMatchObject({ modalidad: 'presencial' });
  });
});

// ─── Consentimiento WhatsApp: sin él, cero envíos ────────────────────────────

describe('AgendaService.book — consentimiento WhatsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.findById.mockResolvedValue(leadAcepto);
    mockLeadService.transition.mockResolvedValue({});
  });

  it('sin consentimiento (default): NO envía al prospecto pero SÍ avisa al asesor con contactarDirecto', async () => {
    const { agenda, createEvent, sendBookingConfirmation, sendAdvisorNotice } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00');

    expect(createEvent).toHaveBeenCalledOnce();
    expect(mockLeadService.transition).toHaveBeenCalledWith('lead-1', 'agendado', expect.anything());
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    // El asesor SIEMPRE recibe el aviso; sin consentimiento, con la marca de
    // contactar directamente al prospecto para hacerle llegar los datos.
    expect(sendAdvisorNotice).toHaveBeenCalledOnce();
    const advisorArgs1 = sendAdvisorNotice.mock.calls[0] as Parameters<typeof sendAdvisorNotice>;
    expect(advisorArgs1[1]).toMatchObject({
      folio: 'evt-1',
      contactarDirecto: true,
    });
  });

  it('enviar:false explícito: cero envíos al prospecto, aviso al asesor con contactarDirecto', async () => {
    const { agenda, sendBookingConfirmation, sendAdvisorNotice } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', 'virtual', { enviar: false });

    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    const advisorArgs2 = sendAdvisorNotice.mock.calls[0] as Parameters<typeof sendAdvisorNotice>;
    expect(advisorArgs2[1]).toMatchObject({ contactarDirecto: true });
  });

  it('con consentimiento sin alterno: ambos envíos; el del prospecto sin telefonoDestino', async () => {
    const { agenda, sendBookingConfirmation, sendAdvisorNotice } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', 'virtual', { enviar: true });

    expect(sendBookingConfirmation).toHaveBeenCalledOnce();
    const confirmArgs3 = sendBookingConfirmation.mock.calls[0] as Parameters<typeof sendBookingConfirmation>;
    expect(confirmArgs3[1]).not.toHaveProperty('telefonoDestino');
    expect(sendAdvisorNotice).toHaveBeenCalledOnce();
    const advisorArgs3 = sendAdvisorNotice.mock.calls[0] as Parameters<typeof sendAdvisorNotice>;
    expect(advisorArgs3[1]).toMatchObject({
      folio: 'evt-1',
      contactarDirecto: false,
    });
  });

  it('con consentimiento y alterno validado: el destino es el alterno', async () => {
    const { agenda, sendBookingConfirmation } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', 'virtual', {
      enviar: true,
      destino: '+524921112233',
    });

    expect(sendBookingConfirmation).toHaveBeenCalledOnce();
    const confirmArgs4 = sendBookingConfirmation.mock.calls[0] as Parameters<typeof sendBookingConfirmation>;
    expect(confirmArgs4[1]).toMatchObject({
      telefonoDestino: '+524921112233',
    });
  });
});

// ─── C1: la máquina de estados solo avanza tras crear el evento en Calendar ──

describe('AgendaService.book — transición de status solo tras Calendar exitoso', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.transition.mockResolvedValue({});
  });

  it('desde llamado: transiciona llamado→acepto→agendado en ese orden', async () => {
    mockLeadService.findById.mockResolvedValue({ ...leadAcepto, status: 'llamado' });
    const { agenda } = setup();

    await agenda.book('lead-1', '2026-08-03T17:00:00');

    expect(mockLeadService.transition).toHaveBeenNthCalledWith(
      1,
      'lead-1',
      'acepto',
      expect.objectContaining({ nota: expect.stringContaining('Aceptó') }),
    );
    expect(mockLeadService.transition).toHaveBeenNthCalledWith(
      2,
      'lead-1',
      'agendado',
      expect.objectContaining({ cita: expect.objectContaining({ googleEventId: 'evt-1' }) }),
    );
  });

  it('si Calendar falla, NO hay ninguna transición — el lead sigue en llamado', async () => {
    mockLeadService.findById.mockResolvedValue({ ...leadAcepto, status: 'llamado' });
    const { agenda, createEvent } = setup();
    createEvent.mockRejectedValue(new Error('Calendar caído'));

    await expect(agenda.book('lead-1', '2026-08-03T17:00:00')).rejects.toThrow('Calendar caído');
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('desde acepto: transiciona directo a agendado sin paso intermedio', async () => {
    mockLeadService.findById.mockResolvedValue(leadAcepto);
    const { agenda } = setup();

    await agenda.book('lead-1', '2026-08-03T17:00:00');

    expect(mockLeadService.transition).toHaveBeenCalledTimes(1);
    expect(mockLeadService.transition).toHaveBeenCalledWith('lead-1', 'agendado', expect.anything());
  });

  it('rechaza estados distintos de llamado/acepto sin tocar Calendar ni status', async () => {
    mockLeadService.findById.mockResolvedValue({ ...leadAcepto, status: 'listo_llamar' });
    const { agenda, createEvent } = setup();

    await expect(agenda.book('lead-1', '2026-08-03T17:00:00')).rejects.toThrow(
      /must be in 'llamado' or 'acepto'/,
    );
    expect(createEvent).not.toHaveBeenCalled();
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });
});

// ─── A4: Revalidación del slot justo antes de agendar ─────────────────────────

describe('AgendaService.book — A4: revalidación de disponibilidad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.findById.mockResolvedValue(leadAcepto);
    mockLeadService.transition.mockResolvedValue({});
  });

  it('slot libre (sin ocupados): pasa la revalidación y crea el evento', async () => {
    // busySlots=[] → ningún hueco ocupado → 17:00 está libre
    const { agenda, createEvent } = setup([]);
    await agenda.book('lead-1', '2026-08-03T17:00:00');

    expect(createEvent).toHaveBeenCalledOnce();
    expect(mockLeadService.transition).toHaveBeenCalledWith('lead-1', 'agendado', expect.anything());
  });

  it('slot ocupado: lanza SlotNoDisponibleError y NO crea el evento ni transiciona', async () => {
    // getBusySlots devuelve el slot 17:00–18:00 como ocupado
    // En UTC: 17:00 MX CST = 23:00 UTC
    const busySlots = [
      { start: '2026-08-03T23:00:00Z', end: '2026-08-04T00:00:00Z' },
    ];
    const { agenda, createEvent } = setup(busySlots);

    const { SlotNoDisponibleError } = await import('../agenda.service');
    await expect(agenda.book('lead-1', '2026-08-03T17:00:00')).rejects.toThrow(SlotNoDisponibleError);
    expect(createEvent).not.toHaveBeenCalled();
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('slot en el pasado dentro de ventana: SlotNoDisponibleError sin consultar Calendar', async () => {
    // 2026-07-14 fue martes (ventana 10-20); a la hora en que corra este test
    // esa fecha siempre estará en el pasado. Sin busySlots, la revalidación
    // normal lo daría por libre — el rechazo debe ocurrir ANTES.
    const { agenda, createEvent, getBusySlots } = setup([]);

    const { SlotNoDisponibleError } = await import('../agenda.service');
    await expect(agenda.book('lead-1', '2026-07-14T17:00:00')).rejects.toThrow(SlotNoDisponibleError);
    expect(getBusySlots).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('slot ocupado: el mensaje de error incluye el slotIso pedido', async () => {
    const busySlots = [
      { start: '2026-08-03T23:00:00Z', end: '2026-08-04T00:00:00Z' },
    ];
    const { agenda } = setup(busySlots);

    const err = await agenda.book('lead-1', '2026-08-03T17:00:00').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('2026-08-03T17:00:00');
  });
});

// ─── Fix #1: DNC guard en book() — segunda línea de defensa ──────────────────
// handleAgendarCita ya rechaza antes de llamar a book(); este test cubre que
// book() también protege por si se llama directamente (p. ej. desde un job de
// reconciliación futuro). noContactar=true → throw, sin evento ni WhatsApp.

describe('AgendaService.book — Fix #1: lead con noContactar=true rechazado sin evento ni WhatsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.transition.mockResolvedValue({});
  });

  it('noContactar=true → lanza error DNC, sin crear evento en Calendar ni enviar WhatsApp', async () => {
    mockLeadService.findById.mockResolvedValue({
      ...leadAcepto,
      noContactar: true,
    });
    const { agenda, createEvent, sendBookingConfirmation, sendAdvisorNotice } = setup();

    await expect(agenda.book('lead-1', '2026-08-03T17:00:00')).rejects.toThrow(/DNC/);

    // Sin evento en Calendar
    expect(createEvent).not.toHaveBeenCalled();
    // Sin notificación al prospecto ni al asesor
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(sendAdvisorNotice).not.toHaveBeenCalled();
    // Sin cambio de status
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('noContactar=false (o ausente) → flujo normal continúa', async () => {
    mockLeadService.findById.mockResolvedValue({
      ...leadAcepto,
      noContactar: false,
    });
    const { agenda, createEvent } = setup();

    await agenda.book('lead-1', '2026-08-03T17:00:00');

    expect(createEvent).toHaveBeenCalledOnce();
    expect(mockLeadService.transition).toHaveBeenCalledWith('lead-1', 'agendado', expect.anything());
  });
});
