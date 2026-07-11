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
 * Antes de todo verifica que el puerto esté libre: un server fantasma de una
 * corrida anterior seguiría sirviendo la config vieja (tools apuntando a un
 * túnel muerto — visto el 11 jul: el server nuevo murió con EADDRINUSE y las
 * llamadas salieron con la URL del túnel anterior). Si el ocupante es node,
 * lo mata (árbol completo, subiendo hasta la raíz node — matar solo al hijo
 * de tsx watch hace que tsx lo reviva); si es otra cosa, falla con mensaje
 * claro pidiendo matarlo a mano.
 *
 * Uso: npm run dev:tunnel
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ─── Puerto ocupado: detección y limpieza ─────────────────────────────────────

/**
 * Extrae los PIDs que ESCUCHAN en `puerto` de la salida de `netstat -ano -p tcp`
 * (Windows). Cubre IPv4 (0.0.0.0:3000) e IPv6 ([::]:3000).
 */
export function extraerPidsNetstat(salida, puerto) {
  const pids = new Set();
  const finDePuerto = new RegExp(`:${puerto}$`);
  for (const linea of salida.split(/\r?\n/)) {
    const cols = linea.trim().split(/\s+/);
    // TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345
    if (cols.length < 5 || cols[3] !== 'LISTENING') continue;
    if (!finDePuerto.test(cols[1])) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Sube por la cadena de padres de `pid` mientras el padre siga siendo node y
 * regresa el ancestro node más alto. Matar solo al hijo que escucha no basta:
 * si el fantasma es un `tsx watch`, el watcher (su padre node) lo revive.
 * `procesos` = [{ pid, ppid, name }].
 */
export function pidRaizNode(pid, procesos) {
  const porPid = new Map(procesos.map((p) => [p.pid, p]));
  const visitados = new Set();
  let actual = porPid.get(pid);
  if (!actual) return pid;
  while (!visitados.has(actual.pid)) {
    visitados.add(actual.pid);
    const padre = porPid.get(actual.ppid);
    if (!padre || !/node/i.test(padre.name)) break;
    actual = padre;
  }
  return actual.pid;
}

function puertoEnUso(puerto) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(puerto);
  });
}

function tablaProcesosWindows() {
  const csv = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation',
    ],
    { encoding: 'utf8' },
  );
  const procesos = [];
  for (const linea of csv.split(/\r?\n/).slice(1)) {
    const m = linea.match(/^"(\d+)","(\d+)","(.*)"$/);
    if (m) procesos.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
  }
  return procesos;
}

function matarFantasmasWindows(puerto) {
  const salida = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const pids = extraerPidsNetstat(salida, puerto);
  const tabla = tablaProcesosWindows();

  for (const pid of pids) {
    const info = tabla.find((p) => p.pid === pid);
    if (!info || !/node/i.test(info.name)) {
      console.error(
        `[dev-tunnel] El puerto ${puerto} lo ocupa el proceso ${pid} (${info?.name ?? 'desconocido'}), que no es node — no lo mato automáticamente.`,
      );
      console.error(`[dev-tunnel] Libéralo a mano y reintenta:  taskkill /PID ${pid} /T /F`);
      process.exit(1);
    }
    const raiz = pidRaizNode(pid, tabla);
    console.warn(`[dev-tunnel] Matando server fantasma: PID raíz ${raiz} (escuchaba :${puerto} vía PID ${pid})`);
    try {
      execFileSync('taskkill', ['/PID', String(raiz), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // taskkill regresa código != 0 si el proceso ya murió entre medio — se
      // valida abajo re-checando el puerto, no aquí.
    }
  }
}

function matarFantasmasPosix(puerto) {
  let pids = [];
  try {
    pids = execFileSync('lsof', ['-ti', `tcp:${puerto}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    // lsof sale con código 1 cuando no hay procesos — puerto libre.
  }
  for (const pid of pids) {
    console.warn(`[dev-tunnel] Matando server fantasma: PID ${pid} (escuchaba :${puerto})`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ya murió */
    }
  }
}

async function asegurarPuertoLibre(puerto) {
  if (!(await puertoEnUso(puerto))) return;

  console.warn(
    `[dev-tunnel] El puerto ${puerto} ya está ocupado — un server fantasma serviría la config vieja (túnel muerto en las tools). Liberando…`,
  );
  if (process.platform === 'win32') {
    matarFantasmasWindows(puerto);
  } else {
    matarFantasmasPosix(puerto);
  }

  await new Promise((r) => setTimeout(r, 1_500));
  if (await puertoEnUso(puerto)) {
    console.error(`[dev-tunnel] No se pudo liberar el puerto ${puerto}. Mátalo a mano y reintenta:`);
    console.error(`[dev-tunnel]   netstat -ano -p tcp | findstr :${puerto}   →   taskkill /PID <pid> /T /F`);
    process.exit(1);
  }
  console.log(`[dev-tunnel] Puerto ${puerto} liberado.`);
}

// ─── Flujo principal ──────────────────────────────────────────────────────────

async function main() {
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

  // ── 0. Puerto libre (nunca un server fantasma con config vieja) ───────────
  const port = puertoLocal(leerEnv());
  await asegurarPuertoLibre(port);

  // ── 1. Túnel ───────────────────────────────────────────────────────────────
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
    return;
  }

  escribirPublicUrl(urlTunel);
  console.log(`[dev-tunnel] Túnel activo: ${urlTunel}`);
  console.log('[dev-tunnel] PUBLIC_URL actualizado en .env');

  // ── 2. Dev server (lee el .env recién escrito) ────────────────────────────
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

// Los tests importan los helpers sin ejecutar el flujo: main() solo corre
// cuando el script se invoca directo (npm run dev:tunnel).
const esEjecucionDirecta =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (esEjecucionDirecta) await main();
