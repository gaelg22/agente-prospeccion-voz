import { logger } from '../../lib/logger';
import { fechaMexicoISO } from '../../lib/fecha-mexico';
import { LeadService } from '../leads/lead.service';
import { isTerminal } from '../leads/lead.transitions';
import { ColaService } from '../cola/cola.service';
import { mapearDesenlace } from './call-outcome.handler';
import {
  VapiToolCall,
  VapiToolResult,
  zArgsRegistrarResultado,
  zArgsMarcarNoContactar,
  zArgsAgendarCita,
} from './vapi.zod';

// ─── Contexto de la llamada ───────────────────────────────────────────────────
// El leadId NO viene en los argumentos de las tools (el LLM no lo conoce):
// el webhook lo recupera de metadata de la llamada y lo pasa aquí.

export interface ToolContext {
  leadId?: string | undefined;
  callId?: string | undefined;
}

type ToolHandler = (toolCall: VapiToolCall, ctx: ToolContext) => Promise<VapiToolResult>;

function sinLead(toolCall: VapiToolCall, toolName: string): VapiToolResult {
  logger.warn({ toolName }, 'Tool sin leadId en metadata de la llamada — no se puede correlacionar');
  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({ ok: false, error: 'Llamada sin leadId en metadata' }),
  };
}

// ─── registrar_resultado ──────────────────────────────────────────────────────

export const handleRegistrarResultado: ToolHandler = async (toolCall, ctx) => {
  const { desenlace, notas } = zArgsRegistrarResultado.parse(toolCall.function.arguments);
  if (!ctx.leadId) return sinLead(toolCall, 'registrar_resultado');
  const { leadId } = ctx;

  logger.info({ leadId, desenlace }, 'Tool: registrar_resultado');

  const lead = await LeadService.findById(leadId);
  if (!lead) {
    logger.warn({ leadId }, 'registrar_resultado: lead no encontrado');
    return { toolCallId: toolCall.id, result: JSON.stringify({ ok: false, error: 'Lead no encontrado' }) };
  }

  // Idempotencia: si el lead ya quedó cerrado en un estado terminal (p. ej.
  // marcar_no_contactar corrió antes en la misma llamada), registrar_resultado
  // no debe fallar con transición ilegal — el cierre ya está hecho.
  if (isTerminal(lead.status)) {
    logger.info(
      { leadId, desenlace, status: lead.status },
      'registrar_resultado: lead ya en estado terminal — sin transición',
    );
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({
        ok: true,
        nuevoStatus: lead.status,
        nota: `lead ya cerrado como ${lead.status}`,
        debeReintentar: false,
      }),
    };
  }

  const outcome = mapearDesenlace(desenlace, lead.intentos);

  await LeadService.transition(lead._id, outcome.nuevoStatus, {
    nota: notas ? `${outcome.nota} | ${notas}` : outcome.nota,
  });

  if (outcome.debeReintentar) {
    await ColaService.scheduleRetry(leadId, lead.ultimaLlamada ?? new Date());
  }

  logger.info(
    { leadId, desenlace, nuevoStatus: outcome.nuevoStatus, reintento: outcome.debeReintentar },
    'registrar_resultado: transición ejecutada',
  );

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({
      ok: true,
      nuevoStatus: outcome.nuevoStatus,
      debeReintentar: outcome.debeReintentar,
    }),
  };
};

// ─── marcar_no_contactar ──────────────────────────────────────────────────────

export const handleMarcarNoContactar: ToolHandler = async (toolCall, ctx) => {
  const { motivo } = zArgsMarcarNoContactar.parse(toolCall.function.arguments);
  if (!ctx.leadId) return sinLead(toolCall, 'marcar_no_contactar');
  const { leadId } = ctx;

  logger.info({ leadId, motivo }, 'Tool: marcar_no_contactar');

  const lead = await LeadService.findById(leadId);
  if (!lead) {
    logger.warn({ leadId }, 'marcar_no_contactar: lead no encontrado');
    return { toolCallId: toolCall.id, result: JSON.stringify({ ok: false, error: 'Lead no encontrado' }) };
  }

  await LeadService.transition(lead._id, 'no_contactar', {
    nota: motivo ? `DNC solicitado: ${motivo}` : 'DNC — solicitado por el lead durante la llamada',
  });

  logger.info({ leadId }, 'marcar_no_contactar: lead marcado como DNC');

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({ ok: true, status: 'no_contactar' }),
  };
};

// ─── verificar_disponibilidad (STUB) ─────────────────────────────────────────
// TODO: integrar con Google Calendar en Paso 5. La tool no lleva parámetros.

export const handleVerificarDisponibilidad: ToolHandler = async (toolCall) => {
  logger.info('Tool: verificar_disponibilidad [STUB]');

  // Stub: devuelve dos días con ventanas hardcodeadas hasta integrar Calendar.
  // Las fechas se calculan en zona de México (NO en UTC del server): en la noche
  // de México toISOString() daría el día siguiente y ofreceríamos días corridos.
  const ahora = new Date();
  const dia = (offset: number): string => fechaMexicoISO(ahora, offset);

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({
      ok: true,
      dias: [
        { fecha: dia(1), horas: ['09:00', '11:00', '15:00', '17:00'] },
        { fecha: dia(2), horas: ['10:00', '12:00', '16:00'] },
      ],
      _stub: true,
      _mensaje: 'Integración con Google Calendar pendiente (Paso 5)',
    }),
  };
};

// ─── agendar_cita (STUB) ─────────────────────────────────────────────────────
// TODO: integrar con Google Calendar + Kapso en Paso 5

export const handleAgendarCita: ToolHandler = async (toolCall, ctx) => {
  const { fecha, hora, notas } = zArgsAgendarCita.parse(toolCall.function.arguments);
  if (!ctx.leadId) return sinLead(toolCall, 'agendar_cita');
  const { leadId } = ctx;

  logger.info({ leadId, fecha, hora, notas }, 'Tool: agendar_cita [STUB]');

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({
      ok: true,
      leadId,
      fecha,
      hora,
      folio: `STUB-${toolCall.id.slice(-6)}`,
      _stub: true,
      _mensaje: 'Integración con Google Calendar pendiente (Paso 5)',
    }),
  };
};

// ─── Registro de handlers ─────────────────────────────────────────────────────

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  registrar_resultado: handleRegistrarResultado,
  marcar_no_contactar: handleMarcarNoContactar,
  verificar_disponibilidad: handleVerificarDisponibilidad,
  agendar_cita: handleAgendarCita,
};
