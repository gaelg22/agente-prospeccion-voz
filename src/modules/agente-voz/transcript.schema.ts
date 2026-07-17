import { Schema, model, Types } from 'mongoose';

// ─── Transcript de llamadas — colección propia con retención acotada ─────────
// Las líneas de transcripción son dato personal del prospecto: viven aparte de
// la bitácora del lead (lead.notas) y MongoDB las purga solo vía índice TTL.
// Solo se guardan líneas FINALES (transcriptType=final) — los partials
// duplicarían cada frase en versiones incrementales.

export const TRANSCRIPT_TTL_DIAS = 90;

export interface ITranscriptLinea {
  _id: Types.ObjectId;
  leadId: Types.ObjectId;
  vapiCallId?: string;
  rol: 'assistant' | 'user' | 'unknown';
  texto: string;
  createdAt: Date;
}

const transcriptSchema = new Schema<ITranscriptLinea>(
  {
    leadId: { type: Schema.Types.ObjectId, required: true },
    vapiCallId: String,
    rol: {
      type: String,
      enum: ['assistant', 'user', 'unknown'],
      required: true,
      default: 'unknown',
    },
    texto: { type: String, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

// Purga automática — expireAfterSeconds corre sobre createdAt.
transcriptSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TRANSCRIPT_TTL_DIAS * 24 * 60 * 60, name: 'idx_ttl_transcript' },
);
// Lectura típica: el transcript de un lead en orden cronológico.
transcriptSchema.index({ leadId: 1, createdAt: 1 }, { name: 'idx_lead_createdAt' });

export const TranscriptLinea = model<ITranscriptLinea>(
  'TranscriptLinea',
  transcriptSchema,
  'transcripts',
);
