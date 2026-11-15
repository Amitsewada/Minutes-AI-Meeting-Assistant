import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openDatabase, type Database } from '../server/db.js';
import { createApp, type AIServices } from '../server/app.js';
import { AIError } from '../server/ai/index.js';
import type { AIResult, Meeting, MeetingRecord, ProviderStatus } from '../shared/schema.js';

const transcript = 'Amit: We decided to launch the pilot. Amit will send the report by Friday. Priya: Budget approval is blocked. What is the rollout date?';
const record: MeetingRecord = {
  summary: 'The team agreed to launch a pilot and discussed reporting and budget approval.',
  decisions: [{ text: 'Launch the pilot.', evidence: 'We decided to launch the pilot.' }],
  actionItems: [{ description: 'Send the report.', owner: 'Amit', deadline: 'Friday', priority: 'medium', evidence: 'Amit will send the report by Friday.' }],
  blockers: [{ text: 'Budget approval is blocked.', evidence: 'Budget approval is blocked.' }],
  questions: [{ text: 'What is the rollout date?', evidence: 'What is the rollout date?' }],
};
const aiResult: AIResult = { record, provider: 'demo', model: 'deterministic-test', warnings: ['Mocked AI response used only by tests.'] };
let db: Database;
let app: ReturnType<typeof createApp>;
let ai: AIServices;
let projectId: string;
beforeAll(async () => { db = await openDatabase(); }, 30000);
beforeEach(async () => {
  await db.exec('TRUNCATE projects, meetings, jobs, action_items, settings, idempotency_keys CASCADE');
  ai = {
    analyzeTranscript: vi.fn(async () => structuredClone(aiResult)),
    defaultSettings: () => ({ provider: 'demo', groqModel: '', ollamaModel: '' }),
    getProviderStatuses: vi.fn(async (): Promise<ProviderStatus[]> => [
      { provider: 'demo', available: true, configured: true, models: ['deterministic-test'], selectedModel: 'deterministic-test', message: 'Test demo' },
      { provider: 'groq', available: false, configured: false, models: [], selectedModel: '', message: 'Missing key' },
      { provider: 'ollama', available: false, configured: false, models: [], selectedModel: '', message: 'Not running' },
    ]),
  };
  app = createApp(db, ai);
  projectId = (await request(app).post('/api/projects').send({ name: 'Atlas', description: 'Pilot launch' }).expect(201)).body.id;
});
afterAll(async () => { await app?.locals.waitForJobs(); await db?.close(); });
const meetingInput = (extra = {}) => ({ title: 'Pilot planning', projectId, date: '2026-10-15', participants: ['Amit', 'Priya'], transcript, ...extra });
async function createMeeting(extra = {}): Promise<Meeting> { return (await request(app).post('/api/meetings').send(meetingInput(extra)).expect(201)).body; }
async function reviewMeeting(): Promise<Meeting> {
  const meeting = await createMeeting();
  await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' }).expect(202);
  await app.locals.waitForJobs();
  return (await request(app).get(`/api/meetings/${meeting.id}`).expect(200)).body;
}
async function finalizeMeeting(): Promise<Meeting> {
  const meeting = await reviewMeeting();
  return (await request(app).post(`/api/meetings/${meeting.id}/finalize`).send({ version: meeting.version, record }).expect(200)).body;
}

