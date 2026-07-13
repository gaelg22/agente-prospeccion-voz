import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { formatFechaHoraMexico } from '../../lib/fecha-mexico';
import { buildAssistant, VapiTransientAssistant, VARIABLES_DEFAULT } from './assistant.config';

export interface VapiCallResponse {
  id: string;
  status: string;
  phoneNumber?: string;
  endedReason?: string;
  /** Historial de la llamada — GET /call/{id} lo incluye una vez terminada */
  messages?: VapiCallMessage[];
}

// Forma mínima de los mensajes de GET /call/{id} que necesita la
// reconciliación: solo interesan los tool calls que el LLM alcanzó a emitir.
// `arguments` llega como objeto o como string JSON según el endpoint.
export interface VapiCallMessage {
  role?: string;
  toolCalls?: Array<{
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
}

// ─── Parámetros de una llamada saliente ───────────────────────────────────────

export interface OutboundCallParams {
  /** Número destino en E.164 */
  toNumber: string;
  /** _id del lead — viaja en assistantOverrides.metadata para correlacionar en el webhook */
  leadId: string;
  /** Nombre con el que el asistente saluda ({{prospecto_nombre}}) */
  prospectoNombre?: string | null;
  /** Giro/especialidad del prospecto ({{especialidad}}) */
  especialidad?: string | null;
  /** Metadata adicional (ej. esReintento) — se fusiona junto al leadId */
  metadata?: Record<string, string>;
}

export interface VapiOutboundCallPayload {
  phoneNumberId: string;
  customer: { number: string };
  assistant: VapiTransientAssistant;
  assistantOverrides: {
    variableValues: { prospecto_nombre: string; especialidad: string; fecha_hora_actual: string };
    metadata: Record<string, string>;
  };
}

/**
 * Construye el body exacto que se manda a POST /call. Pura (sin red) para
 * poder inspeccionarla en tests sin ejecutar ninguna llamada real.
 */
export function buildOutboundCallPayload(params: OutboundCallParams): VapiOutboundCallPayload {
  if (!config.VAPI_PHONE_NUMBER_ID) {
    throw new Error(
      'VAPI_PHONE_NUMBER_ID no configurado — es requerido para crear llamadas salientes en Vapi',
    );
  }

  return {
    phoneNumberId: config.VAPI_PHONE_NUMBER_ID,
    customer: { number: params.toNumber },
    assistant: buildAssistant(),
    assistantOverrides: {
      variableValues: {
        prospecto_nombre: params.prospectoNombre?.trim() || VARIABLES_DEFAULT.prospecto_nombre,
        especialidad: params.especialidad?.trim() || VARIABLES_DEFAULT.especialidad,
        // Fecha/hora de México calculada AQUÍ (no el {{now}} de Vapi, que llega
        // en UTC): es la referencia de "hoy" del prompt (sección 10).
        fecha_hora_actual: formatFechaHoraMexico(),
      },
      metadata: { ...params.metadata, leadId: params.leadId },
    },
  };
}

export class VapiClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.vapi.ai',
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${config.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Crea una llamada saliente en Vapi con el assistant transient completo
   * (prompt + tools de assistant.config) y la identidad del lead.
   */
  async createCall(params: OutboundCallParams): Promise<VapiCallResponse> {
    const payload = buildOutboundCallPayload(params);
    logger.debug({ toNumber: params.toNumber, leadId: params.leadId }, 'Creating Vapi outbound call');

    const { data } = await this.http.post<VapiCallResponse>('/call', payload);

    logger.info({ callId: data.id, toNumber: params.toNumber, leadId: params.leadId }, 'Vapi call created');
    return data;
  }

  /**
   * Retrieves call details by ID.
   */
  async getCall(callId: string): Promise<VapiCallResponse> {
    const { data } = await this.http.get<VapiCallResponse>(`/call/${callId}`);
    return data;
  }
}
