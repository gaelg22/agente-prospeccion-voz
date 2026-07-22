/**
 * Tests C2: verifica que ColaService.scheduleRetry() establece el embargo
 * (noLlamarAntesDe) en el lead después de programar el job de Agenda.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mocks de calling-window: nextDayOppositeSlot devuelve una fecha fija para
// hacer la aserción del embargo determinista.
// IMPORTANTE: la fecha debe estar en vi.hoisted para estar disponible cuando
// Vitest mueve los vi.mock al tope del módulo.
const { SLOT_MANANA_HOISTED, scheduleMock, updateOneMock } = vi.hoisted(() => ({
  SLOT_MANANA_HOISTED: new Date('2026-07-17T16:00:00Z'),
  scheduleMock: vi.fn().mockResolvedValue(undefined),
  updateOneMock: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
}));

vi.mock('../../../lib/calling-window', () => ({
  isMorningSlot: vi.fn().mockReturnValue(true), // llamada en la mañana → slot tarde
  nextDayOppositeSlot: vi.fn().mockReturnValue(SLOT_MANANA_HOISTED),
}));

vi.mock('../agenda', () => ({
  getAgendaInstance: vi.fn(() => ({ schedule: scheduleMock })),
}));

vi.mock('../../leads/lead.schema', () => ({
  Lead: { updateOne: updateOneMock },
}));

// reintento.job solo exporta el nombre del job — no ejecuta lógica al importarse
vi.mock('../jobs/reintento.job', () => ({
  JOB_NAME_REINTENTO: 'reintento-llamada',
}));

import { ColaService } from '../cola.service';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ColaService.scheduleRetry() — C2: embargo de marcación', () => {
  const leadId = new Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
    scheduleMock.mockResolvedValue(undefined);
    updateOneMock.mockResolvedValue({ modifiedCount: 1 });
  });

  it('agenda el job reintento-llamada con la fecha del slot opuesto', async () => {
    await ColaService.scheduleRetry(leadId);

    expect(scheduleMock).toHaveBeenCalledWith(SLOT_MANANA_HOISTED, 'reintento-llamada', { leadId });
  });

  it('establece noLlamarAntesDe en el lead con la misma fecha del slot', async () => {
    await ColaService.scheduleRetry(leadId);

    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: leadId },
      { $set: { noLlamarAntesDe: SLOT_MANANA_HOISTED } },
    );
  });

  it('el embargo y el job usan exactamente la misma fecha (sin desfase)', async () => {
    await ColaService.scheduleRetry(leadId);

    const jobDate: Date = scheduleMock.mock.calls[0]![0];
    const embargoDate: Date = updateOneMock.mock.calls[0]![1]['$set']['noLlamarAntesDe'];

    expect(embargoDate.getTime()).toBe(jobDate.getTime());
  });

  it('si Agenda falla, el error se propaga sin silenciarse', async () => {
    scheduleMock.mockRejectedValue(new Error('Agenda caído'));

    await expect(ColaService.scheduleRetry(leadId)).rejects.toThrow('Agenda caído');
    // El embargo NO debe haberse puesto si el job no se registró
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('lanza si getAgendaInstance devuelve null (agenda no inicializada)', async () => {
    const { getAgendaInstance } = await import('../agenda');
    vi.mocked(getAgendaInstance).mockReturnValueOnce(null);

    await expect(ColaService.scheduleRetry(leadId)).rejects.toThrow('Agenda not initialized');
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});
