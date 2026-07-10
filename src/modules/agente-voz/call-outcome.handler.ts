import type { DesenlaceLlamada } from './assistant.config';
import { LeadStatus } from '../leads/lead.schema';

// ─── Resultado de la resolución ───────────────────────────────────────────────

export interface OutcomeResult {
  /** Nuevo status al que debe transicionar el lead */
  nuevoStatus: LeadStatus;
  /** Nota descriptiva para el historial del lead */
  nota: string;
  /** Si debe programarse un reintento al día siguiente */
  debeReintentar: boolean;
}

/**
 * Mapea el desenlace reportado por el asistente de voz (los 7 valores de
 * DESENLACES_LLAMADA en assistant.config) al status correspondiente en la
 * máquina de estados del lead.
 *
 * Reglas de negocio:
 * - acepto → acepto (agendó cita; queda esperando confirmación/agendado)
 * - no_interesado → no_interesado (terminal, no volver a llamar)
 * - interesado_sin_espacio → interesado_sin_espacio (terminal, seguimiento manual)
 * - no_contactar → no_contactar (terminal inmediato, el cliente lo pidió)
 * - buzon / numero_equivocado / error_tecnico → listo_llamar si intentos < 2,
 *   si no → no_contactable
 */
export function mapearDesenlace(
  desenlace: DesenlaceLlamada,
  intentosActuales: number,
): OutcomeResult {
  switch (desenlace) {
    // ── Positivo ──────────────────────────────────────────────────────────
    case 'acepto':
      return {
        nuevoStatus: 'acepto',
        nota: 'Lead aceptó — cita en proceso de agendarse',
        debeReintentar: false,
      };

    // ── Rechazos terminales ───────────────────────────────────────────────
    case 'no_interesado':
      return {
        nuevoStatus: 'no_interesado',
        nota: 'Lead no interesado en el producto',
        debeReintentar: false,
      };

    case 'no_contactar':
      return {
        nuevoStatus: 'no_contactar',
        nota: 'Lead solicitó no ser contactado — DNC inmediato',
        debeReintentar: false,
      };

    case 'interesado_sin_espacio':
      return {
        nuevoStatus: 'interesado_sin_espacio',
        nota: 'Lead interesado pero sin disponibilidad — seguimiento manual',
        debeReintentar: false,
      };

    // ── Casos operativos — reintento (máximo 1) ───────────────────────────
    // error_tecnico: las herramientas fallaron a mitad de llamada y el agente
    // prometió devolver la llamada — el lead debe recuperarse solo.
    case 'buzon':
    case 'numero_equivocado':
    case 'error_tecnico': {
      const etiqueta =
        desenlace === 'buzon'
          ? 'Buzón de voz'
          : desenlace === 'numero_equivocado'
            ? 'Número equivocado'
            : 'Falla técnica de herramientas durante la llamada';
      if (intentosActuales >= 2) {
        return {
          nuevoStatus: 'no_contactable',
          nota: `${etiqueta} en 2° intento — marcado como no contactable`,
          debeReintentar: false,
        };
      }
      return {
        nuevoStatus: 'listo_llamar',
        nota: `${etiqueta} — reintento programado para mañana`,
        debeReintentar: true,
      };
    }
  }
}
