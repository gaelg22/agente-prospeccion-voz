import { Schema, model, Types } from 'mongoose';

// ─── Status enum ──────────────────────────────────────────────────────────────

export const LEAD_STATUSES = [
  'nuevo',           // recién ingresado, sin enriquecer
  'enriquecido',     // datos completados pero aún no listo para llamar
  'listo_llamar',    // en cola para llamada
  'llamado',         // llamada en curso o completada, pendiente de outcome
  'acepto',          // lead aceptó; esperando agendar cita
  'agendado',        // cita creada en Calendar — TERMINAL
  'no_interesado',   // rechazó explícitamente — TERMINAL
  'no_contactable',  // 2 intentos sin respuesta — TERMINAL
  'no_contactar',    // pidió no ser contactado — TERMINAL
  'interesado_sin_espacio', // interesado pero sin disponibilidad — TERMINAL (seguimiento manual)
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<LeadStatus> = new Set([
  'agendado',
  'no_interesado',
  'no_contactable',
  'no_contactar',
  'interesado_sin_espacio',
]);

// ─── Sub-documentos ───────────────────────────────────────────────────────────

export interface IDireccion {
  calle?: string;
  numeroExterior?: string;
  colonia?: string;
  municipio: string;
  estado: string;
  cp?: string;
  latitud?: number;
  longitud?: number;
}

export interface ICita {
  googleEventId: string;
  fecha: Date;
  meetUrl: string | null;
  confirmacionEnviada: boolean;
  confirmadaEn?: Date;
}

// ─── ILead ────────────────────────────────────────────────────────────────────

export interface ILead {
  _id: Types.ObjectId;

  // Identidad
  denueId: string;               // ID único de DENUE — índice único obligatorio
  razonSocial: string;
  nombreComercial?: string;
  actividadEconomica: string;
  codigoActividad?: string;      // código SCIAN

  // Contacto
  telefono: string | null;       // E.164 (+52…) o null — índice único parcial
  telefonoRaw: string | null;    // valor original antes de normalizar
  email?: string;
  sitioWeb?: string;

  // Ubicación
  direccion: IDireccion;

  // Pipeline / máquina de estados
  status: LeadStatus;
  intentos: number;              // nº de llamadas realizadas (0, 1, 2)
  ultimaLlamada?: Date;
  vapiCallId?: string;           // ID de la llamada en Vapi
  transcripcion?: string;        // resumen/transcripción de la última llamada

  // Cita (solo si status === 'agendado')
  cita?: ICita;

  // Trazabilidad (obligatorios)
  fuente: string;                // e.g. 'denue', 'manual'
  fuenteUrl: string;             // URL exacta de la consulta que originó el lead
  capturadasEn: Date;            // fecha en que se ingresó al sistema

  // Notas libres
  notas: string[];

  // Timestamps automáticos
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const direccionSchema = new Schema<IDireccion>(
  {
    calle: String,
    numeroExterior: String,
    colonia: String,
    municipio: { type: String, required: true },
    estado: { type: String, required: true },
    cp: String,
    latitud: Number,
    longitud: Number,
  },
  { _id: false },
);

const citaSchema = new Schema<ICita>(
  {
    googleEventId: { type: String, required: true },
    fecha: { type: Date, required: true },
    meetUrl: { type: String, default: null },
    confirmacionEnviada: { type: Boolean, required: true, default: false },
    confirmadaEn: Date,
  },
  { _id: false },
);

// ─── Lead schema ──────────────────────────────────────────────────────────────

const leadSchema = new Schema<ILead>(
  {
    // Identidad
    denueId: { type: String, required: true, unique: true },
    razonSocial: { type: String, required: true },
    nombreComercial: String,
    actividadEconomica: { type: String, required: true },
    codigoActividad: String,

    // Contacto
    telefono: { type: String, default: null },
    telefonoRaw: { type: String, default: null },
    email: String,
    sitioWeb: String,

    // Ubicación
    direccion: { type: direccionSchema, required: true },

    // Pipeline
    status: {
      type: String,
      enum: LEAD_STATUSES,
      required: true,
      default: 'nuevo',
    },
    intentos: { type: Number, required: true, default: 0, min: 0, max: 2 },
    ultimaLlamada: Date,
    vapiCallId: String,
    transcripcion: String,

    // Cita
    cita: { type: citaSchema, default: undefined },

    // Trazabilidad
    fuente: { type: String, required: true },
    fuenteUrl: { type: String, required: true },
    capturadasEn: { type: Date, required: true, default: () => new Date() },

    // Notas
    notas: { type: [String], default: [] },
  },
  {
    timestamps: true,
    // Evita que se guarden subdocumentos vacíos para campos opcionales
    minimize: true,
  },
);

// ─── Índices (los dos del CLAUDE.md + auxiliares) ─────────────────────────────

// 1. denueId: único — ya declarado con `unique: true` en el campo.

// 2. telefono: único PARCIAL — solo documentos donde telefono existe como string.
//    Permite múltiples documentos con telefono=null sin violar la unicidad.
leadSchema.index(
  { telefono: 1 },
  {
    unique: true,
    partialFilterExpression: { telefono: { $type: 'string' } },
    name: 'idx_telefono_unique_parcial',
  },
);

// Auxiliares para consultas frecuentes
leadSchema.index({ status: 1, createdAt: 1 }, { name: 'idx_status_createdAt' });
leadSchema.index({ fuente: 1 }, { name: 'idx_fuente' });

export const Lead = model<ILead>('Lead', leadSchema);
