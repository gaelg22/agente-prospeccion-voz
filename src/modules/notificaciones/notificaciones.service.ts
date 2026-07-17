import { config } from '../../config';
import { logger } from '../../lib/logger';
import { ILead } from '../leads/lead.schema';
import { Modalidad } from '../agenda/modalidad';
import { KapsoClient } from './kapso.client';

const TZ = 'America/Mexico_City';

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export class NotificacionesService {
  private readonly kapso: KapsoClient;

  constructor(kapso: KapsoClient = new KapsoClient()) {
    this.kapso = kapso;
  }

  /**
   * Sends the WhatsApp booking confirmation to the lead.
   * This is the LAST step of the lead cycle — call only after lead is `agendado`.
   */
  async sendBookingConfirmation(
    lead: Pick<ILead, 'razonSocial' | 'telefono'>,
    cita: { citaFecha: Date; meetUrl: string | null; modalidad?: Modalidad; telefonoDestino?: string },
  ): Promise<void> {
    // telefonoDestino: número alterno confirmado por voz y ya validado (E.164).
    // Sin él, el destino es el número de la llamada.
    const destino = cita.telefonoDestino ?? lead.telefono;
    if (!destino) {
      logger.warn({ razonSocial: lead.razonSocial }, 'Cannot send WhatsApp — no phone number');
      return;
    }

    const fechaFormateada = formatDateTime(cita.citaFecha);
    // En presencial no hay liga de videollamada: la variable meet_link del
    // template lleva la nota de que el asesor acude en persona.
    const meetLink =
      cita.modalidad === 'presencial'
        ? 'Cita presencial: el asesor acudirá con usted en la fecha indicada.'
        : cita.meetUrl ?? 'El enlace se enviará próximamente';

    try {
      await this.kapso.sendTemplate({
        to: destino,
        templateName: config.KAPSO_WHATSAPP_TEMPLATE,
        variables: {
          razon_social: lead.razonSocial,
          fecha_cita: fechaFormateada,
          meet_link: meetLink,
        },
      });
      logger.info({ razonSocial: lead.razonSocial }, 'Booking confirmation WhatsApp sent');
    } catch (err) {
      // Log but do not throw — the lead is already agendado; WhatsApp failure is non-fatal
      logger.error({ err, razonSocial: lead.razonSocial }, 'Failed to send WhatsApp confirmation');
    }
  }

  /**
   * Aviso interno al ASESOR de que quedó una cita agendada. Se envía en TODO
   * agendado exitoso (haya o no consentido el prospecto su WhatsApp); cuando
   * contactarDirecto=true, la nota le pide contactar al prospecto directamente
   * para hacerle llegar los datos. Best-effort: nunca lanza — si Kapso falla
   * se loguea; sin ASESOR_WHATSAPP configurada se salta con log claro.
   */
  async sendAdvisorNotice(
    lead: Pick<ILead, 'razonSocial' | 'telefono'>,
    cita: { citaFecha: Date; modalidad?: Modalidad; folio: string; contactarDirecto: boolean },
  ): Promise<void> {
    const destino = config.ASESOR_WHATSAPP;
    if (!destino) {
      logger.info(
        { razonSocial: lead.razonSocial, folio: cita.folio },
        'ASESOR_WHATSAPP no configurada — aviso al asesor omitido',
      );
      return;
    }

    const nota = cita.contactarDirecto
      ? 'El prospecto NO quiso la invitación por WhatsApp: contactar directamente para enviarle los datos.'
      : 'El prospecto recibió su confirmación por WhatsApp.';

    try {
      await this.kapso.sendTemplate({
        to: destino,
        templateName: config.KAPSO_ASESOR_TEMPLATE,
        variables: {
          razon_social: lead.razonSocial,
          fecha_cita: formatDateTime(cita.citaFecha),
          modalidad: cita.modalidad === 'presencial' ? 'Presencial' : 'Videollamada',
          folio: cita.folio,
          telefono_prospecto: lead.telefono ?? 'N/A',
          nota,
        },
      });
      logger.info(
        { razonSocial: lead.razonSocial, folio: cita.folio, contactarDirecto: cita.contactarDirecto },
        'Advisor notice WhatsApp sent',
      );
    } catch (err) {
      // Log but do not throw — la cita ya quedó agendada; el aviso es best-effort
      logger.error({ err, razonSocial: lead.razonSocial }, 'Failed to send advisor notice');
    }
  }
}
