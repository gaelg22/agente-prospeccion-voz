// ─── Zona presencial del asesor ───────────────────────────────────────────────
// Decide si un lead cae en la zona donde el asesor puede atender EN PERSONA.
// Si cae → Sofía ofrece elegir modalidad (presencial o videollamada).
// Si no  → videollamada directo, sin preguntar.
//
// Diagnóstico del municipio del lead (confirmado 15 jul):
//   - DENUE entrega el municipio en el campo `nom_mun` con el nombre oficial de
//     INEGI, NO el coloquial. Para los municipios del asesor eso significa:
//       Guadalajara → "Guadalajara"          (coincide con el token corto)
//       Zapopan     → "Zapopan"              (coincide)
//       Tonalá      → "Tonalá"               (coincide)
//       Tlaquepaque → "San Pedro Tlaquepaque" (NO coincide con igualdad exacta)
//       Tlajomulco  → "Tlajomulco de Zúñiga"  (NO coincide con igualdad exacta)
//   - La ingesta guarda `nom_mun` tal cual en `direccion.municipio`.
// Por eso el match es por CONTENCIÓN de token (el municipio del lead contiene
// alguno de los 5 como palabra completa), normalizando sin acentos y en
// minúsculas. La env de municipios se queda EXACTA con los 5 nombres cortos.
//
// Filtro de estado obligatorio: además del municipio, el estado del lead debe
// ser el del asesor (ASESOR_ESTADO, default "Jalisco"). Sin él, un lead de
// "Tonalá, Chiapas" caería como zona presencial por error (Tonalá también
// existe en Chiapas).

import { config } from '../config';

/** Minúsculas, sin acentos/diacríticos, espacios colapsados. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens de municipios en zona presencial, normalizados, desde la env. */
function municipiosZona(): string[] {
  return config.ZONA_PRESENCIAL_MUNICIPIOS.split(',')
    .map((m) => normalizar(m))
    .filter((m) => m.length > 0);
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True si el lead está en la zona presencial del asesor.
 * Regla: (municipio del lead CONTIENE alguno de los municipios-zona como
 * palabra completa) AND (estado del lead == ASESOR_ESTADO). Todo normalizado.
 * Municipio o estado vacío/nulo → false (fallback seguro → virtual directo).
 */
export function esZonaPresencial(
  municipio?: string | null,
  estado?: string | null,
): boolean {
  if (!municipio || !estado) return false;
  if (normalizar(estado) !== normalizar(config.ASESOR_ESTADO)) return false;

  const muni = normalizar(municipio);
  return municipiosZona().some((token) => {
    // Palabra completa: \b…\b evita que "tlaquepaquito" haga match con
    // "tlaquepaque"; capta "san pedro tlaquepaque" y "tlajomulco de zuniga".
    const re = new RegExp(`\\b${escaparRegex(token)}\\b`);
    return re.test(muni);
  });
}
