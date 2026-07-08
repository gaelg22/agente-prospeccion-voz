import { Types } from 'mongoose';
import { logger } from '../../lib/logger';
import { LeadService } from '../leads/lead.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { CalendarClient } from './calendar.client';
import { getAvailableSlots } from './slots';

export class AgendaService {
  private readonly calendar: CalendarClient;
  private readonly notificaciones: NotificacionesService;

  constructor(
    calendar: CalendarClient = new CalendarClient(),
    notificaciones: NotificacionesService = new NotificacionesService(),
  ) {
    this.calendar = calendar;
    this.notificaciones = notificaciones;
  }

  /**
   * Books a 1-hour calendar slot for a lead that has accepted (status=acepto).
   * Transitions lead to `agendado` and sends WhatsApp confirmation.
   * This is the TERMINAL action — the lead cycle ends here.
   *
   * @param leadId The lead's MongoDB ObjectId or string
   * @param slotIso ISO datetime string for the slot start (e.g. "2025-08-01T10:00:00")
   */
  async book(leadId: string | Types.ObjectId, slotIso: string): Promise<void> {
    const lead = await LeadService.findById(String(leadId));
    if (!lead) throw new Error(`Lead not found: ${String(leadId)}`);

    if (lead.status !== 'acepto') {
      throw new Error(`Lead must be in 'acepto' status to book. Current: ${lead.status}`);
    }

    // Derive end time (1 hour later)
    const startDate = new Date(slotIso);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1_000);
    const endIso = endDate.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"

    logger.info({ leadId: String(leadId), slotIso }, 'Booking calendar slot');

    const event = await this.calendar.createEvent({
      summary: `Cita Seguro — ${lead.razonSocial}`,
      description: [
        `Lead: ${lead.razonSocial}`,
        `Actividad: ${lead.actividadEconomica}`,
        `Tel: ${lead.telefono ?? 'N/A'}`,
        `Municipio: ${lead.direccion.municipio}, ${lead.direccion.estado}`,
      ].join('\n'),
      startIso: slotIso,
      endIso,
    });

    // Transition to agendado — terminal status
    await LeadService.transition(lead._id, 'agendado', {
      cita: {
        googleEventId: event.eventId,
        fecha: startDate,
        meetUrl: event.meetUrl,
        confirmacionEnviada: false,
      },
      nota: `Cita agendada: ${event.htmlLink ?? event.eventId}`,
    });

    // Send WhatsApp confirmation — terminal action
    await this.notificaciones.sendBookingConfirmation(lead, {
      citaFecha: startDate,
      meetUrl: event.meetUrl,
    });

    logger.info({ leadId: String(leadId), eventId: event.eventId }, 'Lead agendado — cycle complete');
  }

  /**
   * Returns available slots for a given day.
   */
  async getSlots(dayIso: string): Promise<ReturnType<typeof getAvailableSlots>> {
    return getAvailableSlots(dayIso, this.calendar);
  }
}
