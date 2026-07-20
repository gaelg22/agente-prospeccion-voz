import mongoose from 'mongoose';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Leer .env
const envRaw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
const env = Object.fromEntries(
  envRaw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i+1).trim()]; })
);

const MONGODB_URI = env['MONGODB_URI'];
const SA_EMAIL    = env['GOOGLE_SERVICE_ACCOUNT_EMAIL'];
const PRIVATE_KEY = env['GOOGLE_PRIVATE_KEY']?.replace(/^"(.*)"$/, '$1').replace(/\\n/g, '\n');
const CAL_ID      = env['GOOGLE_CALENDAR_ID'];

if (!MONGODB_URI) { console.error('MONGODB_URI faltante'); process.exit(1); }

// ─── 1. MongoDB: limpiar leads de prueba ─────────────────────────────────────
await mongoose.connect(MONGODB_URI);
const leads = mongoose.connection.collection('leads');

// Borrar leads de fuente 'dev' o con denueId que empiece con 'test-'
const delResult = await leads.deleteMany({
  $or: [
    { fuente: 'dev' },
    { denueId: { $regex: '^test-' } },
  ]
});
console.log(`Leads eliminados: ${delResult.deletedCount}`);
await mongoose.disconnect();

// ─── 2. Google Calendar: borrar eventos del agente ───────────────────────────
if (!SA_EMAIL || !PRIVATE_KEY || !CAL_ID) {
  console.warn('Credenciales de Google Calendar no configuradas — saltando limpieza de Calendar');
  process.exit(0);
}

const auth = new google.auth.JWT({
  email: SA_EMAIL,
  key: PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const cal = google.calendar({ version: 'v3', auth });

// Listar todos los eventos creados por el agente (busca "Cita Seguro" en el summary)
let pageToken = undefined;
let deletedEvents = 0;

do {
  const resp = await cal.events.list({
    calendarId: CAL_ID,
    q: 'Cita Seguro',
    maxResults: 100,
    pageToken,
    singleEvents: true,
  });

  const events = resp.data.items ?? [];
  for (const event of events) {
    if (event.id) {
      await cal.events.delete({ calendarId: CAL_ID, eventId: event.id }).catch(e => {
        console.warn(`No se pudo borrar evento ${event.id}: ${e.message}`);
      });
      deletedEvents++;
      console.log(`Evento eliminado: ${event.summary} (${event.id})`);
    }
  }
  pageToken = resp.data.nextPageToken ?? undefined;
} while (pageToken);

console.log(`Total eventos eliminados: ${deletedEvents}`);
