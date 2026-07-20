import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Leer .env manualmente
const envContent = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
const uri = envContent.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();
if (!uri) throw new Error('MONGODB_URI no encontrada en .env');

const leadId = process.argv[2];
const targetStatus = process.argv[3] ?? 'listo_llamar';
if (!leadId) { console.error('Uso: node scripts/reset-lead.mjs <leadId> [status]'); process.exit(1); }

await mongoose.connect(uri);
const result = await mongoose.connection.collection('leads').updateOne(
  { _id: new mongoose.Types.ObjectId(leadId) },
  { $set: { status: targetStatus, intentos: 0 } }
);
console.log(`Reset OK — matched: ${result.matchedCount}, modified: ${result.modifiedCount}`);
await mongoose.disconnect();
