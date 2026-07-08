import mongoose from 'mongoose';
import { config } from './config';
import { logger } from './lib/logger';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

/**
 * Intenta conectar a MongoDB con backoff exponencial.
 * Si supera MAX_RETRIES, lanza el último error (el servidor no arrancará).
 */
export async function connectDB(): Promise<void> {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB desconectado'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconectado'));
  mongoose.connection.on('error', (err: unknown) => logger.error({ err }, 'MongoDB error'));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(config.MONGODB_URI, {
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 45_000,
      });
      logger.info({ attempt }, 'MongoDB conectado');
      return;
    } catch (err) {
      lastErr = err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn({ attempt, delay, err }, 'Fallo al conectar a MongoDB — reintentando…');
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Cierra la conexión limpiamente (llamado en SIGINT/SIGTERM).
 */
export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB desconectado (graceful)');
}

/**
 * Devuelve el estado actual de la conexión Mongoose.
 * 0=disconnected 1=connected 2=connecting 3=disconnecting
 */
export function dbReadyState(): number {
  return mongoose.connection.readyState;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
