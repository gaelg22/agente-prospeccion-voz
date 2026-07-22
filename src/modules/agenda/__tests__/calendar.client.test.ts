import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Config mockeable por test (flag GOOGLE_MEET_ENABLED) ────────────────────
const mockConfig = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'agente@proyecto.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: 'clave-de-prueba',
  GOOGLE_CALENDAR_ID: 'primary',
  GOOGLE_MEET_ENABLED: false,
};

vi.mock('../../../config', () => ({
  get config() {
    return mockConfig;
  },
}));

// ─── Mock de googleapis: capturamos el body enviado a events.insert ──────────
const insertMock = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: class {
        constructor() {}
      },
    },
    calendar: () => ({
      events: { insert: insertMock },
      freebusy: { query: vi.fn() },
    }),
  },
}));

import { CalendarClient } from '../calendar.client';

const baseParams = {
  summary: 'Cita Seguro — Consultorio X',
  startIso: '2026-07-20T17:00:00',
  endIso: '2026-07-20T18:00:00',
};

describe('CalendarClient.createEvent — link de Meet detrás de GOOGLE_MEET_ENABLED', () => {
  beforeEach(() => {
    insertMock.mockReset();
  });

  it('con el flag ON: manda conferenceData + conferenceDataVersion y extrae el linkReunion', async () => {
    mockConfig.GOOGLE_MEET_ENABLED = true;
    insertMock.mockResolvedValue({
      data: {
        id: 'evt-123',
        htmlLink: 'https://calendar.google.com/evt-123',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
            { entryPointType: 'more', uri: 'https://tel.meet/abc' },
          ],
        },
      },
    });

    const result = await new CalendarClient().createEvent(baseParams);

    const callArg = insertMock.mock.calls[0]?.[0];
    expect(callArg.conferenceDataVersion).toBe(1);
    expect(callArg.requestBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe(
      'hangoutsMeet',
    );
    expect(callArg.requestBody.conferenceData.createRequest.requestId).toMatch(/^lead-/);

    expect(result.meetUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(result.eventId).toBe('evt-123');
  });

  it('con el flag OFF: no manda conferenceData y meetUrl queda null', async () => {
    mockConfig.GOOGLE_MEET_ENABLED = false;
    insertMock.mockResolvedValue({
      data: {
        id: 'evt-456',
        htmlLink: 'https://calendar.google.com/evt-456',
        // Gmail personal: el evento se crea sin conferenceData.
      },
    });

    const result = await new CalendarClient().createEvent(baseParams);

    const callArg = insertMock.mock.calls[0]?.[0];
    expect(callArg.conferenceDataVersion).toBeUndefined();
    expect(callArg.requestBody.conferenceData).toBeUndefined();

    expect(result.meetUrl).toBeNull();
    expect(result.eventId).toBe('evt-456');
  });
});
