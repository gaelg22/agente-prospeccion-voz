import { config } from '../../config';
import { logger } from '../../lib/logger';
import { ILead } from '../leads/lead.schema';
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
    cita: { citaFecha: Date; meetUrl: string | null },
  ): Promise<void> {
    if (!lead.telefono) {
      logger.warn({ razonSocial: lead.razonSocial }, 'Cannot send WhatsApp — no phone number');
      return;
    }

    const fechaFormateada = formatDateTime(cita.citaFecha);
    const meetLink = cita.meetUrl ?? 'El enlace se enviará próximamente';

    try {
      await this.kapso.sendTemplate({
        to: lead.telefono,
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
}
