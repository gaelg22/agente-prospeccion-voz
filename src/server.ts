import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { connectDB, disconnectDB, dbReadyState } from './db';
import { logger } from './lib/logger';
import { errorMiddleware } from './middleware/error.middleware';
import { leadRoutes } from './modules/leads/lead.routes';
import { ingestaRoutes } from './modules/ingesta/ingesta.routes';
import { vapiWebhookRouter } from './modules/agente-voz/vapi.webhook';
import { getAgendaInstance, startAgenda } from './modules/cola/agenda';
import { devRoutes } from './modules/leads/dev.routes';


const DB_STATE_LABELS: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

export function buildApp(): express.Application {
  const app = express();

  // ── Request logging ───────────────────────────────────────────────────────
  app.use(pinoHttp({ logger }));

  // ── Body parsers ──────────────────────────────────────────────────────────
  app.use(express.json());

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    const dbState = dbReadyState();
    const dbLabel = DB_STATE_LABELS[dbState] ?? 'unknown';
    const isHealthy = dbState === 1; // readyState 1 = connected

    res.status(isHealthy ? 200 : 503).json({
      ok: isHealthy,
      env: config.NODE_ENV,
      db: {
        state: dbLabel,
        readyState: dbState,
      },
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/leads', leadRoutes);
  app.use('/ingesta', ingestaRoutes);
  app.use('/webhooks/vapi', vapiWebhookRouter);

  // ── Rutas de desarrollo (solo fuera de producción) ────────────────────────
  if (config.NODE_ENV !== 'production') {
    app.use('/dev', devRoutes);
    logger.warn('Rutas /dev activas — deshabilitar en producción');
  }


  // ── Central error handler (debe ser el último middleware) ─────────────────
  app.use(errorMiddleware);

  return app;
}

// ── Self-check de PUBLIC_URL (solo fuera de producción) ───────────────────────
// Los quick tunnels de cloudflare rotan de URL en cada arranque; si .env quedó
// con una URL muerta, las tools de Vapi fallan con ENOTFOUND a mitad de la
// llamada. Este check avisa al arrancar — no tumba el proceso.
// Reintenta porque un túnel recién creado puede tardar en propagarse en el DNS
// local aunque ya sea alcanzable desde afuera (Vapi resuelve por su cuenta).
async function checkPublicUrl(): Promise<void> {
  const url = `${config.PUBLIC_URL.replace(/\/+$/, '')}/health`;
  const intentos = 4;
  const pausaMs = 15_000;

  let ultimoError = 'desconocido';
  for (let i = 1; i <= intentos; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`respondió con status ${res.status}`);
      logger.info({ url, intento: i }, 'PUBLIC_URL responde — las tools de Vapi pueden llegar');
      return;
    } catch (err) {
      ultimoError = err instanceof Error ? err.message : String(err);
      if (i < intentos) {
        logger.debug({ url, intento: i, err: ultimoError }, 'PUBLIC_URL no respondió — reintentando');
        await new Promise((r) => setTimeout(r, pausaMs));
      }
    }
  }

  logger.warn(
    { url, err: ultimoError },
    '\n' +
      '⚠️ ═══════════════════════════════════════════════════════════════════\n' +
      '⚠️  PUBLIC_URL NO RESPONDE — LAS TOOLS DE VAPI NO PODRÁN LLEGAR AQUÍ\n' +
      `⚠️  GET ${url} falló ${intentos} veces (timeout 5 s c/u).\n` +
      '⚠️  Si el túnel de cloudflare rotó, arranca con: npm run dev:tunnel\n' +
      '⚠️  (actualiza PUBLIC_URL en .env y levanta el server ya alineados).\n' +
      '⚠️  Ojo: si el túnel se acaba de crear, puede ser solo propagación DNS\n' +
      '⚠️  local — Vapi resuelve por su cuenta; verifica con: nslookup <host> 1.1.1.1\n' +
      '⚠️ ═══════════════════════════════════════════════════════════════════',
  );
}

async function main(): Promise<void> {
  await connectDB();
  await startAgenda();

  const app = buildApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, '🚀 Servidor escuchando');

    if (config.NODE_ENV !== 'production') {
      void checkPublicUrl();
    }
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Apagado iniciado…');

    server.close(async () => {
      try {
        const agenda = getAgendaInstance();
        if (agenda) await agenda.stop();
        await disconnectDB();
        logger.info('Apagado completo');
      } catch (err) {
        logger.error({ err }, 'Error durante el apagado');
      } finally {
        process.exit(0);
      }
    });

    // Forzar salida si el shutdown tarda más de 10 s
    setTimeout(() => {
      logger.error('Timeout de apagado — salida forzada');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'Error fatal durante el arranque');
  process.exit(1);
});
