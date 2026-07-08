import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { LeadService } from '../leads/lead.service';
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
