import Agenda, { Job } from 'agenda';
import { logger } from '../../../lib/logger';
import { isInCallingWindow } from '../../../lib/calling-window';
import { LeadService } from '../../leads/lead.service';
import { VapiClient } from '../../agente-voz/vapi.client';

export const JOB_NAME_MARCAR = 'marcar-llamada';

export function defineMarcarLlamadaJob(agenda: Agenda): void {
  agenda.define(JOB_NAME_MARCAR, { concurrency: 1 }, async (_job: Job) => {
    if (!isInCallingWindow()) {
      logger.debug('Outside calling window — skipping marcar-llamada');
      return;
    }

    const lead = await LeadService.findNextToCall();
    if (!lead) {
      logger.debug('No leads ready to call');
      return;
    }

    if (!lead.telefono) {
      logger.warn({ leadId: lead._id.toString() }, 'Lead has no phone — skipping');
      await LeadService.transition(lead._id, 'no_contactable', {
        nota: 'Sin teléfono válido al momento de marcar',
      });
      return;
    }

    logger.info({ leadId: lead._id.toString(), telefono: lead.telefono }, 'Initiating Vapi call');

    const vapiClient = new VapiClient();
    const call = await vapiClient.createCall(lead.telefono, {
      leadId: lead._id.toString(),
      razonSocial: lead.razonSocial,
    });

    await LeadService.transition(lead._id, 'llamado', {
      vapiCallId: call.id,
      nota: `Llamada iniciada: ${call.id}`,
    });
  });
}