describe('project and meeting APIs (real isolated PostgreSQL; mocked AI)', () => {
  it('starts with genuine empty meeting/action collections and a healthy database', async () => {
    expect((await request(app).get('/api/meetings').expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/actions').expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/health').expect(200)).body).toEqual({ status: 'ok', database: 'connected' });
    expect((await request(app).get('/api/projects').expect(200)).body[0].name).toBe('Atlas');
  });
  it('validates project names, unknown fields, transcript lengths, dates and participants', async () => {
    await request(app).post('/api/projects').send({ name: '   ' }).expect(400);
    await request(app).post('/api/projects').send({ name: 'x'.repeat(101) }).expect(400);
    await request(app).post('/api/projects').send({ name: 'A', isAdmin: true }).expect(400);
    for (const invalid of [{ title: '' }, { title: '   ' }, { transcript: '' }, { transcript: 'x'.repeat(120001) }, { date: '2026-02-30' }, { date: 'not-a-date' }, { projectId: 'x' }, { participants: [''] }, { unexpected: 'field' }]) {
      const response = await request(app).post('/api/meetings').send(meetingInput(invalid)).expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    await request(app).post('/api/meetings').send(meetingInput({ projectId: randomUUID() })).expect(404);
  });
  it('preserves Unicode and original transcript, supports literal search, filters and sorting', async () => {
    const older = await createMeeting({ title: 'Résumé — योजना 100%', date: '2026-01-01', transcript: `${transcript}\n原文 '); DROP TABLE meetings; --` });
    const later = await createMeeting({ title: 'Later launch', date: '2026-11-15' });
    expect((await request(app).get(`/api/meetings/${older.id}`).expect(200)).body.transcript).toBe(older.transcript);
    expect((await request(app).get('/api/meetings?q=%25').expect(200)).body.map((m: Meeting) => m.id)).toEqual([older.id]);
    expect((await request(app).get('/api/meetings').query({ q: 'योजना' }).expect(200)).body).toHaveLength(1);
    expect((await request(app).get('/api/meetings?sort=oldest').expect(200)).body.map((m: Meeting) => m.id)).toEqual([older.id, later.id]);
    expect((await request(app).get('/api/meetings?sort=newest').expect(200)).body[0].id).toBe(later.id);
    expect((await request(app).get(`/api/meetings?projectId=${randomUUID()}`).expect(200)).body).toEqual([]);
    expect((await request(app).get('/api/meetings?status=final').expect(200)).body).toEqual([]);
    await request(app).get('/api/meetings?sort=DROP').expect(400);
  });
  it('deduplicates repeated and concurrent create requests and rejects key reuse with changed data', async () => {
    const key = randomUUID();
    const responses = await Promise.all([1, 2].map(() => request(app).post('/api/meetings').set('Idempotency-Key', key).send(meetingInput())));
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    await request(app).post('/api/meetings').set('Idempotency-Key', key).send(meetingInput({ title: 'Different' })).expect(409);
    expect((await request(app).get('/api/meetings')).body).toHaveLength(1);
  });
  it('edits using optimistic concurrency and rejects stale updates and deletions', async () => {
    const meeting = await createMeeting();
    const changed = await request(app).patch(`/api/meetings/${meeting.id}`).send({ version: 1, title: 'Updated title' }).expect(200);
    expect(changed.body.title).toBe('Updated title'); expect(changed.body.version).toBe(2);
    expect((await request(app).patch(`/api/meetings/${meeting.id}`).send({ version: 1, title: 'Stale' }).expect(409)).body.code).toBe('VERSION_CONFLICT');
    await request(app).delete(`/api/meetings/${meeting.id}?version=1`).expect(409);
    await request(app).delete(`/api/meetings/${meeting.id}?version=2`).expect(204);
    await request(app).get(`/api/meetings/${meeting.id}`).expect(404);
  });
  it('rejects malformed ids, missing records, invalid JSON and oversized bodies', async () => {
    await request(app).get('/api/meetings/not-uuid').expect(400);
    await request(app).get(`/api/meetings/${randomUUID()}`).expect(404);
    await request(app).get(`/api/jobs/${randomUUID()}`).expect(404);
    await request(app).post('/api/meetings').set('Content-Type', 'application/json').send('{broken').expect(400);
    await request(app).post('/api/meetings').send({ data: 'x'.repeat(1100000) }).expect(413);
    await request(app).get('/api/not-real').expect(404);
  });
});

