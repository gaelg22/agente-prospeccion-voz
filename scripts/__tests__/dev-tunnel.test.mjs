import { describe, it, expect } from 'vitest';
import { extraerPidsNetstat, pidRaizNode } from '../dev-tunnel.mjs';

// Salida real (recortada) de `netstat -ano -p tcp` en Windows.
const NETSTAT = [
  'Conexiones activas',
  '',
  '  Proto  Dirección local     Dirección remota    Estado       PID',
  '  TCP    0.0.0.0:135         0.0.0.0:0           LISTENING    1416',
  '  TCP    0.0.0.0:3000        0.0.0.0:0           LISTENING    19956',
  '  TCP    [::]:3000           [::]:0              LISTENING    19956',
  '  TCP    0.0.0.0:30001       0.0.0.0:0           LISTENING    7777',
  '  TCP    127.0.0.1:3000      127.0.0.1:52344     ESTABLISHED  19956',
  '  TCP    127.0.0.1:52344     127.0.0.1:3000      TIME_WAIT    0',
].join('\r\n');

describe('extraerPidsNetstat', () => {
  it('regresa el PID que escucha en el puerto, deduplicado (IPv4 + IPv6)', () => {
    expect(extraerPidsNetstat(NETSTAT, 3000)).toEqual([19956]);
  });

  it('no confunde el puerto con prefijos (:3000 vs :30001)', () => {
    expect(extraerPidsNetstat(NETSTAT, 3000)).not.toContain(7777);
    expect(extraerPidsNetstat(NETSTAT, 30001)).toEqual([7777]);
  });

  it('ignora conexiones ESTABLISHED y TIME_WAIT (solo LISTENING)', () => {
    expect(extraerPidsNetstat(NETSTAT, 52344)).toEqual([]);
  });

  it('regresa vacío si el puerto está libre', () => {
    expect(extraerPidsNetstat(NETSTAT, 9999)).toEqual([]);
  });
});

describe('pidRaizNode', () => {
  // Cadena real del fantasma del 11 jul: node (tsx watch) → node (server).
  // Matar solo al hijo no sirve: tsx watch lo revive.
  const tabla = [
    { pid: 100, ppid: 1, name: 'explorer.exe' },
    { pid: 200, ppid: 100, name: 'powershell.exe' },
    { pid: 300, ppid: 200, name: 'node.exe' }, // tsx watch (raíz node)
    { pid: 400, ppid: 300, name: 'node.exe' }, // server hijo que escucha
  ];

  it('sube hasta el ancestro node más alto (el watcher, no el hijo)', () => {
    expect(pidRaizNode(400, tabla)).toBe(300);
  });

  it('se detiene cuando el padre ya no es node', () => {
    expect(pidRaizNode(300, tabla)).toBe(300);
  });

  it('regresa el mismo PID si no aparece en la tabla de procesos', () => {
    expect(pidRaizNode(555, tabla)).toBe(555);
  });

  it('no se cicla con árboles corruptos (pid ancestro de sí mismo)', () => {
    const ciclo = [
      { pid: 10, ppid: 20, name: 'node.exe' },
      { pid: 20, ppid: 10, name: 'node.exe' },
    ];
    expect([10, 20]).toContain(pidRaizNode(10, ciclo));
  });
});
