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
    ['acepto', 'listo_llamar'],
    ['agendado', 'nuevo'],
    ['no_interesado', 'nuevo'],
    ['no_contactable', 'listo_llamar'],
    ['no_contactar', 'llamado'],
    ['interesado_sin_espacio', 'acepto'],
  ];

  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      expect(() => validateTransition(from, to)).toThrow(InvalidTransitionError);
    });
  }
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
