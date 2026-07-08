import { getAgendaInstance } from './agenda';
import { nextDayOppositeSlot, isMorningSlot } from '../../lib/calling-window';
import { JOB_NAME_REINTENTO } from './jobs/reintento.job';
import { logger } from '../../lib/logger';

export const ColaService = {
  /**
   * Schedules a retry call for `leadId` on the next calendar day
   * in the slot opposite to `originalCallTime`.
   * Only valid if lead has had exactly 1 attempt (business rule: 1 retry only).
   */
  async scheduleRetry(leadId: string, originalCallTime: Date = new Date()): Promise<void> {
    const agenda = getAgendaInstance();
    if (!agenda) throw new Error('Agenda not initialized');

    const slot = isMorningSlot(originalCallTime) ? 'tarde' : 'mañana';
    const runAt = nextDayOppositeSlot(originalCallTime);

    await agenda.schedule(runAt, JOB_NAME_REINTENTO, { leadId });
    logger.info({ leadId, runAt, slot }, 'Retry scheduled');
  },
};
