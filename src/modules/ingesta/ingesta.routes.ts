import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { apiKeyMiddleware } from '../../middleware/apiKey.middleware';
import { IngestaService } from './ingesta.service';
import { zDenueSearchParams } from './denue.zod';

export const ingestaRoutes = Router();
const ingestaService = new IngestaService();

ingestaRoutes.use(apiKeyMiddleware);

/**
 * POST /ingesta/denue
 * Body: { busqueda, entidad?, municipio?, actividad?, registro?, registroHasta? }
 * Triggers a DENUE crawl and returns stats. Runs inline (not queued) for now;
 * for very large crawls, move to an Agenda job.
 */
ingestaRoutes.post('/denue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = zDenueSearchParams.parse(req.body);
    const fuenteUrl = z.string().url().optional().parse((req.body as Record<string, unknown>)['fuenteUrl']);
    const result = await ingestaService.run(params, fuenteUrl);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
