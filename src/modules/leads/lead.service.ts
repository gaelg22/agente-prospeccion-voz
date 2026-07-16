import { Types } from 'mongoose';
import { logger } from '../../lib/logger';
import { normalizePhone } from '../../lib/phone';
import { Lead, ILead, LeadStatus, ICita } from './lead.schema';
import { validateTransition, InvalidTransitionError } from './lead.transitions';
import { CreateLeadDto, ListLeadsQuery } from './lead.zod';

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class LeadNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Lead no encontrado: ${id}`);
    this.name = 'LeadNotFoundError';
  }
}

export { InvalidTransitionError };

// ─── Tipos de meta para transition() ─────────────────────────────────────────

export interface TransitionMeta {
  nota?: string;
  vapiCallId?: string;
  transcripcion?: string;
  cita?: ICita;
}

// ─── LeadService ──────────────────────────────────────────────────────────────

export const LeadService = {
  /**
   * Crea un nuevo lead normalizando el teléfono antes de persistir.
   */
  async create(dto: CreateLeadDto): Promise<ILead> {
    const telefono = dto.telefonoRaw ? normalizePhone(dto.telefonoRaw) : null;

    const lead = new Lead({
      ...dto,
      telefono,
      telefonoRaw: dto.telefonoRaw ?? null,
      status: 'nuevo',
      intentos: 0,
      notas: dto.notas ?? [],
      capturadasEn: new Date(),
    });

    const saved = await lead.save();
    logger.info({ leadId: saved._id.toString(), denueId: saved.denueId }, 'Lead creado');
    return saved;
  },

  /**
   * ÚNICA vía legal para actualizar el status de un lead.
   * Valida que la transición sea legal antes de persistir.
   */
  async transition(
    id: string | Types.ObjectId,
    newStatus: LeadStatus,
    meta?: TransitionMeta,
  ): Promise<ILead> {
    const lead = await Lead.findById(id);
    if (!lead) throw new LeadNotFoundError(String(id));

    // Valida la transición — lanza InvalidTransitionError si es ilegal
    validateTransition(lead.status, newStatus);

    // Captura el estado ANTERIOR antes de mutar el documento, para el log.
    const prevStatus = lead.status;

    lead.status = newStatus;

    if (meta?.nota != null) lead.notas.push(meta.nota);
    if (meta?.vapiCallId != null) lead.vapiCallId = meta.vapiCallId;
    if (meta?.transcripcion != null) lead.transcripcion = meta.transcripcion;
    if (meta?.cita != null) lead.cita = meta.cita;

    if (newStatus === 'llamado') {
      lead.intentos += 1;
      lead.ultimaLlamada = new Date();
    }

    const updated = await lead.save();
    logger.info(
      { leadId: updated._id.toString(), prevStatus, newStatus },
      'Transición de status ejecutada',
    );
    return updated;
  },

  async findById(id: string): Promise<ILead | null> {
    return Lead.findById(id).lean();
  },

  async list(query: ListLeadsQuery): Promise<{ items: ILead[]; total: number }> {
    const filter = query.status ? { status: query.status } : {};
    const skip = (query.page - 1) * query.limit;

    const [items, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean(),
      Lead.countDocuments(filter),
    ]);

    return { items, total };
  },

  /**
   * Devuelve el siguiente lead elegible para llamada:
   * status=listo_llamar, con teléfono presente y sin flag DNC.
   * Ordenado por createdAt (FIFO).
   * `$ne: true` cubre también documentos anteriores al campo (sin noContactar).
   */
  async findNextToCall(): Promise<ILead | null> {
    return Lead.findOne({
      status: 'listo_llamar',
      telefono: { $type: 'string' },
      noContactar: { $ne: true },
    })
      .sort({ createdAt: 1 })
      .lean();
  },

  /**
   * Leads varados en status=llamado cuya ultimaLlamada es anterior a `antesDe`:
   * la llamada ya debió terminar pero el webhook de fin de llamada nunca llegó
   * (ej. túnel caído). Los recoge el job de reconciliación.
   */
  async findEstancadosEnLlamado(antesDe: Date): Promise<ILead[]> {
    return Lead.find({
      status: 'llamado',
      ultimaLlamada: { $lte: antesDe },
    })
      .sort({ ultimaLlamada: 1 })
      .lean();
  },

  /**
   * Leads varados en status=acepto SIN cita real (sin cita.googleEventId) cuya
   * ultimaLlamada es anterior a `antesDe`: registrar_resultado reportó acepto
   * pero agendar_cita nunca corrió o falló, así que no existe evento en
   * Calendar. Los recoge el job de reconciliación. Un acepto CON cita solo es
   * un instante intermedio dentro de book() y jamás debe barrerse.
   */
  async findAceptoSinCita(antesDe: Date): Promise<ILead[]> {
    return Lead.find({
      status: 'acepto',
      ultimaLlamada: { $lte: antesDe },
      'cita.googleEventId': { $exists: false },
    })
      .sort({ ultimaLlamada: 1 })
      .lean();
  },
};
