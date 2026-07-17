import { describe, it, expect, vi, beforeEach } from 'vitest';

// config.ts hace process.exit() si faltan envs. Objeto mutable: cada test
// puede poner/quitar ASESOR_WHATSAPP (el servicio lo lee al momento del envío).
const mockConfig = vi.hoisted(() => ({
  KAPSO_WHATSAPP_TEMPLATE: 'confirmacion_cita',
  KAPSO_ASESOR_TEMPLATE: 'aviso_cita_asesor',
  ASESOR_WHATSAPP: undefined as string | undefined,
}));
vi.mock('../../../config', () => ({ config: mockConfig }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../../lib/logger', () => ({ logger: mockLogger }));

import { NotificacionesService } from '../notificaciones.service';
import type { KapsoClient } from '../kapso.client';

const lead = { razonSocial: 'Consultorio Test', telefono: '+525512345678' };
const CITA_FECHA = new Date('2026-08-03T23:00:00Z'); // 17:00 hora de México

function setup() {
  const sendTemplate = vi.fn(async () => ({ messageId: 'msg-1', status: 'sent' }));
  const service = new NotificacionesService({ sendTemplate } as unknown as KapsoClient);
  return { service, sendTemplate };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.ASESOR_WHATSAPP = undefined;
});

// ─── sendAdvisorNotice ────────────────────────────────────────────────────────

describe('NotificacionesService.sendAdvisorNotice', () => {
  it('sin ASESOR_WHATSAPP: se salta el envío con log claro', async () => {
    const { service, sendTemplate } = setup();

    await service.sendAdvisorNotice(lead, {
      citaFecha: CITA_FECHA,
      modalidad: 'virtual',
      folio: 'evt-1',
      contactarDirecto: false,
    });

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('ASESOR_WHATSAPP no configurada'),
    );
  });

  it('con env y contactarDirecto: avisa al asesor con la nota de contactar directo', async () => {
    mockConfig.ASESOR_WHATSAPP = '+525599887766';
    const { service, sendTemplate } = setup();

    await service.sendAdvisorNotice(lead, {
      citaFecha: CITA_FECHA,
      modalidad: 'presencial',
      folio: 'evt-1',
      contactarDirecto: true,
    });

    expect(sendTemplate).toHaveBeenCalledOnce();
    const payload = sendTemplate.mock.calls[0]?.[0] as {
      to: string;
      templateName: string;
      variables: Record<string, string>;
    };
    expect(payload.to).toBe('+525599887766');
    expect(payload.templateName).toBe('aviso_cita_asesor');
    expect(payload.variables['razon_social']).toBe('Consultorio Test');
    expect(payload.variables['modalidad']).toBe('Presencial');
    expect(payload.variables['folio']).toBe('evt-1');
    expect(payload.variables['telefono_prospecto']).toBe('+525512345678');
    expect(payload.variables['nota']).toContain('contactar directamente para enviarle los datos');
  });

  it('con consentimiento del prospecto: la nota confirma que ya recibió su WhatsApp', async () => {
    mockConfig.ASESOR_WHATSAPP = '+525599887766';
    const { service, sendTemplate } = setup();

    await service.sendAdvisorNotice(lead, {
      citaFecha: CITA_FECHA,
      modalidad: 'virtual',
      folio: 'evt-2',
      contactarDirecto: false,
    });

    const payload = sendTemplate.mock.calls[0]?.[0] as { variables: Record<string, string> };
    expect(payload.variables['nota']).toContain('recibió su confirmación por WhatsApp');
    expect(payload.variables['modalidad']).toBe('Videollamada');
  });

  it('si Kapso falla: loguea y NO lanza (no rompe el agendado)', async () => {
    mockConfig.ASESOR_WHATSAPP = '+525599887766';
    const { service, sendTemplate } = setup();
    sendTemplate.mockRejectedValue(new Error('Kapso caído'));

    await expect(
      service.sendAdvisorNotice(lead, {
        citaFecha: CITA_FECHA,
        folio: 'evt-1',
        contactarDirecto: true,
      }),
    ).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to send advisor notice',
    );
  });
});

// ─── sendBookingConfirmation — destino alterno ───────────────────────────────

describe('NotificacionesService.sendBookingConfirmation', () => {
  it('con telefonoDestino: el WhatsApp va al alterno, no al número de la llamada', async () => {
    const { service, sendTemplate } = setup();

    await service.sendBookingConfirmation(lead, {
      citaFecha: CITA_FECHA,
      meetUrl: 'https://meet/x',
      modalidad: 'virtual',
      telefonoDestino: '+524921112233',
    });

    const payload = sendTemplate.mock.calls[0]?.[0] as { to: string };
    expect(payload.to).toBe('+524921112233');
  });

  it('sin telefonoDestino: usa el número de la llamada', async () => {
    const { service, sendTemplate } = setup();

    await service.sendBookingConfirmation(lead, {
      citaFecha: CITA_FECHA,
      meetUrl: null,
      modalidad: 'virtual',
    });

    const payload = sendTemplate.mock.calls[0]?.[0] as { to: string };
    expect(payload.to).toBe('+525512345678');
  });
});
