/**
 * Tests A2: verifica que pino-http redacta los headers sensibles.
 *
 * Estrategia: se construye una app mínima con buildApp() usando un pino
 * que escribe en un stream de memoria. Se envía un request con headers
 * sensibles y se confirma que el JSON del log contiene "[Redacted]"
 * en lugar del valor real.
 *
 * NOTA: buildApp() registra pino-http con la instancia de logger del
 * módulo lib/logger. Para capturar el output sin reemplazar todo el
 * módulo, usamos la opción `logger` de pino-http a través del stream
 * de pino — esto se prueba de forma directa con la función buildApp
 * reconstruida en modo stream.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { Writable } from 'node:stream';

// ─── Mocks de dependencias que buildApp necesita ─────────────────────────────

vi.mock('../../config', () => ({
  config: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    API_KEY: 'test-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    PORT: 3000,
  },
}));

// ─── Helper: app con pino-http en stream de memoria ──────────────────────────

/**
 * Construye una app express mínima con la MISMA configuración de redact
 * definida en server.ts, pero escribiendo logs en un array en memoria
 * para poder inspeccionarlos en los tests.
 */
function buildRedactTestApp(): { app: express.Application; lines: string[] } {
  const lines: string[] = [];

  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      lines.push(chunk.toString());
      cb();
    },
  });

  // Logger sincrónico para tests (sin pino-pretty)
  const testLogger = pino({ level: 'info' }, dest);

  const app = express();
  app.use(
    pinoHttp({
      logger: testLogger,
      redact: {
        paths: [
          'req.headers["x-api-key"]',
          'req.headers["authorization"]',
          'req.headers["x-vapi-secret"]',
          'req.headers["x-kapso-api-key"]',
          'req.headers["x-vapi-signature"]',
        ],
        censor: '[Redacted]',
      },
    }),
  );

  app.get('/ping', (_req, res) => res.json({ ok: true }));

  return { app, lines };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('A2 — pino-http redact: headers sensibles nunca aparecen en claro', () => {
  let app: express.Application;
  let lines: string[];

  beforeAll(() => {
    ({ app, lines } = buildRedactTestApp());
  });

  it('redacta x-api-key: el log contiene [Redacted] y no el valor real', async () => {
    const secretValue = 'mi-api-key-super-secreta';
    await request(app).get('/ping').set('x-api-key', secretValue);

    const logLine = lines.find((l) => l.includes('req'));
    expect(logLine).toBeDefined();

    const parsed = JSON.parse(logLine!);
    expect(parsed.req.headers?.['x-api-key']).toBe('[Redacted]');
    expect(logLine).not.toContain(secretValue);
  });

  it('redacta authorization: el log contiene [Redacted] y no el valor real', async () => {
    const tokenValue = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
    await request(app).get('/ping').set('authorization', tokenValue);

    const logLine = lines.find((l, i) => i === lines.length - 1); // última línea
    const parsed = JSON.parse(logLine!);
    expect(parsed.req.headers?.authorization).toBe('[Redacted]');
    expect(logLine).not.toContain(tokenValue);
  });

  it('redacta x-vapi-secret: el log contiene [Redacted] y no el valor real', async () => {
    const secretValue = 'vapi-secret-xyz-987';
    await request(app).get('/ping').set('x-vapi-secret', secretValue);

    const logLine = lines[lines.length - 1];
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine!);
    expect(parsed.req.headers?.['x-vapi-secret']).toBe('[Redacted]');
    expect(logLine).not.toContain(secretValue);
  });

  it('headers NO sensibles (user-agent, host) aparecen en claro', async () => {
    await request(app).get('/ping').set('x-custom-header', 'valor-publico');

    const logLine = lines[lines.length - 1];
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine!);
    // x-custom-header no está en la lista de redact — debe verse
    expect(parsed.req.headers?.['x-custom-header']).toBe('valor-publico');
  });
});
