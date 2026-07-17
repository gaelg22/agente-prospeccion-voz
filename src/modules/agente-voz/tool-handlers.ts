import { logger } from '../../lib/logger';
import { LeadService } from '../leads/lead.service';
import { Lead } from '../leads/lead.schema';
import { isTerminal, InvalidTransitionError } from '../leads/lead.transitions';
import { ColaService } from '../cola/cola.service';
import { mapearDesenlace } from './call-outcome.handler';
import { AgendaService } from '../agenda/agenda.service';
import { normalizePhone } from '../../lib/phone';
import { CalendarClient } from '../agenda/calendar.client';
import { getNextDaysWithSlots } from '../agenda/slots';
import { duracionHoras } from '../agenda/modalidad';
import {
  VapiToolCall,
  VapiToolResult,
  zArgsRegistrarResultado,
  zArgsMarcarNoContactar,
  zArgsAgendarCita,
  zArgsVerificarDisponibilidad,
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

  // Marca inequívoca e incondicional: el flag noContactar + la nota se
  // persisten SIEMPRE, aunque el status actual no admita la transición.
  // findNextToCall excluye cualquier lead con este flag, esté donde esté.
  const notaDnc = motivo ? `DNC solicitado: ${motivo}` : 'DNC — solicitado por el lead durante la llamada';
  await Lead.updateOne({ _id: lead._id }, { $set: { noContactar: true }, $push: { notas: notaDnc } });

  let statusFinal = lead.status;
  if (lead.status !== 'no_contactar') {
    try {
      const updated = await LeadService.transition(lead._id, 'no_contactar');
      statusFinal = updated.status;
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Idempotente: desde este status (terminal, acepto…) la transición no
        // aplica. El flag DNC ya quedó persistido — el lead no volverá a marcarse.
        logger.info(
          { leadId, status: lead.status },
          'marcar_no_contactar: transición no aplicable desde status actual — flag DNC persistido sin cambio de status',
        );
      } else {
        // El flag ya está persistido: cualquier otro error en la transición
        // no debe hacer fallar la tool ni revertir el DNC.
        logger.error({ err, leadId }, 'marcar_no_contactar: error en transición — flag DNC ya persistido');
      }
    }
  }

  logger.info({ leadId, status: statusFinal }, 'marcar_no_contactar: lead marcado como DNC');

  return {
    toolCallId: toolCall.id,
    result: JSON.stringify({ ok: true, status: statusFinal, noContactar: true }),
  };
};

// ─── verificar_disponibilidad ─────────────────────────────────────────────────
// Consulta Google Calendar y devuelve hasta 2 días con slots libres.
// Si las credenciales no están configuradas, devuelve error para que el LLM
// aplique la regla de falla técnica (sección 7 del prompt).

export const handleVerificarDisponibilidad: ToolHandler = async (toolCall) => {
  const { modalidad } = zArgsVerificarDisponibilidad.parse(toolCall.function.arguments);
  const duracion = duracionHoras(modalidad);
  logger.info({ modalidad, duracion }, 'Tool: verificar_disponibilidad');

  try {
    const calendarClient = new CalendarClient();
    const dias = await getNextDaysWithSlots(calendarClient, 2, 14, duracion);

    if (dias.length === 0) {
      logger.warn('verificar_disponibilidad: no hay slots disponibles en los próximos 14 días');
      return {
        toolCallId: toolCall.id,
        result: JSON.stringify({
          ok: false,
          error: 'Sin disponibilidad en los próximos 14 días',
        }),
      };
    }

    logger.info({ dias: dias.map((d) => d.fecha) }, 'verificar_disponibilidad: slots obtenidos');
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ ok: true, dias }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'verificar_disponibilidad: error al consultar Calendar');
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ ok: false, error: msg }),
    };
  }
};

// ─── agendar_cita ─────────────────────────────────────────────────────────────
// Crea el evento en Google Calendar, transiciona el lead a 'agendado' y envía
// la confirmación por WhatsApp vía Kapso.

