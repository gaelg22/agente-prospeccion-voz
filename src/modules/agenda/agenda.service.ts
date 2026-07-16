import { Types } from 'mongoose';
import { logger } from '../../lib/logger';
import { LeadService } from '../leads/lead.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { CalendarClient } from './calendar.client';
import { getAvailableSlots } from './slots';
import { Modalidad, duracionHoras } from './modalidad';

// ─── Errores de dominio ───────────────────────────────────────────────────────

/**
 * El slot elegido por el prospecto ya no está disponible en Calendar.
 * Ocurre cuando dos llamadas en paralelo eligen el mismo hueco o cuando
 * el hueco se ocupa entre verificar_disponibilidad y agendar_cita.
 * El handler de agendar_cita devuelve { ok: false } al LLM; el lead
 * queda en llamado y el job de reconciliación lo reintenta.
 */
export class SlotNoDisponibleError extends Error {
  readonly slotIso: string;
  constructor(slotIso: string) {
    super(`El slot ${slotIso} ya no está disponible en Calendar`);
    this.name = 'SlotNoDisponibleError';
    this.slotIso = slotIso;
  }
}


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
   * Books a calendar slot for a lead in `llamado` (aceptó durante la llamada)
   * o `acepto`. La duración depende de la modalidad: virtual = 1 h,
   * presencial = 2 h (1 h de cita + 1 h de traslado del asesor). El link de
   * Meet solo se pide en modalidad virtual. Transitions lead to `agendado`
   * and sends WhatsApp confirmation. This is the TERMINAL action — the lead
   * cycle ends here.
   *
   * La máquina de estados solo avanza DESPUÉS de crear el evento en Calendar:
   * si Calendar falla, el lead se queda en su status actual. En `llamado`
   * sigue siendo recuperable (registrar_resultado(error_tecnico) → reintento,
   * o barrido de reconciliación); no queda varado en `acepto`.
   *
   * @param leadId The lead's MongoDB ObjectId or string
   * @param slotIso ISO datetime string for the slot start (e.g. "2025-08-01T10:00:00")
   * @param modalidad 'virtual' (default) o 'presencial'
   */
  async book(
    leadId: string | Types.ObjectId,
    slotIso: string,
    modalidad: Modalidad = 'virtual',
  ): Promise<void> {
    const lead = await LeadService.findById(String(leadId));
    if (!lead) throw new Error(`Lead not found: ${String(leadId)}`);

    if (lead.status !== 'acepto' && lead.status !== 'llamado') {
      throw new Error(`Lead must be in 'llamado' or 'acepto' status to book. Current: ${lead.status}`);
    }

    const duracion = duracionHoras(modalidad);

    // Derive end time (duracion hours after start) manipulating the ISO string
    // directly. Usar Date.toISOString() produciría una cadena UTC que Calendar
    // interpretaría como hora local de México, desplazando el fin 6-7 horas.
    // slotIso viene en formato "YYYY-MM-DDTHH:mm:ss" en hora local de México.
    const startDate = new Date(`${slotIso}-06:00`); // para la confirmación de Kapso
    const [slotDate, slotTime = '00:00:00'] = slotIso.split('T');
    const [hhStr = '0', mmStr = '00', ssStr = '00'] = slotTime.split(':');
    const endHour = parseInt(hhStr, 10) + duracion;
    let endDate: string;
    if (endHour >= 24) {
      // Avance de día — usar UTC noon para evitar problemas de DST
      const d = new Date(`${slotDate}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = `${d.toISOString().slice(0, 10)}T00:${mmStr}:${ssStr}`;
    } else {
      endDate = `${slotDate}T${String(endHour).padStart(2, '0')}:${mmStr}:${ssStr}`;
    }

    logger.info({ leadId: String(leadId), slotIso, modalidad }, 'Booking calendar slot');

    // ── A4: Revalidación justo antes de crear el evento ───────────────────────
    // El LLM eligió este slot durante verificar_disponibilidad, pero puede haber
    // pasado tiempo desde entonces. Se consulta Calendar de nuevo para asegurarse
    // de que el slot sigue libre. Si ya está ocupado, se lanza SlotNoDisponibleError
    // y el handler devuelve { ok: false } al LLM sin tocar el status del lead.
    const startHour = parseInt(hhStr, 10);
    const slotsLibres = await getAvailableSlots(slotDate ?? '', this.calendar, duracion);
    const slotValido = slotsLibres.some((s) => s.startHour === startHour);
    if (!slotValido) {
      logger.warn({ leadId: String(leadId), slotIso }, 'Slot ya no disponible al intentar agendar');
      throw new SlotNoDisponibleError(slotIso);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const esPresencial = modalidad === 'presencial';
    const modalidadLabel = esPresencial ? 'Presencial' : 'Videollamada';

    const event = await this.calendar.createEvent({
      summary: `Cita Seguro (${modalidadLabel}) — ${lead.razonSocial}`,
      description: [
        `Lead: ${lead.razonSocial}`,
        `Actividad: ${lead.actividadEconomica}`,
        `Tel: ${lead.telefono ?? 'N/A'}`,
        `Modalidad: ${modalidadLabel} (${duracion} h)`,
        `Municipio: ${lead.direccion.municipio}, ${lead.direccion.estado}`,
      ].join('\n'),
      startIso: slotIso,
      endIso: endDate,
      // Presencial no lleva Meet.
      withMeet: !esPresencial,
    });

    // El evento ya existe en Calendar — solo ahora se avanza la máquina de
    // estados. Si el lead venía de 'llamado' se pasa primero por 'acepto'
    // (único edge legal hacia 'agendado').
    if (lead.status === 'llamado') {
      await LeadService.transition(lead._id, 'acepto', {
        nota: 'Aceptó durante la llamada — confirmado al crear la cita',
      });
    }

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

    // Send WhatsApp confirmation — best-effort, no debe bloquear el agendado
    // Si Kapso no está configurado o falla, se loguea y se continúa.
    try {
      await this.notificaciones.sendBookingConfirmation(lead, {
        citaFecha: startDate,
        meetUrl: event.meetUrl,
        modalidad,
      });
      logger.info({ leadId: String(leadId), eventId: event.eventId }, 'Lead agendado — cycle complete');
    } catch (notifErr) {
      logger.warn(
        { err: notifErr, leadId: String(leadId) },
        'WhatsApp no enviado (Kapso no configurado o error de red) — cita agendada de todas formas',
      );
    }
  }

  /**
   * Returns available slots for a given day.
   */
  async getSlots(dayIso: string): Promise<ReturnType<typeof getAvailableSlots>> {
    return getAvailableSlots(dayIso, this.calendar);
  }
}
