import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { zVapiWebhookBody, VapiToolCallsResponse, leadIdDeLlamada } from './vapi.zod';
import { TOOL_HANDLERS } from './tool-handlers';
import { Lead } from '../leads/lead.schema';

export const vapiWebhookRouter = Router();

// ─── Verificación de secreto ──────────────────────────────────────────────────
// Vapi permite configurar un header secreto personalizado (x-vapi-secret).
// Comparación de tiempo constante para evitar timing attacks.

function verificarSecreto(req: Request): boolean {
  const secreto = req.headers['x-vapi-secret'];
  if (!secreto || typeof secreto !== 'string') return false;

  const esperado = config.VAPI_WEBHOOK_SECRET;
  if (secreto.length !== esperado.length) return false;

  let igual = true;
  for (let i = 0; i < esperado.length; i++) {
    // Continúa el loop hasta el final — no break — para evitar timing attack
    if (secreto.charCodeAt(i) !== esperado.charCodeAt(i)) {
      igual = false;
    }
  }
  return igual;
}

// ─── POST /webhooks/vapi ──────────────────────────────────────────────────────

vapiWebhookRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Verificar secreto
    if (!verificarSecreto(req)) {
      logger.warn({ ip: req.ip }, 'Webhook Vapi: secreto inválido — rechazado 401');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2. Validar payload con Zod (body ya parseado como JSON por express.json())
    const parsed = zVapiWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'Webhook Vapi: payload inválido — descartado');
      // Siempre 200 a Vapi para no generar reintentos innecesarios
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = parsed.data;
    // Correlación única llamada→lead: metadata.leadId (se envía al crear la llamada)
    const leadId = leadIdDeLlamada(message.call);
    logger.debug({ type: message.type, callId: message.call?.id, leadId }, 'Webhook Vapi recibido');

    // ── tool-calls ────────────────────────────────────────────────────────
    if (message.type === 'tool-calls') {
      const toolCalls = message.toolCallList ?? [];
      const results: VapiToolCallsResponse['results'] = [];
      const ctx = { leadId, callId: message.call?.id };

      for (const toolCall of toolCalls) {
        const handler = TOOL_HANDLERS[toolCall.function.name];

        if (!handler) {
          logger.warn({ toolName: toolCall.function.name }, 'Tool no registrado — ignorando');
          results.push({
            toolCallId: toolCall.id,
            result: JSON.stringify({
              ok: false,
              error: `Tool desconocido: ${toolCall.function.name}`,
            }),
          });
          continue;
        }

        try {
          const result = await handler(toolCall, ctx);
          results.push(result);
        } catch (err) {
          logger.error(
            { err, toolName: toolCall.function.name, toolCallId: toolCall.id },
            'Error ejecutando tool',
          );
          results.push({
            toolCallId: toolCall.id,
            result: JSON.stringify({ ok: false, error: 'Error interno al ejecutar tool' }),
          });
        }
      }

      // Formato que Vapi espera: { results: [{ toolCallId, result }] }
      res.status(200).json({ results } satisfies VapiToolCallsResponse);
      return;
    }

    // ── call-started ──────────────────────────────────────────────────────
    if (message.type === 'call-started' && message.call) {
      logger.info({ callId: message.call.id, leadId }, 'Llamada iniciada');
    }

    // ── call-ended ────────────────────────────────────────────────────────
    if (message.type === 'call-ended' && message.call) {
      // El desenlace se registra vía tool-call registrar_resultado durante la llamada.
      // Aquí solo logueamos para auditoría.
      logger.info(
        {
          callId: message.call.id,
          endedReason: message.call.endedReason,
          leadId,
        },
        'Llamada finalizada — desenlace esperado vía tool registrar_resultado',
      );
    }

    // ── transcript ────────────────────────────────────────────────────────
    if (message.type === 'transcript' && message.call) {
      const texto = message.transcript;
      const rol = message.role;

      if (leadId && texto) {
        await Lead.updateOne(
          { _id: leadId },
          { $push: { notas: `[${rol ?? 'unknown'}] ${texto}` } },
        ).catch((err: unknown) =>
          logger.warn({ err, leadId }, 'No se pudo guardar línea de transcripción'),
        );
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
