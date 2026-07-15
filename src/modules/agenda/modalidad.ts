// ─── Modalidad de la cita ─────────────────────────────────────────────────────
// Fuente única de la modalidad y su duración. La modalidad se decide ANTES de
// consultar la agenda (la elige el prospecto en la llamada, o es 'virtual' por
// defecto si no está en zona presencial). La duración se deriva de la modalidad:
//   - virtual   → 1 h.
//   - presencial → 2 h (1 h de cita + 1 h de traslado del asesor).

export const MODALIDADES = ['virtual', 'presencial'] as const;

export type Modalidad = (typeof MODALIDADES)[number];

/** Duración de la cita en horas según la modalidad. */
export const DURACION_HORAS: Record<Modalidad, number> = {
  virtual: 1,
  presencial: 2,
};

/** Horas que dura la cita para la modalidad dada. */
export function duracionHoras(modalidad: Modalidad): number {
  return DURACION_HORAS[modalidad];
}
