import Agenda, { Job } from 'agenda';
import { config } from '../../../config';
import { logger } from '../../../lib/logger';
import { isInCallingWindow } from '../../../lib/calling-window';
import { LeadService } from '../../leads/lead.service';
import { VapiClient } from '../../agente-voz/vapi.client';

export const JOB_NAME_REINTENTO = 'reintento-llamada';

interface ReintentoData {
  leadId: string;
}

export function defineReintentoJob(agenda: Agenda): void {
  agenda.define(JOB_NAME_REINTENTO, { concurrency: 1 }, async (job: Job<ReintentoData>) => {
    if (!config.COLA_ACTIVA) {
      logger.info('COLA_ACTIVA=false — reintento-llamada registrado pero inactivo, no se disparan llamadas');
      return;
    }

    const { leadId } = job.attrs.data;

    const lead = await LeadService.findById(leadId);
    if (!lead) {
      logger.warn({ leadId }, 'Lead not found for reintento — skipping');
      return;
    }

    // Safety: don't retry terminal or already re-queued leads
    if (lead.status !== 'listo_llamar') {
      logger.info({ leadId, status: lead.status }, 'Lead not in listo_llamar — reintento cancelled');
      return;
    }

    if (!isInCallingWindow()) {
      // Reschedule 30 min later and try again
      await job.schedule('in 30 minutes');
      await job.save();
      logger.debug({ leadId }, 'Outside window — rescheduled reintento');
      return;
    }

    if (!lead.telefono) {
      await LeadService.transition(lead._id, 'no_contactable', { nota: 'Sin teléfono en reintento' });
      return;
    }

    // Second attempt — if this also fails, the webhook handler will mark no_contactable
    const vapiClient = new VapiClient();
    const call = await vapiClient.createCall(lead.telefono, {
      leadId: lead._id.toString(),
      razonSocial: lead.razonSocial,
      esReintento: 'true',
    });

    await LeadService.transition(lead._id, 'llamado', {
      vapiCallId: call.id,
      nota: `Reintento iniciado: ${call.id}`,
    });

    logger.info({ leadId, vapiCallId: call.id }, 'Reintento call placed');
  });
}