describe('analysis, review and action workflow', () => {
  it('saves a separate AI draft, requires review, confirms transactionally and retains source', async () => {
    const draft = await reviewMeeting();
    expect(draft.status).toBe('review'); expect(draft.isDemo).toBe(true); expect(draft.transcript).toBe(transcript); expect(draft.record).toEqual(record);
    expect((await request(app).get('/api/actions')).body).toEqual([]);
    const edited = { ...record, summary: 'A human-reviewed summary.' };
    const final = (await request(app).post(`/api/meetings/${draft.id}/finalize`).send({ version: draft.version, record: edited }).expect(200)).body;
    expect(final.status).toBe('final'); expect(final.record.summary).toBe(edited.summary); expect(final.transcript).toBe(transcript);
    const actions = (await request(app).get('/api/actions').expect(200)).body;
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ owner: 'Amit', deadline: 'Friday', meetingId: final.id, status: 'todo' });
    await request(app).post(`/api/meetings/${draft.id}/finalize`).send({ version: draft.version, record: edited }).expect(409);
    expect((await request(app).get('/api/actions')).body).toHaveLength(1);
  });
  it('does not finalize unreviewed meetings or accept unsupported evidence, owners or deadlines', async () => {
    const raw = await createMeeting();
    await request(app).post(`/api/meetings/${raw.id}/finalize`).send({ version: 1, record }).expect(409);
    const draft = await reviewMeeting();
    for (const changed of [{ evidence: 'Invented promise' }, { owner: 'Unknown person' }, { owner: 'Priya' }, { deadline: '2099-01-01' }]) {
      const invalid = { ...record, actionItems: [{ ...record.actionItems[0], ...changed }] };
      await request(app).post(`/api/meetings/${draft.id}/finalize`).send({ version: draft.version, record: invalid }).expect(422);
    }
    expect((await request(app).get('/api/actions')).body).toEqual([]);
    expect((await request(app).get(`/api/meetings/${draft.id}`)).body.status).toBe('review');
  });
  it('allows unknown owners and deadlines instead of inventing values', async () => {
    const draft = await reviewMeeting();
    const unknowns = { ...record, actionItems: [{ ...record.actionItems[0], owner: null, deadline: null }] };
    await request(app).post(`/api/meetings/${draft.id}/finalize`).send({ version: draft.version, record: unknowns }).expect(200);
    expect((await request(app).get('/api/actions')).body[0]).toMatchObject({ owner: null, deadline: null });
  });
  it('deduplicates completed analysis without spending AI quota twice', async () => {
    const draft = await reviewMeeting();
    const again = await request(app).post(`/api/meetings/${draft.id}/analyze`).send({ provider: 'demo' }).expect(200);
    expect(again.body.status).toBe('completed'); expect(ai.analyzeTranscript).toHaveBeenCalledTimes(1);
  });
  it('locks meeting edits/deletion during jobs and deduplicates concurrent clicks', async () => {
    let complete!: (value: AIResult) => void;
    ai.analyzeTranscript = vi.fn(() => new Promise<AIResult>(resolve => { complete = resolve; }));
    const meeting = await createMeeting();
    const first = await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' }).expect(202);
    const again = await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' }).expect(200);
    expect(first.body.id).toBe(again.body.id);
    await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'ollama' }).expect(409);
    await request(app).patch(`/api/meetings/${meeting.id}`).send({ version: 1, transcript: 'Replacement' }).expect(409);
    await request(app).delete(`/api/meetings/${meeting.id}?version=1`).expect(409);
    complete(aiResult); await app.locals.waitForJobs();
    expect((await request(app).get(`/api/jobs/${first.body.id}`)).body.status).toBe('completed');
    expect(ai.analyzeTranscript).toHaveBeenCalledTimes(1);
  });
  it('caps concurrent analysis at two jobs, releases capacity, and reuses completed work while busy', async () => {
    const pending: Array<(value: AIResult) => void> = [];
    ai.analyzeTranscript = vi.fn(() => new Promise<AIResult>(resolve => { pending.push(resolve); }));
    const meetings = await Promise.all([1, 2, 3].map(i => createMeeting({ title: `Concurrent ${i}` })));
    try {
      const results = await Promise.all(meetings.map(meeting => request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' })));
      expect(results.map(response => response.status).sort()).toEqual([202, 202, 429]);
      const busyIndex = results.findIndex(response => response.status === 429);
      expect(results[busyIndex].body.code).toBe('WORKSPACE_BUSY');
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(ai.analyzeTranscript).toHaveBeenCalledTimes(2);
      const active = results.find(response => response.status === 202)!;
      const duplicate = await request(app).post(`/api/meetings/${active.body.meetingId}/analyze`).send({ provider: 'demo' }).expect(200);
      expect(duplicate.body.id).toBe(active.body.id);
      pending.shift()!(aiResult);
      let completedMeetingId = '';
      await vi.waitFor(async () => {
        const rows = await db.query<{ meeting_id: string }>("SELECT meeting_id FROM jobs WHERE status='completed'");
        expect(rows.rows).toHaveLength(1);
        completedMeetingId = rows.rows[0].meeting_id;
      });
      await request(app).post(`/api/meetings/${meetings[busyIndex].id}/analyze`).send({ provider: 'demo' }).expect(202);
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      const cached = await request(app).post(`/api/meetings/${completedMeetingId}/analyze`).send({ provider: 'demo' }).expect(200);
      expect(cached.body.status).toBe('completed');
      expect(ai.analyzeTranscript).toHaveBeenCalledTimes(3);
    } finally {
      for (const resolve of pending) resolve(aiResult);
      await app.locals.waitForJobs();
    }
  });
  it('shows typed AI failures, keeps source intact, and retries explicitly', async () => {
    ai.analyzeTranscript = vi.fn().mockRejectedValueOnce(new AIError('AI_RATE_LIMIT', 'Groq quota reached. Choose Ollama explicitly.', 429, true)).mockResolvedValueOnce(aiResult);
    const meeting = await createMeeting();
    const failure = await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'groq' }).expect(202);
    await app.locals.waitForJobs();
    expect((await request(app).get(`/api/jobs/${failure.body.id}`)).body).toMatchObject({ status: 'failed', errorCode: 'AI_RATE_LIMIT', fallbackAvailable: true });
    expect((await request(app).get(`/api/meetings/${meeting.id}`)).body).toMatchObject({ status: 'draft', transcript, record: null });
    await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' }).expect(202);
    await app.locals.waitForJobs();
    expect((await request(app).get(`/api/meetings/${meeting.id}`)).body.status).toBe('review');
  });
  it('rejects malformed, ungrounded, or unexpectedly switched provider outputs before saving', async () => {
    for (const result of [{ ...aiResult, record: { summary: 'Incomplete' } }, { ...aiResult, record: { ...record, decisions: [{ text: 'Unsupported claim', evidence: 'Made up evidence' }] } }, { ...aiResult, provider: 'ollama' }]) {
      ai.analyzeTranscript = vi.fn().mockResolvedValue(result);
      const meeting = await createMeeting();
      const job = (await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'demo' }).expect(202)).body;
      await app.locals.waitForJobs();
      expect((await request(app).get(`/api/jobs/${job.id}`)).body.status).toBe('failed');
      expect((await request(app).get(`/api/meetings/${meeting.id}`)).body.record).toBeNull();
    }
  });
  it('invalidates derived records and tasks when the original transcript changes', async () => {
    const meeting = await finalizeMeeting();
    const changed = (await request(app).patch(`/api/meetings/${meeting.id}`).send({ version: meeting.version, transcript: 'A new meeting transcript.' }).expect(200)).body;
    expect(changed).toMatchObject({ status: 'draft', record: null, provider: null, model: null, isDemo: false });
    expect((await request(app).get('/api/actions')).body).toEqual([]);
  });
  it('persists action edits, searches and filters, rejects stale writes, and cascades deletion', async () => {
    const meeting = await finalizeMeeting();
    const action = (await request(app).get('/api/actions')).body[0];
    const updated = (await request(app).patch(`/api/actions/${action.id}`).send({ version: action.version, description: 'Send reviewed report', status: 'done', priority: 'high', owner: null, deadline: null }).expect(200)).body;
    expect(updated).toMatchObject({ status: 'done', priority: 'high', owner: null, deadline: null, version: 2 });
    await request(app).patch(`/api/actions/${action.id}`).send({ version: 1, status: 'todo' }).expect(409);
    await request(app).patch(`/api/actions/${randomUUID()}`).send({ version: 1, status: 'done' }).expect(404);
    expect((await request(app).get('/api/actions').query({ q: 'reviewed', status: 'done', projectId }).expect(200)).body).toHaveLength(1);
    expect((await request(app).get('/api/actions?status=todo')).body).toEqual([]);
    await request(app).delete(`/api/meetings/${meeting.id}?version=${meeting.version}`).expect(204);
    expect((await request(app).get('/api/actions')).body).toEqual([]);
  });
});

