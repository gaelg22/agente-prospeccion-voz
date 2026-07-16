import { getAgendaInstance } from './agenda';
import { nextDayOppositeSlot, isMorningSlot } from '../../lib/calling-window';
import { JOB_NAME_REINTENTO } from './jobs/reintento.job';
import { logger } from '../../lib/logger';
import { Lead } from '../leads/lead.schema';

export const ColaService = {
  /**
   * Schedules a retry call for `leadId` on the next calendar day
   * in the slot opposite to `originalCallTime`.
   * Only valid if lead has had exactly 1 attempt (business rule: 1 retry only).
   *
   * También pone un embargo temporal en el lead (noLlamarAntesDe = runAt)
   * para que marcar-llamada no lo recoja antes de que llegue el slot de
   * reintento. Sin esto, el lead quedaría en listo_llamar y la cola lo
   * volvería a marcar en 10 minutos, gastando el 2º intento prematuramente.
   */
  async scheduleRetry(leadId: string, originalCallTime: Date = new Date()): Promise<void> {
    const agenda = getAgendaInstance();
    if (!agenda) throw new Error('Agenda not initialized');

    const slot = isMorningSlot(originalCallTime) ? 'tarde' : 'mañana';
    const runAt = nextDayOppositeSlot(originalCallTime);

    await agenda.schedule(runAt, JOB_NAME_REINTENTO, { leadId });

    // Embargo: bloquea al lead hasta que llegue su slot de reintento.
    // $set en lugar de transition() — es metadata de scheduling, no un cambio de status.
    await Lead.updateOne({ _id: leadId }, { $set: { noLlamarAntesDe: runAt } });

    logger.info({ leadId, runAt, slot }, 'Retry scheduled — embargo establecido');
  },
};
