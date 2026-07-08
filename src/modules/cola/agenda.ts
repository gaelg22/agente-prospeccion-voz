import Agenda from 'agenda';
import mongoose from 'mongoose';
import { config } from '../../config';
import { logger } from '../../lib/logger';

let agendaInstance: Agenda | null = null;

export function getAgendaInstance(): Agenda | null {
  return agendaInstance;
}

export async function startAgenda(): Promise<Agenda> {
  // Agenda v5 expects a MongoDB connection string (db.address) rather than a Db instance
  // to avoid the type mismatch with Mongoose's Db type. We reuse the same Atlas URI.
  agendaInstance = new Agenda({
    db: {
      address: config.MONGODB_URI,
      collection: config.AGENDA_COLLECTION,
    },
    processEvery: '1 minute',
    maxConcurrency: 5,
  });

  // Register job definitions (imported here to avoid circular deps)
  const { defineMarcarLlamadaJob } = await import('./jobs/marcar-llamada.job');
  const { defineReintentoJob } = await import('./jobs/reintento.job');
  defineMarcarLlamadaJob(agendaInstance);
  defineReintentoJob(agendaInstance);

  agendaInstance.on('error', (err: Error) => logger.error({ err }, 'Agenda error'));
  agendaInstance.on('start', (job) => logger.debug({ jobName: job.attrs.name }, 'Job started'));
  agendaInstance.on('success', (job) => logger.debug({ jobName: job.attrs.name }, 'Job succeeded'));
  agendaInstance.on('fail', (err: Error, job) =>
    logger.error({ err, jobName: job.attrs.name, jobId: job.attrs._id }, 'Job failed'),
  );

  await agendaInstance.start();
  logger.info('Agenda started');

  // Schedule the recurring call cadence job
  // Using a named job without the `unique` option (not in Agenda v5 JobOptions)
  await agendaInstance.every(`${config.CALL_CADENCE_MINUTES} minutes`, 'marcar-llamada');

  return agendaInstance;
}
