import { logger } from '../../lib/logger';
import { LeadService } from '../leads/lead.service';
import { DenueClient } from './denue.client';
import { DenueSearchParams } from './denue.zod';

interface IngestaResult {
  fetched: number;
  created: number;
  skipped: number;
  errors: number;
}

export class IngestaService {
  private readonly denue: DenueClient;

  constructor(denue: DenueClient = new DenueClient()) {
    this.denue = denue;
  }

  /**
   * Fetches DENUE records for the given query, deduplicates by denueId,
   * and creates new leads. Already-existing leads (duplicate denueId or telefono)
   * are silently skipped.
   */
  async run(params: DenueSearchParams, fuenteUrl?: string): Promise<IngestaResult> {
    const establecimientos = await this.denue.fetchAll(params);
    const result: IngestaResult = { fetched: establecimientos.length, created: 0, skipped: 0, errors: 0 };

    for (const est of establecimientos) {
      try {
        await LeadService.create({
          denueId: est.id,
          razonSocial: est.raz_social ?? est.nom_estab,
          actividadEconomica: est.nombre_act,
          telefonoRaw: est.telefono,
          direccion: {
            calle: [est.tipo_vial, est.nom_vial, est.numero_ext].filter(Boolean).join(' ') || undefined,
            colonia: est.nom_col,
            municipio: est.nom_mun,
            estado: est.nom_ent,
            cp: est.cp,
          },
          fuente: 'denue',
          fuenteUrl: fuenteUrl ?? `${params.busqueda}@${est.nom_ent}`,
          notas: [],
        });
        result.created++;
      } catch (err: unknown) {
        // Duplicate key errors (denueId or telefono conflict) are expected and silent
        if (isDuplicateKeyError(err)) {
          result.skipped++;
        } else {
          result.errors++;
          logger.error({ err, denueId: est.id }, 'Error creating lead from DENUE record');
        }
      }
    }

    logger.info(result, 'Ingesta run complete');
    return result;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}
