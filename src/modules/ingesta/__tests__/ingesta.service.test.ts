/**
 * Tests A5: IngestaService.run() promueve leads a listo_llamar automáticamente
 * cuando el lead creado tiene teléfono válido (Opción B: siempre, sin depender
 * de COLA_ACTIVA).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createMock, transitionMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  transitionMock: vi.fn(),
}));

vi.mock('../../leads/lead.service', () => ({
  LeadService: {
    create: createMock,
    transition: transitionMock,
  },
}));

vi.mock('../denue.client', () => ({
  DenueClient: vi.fn(() => ({ fetchAll: vi.fn() })),
}));

import { IngestaService } from '../ingesta.service';
import { DenueClient } from '../denue.client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEstablecimiento(overrides = {}) {
  return {
    id: 'denue-001',
    nom_estab: 'Consultorio Test',
    raz_social: 'Test S.A.',
    nombre_act: 'Consultorios de medicina general',
    telefono: '5512345678',
    tipo_vial: 'Calle',
    nom_vial: 'Reforma',
    numero_ext: '100',
    nom_col: 'Centro',
    nom_mun: 'Monterrey',
    nom_ent: 'Nuevo León',
    cp: '64000',
    ...overrides,
  };
}

function makeLeadCreado(telefono: string | null) {
  return {
    _id: new Types.ObjectId(),
    status: 'nuevo',
    telefono,
    razonSocial: 'Test S.A.',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IngestaService.run() — A5: promoción automática nuevo→listo_llamar', () => {
  let fetchAllMock: ReturnType<typeof vi.fn>;
  let service: IngestaService;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchAllMock = vi.fn();
    const denue = { fetchAll: fetchAllMock } as unknown as DenueClient;
    service = new IngestaService(denue);
    transitionMock.mockResolvedValue({});
  });

  it('lead con teléfono válido: create() + transition(listo_llamar) — result.promoted=1', async () => {
    const lead = makeLeadCreado('+525512345678');
    fetchAllMock.mockResolvedValue([makeEstablecimiento()]);
    createMock.mockResolvedValue(lead);

    const result = await service.run({ busqueda: 'consultorios', entidad: '19' });

    expect(createMock).toHaveBeenCalledOnce();
    expect(transitionMock).toHaveBeenCalledWith(
      lead._id,
      'listo_llamar',
      expect.objectContaining({ nota: expect.stringContaining('ingesta DENUE') }),
    );
    expect(result.created).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('lead sin teléfono (null): create() pero NO transition() — result.promoted=0', async () => {
    const leadSinTel = makeLeadCreado(null);
    fetchAllMock.mockResolvedValue([makeEstablecimiento({ telefono: '' })]);
    createMock.mockResolvedValue(leadSinTel);

    const result = await service.run({ busqueda: 'consultorios', entidad: '19' });

    expect(createMock).toHaveBeenCalledOnce();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(result.created).toBe(1);
    expect(result.promoted).toBe(0);
  });

  it('duplicado (código 11000): ni create ni transition — result.skipped=1', async () => {
    fetchAllMock.mockResolvedValue([makeEstablecimiento()]);
    const dupError = Object.assign(new Error('E11000'), { code: 11000 });
    createMock.mockRejectedValue(dupError);

    const result = await service.run({ busqueda: 'consultorios', entidad: '19' });

    expect(transitionMock).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('varios leads: promoted cuenta solo los que tienen teléfono', async () => {
    fetchAllMock.mockResolvedValue([
      makeEstablecimiento({ id: 'denue-001' }),
      makeEstablecimiento({ id: 'denue-002', telefono: '' }),
      makeEstablecimiento({ id: 'denue-003' }),
    ]);

    createMock
      .mockResolvedValueOnce(makeLeadCreado('+525511111111'))
      .mockResolvedValueOnce(makeLeadCreado(null))
      .mockResolvedValueOnce(makeLeadCreado('+525522222222'));

    const result = await service.run({ busqueda: 'consultorios', entidad: '19' });

    expect(result.fetched).toBe(3);
    expect(result.created).toBe(3);
    expect(result.promoted).toBe(2);
    expect(transitionMock).toHaveBeenCalledTimes(2);
  });

  it('resultado incluye campo promoted en la respuesta JSON', async () => {
    fetchAllMock.mockResolvedValue([]);
    const result = await service.run({ busqueda: 'consultorios', entidad: '19' });

    expect(result).toHaveProperty('promoted');
    expect(result.promoted).toBe(0);
  });
});
