#!/usr/bin/env node
/**
 * Dev server + túnel de cloudflare en un solo proceso.
 *
 * Los quick tunnels de cloudflared rotan de URL en cada arranque; si .env se
 * queda con la URL vieja, las tools de Vapi fallan con ENOTFOUND. Este script
 * hace imposible ese desalineo: levanta el túnel, captura la URL nueva de su
 * salida, la escribe en PUBLIC_URL de .env y SOLO ENTONCES arranca el dev
 * server (que lee .env al spawnearse).
 *
 * Uso: npm run dev:tunnel
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 30_000;

function leerEnv() {
  try {
    return readFileSync(envPath, 'utf8');
  } catch {
    console.error(`[dev-tunnel] No se pudo leer ${envPath} — crea el .env primero (ver .env.example)`);
    process.exit(1);
  }
}

function puertoLocal(envRaw) {
  const m = envRaw.match(/^PORT=(\d+)\s*$/m);
  return m ? Number(m[1]) : 3000;
}

function escribirPublicUrl(url) {
  let envRaw = leerEnv();
  const linea = `PUBLIC_URL=${url}`;
  if (/^PUBLIC_URL=.*$/m.test(envRaw)) {
    envRaw = envRaw.replace(/^PUBLIC_URL=.*$/m, linea);
  } else {
    envRaw += (envRaw.endsWith('\n') ? '' : '\n') + linea + '\n';
  }
  writeFileSync(envPath, envRaw);
}

const hijos = [];
let cerrando = false;

function apagarTodo(codigo) {
  if (cerrando) return;
  cerrando = true;
  for (const hijo of hijos) {
    if (hijo.exitCode === null) hijo.kill();
  }
  process.exitCode = codigo;
}

process.on('SIGINT', () => apagarTodo(0));
process.on('SIGTERM', () => apagarTodo(0));

// ─── 1. Túnel ─────────────────────────────────────────────────────────────────

const port = puertoLocal(leerEnv());
console.log(`[dev-tunnel] Lanzando cloudflared → http://localhost:${port} …`);

const tunel = spawn(
  'cloudflared',
  ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
  { cwd: root },
);
hijos.push(tunel);

tunel.on('error', (err) => {
  console.error(`[dev-tunnel] No se pudo lanzar cloudflared: ${err.message}`);
  console.error('[dev-tunnel] ¿Está instalado y en el PATH? https://developers.cloudflare.com/cloudflared/');
  apagarTodo(1);
});

const urlTunel = await new Promise((resolve) => {
  const timeout = setTimeout(() => {
    console.error(`[dev-tunnel] cloudflared no publicó la URL en ${TUNNEL_TIMEOUT_MS / 1000} s`);
    resolve(null);
  }, TUNNEL_TIMEOUT_MS);

  // cloudflared imprime la URL del quick tunnel en stderr
  const buscar = (chunk) => {
    const m = String(chunk).match(TUNNEL_URL_RE);
    if (m) {
      clearTimeout(timeout);
      resolve(m[0]);
    }
  };
  tunel.stderr.on('data', buscar);
  tunel.stdout.on('data', buscar);
  tunel.on('exit', () => {
    clearTimeout(timeout);
    resolve(null);
  });
});

if (!urlTunel) {
  apagarTodo(1);
} else {
  escribirPublicUrl(urlTunel);
  console.log(`[dev-tunnel] Túnel activo: ${urlTunel}`);
  console.log('[dev-tunnel] PUBLIC_URL actualizado en .env');

  // ─── 2. Dev server (lee el .env recién escrito) ───────────────────────────

  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const server = spawn(
    process.execPath,
    [tsxCli, 'watch', '--env-file=.env', 'src/server.ts'],
    { cwd: root, stdio: 'inherit' },
  );
  hijos.push(server);

  server.on('exit', (code) => apagarTodo(code ?? 0));
  tunel.on('exit', () => {
    if (!cerrando) {
      console.error('[dev-tunnel] cloudflared terminó — apagando el dev server');
      apagarTodo(1);
    }
  });
}
