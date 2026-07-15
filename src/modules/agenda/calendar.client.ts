import { google, calendar_v3, Auth } from 'googleapis';
import { config } from '../../config';
import { logger } from '../../lib/logger';

const TZ = 'America/Mexico_City';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getAuthClient(): Auth.JWT {
  const email = config.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = config.GOOGLE_PRIVATE_KEY;

  if (!email || !key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL y GOOGLE_PRIVATE_KEY son requeridos para el calendario');
  }

  return new google.auth.JWT(email, undefined, key.replace(/\\n/g, '\n'), SCOPES);
}

function getCalendarId(): string {
  const id = config.GOOGLE_CALENDAR_ID;
  if (!id) throw new Error('GOOGLE_CALENDAR_ID es requerida para operaciones de calendario');
  return id;
}

export interface CalendarEventParams {
  summary: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendeeEmail?: string;
  /**
   * Pide link de Meet para este evento. Default true (compat). En citas
   * presenciales va false: no hay videollamada, así que no se genera Meet.
   * Además de este flag, se requiere GOOGLE_MEET_ENABLED activado.
   */
  withMeet?: boolean;
}

export interface CalendarEventResult {
  eventId: string;
  meetUrl: string | null;
  htmlLink: string | null;
}

export class CalendarClient {
  private readonly cal: calendar_v3.Calendar;

  constructor() {
    const auth = getAuthClient();
    this.cal = google.calendar({ version: 'v3', auth });
  }

  async createEvent(params: CalendarEventParams): Promise<CalendarEventResult> {
    const calendarId = getCalendarId();
    logger.debug({ summary: params.summary, start: params.startIso }, 'Creando evento en Calendar');

    // conferenceData (link de Meet) solo funciona con Google Workspace: un Gmail
    // personal responde "Invalid conference type". Se activa por env
    // GOOGLE_MEET_ENABLED; con el flag apagado el evento se crea sin Meet y
    // meetUrl queda null, sin romper el flujo. En citas presenciales el caller
    // pasa withMeet=false: no hay videollamada, así que tampoco link de Meet.
    const meetEnabled = config.GOOGLE_MEET_ENABLED && params.withMeet !== false;

    const requestBody: calendar_v3.Schema$Event = {
      summary: params.summary,
      description: params.description ?? null,
      start: { dateTime: params.startIso, timeZone: TZ },
      end: { dateTime: params.endIso, timeZone: TZ },
      ...(meetEnabled && {
        conferenceData: {
          createRequest: {
            // requestId único por evento: idempotencia de la creación de Meet.
            requestId: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
      ...(params.attendeeEmail && {
        attendees: [{ email: params.attendeeEmail }],
      }),
    };

    const response = await this.cal.events.insert({
      calendarId,
      // conferenceDataVersion: 1 es obligatorio para que Google procese el
      // createRequest y devuelva los entryPoints con el link de Meet.
      ...(meetEnabled && { conferenceDataVersion: 1 }),
      requestBody,
    });

    const data = response.data;
    const eventId = data.id ?? '';
    const entryPoints = data.conferenceData?.entryPoints ?? [];
    const meetUrl = entryPoints.find((ep: calendar_v3.Schema$EntryPoint) => ep.entryPointType === 'video')?.uri ?? null;
    const htmlLink = data.htmlLink ?? null;

    logger.info({ eventId, meetUrl }, 'Evento de Calendar creado');
    return { eventId, meetUrl, htmlLink };
  }

  async getBusySlots(dayIso: string): Promise<Array<{ start: string; end: string }>> {
    const calendarId = getCalendarId();

    // RFC3339 completo: Google Calendar rechaza datetimes sin timezone offset.
    // Usamos -06:00 (CST) para abarcar el día completo en México; durante CDT
    // (-05:00) el desfase de 1 hora en los bordes es inocuo para freeBusy.
    const timeMin = new Date(`${dayIso}T00:00:00-06:00`).toISOString();
    const timeMax = new Date(`${dayIso}T23:59:59-06:00`).toISOString();

    const response = await this.cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: TZ,
        items: [{ id: calendarId }],
      },
    });

    const data = response.data;
    const calendars = data.calendars ?? {};
    const calData = calendars[calendarId];
    return (calData?.busy ?? []).flatMap((b: calendar_v3.Schema$TimePeriod) =>
      b.start != null && b.end != null ? [{ start: b.start, end: b.end }] : [],
    );
  }
}
