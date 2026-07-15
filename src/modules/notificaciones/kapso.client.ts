import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import { logger } from '../../lib/logger';

export interface KapsoMessagePayload {
  to: string;
  templateName: string;
  variables: Record<string, string>;
}

export interface KapsoMessageResponse {
  messageId: string;
  status: string;
}

export class KapsoClient {
  private readonly http: AxiosInstance | null;

  constructor() {
    const apiUrl = config.KAPSO_API_URL;
    const apiKey = config.KAPSO_API_KEY;

    // Inicialización lazy: si no hay credenciales, http queda null.
    // El error se lanza en sendTemplate() para que el caller lo maneje.
    if (apiUrl && apiKey) {
      this.http = axios.create({
        baseURL: apiUrl,
        timeout: 15_000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    } else {
      this.http = null;
    }
  }

  async sendTemplate(payload: KapsoMessagePayload): Promise<KapsoMessageResponse> {
    if (!this.http) {
      throw new Error('KAPSO_API_URL y KAPSO_API_KEY son requeridas para WhatsApp');
    }

    logger.debug({ to: payload.to, template: payload.templateName }, 'Enviando mensaje Kapso');

    const { data } = await this.http.post<KapsoMessageResponse>('/messages/template', {
      to: payload.to,
      template: {
        name: payload.templateName,
        variables: payload.variables,
      },
    });

    logger.info({ messageId: data.messageId, to: payload.to }, 'Mensaje Kapso enviado');
    return data;
  }
}
