import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks antes de importar los handlers ────────────────────────────────────
// config.ts hace process.exit() si faltan vars; assistant.config (importado por
// vapi.zod) lee PUBLIC_URL y la identidad al cargar.

vi.mock('../../../config', () => ({
  config: {
    NODE_ENV: 'test',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    PUBLIC_URL: 'https://agente-test.onrender.com',
    AGENTE_NOMBRE: 'Sofía',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
  },
}));

const mockLeadService = vi.hoisted(() => ({
  findById: vi.fn(),
  transition: vi.fn(),
}));
vi.mock('../../leads/lead.service', () => ({ LeadService: mockLeadService }));

const mockColaService = vi.hoisted(() => ({
  scheduleRetry: vi.fn(),
}));
vi.mock('../../cola/cola.service', () => ({ ColaService: mockColaService }));

import { handleRegistrarResultado } from '../tool-handlers';
import type { VapiToolCall } from '../vapi.zod';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolCallRegistrar(desenlace: string, notas?: string): VapiToolCall {
  return {
    id: 'tc-idem-01',
    type: 'function',
    function: {
      name: 'registrar_resultado',
      arguments: notas ? { desenlace, notas } : { desenlace },
    },
  } as VapiToolCall;
}

const CTX = { leadId: 'lead-123', callId: 'call-abc' };

// ─── Tests: idempotencia sobre lead terminal ─────────────────────────────────

describe('handleRegistrarResultado — idempotencia con lead ya terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no_contactar → registrar_resultado responde éxito sin intentar transición', async () => {
    // Caso exacto de la llamada de validación del 11 jul: marcar_no_contactar
    // ya cerró el lead y el registrar_resultado final fallaba con 409.
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'no_contactar',
      intentos: 1,
    });

    const res = await handleRegistrarResultado(toolCallRegistrar('no_contactar'), CTX);

    const body = JSON.parse(res.result) as {
      ok: boolean;
      nuevoStatus: string;
      nota: string;
      debeReintentar: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('no_contactar');
    expect(body.nota).toBe('lead ya cerrado como no_contactar');
    expect(body.debeReintentar).toBe(false);

    expect(mockLeadService.transition).not.toHaveBeenCalled();
    expect(mockColaService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('cubre cualquier terminal, sin importar el desenlace reportado', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'no_interesado',
      intentos: 2,
    });

    const res = await handleRegistrarResultado(toolCallRegistrar('error_tecnico'), CTX);

    const body = JSON.parse(res.result) as { ok: boolean; nota: string };
    expect(body.ok).toBe(true);
    expect(body.nota).toBe('lead ya cerrado como no_interesado');
    expect(mockLeadService.transition).not.toHaveBeenCalled();
  });

  it('con lead NO terminal sigue transicionando normal', async () => {
    mockLeadService.findById.mockResolvedValue({
      _id: 'lead-123',
      status: 'llamado',
      intentos: 1,
    });
    mockLeadService.transition.mockResolvedValue({});

    const res = await handleRegistrarResultado(toolCallRegistrar('no_interesado'), CTX);

    const body = JSON.parse(res.result) as { ok: boolean; nuevoStatus: string };
    expect(body.ok).toBe(true);
    expect(body.nuevoStatus).toBe('no_interesado');
    expect(mockLeadService.transition).toHaveBeenCalledWith(
      'lead-123',
      'no_interesado',
      expect.objectContaining({ nota: expect.stringContaining('no interesado') }),
    );
  });
});
