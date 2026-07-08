import { Router, Request, Response, NextFunction } from 'express';
import { apiKeyMiddleware } from '../../middleware/apiKey.middleware';
import { LeadService } from './lead.service';
import { zCreateLead, zPatchStatus, zListLeadsQuery } from './lead.zod';

export const leadRoutes = Router();

leadRoutes.use(apiKeyMiddleware);

// ── GET /leads ─────────────────────────────────────────────────────────────
leadRoutes.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = zListLeadsQuery.parse(req.query);
    const result = await LeadService.list(query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /leads/:id ─────────────────────────────────────────────────────────
leadRoutes.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lead = await LeadService.findById(req.params['id'] ?? '');
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    res.json(lead);
  } catch (err) {
    next(err);
  }
});

// ── POST /leads ────────────────────────────────────────────────────────────
leadRoutes.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = zCreateLead.parse(req.body);
    const lead = await LeadService.create(dto);
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /leads/:id/status ────────────────────────────────────────────────
leadRoutes.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, nota } = zPatchStatus.parse(req.body);
    const lead = await LeadService.transition(req.params['id'] ?? '', status, nota != null ? { nota } : {});
    res.json(lead);
  } catch (err) {
    next(err);
  }
});
