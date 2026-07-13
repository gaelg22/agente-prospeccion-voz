// ─── Fechas en zona horaria de México ─────────────────────────────────────────
// El server puede correr en UTC (Render), así que NUNCA hay que derivar "hoy",
// "mañana" ni la fecha/hora que viaja al prompt del reloj local del proceso:
// en la noche de México el UTC ya está en el día siguiente y el agente ofrece
// o dice fechas corridas (bug del 13 jul: dijo "14 de julio" siendo día 13).
// Todo lo temporal de cara al prospecto se ancla explícitamente a esta zona.

export const ZONA_MEXICO = 'America/Mexico_City';

/**
 * Fecha y hora actual formateada para el prompt, en español de México y en la
 * zona de México. Ej.: "lunes, 13 de julio de 2026, 8:00 p.m.".
 * Es la referencia de "hoy"/"ahora" que el modelo usa en la sección 10.
 */
export function formatFechaHoraMexico(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: ZONA_MEXICO,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(ahora);
}

function parteNumerica(
  partes: Intl.DateTimeFormatPart[],
  tipo: Intl.DateTimeFormatPartTypes,
): number {
  const parte = partes.find((p) => p.type === tipo);
  return parte ? Number(parte.value) : Number.NaN;
}

/**
 * Fecha CALENDARIO en México (YYYY-MM-DD) para `ahora` desplazada `offsetDias`.
 * Se toma la fecha local mexicana de `ahora`, se ancla a su mediodía UTC (para
 * que sumar días no cruce ningún borde de zona) y se le suma el offset.
 * Ej.: a las 20:00 hora de México (02:00 UTC del día siguiente),
 * fechaMexicoISO(ahora, 0) === la fecha de México, no la de UTC.
 */
export function fechaMexicoISO(ahora: Date = new Date(), offsetDias = 0): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_MEXICO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ahora);

  const anio = parteNumerica(partes, 'year');
  const mes = parteNumerica(partes, 'month');
  const dia = parteNumerica(partes, 'day');

  const base = new Date(Date.UTC(anio, mes - 1, dia, 12));
  base.setUTCDate(base.getUTCDate() + offsetDias);
  return base.toISOString().slice(0, 10);
}
