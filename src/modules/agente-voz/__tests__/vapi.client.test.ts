import { describe, it, expect, vi } from 'vitest';

// ─── Mock de config — assistant.config y vapi.client la leen al importarse ───

vi.mock('../../../config', () => ({
  config: {
    PUBLIC_URL: 'https://agente-test.onrender.com',
    VAPI_API_KEY: 'vapi-key-test',
    VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
    VAPI_PHONE_NUMBER_ID: 'phone-number-test-id',
    VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
    VAPI_VOICE_ID: 'voz-de-prueba',
    VAPI_VOICE_MODEL: 'eleven_flash_v2_5',
    VAPI_TRANSCRIBER_MODEL: 'nova-2',
    VAPI_TRANSCRIBER_LANGUAGE: 'es-419',
    AGENTE_NOMBRE: 'Sofía',
    EMPRESA_NOMBRE: 'Seguros Test S.A.',
    TELEFONO_OFICIAL: '55 1234 5678',
  },
}));

import { buildOutboundCallPayload } from '../vapi.client';
import { systemPrompt, VARIABLES_DEFAULT } from '../assistant.config';

const paramsBase = {
  toNumber: '+525512345678',
  leadId: '6650f0aa1234567890abcdef',
  prospectoNombre: 'Dra. Martínez',
  especialidad: 'Consultorios dentales',
  metadata: { razonSocial: 'Consultorio Dental Martínez SC' },
};

describe('buildOutboundCallPayload — payload exacto para POST /call', () => {
  it('incluye el assistant transient completo: prompt + 4 tools + endCall + modelo', () => {
    const payload = buildOutboundCallPayload(paramsBase);

    expect(payload.assistant.model.messages[0]).toEqual({
      role: 'system',
      content: systemPrompt,
    });
    expect(payload.assistant.model.provider).toBe('anthropic');
    expect(payload.assistant.model.model).toBe('claude-sonnet-4-5-20250929');
    expect(
      payload.assistant.model.tools.map((t) => (t.type === 'function' ? t.function.name : t.type)),
    ).toEqual([
      'verificar_disponibilidad',
      'agendar_cita',
      'registrar_resultado',
      'marcar_no_contactar',
      'endCall',
    ]);
  });

  it('manda variableValues con los datos del lead', () => {
    const payload = buildOutboundCallPayload(paramsBase);

    expect(payload.assistantOverrides.variableValues).toEqual({
      prospecto_nombre: 'Dra. Martínez',
      especialidad: 'Consultorios dentales',
    });
  });

  it('aplica defaults sensatos cuando el lead no trae nombre/especialidad', () => {
    const payload = buildOutboundCallPayload({
      toNumber: '+525512345678',
      leadId: 'lead-sin-datos',
      prospectoNombre: null,
      especialidad: '   ',
    });

    expect(payload.assistantOverrides.variableValues).toEqual({
      prospecto_nombre: VARIABLES_DEFAULT.prospecto_nombre, // doctor(a)
      especialidad: VARIABLES_DEFAULT.especialidad,
    });
  });

  it('lleva metadata.leadId para correlacionar en el webhook (y no se puede pisar)', () => {
    const payload = buildOutboundCallPayload({
      ...paramsBase,
      metadata: { razonSocial: 'X', leadId: 'intruso' },
    });

    expect(payload.assistantOverrides.metadata['leadId']).toBe('6650f0aa1234567890abcdef');
    expect(payload.assistantOverrides.metadata['razonSocial']).toBe('X');
  });

  it('incluye phoneNumberId y el número destino', () => {
    const payload = buildOutboundCallPayload(paramsBase);

    expect(payload.phoneNumberId).toBe('phone-number-test-id');
    expect(payload.customer).toEqual({ number: '+525512345678' });
  });

  it('[demo] imprime el payload exacto que se mandaría a Vapi (sin ejecutar llamada)', () => {
    const payload = buildOutboundCallPayload(paramsBase);

    // El system prompt completo (~90 líneas) se acorta solo para la impresión;
    // en el payload real viaja íntegro (verificado en el primer test).
    const paraImprimir = JSON.parse(JSON.stringify(payload)) as typeof payload;
    const prompt = paraImprimir.assistant.model.messages[0];
    if (prompt) {
      prompt.content = `${prompt.content.slice(0, 120)}… [system prompt completo: ${payload.assistant.model.messages[0]?.content.length} chars]`;
    }

    console.log('\n═══ PAYLOAD EXACTO → POST https://api.vapi.ai/call ═══\n');
    console.log(JSON.stringify(paraImprimir, null, 2));

    expect(payload).toBeTruthy();
  });
});

describe('buildOutboundCallPayload — validaciones', () => {
  it('falla con error claro si VAPI_PHONE_NUMBER_ID no está configurado', async () => {
    vi.resetModules();
    vi.doMock('../../../config', () => ({
      config: {
        PUBLIC_URL: 'https://agente-test.onrender.com',
        VAPI_API_KEY: 'vapi-key-test',
        VAPI_WEBHOOK_SECRET: 'secreto-de-prueba',
        VAPI_PHONE_NUMBER_ID: undefined,
        VAPI_LLM_MODEL: 'claude-sonnet-4-5-20250929',
        AGENTE_NOMBRE: 'Sofía',
        EMPRESA_NOMBRE: 'Seguros Test S.A.',
        TELEFONO_OFICIAL: '55 1234 5678',
      },
    }));

    const mod = await import('../vapi.client');
    expect(() => mod.buildOutboundCallPayload(paramsBase)).toThrow(/VAPI_PHONE_NUMBER_ID/);

    vi.doUnmock('../../../config');
    vi.resetModules();
  });
});