export const handleAgendarCita: ToolHandler = async (toolCall, ctx) => {
  const { fecha, hora, modalidad, consienteWhatsapp, whatsappAlterno, notas } =
    zArgsAgendarCita.parse(toolCall.function.arguments);
  if (!ctx.leadId) return sinLead(toolCall, 'agendar_cita');
  const { leadId } = ctx;

  logger.info(
    { leadId, fecha, hora, modalidad, consienteWhatsapp, whatsappAlterno, notas },
    'Tool: agendar_cita',
  );

  try {
    const lead = await LeadService.findById(leadId);
    if (!lead) {
      return {
        toolCallId: toolCall.id,
        result: JSON.stringify({ ok: false, error: 'Lead no encontrado' }),
      };
    }

    // La transición llamado→acepto ocurre DENTRO de book(), solo después de
    // que el evento de Calendar se creó. Si Calendar falla, el lead permanece
    // en 'llamado' y sigue recuperable (reintento vía error_tecnico o barrido
    // de reconciliación) — no queda varado en 'acepto'.
    if (lead.status !== 'llamado' && lead.status !== 'acepto') {
      return {
        toolCallId: toolCall.id,
        result: JSON.stringify({
          ok: false,
          error: `Lead en estado inesperado: ${lead.status}`,
        }),
      };
    }

    // slotIso: "YYYY-MM-DDTHH:mm:ss" en zona México (Calendar lo interpreta con TZ)
    const slotIso = `${fecha}T${hora}:00`;

    // ── Consentimiento WhatsApp y número alterno ──────────────────────────────
    // El alterno dictado por voz se valida como número MX (E.164). Si no valida:
    // se ignora, queda nota, y NO se envía nada — ni siquiera al número de la
    // llamada, porque la persona pidió explícitamente OTRO destino.
    const alternoNormalizado = whatsappAlterno ? normalizePhone(whatsappAlterno) : null;
    const alternoInvalido = Boolean(whatsappAlterno) && alternoNormalizado === null;
    const enviarWhatsapp = consienteWhatsapp && !alternoInvalido;
    if (alternoInvalido) {
      logger.warn({ leadId, whatsappAlterno }, 'agendar_cita: alterno no validó como número MX — sin envío');
    }

    // Persistir consentimiento/alterno y notas sin cambiar el estado
    // (evita transición acepto→acepto ilegal)
    const notasNuevas: string[] = [];
    if (notas) notasNuevas.push(`Notas llamada: ${notas}`);
    if (alternoInvalido) {
      notasNuevas.push(
        `WhatsApp alterno inválido ("${whatsappAlterno}") — confirmación NO enviada, contactar para completar registro`,
      );
    }
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: {
          consienteWhatsapp,
          ...(alternoNormalizado ? { whatsappAlterno: alternoNormalizado } : {}),
        },
        ...(notasNuevas.length ? { $push: { notas: { $each: notasNuevas } } } : {}),
      },
    ).catch(() => null);

    const agenda = new AgendaService();
    // book() crea el evento en Calendar, transiciona a 'agendado' y envía la
    // confirmación por WhatsApp SOLO si hubo consentimiento (al alterno validado
    // o, sin alterno, al número de la llamada). La modalidad define la duración
    // (virtual 1 h, presencial 2 h).
    await agenda.book(leadId, slotIso, modalidad, {
      enviar: enviarWhatsapp,
      ...(alternoNormalizado ? { destino: alternoNormalizado } : {}),
    });

    // Recuperar el lead actualizado para obtener el folio (googleEventId)
    const leadAgendado = await LeadService.findById(leadId);
    const folio = leadAgendado?.cita?.googleEventId ?? `EVT-${Date.now()}`;
    const meetUrl = leadAgendado?.cita?.meetUrl ?? null;

    logger.info({ leadId, folio, slotIso }, 'agendar_cita: cita confirmada');

    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({
        ok: true,
        folio,
        fecha,
        hora,
        modalidad,
        meetUrl,
        // false cuando no hubo consentimiento O el alterno no validó: en ambos
        // casos el modelo debe dictar folio y hora de viva voz (Paso 7).
        whatsappEnviado: enviarWhatsapp,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, leadId, fecha, hora }, 'agendar_cita: error al agendar');
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ ok: false, error: msg }),
    };
  }
};

// ─── Registro de handlers ─────────────────────────────────────────────────────

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  registrar_resultado: handleRegistrarResultado,
  marcar_no_contactar: handleMarcarNoContactar,
  verificar_disponibilidad: handleVerificarDisponibilidad,
  agendar_cita: handleAgendarCita,
};
