import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import { logger } from '../../lib/logger';

export interface VapiCallResponse {
  id: string;
  status: string;
  phoneNumber?: string;
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
   * Creates an outbound phone call via Vapi.
   * @param toNumber E.164 phone number to call
   * @param metadata Key-value metadata passed through to the call (leadId, etc.)
   */
  async createCall(
    toNumber: string,
    metadata: Record<string, string> = {},
  ): Promise<VapiCallResponse> {
    logger.debug({ toNumber }, 'Creating Vapi outbound call');

    const { data } = await this.http.post<VapiCallResponse>('/call/phone', {
      assistantId: config.VAPI_ASSISTANT_ID,
      customer: { number: toNumber },
      metadata,
    });

    logger.info({ callId: data.id, toNumber }, 'Vapi call created');
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
