import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { LeadService } from '../leads/lead.service';
import { Lead } from '../leads/lead.schema';
import { VapiClient } from '../agente-voz/vapi.client';
import { logger } from '../../lib/logger';

/**
 * Rutas de desarrollo — solo activas fuera de producción.
 * NUNCA exportar ni registrar estas rutas cuando NODE_ENV === 'production'.
 */
export const devRoutes = Router();

// ─── POST /dev/leads ──────────────────────────────────────────────────────────
// Inserta un lead de prueba con datos mínimos.
// Útil para probar el webhook sin tener que correr ingesta DENUE.

const zDevLead = z.object({
  denueId: z.string().default(() => `dev-${Date.now()}`),
  razonSocial: z.string().default('Empresa de Prueba S.A.'),
  actividadEconomica: z.string().default('Servicios de prueba'),
  telefonoRaw: z.string().optional(),
  municipio: z.string().default('Monterrey'),
  estado: z.string().default('Nuevo León'),
});

devRoutes.post('/leads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = zDevLead.parse(req.body);

    const lead = await LeadService.create({
      denueId: body.denueId,
      razonSocial: body.razonSocial,
      actividadEconomica: body.actividadEconomica,
      telefonoRaw: body.telefonoRaw,
      direccion: {
        municipio: body.municipio,
        estado: body.estado,
      },
      fuente: 'dev',
      fuenteUrl: 'http://localhost/dev',
      notas: ['Lead de prueba — creado vía /dev/leads'],
    });

    logger.info({ leadId: lead._id.toString() }, '[DEV] Lead de prueba creado');
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /dev/leads/:id/status ─────────────────────────────────────────────
// Permite saltar a cualquier status para probar flujos.

const zDevTransition = z.object({
  status: z.string(),
  nota: z.string().optional(),
});

devRoutes.patch('/leads/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, nota } = zDevTransition.parse(req.body);
    const lead = await LeadService.transition(
      req.params['id'] ?? '',
      status as Parameters<typeof LeadService.transition>[1],
      nota != null ? { nota } : {},
    );
    logger.info({ leadId: lead._id.toString(), status }, '[DEV] Transición manual');
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

// ─── POST /dev/llamar/:leadId ─────────────────────────────────────────────────
// Dispara una llamada de Vapi INMEDIATAMENTE para un lead, sin pasar por la
// cola ni por COLA_ACTIVA. Las transiciones (las mismas que hace el job) van
// ANTES de llamar a Vapi: si son ilegales, se responde el error sin marcar.

devRoutes.post('/llamar/:leadId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leadId = req.params['leadId'] ?? '';

    const lead = await LeadService.findById(leadId);
    if (!lead) {
      res.status(404).json({ error: `Lead no encontrado: ${leadId}` });
      return;
    }

    if (!lead.telefono) {
      res.status(400).json({ error: 'El lead no tiene teléfono válido (E.164)' });
      return;
    }

    // Mismas transiciones que la cola. Lanzan InvalidTransitionError (409)
    // antes de tocar Vapi si el lead está en un status que no permite marcar.
    if (lead.status !== 'listo_llamar') {
      await LeadService.transition(lead._id, 'listo_llamar', {
        nota: '[DEV] Preparado para llamada de prueba vía /dev/llamar',
      });
    }
    await LeadService.transition(lead._id, 'llamado', {
      nota: '[DEV] Llamada de prueba disparada vía /dev/llamar',
    });

    const vapiClient = new VapiClient();
    const call = await vapiClient.createCall({
      toNumber: lead.telefono,
      leadId: lead._id.toString(),
      prospectoNombre: lead.nombreComercial ?? lead.razonSocial,
      especialidad: lead.actividadEconomica,
      metadata: { razonSocial: lead.razonSocial, origen: 'dev' },
    });

    // El callId se conoce hasta después de crear la llamada; se adjunta directo
    // (la transición a 'llamado' ya ocurrió).
    await Lead.updateOne({ _id: lead._id }, { vapiCallId: call.id });

    logger.info({ leadId, callId: call.id }, '[DEV] Llamada de prueba creada en Vapi');
    res.status(201).json({ callId: call.id });
  } catch (err) {
    next(err);
  }
});
