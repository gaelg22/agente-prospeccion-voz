import { z } from 'zod';

/** Raw record from the DENUE search endpoint */
export const zDenueEstablecimiento = z.object({
  id: z.string(),
  nom_estab: z.string(),
  raz_social: z.string().optional(),
  codigo_act: z.string(),
  nombre_act: z.string(),
  per_ocu: z.string().optional(),
  tipounidad: z.string().optional(),
  latitud: z.string(),
  longitud: z.string(),
  telefono: z.string().optional(),
  correoelec: z.string().optional(),
  www: z.string().optional(),
  tipoasent: z.string().optional(),
  localidad: z.string().optional(),
  ageb: z.string().optional(),
  manzana: z.string().optional(),
  nom_vial: z.string().optional(),
  numero_ext: z.string().optional(),
  nom_col: z.string().optional(),
  nom_loc: z.string().optional(),
  nom_mun: z.string(),
  nom_ent: z.string(),
  cp: z.string().optional(),
  fecha_alta: z.string().optional(),
  tipo_vial: z.string().optional(),
});

export type DenueEstablecimiento = z.infer<typeof zDenueEstablecimiento>;

/** Minimal query params accepted by the DENUE search API */
export const zDenueSearchParams = z.object({
  busqueda: z.string().min(1),
  entidad: z.string().default('00'), // 00 = national
  municipio: z.string().default('0'),
  actividad: z.string().default('0'),
  registro: z.coerce.number().int().positive().default(1),
  registroHasta: z.coerce.number().int().positive().default(10),
});

export type DenueSearchParams = z.infer<typeof zDenueSearchParams>;
