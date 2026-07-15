import { describe, it, expect, vi, beforeEach } from 'vitest';

// config.ts hace process.exit() si faltan envs; calendar.client y kapso.client lo
// leen al importarse. Se mockea con lo mínimo.
vi.mock('../../../config', () => ({
  config: { GOOGLE_MEET_ENABLED: false, KAPSO_WHATSAPP_TEMPLATE: 'confirmacion_cita' },
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

function setup() {
  const createEvent = vi.fn(async (_p: CalendarEventParams) => ({
    eventId: 'evt-1',
    meetUrl: null,
    htmlLink: 'https://cal/evt-1',
  }));
  const sendBookingConfirmation = vi.fn(async () => undefined);
  const calendar = { createEvent } as unknown as CalendarClient;
  const notificaciones = { sendBookingConfirmation } as unknown as NotificacionesService;
  const agenda = new AgendaService(calendar, notificaciones);
  return { agenda, createEvent, sendBookingConfirmation };
}

describe('AgendaService.book — duración del evento por modalidad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeadService.findById.mockResolvedValue(leadAcepto);
    mockLeadService.transition.mockResolvedValue({});
  });

  it('virtual (default): evento de 1 h y sí pide Meet', async () => {
    const { agenda, createEvent, sendBookingConfirmation } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00');

    const params = createEvent.mock.calls[0]?.[0] as CalendarEventParams;
    expect(params.startIso).toBe('2026-08-03T17:00:00');
    expect(params.endIso).toBe('2026-08-03T18:00:00'); // +1 h
    expect(params.withMeet).toBe(true);
    expect(sendBookingConfirmation.mock.calls[0]?.[1]).toMatchObject({ modalidad: 'virtual' });
  });

  it('presencial: evento de 2 h y NO pide Meet', async () => {
    const { agenda, createEvent, sendBookingConfirmation } = setup();
    await agenda.book('lead-1', '2026-08-03T17:00:00', 'presencial');

    const params = createEvent.mock.calls[0]?.[0] as CalendarEventParams;
    expect(params.startIso).toBe('2026-08-03T17:00:00');
    expect(params.endIso).toBe('2026-08-03T19:00:00'); // +2 h
    expect(params.withMeet).toBe(false);
    expect(sendBookingConfirmation.mock.calls[0]?.[1]).toMatchObject({ modalidad: 'presencial' });
  });
});
