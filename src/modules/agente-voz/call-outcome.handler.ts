import { DesenlaceLlamada } from './vapi.zod';
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
 * Mapea el desenlace reportado por el asistente de voz
 * al status correspondiente en la máquina de estados del lead.
 *
 * Reglas de negocio:
 * - interesado → acepto (quiere saber más; se agenda cita)
 * - no_interesado → no_interesado (terminal, no volver a llamar)
 * - no_contesto / buzon → listo_llamar si intentos < 2, si no → no_contactable
 * - no_contactar → no_contactar (terminal inmediato, el cliente lo pidió)
 * - numero_incorrecto → no_contactable (terminal, no hay forma de contactar)
 * - interesado_sin_espacio → interesado_sin_espacio (terminal, seguimiento manual)
 */
export function mapearDesenlace(
  desenlace: DesenlaceLlamada,
  intentosActuales: number,
): OutcomeResult {
  switch (desenlace) {
    // ── Positivo ──────────────────────────────────────────────────────────
    case 'interesado':
      return {
        nuevoStatus: 'acepto',
        nota: 'Lead interesado — solicitud de cita iniciada',
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

    case 'numero_incorrecto':
      return {
        nuevoStatus: 'no_contactable',
        nota: 'Número incorrecto o fuera de servicio',
        debeReintentar: false,
      };

    case 'interesado_sin_espacio':
      return {
        nuevoStatus: 'interesado_sin_espacio',
        nota: 'Lead interesado pero sin disponibilidad — seguimiento manual',
        debeReintentar: false,
      };

    // ── Sin respuesta — reintento (máximo 1) ──────────────────────────────
    case 'no_contesto':
    case 'buzon': {
      const etiqueta = desenlace === 'buzon' ? 'Buzón de voz' : 'Sin respuesta';
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