describe('settings, security and resilience', () => {
  it('persists provider choices and never accepts an API key in browser settings', async () => {
    const settings = { provider: 'ollama', groqModel: 'account-model', ollamaModel: 'local-model' };
    await request(app).patch('/api/settings').send(settings).expect(200);
    expect((await request(app).get('/api/settings')).body).toEqual(settings);
    expect((await request(app).get('/api/providers')).body.defaultProvider).toBe('ollama');
    await request(app).patch('/api/settings').send({ ...settings, GROQ_API_KEY: 'do-not-store' }).expect(400);
    expect(JSON.stringify((await request(app).get('/api/settings')).body)).not.toContain('do-not-store');
  });
  it('reconciles selected models from persisted Settings with provider availability', async () => {
    ai.getProviderStatuses = vi.fn(async (): Promise<ProviderStatus[]> => [{ provider: 'ollama', configured: false, available: false, models: ['local-model'], selectedModel: '', message: 'Select a model.' }]);
    await request(app).patch('/api/settings').send({ provider: 'ollama', groqModel: '', ollamaModel: 'local-model' }).expect(200);
    const response = (await request(app).get('/api/providers').expect(200)).body;
    expect(response.providers[0]).toMatchObject({ provider: 'ollama', configured: true, available: true, selectedModel: 'local-model' });
  });
  it('offers an explicitly selected local fallback after a temporary Groq failure', async () => {
    ai.getProviderStatuses = vi.fn(async (): Promise<ProviderStatus[]> => [{ provider: 'ollama', configured: false, available: false, models: ['local-model'], selectedModel: '', message: 'Select a model.' }]);
    ai.analyzeTranscript = vi.fn().mockRejectedValue(new AIError('AI_TIMEOUT', 'The cloud request timed out.', 503));
    await request(app).patch('/api/settings').send({ provider: 'groq', groqModel: '', ollamaModel: 'local-model' }).expect(200);
    const meeting = await createMeeting();
    const job = (await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({ provider: 'groq' }).expect(202)).body;
    await app.locals.waitForJobs();
    expect((await request(app).get(`/api/jobs/${job.id}`)).body).toMatchObject({ status: 'failed', fallbackAvailable: true });
    expect(ai.analyzeTranscript).toHaveBeenCalledTimes(1);
  });
  it('rejects DNS-rebinding Hosts and untrusted Origins, and accepts its local development origin', async () => {
    await request(app).get('/api/meetings').set('Host', 'attacker.example:3001').expect(403);
    await request(app).post('/api/projects').set('Origin', 'https://evil.example').send({ name: 'Attack' }).expect(403);
    await request(app).get('/api/meetings').set('Origin', 'null').expect(403);
    await request(app).get('/api/meetings').set('Origin', 'http://127.0.0.1:9999').expect(403);
    await request(app).get('/api/meetings').set('Origin', 'http://127.0.0.1:5173').expect(200);
    expect((await request(app).get('/api/projects')).body).toHaveLength(1);
  });
  it('does not interpolate SQL and delivers security headers', async () => {
    const meeting = await createMeeting({ title: '<script>alert(1)</script>' });
    const response = await request(app).get('/api/meetings').query({ q: "' OR 1=1 --" }).expect(200);
    expect(response.body).toEqual([]);
    expect(response.headers['content-security-policy']).toContain("object-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect((await request(app).get(`/api/meetings/${meeting.id}`)).body.title).toBe('<script>alert(1)</script>');
  });
  it('returns a generic failure without SQL, stack traces or secrets on database errors', async () => {
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('SELECT secret FROM users; API_KEY=hidden'));
    const response = await request(app).get('/api/projects').expect(500);
    spy.mockRestore();
    expect(response.body).toEqual({ error: 'The server could not complete this request. Please try again.', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|SELECT|hidden|stack/);
  });
});

describe('durable database and interrupted-job recovery', () => {
  it('rejects a second instance on the same data directory and releases its lock on close', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'minutes-db-lock-test-'));
    const path = join(folder, 'postgres');
    let first: Database | undefined; let reopened: Database | undefined;
    try {
      first = await openDatabase(path);
      await expect(openDatabase(path)).rejects.toMatchObject({ code: 'DATABASE_LOCKED' });
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8')).pid).toBe(process.pid);
      await first.close(); first = undefined;
      await expect(readFile(`${path}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      reopened = await openDatabase(path);
      expect((await reopened.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally { await reopened?.close(); await first?.close(); await rm(folder, { recursive: true, force: true }); }
  }, 30000);
  it('recovers a lock only when its valid owning PID demonstrably no longer exists', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'minutes-db-stale-test-'));
    const path = join(folder, 'postgres');
    let persistent: Database | undefined;
    try {
      // An isolated child process provides a genuinely exited PID rather than
      // guessing a PID that might belong to another application.
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
      const deadPid = child.pid;
      await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
      expect(deadPid).toBeTypeOf('number');
      await writeFile(`${path}.lock`, JSON.stringify({ version: 1, pid: deadPid, token: randomUUID(), createdAt: new Date().toISOString() }));
      persistent = await openDatabase(path);
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8')).pid).toBe(process.pid);
    } finally { await persistent?.close(); await rm(folder, { recursive: true, force: true }); }
  }, 30000);
  it('leaves unknown and malformed locks untouched', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'minutes-db-unknown-lock-test-'));
    const path = join(folder, 'postgres');
    try {
      for (const content of ['not json', '{}', JSON.stringify({ pid: process.pid, token: 'unknown-format' })]) {
        await writeFile(`${path}.lock`, content);
        await expect(openDatabase(path)).rejects.toMatchObject({ code: 'DATABASE_LOCKED' });
        expect(await readFile(`${path}.lock`, 'utf8')).toBe(content);
      }
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('survives closing/reopening the database and marks interrupted work as retryable', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'minutes-db-test-'));
    let persistent: Database | undefined;
    try {
      persistent = await openDatabase(join(folder, 'postgres'));
      const p = randomUUID(); const m = randomUUID(); const j = randomUUID(); const now = new Date().toISOString();
      await persistent.query('INSERT INTO projects(id,name,description,created_at) VALUES ($1,$2,$3,$4)', [p, 'Persistent project', '', now]);
      await persistent.query('INSERT INTO meetings(id,project_id,title,date,transcript,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)', [m, p, 'Saved meeting', '2026-10-15', transcript, now]);
      await persistent.query("INSERT INTO jobs(id,meeting_id,status,provider,fingerprint,created_at) VALUES ($1,$2,'processing','demo','test',$3)", [j, m, now]);
      await persistent.close(); persistent = await openDatabase(join(folder, 'postgres'));
      const newApp = createApp(persistent, ai);
      expect((await request(newApp).get(`/api/meetings/${m}`)).body.transcript).toBe(transcript);
      expect((await request(newApp).get(`/api/jobs/${j}`)).body).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED' });
    } finally { await persistent?.close(); await rm(folder, { recursive: true, force: true }); }
  }, 30000);
});
