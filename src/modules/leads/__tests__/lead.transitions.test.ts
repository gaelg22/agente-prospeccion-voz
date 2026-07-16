import { describe, it, expect } from 'vitest';
import { validateTransition, InvalidTransitionError, isTerminal } from '../lead.transitions';
import { LeadStatus } from '../lead.schema';

describe('validateTransition — legal transitions', () => {
  const legal: Array<[LeadStatus, LeadStatus]> = [
    ['nuevo', 'enriquecido'],
    ['nuevo', 'listo_llamar'],
    ['enriquecido', 'listo_llamar'],
    ['listo_llamar', 'llamado'],
    ['llamado', 'acepto'],
    ['llamado', 'no_interesado'],
    ['llamado', 'no_contactable'],
    ['llamado', 'no_contactar'],
    ['llamado', 'interesado_sin_espacio'],
    ['llamado', 'listo_llamar'], // retry path
    ['acepto', 'agendado'],
    ['acepto', 'listo_llamar'], // reconciliación: acepto sin cita → reintento
    ['acepto', 'no_contactable'], // reconciliación: acepto sin cita con reintentos agotados
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} → ${to}`, () => {
      expect(() => validateTransition(from, to)).not.toThrow();
    });
  }
});

describe('validateTransition — illegal transitions', () => {
  const illegal: Array<[LeadStatus, LeadStatus]> = [
    ['nuevo', 'llamado'],
    ['nuevo', 'agendado'],
    ['enriquecido', 'llamado'],
    ['listo_llamar', 'acepto'],
    ['acepto', 'llamado'], // a la cola se vuelve vía listo_llamar, nunca directo
    ['agendado', 'nuevo'],
    ['no_interesado', 'nuevo'],
    ['no_contactable', 'listo_llamar'],
    ['no_contactar', 'llamado'],
    ['no_contactar', 'listo_llamar'], // terminal — nunca debe volver a la cola
    ['no_interesado', 'listo_llamar'], // terminal — nunca debe volver a la cola
    ['interesado_sin_espacio', 'acepto'],
  ];

  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      expect(() => validateTransition(from, to)).toThrow(InvalidTransitionError);
    });
  }

  it('InvalidTransitionError lleva statusCode 409 (Conflict) para el error middleware', () => {
    const err = new InvalidTransitionError('no_contactar', 'listo_llamar');
    expect(err.statusCode).toBe(409);
  });
});

describe('isTerminal', () => {
  const terminals: LeadStatus[] = ['agendado', 'no_interesado', 'no_contactable', 'no_contactar', 'interesado_sin_espacio'];
  const nonTerminals: LeadStatus[] = ['nuevo', 'enriquecido', 'listo_llamar', 'llamado', 'acepto'];

  for (const s of terminals) {
    it(`${s} is terminal`, () => expect(isTerminal(s)).toBe(true));
  }
  for (const s of nonTerminals) {
    it(`${s} is not terminal`, () => expect(isTerminal(s)).toBe(false));
  }
});
