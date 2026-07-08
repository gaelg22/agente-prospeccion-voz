import { LeadStatus, TERMINAL_STATUSES } from './lead.schema';

/**
 * Adjacency map: from → allowed targets.
 * The `llamado → listo_llamar` edge is the retry path (no-answer, first attempt only).
 */
const TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  nuevo: ['enriquecido', 'listo_llamar'],
  enriquecido: ['listo_llamar'],
  listo_llamar: ['llamado'],
  llamado: [
    'acepto',
    'no_interesado',
    'no_contactable',
    'no_contactar',
    'interesado_sin_espacio',
    'listo_llamar', // retry path (no-answer, intentos < 2)
  ],
  acepto: ['agendado'],
  // Terminal — no outgoing edges
  agendado: [],
  no_interesado: [],
  no_contactable: [],
  no_contactar: [],
  interesado_sin_espacio: [],
};

export class InvalidTransitionError extends Error {
  readonly statusCode = 409;
  readonly from: LeadStatus;
  readonly to: LeadStatus;

  constructor(from: LeadStatus, to: LeadStatus) {
    super(`Invalid lead transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Validates that the transition from → to is legal.
 * Throws InvalidTransitionError if not.
 */
export function validateTransition(from: LeadStatus, to: LeadStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Returns true if `status` is a terminal (no further transitions possible).
 */
export function isTerminal(status: LeadStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export { TRANSITIONS };
