import { z } from 'zod';
import { LEAD_STATUSES } from './lead.schema';

// ─── Shared primitives ────────────────────────────────────────────────────────

export const zLeadStatus = z.enum(LEAD_STATUSES);

const zDireccion = z.object({
  calle: z.string().optional(),
  numeroExterior: z.string().optional(),
  colonia: z.string().optional(),
  municipio: z.string().min(1),
  estado: z.string().min(1),
  cp: z.string().optional(),
  latitud: z.number().optional(),
  longitud: z.number().optional(),
});

// ─── Create ───────────────────────────────────────────────────────────────────

export const zCreateLead = z.object({
  denueId: z.string().min(1),
  razonSocial: z.string().min(1),
  nombreComercial: z.string().optional(),
  actividadEconomica: z.string().min(1),
  codigoActividad: z.string().optional(),
  telefonoRaw: z.string().optional(),
  email: z.string().email().optional(),
  sitioWeb: z.string().url().optional(),
  direccion: zDireccion,
  fuente: z.string().min(1),
  fuenteUrl: z.string().url(),
  notas: z.array(z.string()).optional(),
});

export type CreateLeadDto = z.infer<typeof zCreateLead>;

// ─── Patch status ─────────────────────────────────────────────────────────────

export const zPatchStatus = z.object({
  status: zLeadStatus,
  nota: z.string().optional(),
});

export type PatchStatusDto = z.infer<typeof zPatchStatus>;

// ─── Query / list ─────────────────────────────────────────────────────────────

export const zListLeadsQuery = z.object({
  status: zLeadStatus.optional(),
  fuente: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export type ListLeadsQuery = z.infer<typeof zListLeadsQuery>;
