import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Database } from './db.js';
import { analyzeTranscript, defaultSettings, getProviderStatuses, AIError } from './ai/index.js';
import { createGroqTranscriptionServices, createTranscriptionRouter, TranscriptionError, type TranscriptionServices } from './transcription.js';
import { dateSchema, meetingInputSchema, providerSchema, recordSchema, type ActionItem, type AIResult, type Job, type Meeting, type Provider, type ProviderStatus, type Settings } from '../shared/schema.js';

export interface AIServices {
  analyzeTranscript: (transcript: string, provider: Provider, model?: string, onProgress?: (progress: number) => void) => Promise<AIResult>;
  getProviderStatuses: () => Promise<ProviderStatus[]>;
  defaultSettings: () => Settings;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const uuid = z.string().uuid();
const version = z.number().int().positive();
const label = (max: number) => z.string().trim().min(1).max(max);
const settingsSchema = z.object({ provider: providerSchema, groqModel: z.string().trim().max(200), ollamaModel: z.string().trim().max(200) }).strict();
const patchMeetingSchema = z.object({ version, title: label(160).optional(), date: dateSchema.optional(), participants: z.array(label(100)).max(100).optional(), transcript: label(120000).optional() }).strict().refine(v => Object.keys(v).length > 1, 'Provide a field to update');
const patchActionSchema = z.object({ version, description: label(2000).optional(), owner: label(200).nullable().optional(), deadline: label(100).nullable().optional(), priority: z.enum(['low', 'medium', 'high']).optional(), status: z.enum(['todo', 'in_progress', 'done']).optional() }).strict().refine(v => Object.keys(v).length > 1, 'Provide a field to update');
const meetingSelect = `SELECT m.id, m.title, m.project_id AS "projectId", m.date, m.participants, m.transcript, m.status, m.record, m.provider, m.model, m.warnings, m.version, m.created_at AS "createdAt", m.updated_at AS "updatedAt", p.name AS "projectName", m.is_demo AS "isDemo" FROM meetings m JOIN projects p ON p.id = m.project_id`;
const actionSelect = `SELECT a.id, a.meeting_id AS "meetingId", m.title AS "meetingTitle", m.project_id AS "projectId", a.description, a.owner, a.deadline, a.priority, a.status, a.evidence, a.version FROM action_items a JOIN meetings m ON m.id = a.meeting_id`;
const jobSelect = `SELECT id, meeting_id AS "meetingId", status, provider, progress, error, error_code AS "errorCode", fallback_available AS "fallbackAvailable", created_at AS "createdAt" FROM jobs`;
type Queryable = Pick<Database, 'query'>;
async function meetingById(db: Queryable, id: string): Promise<Meeting> {
  const row = (await db.query<Meeting>(`${meetingSelect} WHERE m.id = $1`, [id])).rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Meeting not found.');
  return row;
}
async function assertIdle(db: Queryable, id: string) {
  const active = await db.query('SELECT id FROM jobs WHERE meeting_id = $1 AND status IN (\'queued\', \'processing\')', [id]);
  if (active.rows.length) throw new HttpError(409, 'PROCESSING', 'Analysis is running. Wait for it to finish before changing this meeting.');
}
function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new HttpError(409, 'VERSION_CONFLICT', 'This record changed in another window. Refresh it before saving.');
}
function fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function normalized(value: string) { return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function validateEvidence(record: z.infer<typeof recordSchema>, transcript: string) {
  const source = normalized(transcript);
  for (const item of [...record.decisions, ...record.actionItems, ...record.blockers, ...record.questions]) {
    if (!source.includes(normalized(item.evidence))) throw new HttpError(422, 'UNSUPPORTED_EVIDENCE', 'Every extracted item must include an exact supporting quotation from the transcript.');
  }
  for (const item of record.actionItems) {
    const evidence = normalized(item.evidence);
    if (item.owner && !evidence.includes(normalized(item.owner))) throw new HttpError(422, 'UNSUPPORTED_OWNER', 'An action owner is not present in its supporting quotation. Use unknown instead.');
    if (item.deadline && !evidence.includes(normalized(item.deadline))) throw new HttpError(422, 'UNSUPPORTED_DEADLINE', 'An action deadline is not present in its supporting quotation. Preserve the original wording or use unknown.');
  }
}

export function createApp(db: Database, ai: AIServices = { analyzeTranscript, defaultSettings, getProviderStatuses }, transcription: TranscriptionServices = createGroqTranscriptionServices()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } }, hsts: false }));
  app.use((req, _res, next) => {
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    try {
      const host = new URL(`http://${req.headers.host ?? ''}`).hostname;
      if (!allowedHosts.has(host)) throw new Error('host');
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        const ports = new Set([process.env.PORT || '3001', process.env.CLIENT_PORT || '5173']);
        if (origin.protocol !== 'http:' || !allowedHosts.has(origin.hostname) || !ports.has(origin.port)) throw new Error('origin');
      }
      next();
    } catch { next(new HttpError(403, 'ORIGIN_DENIED', 'This local application only accepts requests from its own loopback origin.')); }
  });
  const speech = createTranscriptionRouter(transcription);
  app.use('/api', speech.router);
  app.locals.waitForTranscriptions = speech.waitForJobs;
  app.locals.stopTranscriptions = speech.dispose;
  app.use(express.json({ limit: '1mb' }));
  // Keep only operational metadata in responses; never expose environment values.
  app.get('/api/health', asyncRoute(async (_req, res) => { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }));
  app.get('/api/projects', asyncRoute(async (_req, res) => {
    res.json((await db.query('SELECT id, name, description, created_at AS "createdAt" FROM projects ORDER BY created_at DESC, id')).rows);
  }));
  app.post('/api/projects', asyncRoute(async (req, res) => {
    const input = z.object({ name: label(100), description: z.string().trim().max(2000).default('') }).strict().parse(req.body);
    const project = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO projects(id, name, description, created_at) VALUES ($1, $2, $3, $4)', [project.id, project.name, project.description, project.createdAt]);
    res.status(201).json(project);
  }));
  app.get('/api/meetings', asyncRoute(async (req, res) => {
    const query = z.object({ q: z.string().trim().max(500).optional(), projectId: uuid.optional(), status: z.enum(['draft', 'review', 'final']).optional(), sort: z.enum(['newest', 'oldest']).default('newest') }).strict().parse(req.query);
    const values: unknown[] = []; const where: string[] = [];
    if (query.q) { values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(m.title ILIKE $${values.length} OR m.transcript ILIKE $${values.length})`); }
    if (query.projectId) { values.push(query.projectId); where.push(`m.project_id = $${values.length}`); }
    if (query.status) { values.push(query.status); where.push(`m.status = $${values.length}`); }
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';
    res.json((await db.query<Meeting>(`${meetingSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.date ${order}, m.created_at ${order}, m.id`, values)).rows);
  }));
  app.post('/api/meetings', asyncRoute(async (req, res) => {
    const input = meetingInputSchema.parse(req.body);
    const rawKey = req.header('Idempotency-Key');
    const key = rawKey ? z.string().regex(/^[a-zA-Z0-9_-]{10,128}$/).parse(rawKey) : null;
    const digest = fingerprint(input);
    const result = await db.transaction(async tx => {
      if (key) {
        const previous = (await tx.query<{ fingerprint: string; meeting_id: string }>('SELECT fingerprint, meeting_id FROM idempotency_keys WHERE key = $1', [key])).rows[0];
        if (previous) {
          if (previous.fingerprint !== digest) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used with different meeting data.');
          return { meeting: await meetingById(tx, previous.meeting_id), created: false };
        }
      }
      if (!(await tx.query('SELECT id FROM projects WHERE id = $1', [input.projectId])).rows.length) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Choose an existing project.');
      const id = randomUUID(); const now = new Date().toISOString();
      await tx.query('INSERT INTO meetings(id, project_id, title, date, participants, transcript, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, input.projectId, input.title, input.date, JSON.stringify(input.participants), input.transcript, now]);
      if (key) await tx.query('INSERT INTO idempotency_keys(key, fingerprint, meeting_id, created_at) VALUES ($1,$2,$3,$4)', [key, digest, id, now]);
      return { meeting: await meetingById(tx, id), created: true };
    });
    res.status(result.created ? 201 : 200).json(result.meeting);
  }));
  app.get('/api/meetings/:id', asyncRoute(async (req, res) => res.json(await meetingById(db, uuid.parse(req.params.id)))));
  app.patch('/api/meetings/:id', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id); const input = patchMeetingSchema.parse(req.body);
    const meeting = await db.transaction(async tx => {
      const original = await meetingById(tx, id); assertVersion(original.version, input.version); await assertIdle(tx, id);
      const changedTranscript = input.transcript !== undefined && input.transcript !== original.transcript;
      if (changedTranscript) await tx.query('DELETE FROM action_items WHERE meeting_id = $1', [id]);
      await tx.query(`UPDATE meetings SET title=$2, date=$3, participants=$4, transcript=$5, version=version+1, updated_at=$6, status=$7, record=$8, provider=$9, model=$10, warnings=$11, is_demo=$12 WHERE id=$1`, [id, input.title ?? original.title, input.date ?? original.date, JSON.stringify(input.participants ?? original.participants), input.transcript ?? original.transcript, new Date().toISOString(), changedTranscript ? 'draft' : original.status, changedTranscript ? null : JSON.stringify(original.record), changedTranscript ? null : original.provider, changedTranscript ? null : original.model, JSON.stringify(changedTranscript ? [] : original.warnings), changedTranscript ? false : original.isDemo]);
      return meetingById(tx, id);
    });
    res.json(meeting);
  }));
  app.delete('/api/meetings/:id', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id); const expectedVersion = z.coerce.number().int().positive().parse(req.query.version);
    await db.transaction(async tx => { const meeting = await meetingById(tx, id); assertVersion(meeting.version, expectedVersion); await assertIdle(tx, id); await tx.query('DELETE FROM meetings WHERE id=$1', [id]); });
    res.status(204).end();
  }));

  const running = new Set<Promise<void>>();
  app.locals.waitForJobs = async () => { await Promise.all([...running]); };
  async function runAnalysis(job: Job, meeting: Meeting, model?: string) {
    try {
      await db.query("UPDATE jobs SET status='processing', progress=5 WHERE id=$1", [job.id]);
      const result = await ai.analyzeTranscript(meeting.transcript, job.provider, model, progress => {
        // Progress is best effort and must never fail the actual inference.
        if (Number.isFinite(progress)) void db.query("UPDATE jobs SET progress=$2 WHERE id=$1 AND status='processing'", [job.id, Math.max(5, Math.min(95, Math.round(progress)))]).catch(() => undefined);
      });
      const record = recordSchema.parse(result.record);
      validateEvidence(record, meeting.transcript);
      if (result.provider !== job.provider) throw new HttpError(502, 'UNEXPECTED_PROVIDER', 'The AI response came from an unexpected provider.');
      await db.transaction(async tx => {
        const current = await meetingById(tx, meeting.id); assertVersion(current.version, meeting.version);
        await tx.query("UPDATE meetings SET status='review', record=$2, provider=$3, model=$4, warnings=$5, is_demo=$6, version=version+1, updated_at=$7 WHERE id=$1", [meeting.id, JSON.stringify(record), result.provider, result.model, JSON.stringify(result.warnings), result.provider === 'demo', new Date().toISOString()]);
        await tx.query("UPDATE jobs SET status='completed', progress=100 WHERE id=$1", [job.id]);
      });
    } catch (error) {
      let code = 'ANALYSIS_FAILED'; let message = 'Analysis could not be completed. Your transcript is safe; please try again.'; let fallback = false;
      if (error instanceof AIError) {
        code = error.code; message = error.message; fallback = Boolean(error.fallbackAvailable);
        if (job.provider === 'groq' && ['AI_RATE_LIMIT', 'AI_NETWORK', 'AI_TIMEOUT', 'AI_UNAVAILABLE'].includes(code)) {
          // A user may select a local model in Settings without editing .env.
          // Offer that model explicitly too; never run a fallback automatically.
          try {
            const configured = (await db.query<{ value: Settings }>('SELECT value FROM settings WHERE id=1')).rows[0]?.value ?? ai.defaultSettings();
            if (configured.ollamaModel) {
              const local = (await ai.getProviderStatuses()).find(status => status.provider === 'ollama');
              fallback = Boolean(local?.models.includes(configured.ollamaModel));
            }
          } catch { /* Keep the original safe failure and known fallback state. */ }
        }
      }
      else if (error instanceof HttpError) { code = error.code; message = error.message; }
      else if (error instanceof z.ZodError) { code = 'INVALID_AI_RESPONSE'; message = 'The model returned incomplete or malformed meeting data. No draft was saved. Try again or choose another provider.'; }
      await db.query("UPDATE jobs SET status='failed', error=$2, error_code=$3, fallback_available=$4 WHERE id=$1", [job.id, message, code, fallback]).catch(() => undefined);
    }
  }
  app.post('/api/meetings/:id/analyze', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id); const input = z.object({ provider: providerSchema, model: label(200).optional() }).strict().parse(req.body);
    const result = await db.transaction(async tx => {
      const meeting = await meetingById(tx, id);
      const savedSettings = (await tx.query<{ value: Settings }>('SELECT value FROM settings WHERE id=1')).rows[0]?.value ?? ai.defaultSettings();
      const model = input.model ?? (input.provider === 'groq' ? savedSettings.groqModel : input.provider === 'ollama' ? savedSettings.ollamaModel : undefined);
      const digest = fingerprint([meeting.transcript, input.provider, model || '']);
      const active = (await tx.query<Job>(`${jobSelect} WHERE meeting_id=$1 AND status IN ('queued','processing')`, [id])).rows[0];
      if (active) {
        const activeDigest = (await tx.query<{ fingerprint: string }>('SELECT fingerprint FROM jobs WHERE id=$1', [active.id])).rows[0].fingerprint;
        if (activeDigest !== digest) throw new HttpError(409, 'PROCESSING', 'Another provider or model is already analyzing this meeting. Wait for it to finish.');
        return { job: active, start: false, meeting, model };
      }
      const previous = (await tx.query<Job>(`${jobSelect} WHERE meeting_id=$1 AND fingerprint=$2 AND status='completed' ORDER BY created_at DESC LIMIT 1`, [id, digest])).rows[0];
      if (previous && meeting.record && meeting.provider === input.provider && (!model || meeting.model === model)) return { job: previous, start: false, meeting, model };
      if (meeting.status === 'final') throw new HttpError(409, 'ALREADY_FINAL', 'This meeting is already confirmed. Edit its transcript to create a new draft.');
      const activeCount = await tx.query<{ count: string }>("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','processing')");
      if (Number(activeCount.rows[0].count) >= 2) throw new HttpError(429, 'WORKSPACE_BUSY', 'Two meetings are already processing. Wait for one to finish before starting another.');
      const job: Job = { id: randomUUID(), meetingId: id, status: 'queued', provider: input.provider, progress: 0, error: null, errorCode: null, fallbackAvailable: false, createdAt: new Date().toISOString() };
      await tx.query('INSERT INTO jobs(id, meeting_id, status, provider, model, fingerprint, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [job.id, id, job.status, job.provider, model || null, digest, job.createdAt]);
      return { job, start: true, meeting, model };
    });
    if (result.start) {
      const promise = runAnalysis(result.job, result.meeting, result.model || undefined);
      running.add(promise); void promise.finally(() => running.delete(promise));
    }
    res.status(result.start ? 202 : 200).json(result.job);
  }));
  app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
    const job = (await db.query<Job>(`${jobSelect} WHERE id=$1`, [uuid.parse(req.params.id)])).rows[0];
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Analysis job not found.'); res.json(job);
  }));
  app.post('/api/meetings/:id/finalize', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id); const input = z.object({ version, record: recordSchema }).strict().parse(req.body);
    const result = await db.transaction(async tx => {
      const meeting = await meetingById(tx, id); assertVersion(meeting.version, input.version); await assertIdle(tx, id);
      if (meeting.status !== 'review') throw new HttpError(409, 'REVIEW_REQUIRED', 'Analyze the transcript and review its draft before confirming the meeting.');
      validateEvidence(input.record, meeting.transcript);
      await tx.query('DELETE FROM action_items WHERE meeting_id=$1', [id]);
      for (const action of input.record.actionItems) await tx.query('INSERT INTO action_items(id, meeting_id, description, owner, deadline, priority, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), id, action.description, action.owner, action.deadline, action.priority, action.evidence]);
      await tx.query("UPDATE meetings SET status='final', record=$2, version=version+1, updated_at=$3 WHERE id=$1", [id, JSON.stringify(input.record), new Date().toISOString()]);
      return meetingById(tx, id);
    });
    res.json(result);
  }));
  app.get('/api/actions', asyncRoute(async (req, res) => {
    const query = z.object({ q: z.string().trim().max(500).optional(), projectId: uuid.optional(), status: z.enum(['todo', 'in_progress', 'done']).optional() }).strict().parse(req.query);
    const values: unknown[] = []; const where: string[] = [];
    if (query.q) { values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(a.description ILIKE $${values.length} OR COALESCE(a.owner, '') ILIKE $${values.length})`); }
    if (query.projectId) { values.push(query.projectId); where.push(`m.project_id=$${values.length}`); }
    if (query.status) { values.push(query.status); where.push(`a.status=$${values.length}`); }
    res.json((await db.query<ActionItem>(`${actionSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.date DESC, a.id`, values)).rows);
  }));
  app.patch('/api/actions/:id', asyncRoute(async (req, res) => {
    const id = uuid.parse(req.params.id); const input = patchActionSchema.parse(req.body);
    const action = await db.transaction(async tx => {
      const original = (await tx.query<ActionItem>(`${actionSelect} WHERE a.id=$1`, [id])).rows[0];
      if (!original) throw new HttpError(404, 'NOT_FOUND', 'Action item not found.'); assertVersion(original.version, input.version);
      await tx.query('UPDATE action_items SET description=$2, owner=$3, deadline=$4, priority=$5, status=$6, version=version+1 WHERE id=$1', [id, input.description ?? original.description, input.owner === undefined ? original.owner : input.owner, input.deadline === undefined ? original.deadline : input.deadline, input.priority ?? original.priority, input.status ?? original.status]);
      return (await tx.query<ActionItem>(`${actionSelect} WHERE a.id=$1`, [id])).rows[0];
    }); res.json(action);
  }));
  app.get('/api/settings', asyncRoute(async (_req, res) => res.json((await db.query<{ value: Settings }>('SELECT value FROM settings WHERE id=1')).rows[0]?.value ?? ai.defaultSettings())));
  app.patch('/api/settings', asyncRoute(async (req, res) => {
    const settings = settingsSchema.parse(req.body);
    await db.query('INSERT INTO settings(id,value) VALUES (1,$1) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value', [JSON.stringify(settings)]);
    res.json(settings);
  }));
  app.get('/api/providers', asyncRoute(async (_req, res) => {
    const detected = await ai.getProviderStatuses();
    const settings = (await db.query<{ value: Settings }>('SELECT value FROM settings WHERE id=1')).rows[0]?.value ?? ai.defaultSettings();
    const providers = detected.map(status => {
      const selectedModel = status.provider === 'groq' ? settings.groqModel : status.provider === 'ollama' ? settings.ollamaModel : '';
      if (!selectedModel) return status;
      const configured = status.provider === 'ollama' ? true : status.configured;
      if (!status.models.length) return { ...status, configured, selectedModel };
      const available = status.models.includes(selectedModel);
      return { ...status, configured, selectedModel, available, message: available ? `${selectedModel} is available. ${status.provider === 'groq' ? 'Cloud processing; plan limits apply.' : 'Local processing on this computer.'}` : 'The selected model is missing. Choose an installed or available model.' };
    });
    res.json({ providers, defaultProvider: settings.provider });
  }));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'API endpoint not found.')));
  const dist = resolve(process.cwd(), 'dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist, { dotfiles: 'deny', index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError || error instanceof TranscriptionError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Check the highlighted fields and try again.', code: 'VALIDATION_ERROR', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }); return; }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : null;
    if (type === 'entity.too.large') { res.status(413).json({ error: 'This request is too large. Transcripts are limited to 120,000 characters.', code: 'PAYLOAD_TOO_LARGE' }); return; }
    if (type === 'entity.parse.failed') { res.status(400).json({ error: 'The request must contain valid JSON.', code: 'INVALID_JSON' }); return; }
    // Never send SQL, transcripts, credentials or stack traces to the browser.
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: 'The server could not complete this request. Please try again.', code: 'INTERNAL_ERROR' });
  });
  return app;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
}
