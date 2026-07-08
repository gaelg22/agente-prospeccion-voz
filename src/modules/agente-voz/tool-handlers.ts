import { logger } from '../../lib/logger';
import { LeadService } from '../leads/lead.service';
import { ColaService } from '../cola/cola.service';
import { mapearDesenlace } from './call-outcome.handler';
import {
  VapiToolCall,
  VapiToolResult,
  zArgsRegistrarResultado,
  zArgsMarcarNoContactar,
  zArgsAgendarCita,
  zArgsVerificarDisponibilidad,
} from './vapi.zod';

// ─── Tipo de un handler de tool ───────────────────────────────────────────────

type ToolHandler = (toolCall: VapiToolCall) => Promise<VapiToolResult>;

// ─── registrar_resultado ──────────────────────────────────────────────────────

export const handleRegistrarResultado: ToolHandler = async (toolCall) => {
  const args = zArgsRegistrarResultado.parse(toolCall.function.arguments);
  const { leadId, desenlace, nota } = args;

  logger.info({ leadId, desenlace }, 'Tool: registrar_resultado');

  const lead = await LeadService.findById(leadId);
  if (!lead) {
    logger.warn({ leadId }, 'registrar_resultado: lead no encontrado');
    return { toolCallId: toolCall.id, result: JSON.stringify({ ok: false, error: 'Lead no encontrado' }) };
  }

  const outcome = mapearDesenlace(desenlace, lead.intentos);

  await LeadService.transition(lead._id, outcome.nuevoStatus, {
    nota: nota ? `${outcome.nota} | ${nota}` : outcome.nota,
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

export const handleMarcarNoContactar: ToolHandler = async (toolCall) => {
  const args = zArgsMarcarNoContactar.parse(toolCall.function.arguments);
  const { leadId, razon } = args;

  logger.info({ leadId, razon }, 'Tool: marcar_no_contactar');

  const lead = await LeadService.findById(leadId);
  if (!lead) {
    logger.warn({ leadId }, 'marcar_no_contactar: lead no encontrado');
    return { toolCallId: toolCall.id, result: JSON.stringify({ ok: false, error: 'Lead no encontrado' }) };
  }

  await LeadService.transition(lead._id, 'no_contactar', {
    nota: razon ? `DNC solicitado: ${razon}` : 'DNC — solicitado por el lead durante la llamada',
  });

  logger.info({ leadId }, 'marcar_no_contactar: lead marcado como DNC');

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({ ok: true, status: 'no_contactar' }),
  };
};

// ─── verificar_disponibilidad (STUB) ─────────────────────────────────────────
// TODO: integrar con Google Calendar en Paso 5

export const handleVerificarDisponibilidad: ToolHandler = async (toolCall) => {
  const args = zArgsVerificarDisponibilidad.parse(toolCall.function.arguments);
  const { fecha } = args;

  logger.info({ fecha }, 'Tool: verificar_disponibilidad [STUB]');

  // Stub: devuelve slots hardcodeados hasta que se integre Calendar
  const slotsSimulados = ['09:00', '11:00', '15:00', '17:00'];

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({
      ok: true,
      fecha,
      slots: slotsSimulados,
      _stub: true,
      _mensaje: 'Integración con Google Calendar pendiente (Paso 5)',
    }),
  };
};

// ─── agendar_cita (STUB) ─────────────────────────────────────────────────────
// TODO: integrar con Google Calendar + Kapso en Paso 5

export const handleAgendarCita: ToolHandler = async (toolCall) => {
  const args = zArgsAgendarCita.parse(toolCall.function.arguments);
  const { leadId, fechaPreferida, horaPreferida } = args;

  logger.info({ leadId, fechaPreferida, horaPreferida }, 'Tool: agendar_cita [STUB]');

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({
      ok: true,
      leadId,
      fechaPreferida,
      horaPreferida,
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
