import 'dotenv/config';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const dataPath = resolve(process.env.DATA_DIR || './data/postgres');
await mkdir(dataPath, { recursive: true });
const db = await openDatabase(dataPath);
const app = createApp(db);
// Deliberately bind only to loopback. This release has one local workspace and
// does not provide accounts or multi-user authentication.
const server = app.listen(port, '127.0.0.1', () => console.log(`Minutes is running at http://127.0.0.1:${port}`));
server.on('error', async error => { console.error('Could not start the local server:', error.message); await db.close(); process.exit(1); });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  app.locals.stopTranscriptions();
  server.close(async () => { await Promise.all([app.locals.waitForJobs(), app.locals.waitForTranscriptions()]); await db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
