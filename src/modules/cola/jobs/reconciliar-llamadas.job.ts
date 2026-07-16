import Agenda, { Job } from 'agenda';
import { logger } from '../../../lib/logger';
import { LeadService } from '../../leads/lead.service';
import { ColaService } from '../cola.service';
import { VapiClient, VapiCallResponse } from '../../agente-voz/vapi.client';
import { mapearDesenlace } from '../../agente-voz/call-outcome.handler';
import { DESENLACES_LLAMADA, DesenlaceLlamada } from '../../agente-voz/assistant.config';

export const JOB_NAME_RECONCILIAR = 'reconciliar-llamadas';

/** Cada cuánto corre el barrido de reconciliación */
export const RECONCILIAR_CADA_MINUTOS = 10;

/** Minutos en status=llamado a partir de los cuales un lead se considera varado */
export const UMBRAL_VARADO_MINUTOS = 15;

const NOTA_SIN_DESENLACE = 'reconciliado: webhook nunca llegó';
const NOTA_ACEPTO_SIN_CITA = 'reconciliado: acepto sin cita';

/**
 * Extrae el desenlace que el asistente alcanzó a reportar durante la llamada.
 * Si `registrar_resultado` se emitió pero nunca llegó al server (túnel caído),
 * el tool call queda de todas formas en el historial de GET /call/{id} — de
 * ahí se recupera. Regresa null si no hay ningún desenlace utilizable.
 */
export function extraerDesenlace(call: VapiCallResponse): DesenlaceLlamada | null {
  for (const mensaje of [...(call.messages ?? [])].reverse()) {
    for (const toolCall of mensaje.toolCalls ?? []) {
      if (toolCall.function?.name !== 'registrar_resultado') continue;

      let args = toolCall.function.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          continue;
        }
      }

      const desenlace = (args as { desenlace?: unknown } | null)?.desenlace;
      if (
        typeof desenlace === 'string' &&
        (DESENLACES_LLAMADA as readonly string[]).includes(desenlace)
      ) {
        return desenlace as DesenlaceLlamada;
      }
    }
  }
  return null;
}

/**
 * Job de reconciliación: recoge leads que quedaron varados en `llamado` porque
 * el webhook de fin de llamada nunca llegó (ej. túnel caído a media llamada),
 * consulta en el API de Vapi cómo terminó la llamada y aplica la transición
 * que el webhook habría aplicado.
 *
 * A PROPÓSITO no consulta COLA_ACTIVA: ese flag es el kill-switch de los jobs
 * que DISPARAN llamadas (marcar-llamada, reintento-llamada). Este job es de
 * limpieza — solo lee Vapi y corrige status; no marca a nadie. Si se apagara
 * junto con la cola, los leads varados se quedarían zombis para siempre,
 * justo en los periodos (cola apagada tras un incidente) donde más se ocupa.
 */
export function defineReconciliarLlamadasJob(agenda: Agenda): void {
  agenda.define(JOB_NAME_RECONCILIAR, { concurrency: 1 }, async (_job: Job) => {
    const umbral = new Date(Date.now() - UMBRAL_VARADO_MINUTOS * 60_000);
    await barrerLlamadosVarados(umbral);
    await barrerAceptoSinCita(umbral);
  });
}

// ─── Barrido 1: leads varados en `llamado` ────────────────────────────────────

async function barrerLlamadosVarados(umbral: Date): Promise<void> {
  const varados = await LeadService.findEstancadosEnLlamado(umbral);

  if (varados.length === 0) {
    logger.debug('reconciliar-llamadas: sin leads varados en llamado');
  } else {
    logger.info({ total: varados.length }, 'reconciliar-llamadas: leads varados encontrados');

    const vapiClient = new VapiClient();

    for (const lead of varados) {
      const leadId = lead._id.toString();
      try {
        let desenlace: DesenlaceLlamada = 'error_tecnico';
        let notaExtra = NOTA_SIN_DESENLACE;

        if (lead.vapiCallId) {
          const call = await vapiClient.getCall(lead.vapiCallId);

          // Llamada aún viva en Vapi: no hay nada que reconciliar todavía.
          if (call.status !== 'ended') {
            logger.debug(
              { leadId, vapiCallId: lead.vapiCallId, callStatus: call.status },
              'reconciliar-llamadas: la llamada sigue activa — se deja para el siguiente barrido',
            );
            continue;
          }

          const reportado = extraerDesenlace(call);
          if (reportado) {
            desenlace = reportado;
            notaExtra = 'reconciliado desde el API de Vapi: el webhook nunca llegó';
          }
        }

        const outcome = mapearDesenlace(desenlace, lead.intentos);

        await LeadService.transition(lead._id, outcome.nuevoStatus, {
          nota: `${outcome.nota} | ${notaExtra}`,
        });

        if (outcome.debeReintentar) {
          await ColaService.scheduleRetry(leadId, lead.ultimaLlamada ?? new Date());
        }

        logger.info(
          {
            leadId,
            vapiCallId: lead.vapiCallId ?? null,
            desenlace,
            nuevoStatus: outcome.nuevoStatus,
            reintento: outcome.debeReintentar,
          },
          'reconciliar-llamadas: lead reconciliado',
        );
      } catch (err) {
        // Un lead que falla (Vapi caído, transición ilegal) no debe frenar a
        // los demás; se queda varado y lo recoge el siguiente barrido.
        logger.error(
          { err, leadId, vapiCallId: lead.vapiCallId ?? null },
          'reconciliar-llamadas: fallo al reconciliar — se reintenta en el siguiente barrido',
        );
      }
    }
  }
}

// ─── Barrido 2: leads en `acepto` sin cita real ───────────────────────────────
// Hermano del barrido de `llamado`: registrar_resultado reportó acepto pero
// agendar_cita nunca corrió o falló, así que no hay evento en Calendar y nadie
// va a volver a llamar al lead. Se trata como error_tecnico (mismo mapeo que
// el webhook): reintento si intentos < 2, no_contactable si ya se agotaron.

async function barrerAceptoSinCita(umbral: Date): Promise<void> {
  const varados = await LeadService.findAceptoSinCita(umbral);

  if (varados.length === 0) {
    logger.debug('reconciliar-llamadas: sin leads varados en acepto sin cita');
    return;
  }

  logger.info({ total: varados.length }, 'reconciliar-llamadas: leads en acepto sin cita encontrados');

  for (const lead of varados) {
    const leadId = lead._id.toString();
    try {
      const outcome = mapearDesenlace('error_tecnico', lead.intentos);

      await LeadService.transition(lead._id, outcome.nuevoStatus, {
        nota: `${outcome.nota} | ${NOTA_ACEPTO_SIN_CITA}`,
      });

      if (outcome.debeReintentar) {
        await ColaService.scheduleRetry(leadId, lead.ultimaLlamada ?? new Date());
      }

      logger.info(
        { leadId, nuevoStatus: outcome.nuevoStatus, reintento: outcome.debeReintentar },
        'reconciliar-llamadas: acepto sin cita reconciliado',
      );
    } catch (err) {
      logger.error(
        { err, leadId },
        'reconciliar-llamadas: fallo al reconciliar acepto sin cita — se reintenta en el siguiente barrido',
      );
    }
  }
}
