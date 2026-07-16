import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { zDenueEstablecimiento, DenueEstablecimiento, DenueSearchParams } from './denue.zod';

const PAGE_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

function buildUrl(params: DenueSearchParams, registro: number): string {
  const { busqueda, entidad, municipio, actividad } = params;
  const hasta = registro + PAGE_SIZE - 1;
  // DENUE URL pattern:
  // /BuscarAreaActEstr/{token}/{busqueda}/{entidad}/{municipio}/{seccion}/{actividad}/{lat}/{lon}/{distancia}/{num}/{registro}
  return [
    config.DENUE_BASE_URL,
    'BuscarAreaActEstr',
    config.DENUE_TOKEN,
    encodeURIComponent(busqueda),
    entidad,
    municipio,
    '0', // seccion
    actividad,
    '0', // lat
    '0', // lon
    '0', // distancia (0 = ignore)
    hasta,
    registro,
  ].join('/');
}

async function fetchWithRetry(client: AxiosInstance, url: string): Promise<unknown[]> {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const { data } = await client.get<unknown[]>(url);
      if (!Array.isArray(data)) return [];
      return data;
    } catch (err) {
      attempt++;
      if (attempt >= MAX_RETRIES) throw err;
      const delay = RETRY_BASE_MS * 2 ** attempt;
      logger.warn({ url, attempt, delay }, 'DENUE request failed, retrying…');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return [];
}

export class DenueClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({ timeout: 15_000 });
  }

  /**
   * Fetches all pages for a given search query.
   * Validates each record with Zod; invalid records are logged and skipped.
   */
  async fetchAll(params: DenueSearchParams): Promise<DenueEstablecimiento[]> {
    const results: DenueEstablecimiento[] = [];
    let registro = 1;

    while (true) {
      const url = buildUrl(params, registro);
      logger.debug({ url, registro }, 'Fetching DENUE page');

      const raw = await fetchWithRetry(this.http, url);
      if (raw.length === 0) break;

      for (const item of raw) {
        const parsed = zDenueEstablecimiento.safeParse(item);
        if (parsed.success) {
          results.push(parsed.data);
        } else {
          logger.warn({ issues: parsed.error.issues, item }, 'Skipping invalid DENUE record');
        }
      }

      if (raw.length < PAGE_SIZE) break;
      registro += PAGE_SIZE;
    }

    logger.info({ count: results.length, busqueda: params.busqueda }, 'DENUE fetch complete');
    return results;
  }
}
