import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp, type AIServices } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';
import { AUDIO_MAX_BYTES, AUDIO_FORMATS, createGroqTranscriptionServices, createTranscriptionRouter, TranscriptionError, validateAudioSignature, type TranscriptionServices, type TranscriptionResult } from '../server/transcription.js';

// These are signature fixtures, not speech recordings. All provider responses
// in this suite are mocked; the opt-in live script exercises actual inference.
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(28)]);
const text = 'Amit: We agreed to review the pilot. Amit will send the report by Friday.';
const json = (value: unknown, status = 200) => new globalThis.Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const models = () => json({ data: [{ id: 'text-model' }, { id: 'whisper-test' }, { id: 'whisper-test-turbo' }, { id: 'whisper-inactive', active: false }] });
const env = { GROQ_API_KEY: 'test-secret-never-output', GROQ_TRANSCRIPTION_MODEL: '' };
const ready = { available: true, model: 'whisper-test', message: 'Mock speech provider', maxBytes: AUDIO_MAX_BYTES, formats: AUDIO_FORMATS };
const signal = () => new AbortController().signal;
const fetchMock = () => vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/models') ? models() : json({ text }));
function waitingFetch(_url: unknown, options?: RequestInit): Promise<globalThis.Response> {
  return new Promise((_resolve, reject) => {
    if (options?.signal?.aborted) reject(new Error('AbortError'));
    else options?.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
  });
}

describe('Groq speech adapter (mock HTTP only)', () => {
  it('discovers an active speech model, coalesces probes and caches discovery', async () => {
    const fetch = fetchMock(); const service = createGroqTranscriptionServices({ fetch, env });
    const [first, second] = await Promise.all([service.getStatus(), service.getStatus()]);
    expect(first).toEqual(second); expect(first).toMatchObject({ available: true, model: 'whisper-test-turbo', maxBytes: AUDIO_MAX_BYTES });
    await service.getStatus(); expect(fetch).toHaveBeenCalledTimes(1);
    await service.transcribe(wav(), 'private-client.wav', signal());
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` } });
    const form = options!.body as FormData;
    expect((form.get('file') as File).name).toBe('recording.wav');
    expect((form.get('file') as File).size).toBe(wav().length);
    expect(form.get('model')).toBe('whisper-test-turbo'); expect(form.get('response_format')).toBe('json');
  });
  it('honors configured model and invalidates cached discovery when configuration changes', async () => {
    const fetch = fetchMock(); const config = { ...env, GROQ_TRANSCRIPTION_MODEL: 'whisper-test' };
    const service = createGroqTranscriptionServices({ fetch, env: config });
    expect((await service.getStatus()).model).toBe('whisper-test');
    config.GROQ_TRANSCRIPTION_MODEL = 'whisper-inactive';
    expect(await service.getStatus()).toMatchObject({ available: false, model: '' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps missing credentials unavailable without making any network calls', async () => {
    const fetch = fetchMock(); const service = createGroqTranscriptionServices({ fetch, env: {} });
    expect((await service.getStatus()).available).toBe(false);
    await expect(service.transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code: 'TRANSCRIPTION_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [{ data: [] }, 'TRANSCRIPTION_MODEL_MISSING'],
    [{ data: [{ id: 'only-chat-model' }] }, 'TRANSCRIPTION_MODEL_MISSING'],
    [{ unexpected: [] }, 'INVALID_TRANSCRIPTION_RESPONSE'],
  ])('rejects missing or malformed model discovery %#', async (body, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
    await expect(createGroqTranscriptionServices({ fetch, env }).transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, 'TRANSCRIPTION_AUTH'], [403, 'TRANSCRIPTION_AUTH'], [429, 'TRANSCRIPTION_RATE_LIMIT'],
    [413, 'AUDIO_TOO_LARGE'], [400, 'AUDIO_REJECTED'], [422, 'AUDIO_REJECTED'],
    [404, 'TRANSCRIPTION_MODEL_MISSING'], [500, 'TRANSCRIPTION_UNAVAILABLE'],
  ])('sanitizes HTTP %s errors and never retries automatically', async (status, code) => {
    const fetch = fetchMock(); fetch.mockImplementation(async url => String(url).endsWith('/models') ? models() : json({ error: `provider-internals ${env.GROQ_API_KEY}` }, status));
    const service = createGroqTranscriptionServices({ fetch, env });
    const error = await service.transcribe(wav(), 'sample.wav', signal()).catch(value => value);
    expect(error).toMatchObject({ code }); expect(error.message).not.toMatch(/provider-internals|test-secret/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('sanitizes model discovery authentication errors in status responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: env.GROQ_API_KEY }, 401));
    const status = await createGroqTranscriptionServices({ fetch, env }).getStatus();
    expect(status.available).toBe(false); expect(status.message).toContain('API key');
    expect(JSON.stringify(status)).not.toContain(env.GROQ_API_KEY);
  });
  it('sanitizes network failures without retries', async () => {
    const fetch = fetchMock(); fetch.mockRejectedValue(new Error(`Socket secret ${env.GROQ_API_KEY}`));
    await expect(createGroqTranscriptionServices({ fetch, env }).transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code: 'TRANSCRIPTION_NETWORK' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts timed out requests and distinguishes explicit cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(waitingFetch);
    const service = createGroqTranscriptionServices({ fetch, env, timeoutMs: 10 });
    await expect(service.transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code: 'TRANSCRIPTION_TIMEOUT' });
    const controller = new AbortController(); const pending = service.transcribe(wav(), 'sample.wav', controller.signal);
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ text: ' \r\n\u0000 ' }, 'EMPTY_TRANSCRIPTION'], [{ text: 42 }, 'INVALID_TRANSCRIPTION_RESPONSE'],
    [{ transcript: text }, 'INVALID_TRANSCRIPTION_RESPONSE'], [{ text: 'x'.repeat(120001) }, 'TRANSCRIPT_TOO_LONG'],
  ])('rejects empty, incomplete and oversized transcripts %#', async (body, code) => {
    const fetch = fetchMock(); fetch.mockImplementation(async url => String(url).endsWith('/models') ? models() : json(body));
    await expect(createGroqTranscriptionServices({ fetch, env }).transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code });
  });
  it('normalizes recognized text without inventing speaker labels', async () => {
    const fetch = fetchMock(); fetch.mockImplementation(async url => String(url).endsWith('/models') ? models() : json({ text: '  Discussion\r\nअमित\u0000  ' }));
    expect(await createGroqTranscriptionServices({ fetch, env }).transcribe(wav(), 'sample.wav', signal())).toEqual({ transcript: 'Discussion\nअमित', model: 'whisper-test-turbo' });
  });
  it.each([
    [() => new globalThis.Response('not JSON'), 'INVALID_TRANSCRIPTION_RESPONSE'],
    [() => new globalThis.Response(null), 'INVALID_TRANSCRIPTION_RESPONSE'],
    [() => new globalThis.Response('x', { headers: { 'content-length': '1000001' } }), 'TRANSCRIPTION_RESPONSE_TOO_LARGE'],
    [() => new globalThis.Response('x'.repeat(1000001)), 'TRANSCRIPTION_RESPONSE_TOO_LARGE'],
  ])('bounds and validates provider response bodies %#', async (response, code) => {
    const fetch = fetchMock(); fetch.mockImplementation(async url => String(url).endsWith('/models') ? models() : response());
    await expect(createGroqTranscriptionServices({ fetch, env }).transcribe(wav(), 'sample.wav', signal())).rejects.toMatchObject({ code });
  });
});

describe('audio signature screening', () => {
  it.each([
    ['wav', wav()], ['mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)])],
    ['mp3', Buffer.from([0xff, 0xfb, ...new Array(16).fill(0)])],
    ['m4a', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)])],
    ['mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42'), Buffer.alloc(8)])],
    ['flac', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)])],
    ['ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)])],
    ['webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('----webm----')])],
  ])('recognizes the %s container signature %#', (extension, bytes) => expect(() => validateAudioSignature(bytes, extension)).not.toThrow());
  it('rejects a renamed text file and mismatched audio extension', () => {
    expect(() => validateAudioSignature(Buffer.from('Not real audio content'), 'wav')).toThrow(TranscriptionError);
    expect(() => validateAudioSignature(wav(), 'mp3')).toThrow(TranscriptionError);
  });
});

let db: Database; let app: ReturnType<typeof createApp>; let speech: TranscriptionServices;
const ai: AIServices = { defaultSettings: () => ({ provider: 'demo', groqModel: '', ollamaModel: '' }), getProviderStatuses: async () => [], analyzeTranscript: async () => { throw new Error('Analysis must be a separate user action'); } };
beforeAll(async () => { db = await openDatabase(); });
beforeEach(async () => {
  await db.exec('TRUNCATE projects, meetings, jobs, action_items, settings, idempotency_keys CASCADE');
  speech = { getStatus: vi.fn(async () => ready), transcribe: vi.fn(async () => ({ transcript: text, model: 'whisper-test' })) };
  app = createApp(db, ai, speech);
});
afterEach(async () => { app?.locals.stopTranscriptions?.(); await app?.locals.waitForTranscriptions(); });
afterAll(async () => { await db?.close(); });
function upload(options: { filename?: string; key?: string; bytes?: Buffer; target?: typeof app } = {}) {
  return request(options.target ?? app).post('/api/transcriptions').set('Content-Type', 'application/octet-stream').set('X-Audio-Filename', encodeURIComponent(options.filename ?? 'meeting.wav')).set('Idempotency-Key', options.key ?? randomUUID()).send(options.bytes ?? wav());
}

describe('transcription APIs (real isolated database; mocked speech)', () => {
  it('exposes availability and creates a reviewable temporary transcript without saving a meeting', async () => {
    expect((await request(app).get('/api/transcription-status').expect(200)).body).toEqual(ready);
    const job = (await upload().expect(202)).body;
    await app.locals.waitForTranscriptions();
    expect((await request(app).get(`/api/transcriptions/${job.id}`).expect(200)).body).toMatchObject({ status: 'completed', transcript: text, model: 'whisper-test', provider: 'groq' });
    expect((await request(app).get('/api/meetings')).body).toEqual([]);
    const project = (await request(app).post('/api/projects').send({ name: 'Audio test project' }).expect(201)).body;
    const meeting = (await request(app).post('/api/meetings').send({ title: 'Corrected transcript', projectId: project.id, date: '2026-10-18', participants: [], transcript: text.replace('Friday', 'Monday') }).expect(201)).body;
    expect((await request(app).get(`/api/meetings/${meeting.id}`).expect(200)).body).toMatchObject({ transcript: text.replace('Friday', 'Monday'), status: 'draft', record: null });
  });
  it('accepts Unicode filenames while preserving only neutral model uploads in the adapter', async () => {
    await upload({ filename: 'बैठक.wav' }).expect(202); await app.locals.waitForTranscriptions();
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['../private.wav', 400, 'INVALID_AUDIO_FILENAME'], ['C:\\private.wav', 400, 'INVALID_AUDIO_FILENAME'],
    ['.hidden.wav', 400, 'INVALID_AUDIO_FILENAME'], ['a\u0000.wav', 400, 'INVALID_AUDIO_FILENAME'],
    ['a'.repeat(256) + '.wav', 400, 'INVALID_AUDIO_FILENAME'], ['meeting.txt', 415, 'UNSUPPORTED_AUDIO_FORMAT'],
  ])('rejects invalid filename %s before inference', async (filename, status, code) => {
    expect((await upload({ filename }).expect(status)).body.code).toBe(code); expect(speech.transcribe).not.toHaveBeenCalled();
  });
  it('rejects missing or malformed metadata and incorrect request type/encoding', async () => {
    await request(app).post('/api/transcriptions').send({ audio: 'not-binary' }).expect(415);
    await request(app).post('/api/transcriptions').set('Content-Type', 'application/octet-stream').send(wav()).expect(400);
    await request(app).post('/api/transcriptions').set('Content-Type', 'application/octet-stream').set('X-Audio-Filename', '%zz.wav').send(wav()).expect(400);
    expect((await upload({ key: 'not-a-uuid' }).expect(400)).body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    await upload().set('Content-Encoding', 'gzip').expect(415); expect(speech.transcribe).not.toHaveBeenCalled();
  });
  it('rejects empty, oversized and mismatched media before inference', async () => {
    expect((await upload({ bytes: Buffer.alloc(0) }).expect(400)).body.code).toBe('EMPTY_AUDIO');
    expect((await upload().set('Content-Length', String(AUDIO_MAX_BYTES + 1)).expect(413)).body.code).toBe('AUDIO_TOO_LARGE');
    expect((await upload({ bytes: Buffer.from('This is a text file') }).expect(415)).body.code).toBe('INVALID_AUDIO_CONTENT');
    await upload({ filename: 'renamed.mp3' }).expect(415); expect(speech.transcribe).not.toHaveBeenCalled();
  });
  it('validates identifiers and reports missing jobs without leaking data', async () => {
    for (const method of ['get', 'delete'] as const) {
      await request(app)[method]('/api/transcriptions/invalid').expect(400);
      await request(app)[method](`/api/transcriptions/${randomUUID()}`).expect(404);
    }
  });
  it('rejects hostile origins and DNS rebinding before status, upload or cancellation', async () => {
    await request(app).get('/api/transcription-status').set('Origin', 'https://evil.example').expect(403);
    await upload().set('Origin', 'http://localhost:9999').expect(403);
    await request(app).get('/api/transcription-status').set('Host', 'evil.example:3001').expect(403);
    await request(app).delete(`/api/transcriptions/${randomUUID()}`).set('Origin', 'null').expect(403);
    expect(speech.getStatus).not.toHaveBeenCalled(); expect(speech.transcribe).not.toHaveBeenCalled();
  });
  it('deduplicates repeated uploads and rejects changed bytes or filename for a reused key', async () => {
    const key = randomUUID(); const first = (await upload({ key }).expect(202)).body; await app.locals.waitForTranscriptions();
    expect((await upload({ key }).expect(202)).body.id).toBe(first.id);
    const changed = wav(); changed[20] = 1;
    await upload({ key, bytes: changed }).expect(409); await upload({ key, filename: 'different.wav' }).expect(409);
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('deduplicates an in-flight job and refuses another recording while inference is active', async () => {
    let finish!: (result: TranscriptionResult) => void;
    speech.transcribe = vi.fn(() => new Promise<TranscriptionResult>(resolve => { finish = resolve; }));
    const key = randomUUID(); const first = (await upload({ key }).expect(202)).body;
    expect((await upload({ key }).expect(202)).body.id).toBe(first.id);
    expect((await upload().expect(429)).body.code).toBe('TRANSCRIPTION_BUSY');
    finish({ transcript: text, model: 'whisper-test' }); await app.locals.waitForTranscriptions();
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('keeps failed jobs idempotent and permits an explicit retry with a new key', async () => {
    speech.transcribe = vi.fn().mockRejectedValueOnce(new TranscriptionError(429, 'TRANSCRIPTION_RATE_LIMIT', 'Wait and retry explicitly.')).mockResolvedValue({ transcript: text, model: 'whisper-test' });
    const key = randomUUID(); const job = (await upload({ key }).expect(202)).body; await app.locals.waitForTranscriptions();
    expect((await upload({ key }).expect(202)).body).toMatchObject({ id: job.id, status: 'failed', transcript: null, errorCode: 'TRANSCRIPTION_RATE_LIMIT' });
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    const retry = (await upload().expect(202)).body; await app.locals.waitForTranscriptions();
    expect((await request(app).get(`/api/transcriptions/${retry.id}`)).body.status).toBe('completed'); expect(speech.transcribe).toHaveBeenCalledTimes(2);
  });
  it('sanitizes unexpected job errors and revalidates injected incomplete responses', async () => {
    for (const outcome of [new Error('API_KEY=secret stack internals'), { transcript: '  ', model: 'test' }, { transcript: text }]) {
      speech.transcribe = outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue(outcome);
      const job = (await upload().expect(202)).body; await app.locals.waitForTranscriptions();
      const failure = (await request(app).get(`/api/transcriptions/${job.id}`)).body;
      expect(failure).toMatchObject({ status: 'failed', transcript: null }); expect(JSON.stringify(failure)).not.toMatch(/API_KEY|secret|internals|stack/);
    }
  });
  it('cancels a request, erases its result, zeroes audio memory and prevents a late result from restoring it', async () => {
    let finish!: (result: TranscriptionResult) => void; let audio!: Uint8Array; let abortSignal!: AbortSignal;
    speech.transcribe = vi.fn<TranscriptionServices['transcribe']>((bytes, _filename, parent) => { audio = bytes; abortSignal = parent; return new Promise<TranscriptionResult>(resolve => { finish = resolve; }); });
    const job = (await upload().expect(202)).body;
    await request(app).delete(`/api/transcriptions/${job.id}`).expect(204); expect(abortSignal.aborted).toBe(true);
    finish({ transcript: text, model: 'test' }); await app.locals.waitForTranscriptions();
    expect((await request(app).get(`/api/transcriptions/${job.id}`)).body).toMatchObject({ status: 'cancelled', transcript: null, error: null });
    expect(audio.every(byte => byte === 0)).toBe(true);
    await upload().expect(202); finish({ transcript: text, model: 'test' }); await app.locals.waitForTranscriptions();
  });
  it('cancels by request key before the upload arrives and prevents repeated late submissions', async () => {
    const key = randomUUID();
    await request(app).delete(`/api/transcriptions/by-key/${key}`).expect(204);
    await request(app).delete(`/api/transcriptions/by-key/${key}`).expect(204);
    for (let i = 0; i < 2; i++) expect((await upload({ key }).expect(409)).body.code).toBe('TRANSCRIPTION_CANCELLED');
    expect(speech.transcribe).not.toHaveBeenCalled();
    await request(app).delete('/api/transcriptions/by-key/not-a-uuid').expect(400);
    await upload().expect(202); await app.locals.waitForTranscriptions();
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('cancels an accepted job by its request key without its response identifier and blocks quota-consuming resends', async () => {
    let finish!: (result: TranscriptionResult) => void; let abortSignal!: AbortSignal;
    speech.transcribe = vi.fn<TranscriptionServices['transcribe']>((_bytes, _filename, parent) => { abortSignal = parent; return new Promise<TranscriptionResult>(resolve => { finish = resolve; }); });
    const key = randomUUID(); const job = (await upload({ key }).expect(202)).body;
    await request(app).delete(`/api/transcriptions/by-key/${key}`).expect(204);
    expect(abortSignal.aborted).toBe(true);
    expect((await request(app).get(`/api/transcriptions/${job.id}`)).body).toMatchObject({ status: 'cancelled', transcript: null });
    expect((await upload({ key }).expect(409)).body.code).toBe('TRANSCRIPTION_CANCELLED');
    // Keep the reservation until the provider settles, even after cancellation.
    expect((await upload().expect(429)).body.code).toBe('TRANSCRIPTION_BUSY');
    finish({ transcript: text, model: 'test' }); await app.locals.waitForTranscriptions();
    expect((await request(app).get(`/api/transcriptions/${job.id}`)).body).toMatchObject({ status: 'cancelled', transcript: null });
    expect((await upload({ key }).expect(409)).body.code).toBe('TRANSCRIPTION_CANCELLED');
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('clears a completed temporary transcript when cancelled by request key', async () => {
    const key = randomUUID(); const job = (await upload({ key }).expect(202)).body; await app.locals.waitForTranscriptions();
    await request(app).delete(`/api/transcriptions/by-key/${key}`).expect(204);
    expect((await request(app).get(`/api/transcriptions/${job.id}`)).body).toMatchObject({ status: 'cancelled', transcript: null, error: null });
    await upload({ key }).expect(409); expect(speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('keeps the rest of the app available when speech configuration is missing', async () => {
    speech.getStatus = vi.fn(async () => ({ ...ready, available: false, model: '', message: 'Set GROQ_API_KEY.' }));
    speech.transcribe = vi.fn().mockRejectedValue(new TranscriptionError(503, 'TRANSCRIPTION_NOT_CONFIGURED', 'Set GROQ_API_KEY.'));
    expect((await request(app).get('/api/transcription-status')).body.available).toBe(false);
    const job = (await upload().expect(202)).body; await app.locals.waitForTranscriptions();
    expect((await request(app).get(`/api/transcriptions/${job.id}`)).body.errorCode).toBe('TRANSCRIPTION_NOT_CONFIGURED');
    await request(app).get('/api/health').expect(200); await request(app).post('/api/projects').send({ name: 'Manual notes still work' }).expect(201);
  });
});

function routerApp(options: Parameters<typeof createTranscriptionRouter>[1] = {}) {
  const controller = createTranscriptionRouter(speech, options); const target = express(); target.use('/api', controller.router);
  target.use((error: TranscriptionError, _req: Request, res: Response, _next: NextFunction) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  return { ...controller, target };
}
async function listen(target: express.Express) {
  const server = createServer(target); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { server, port: address.port };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function rawUpload(port: number, key = randomUUID()) {
  const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/transcriptions', headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Filename': 'meeting.wav', 'Idempotency-Key': key } });
  const result = new Promise<{ status: number; body: { code: string } }>((resolve, reject) => {
    req.once('error', reject); req.once('response', res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
  });
  return { req, result };
}

describe('temporary job lifecycle and streamed upload limits', () => {
  it('expires cancellation tombstones and caps them at one hundred keys', async () => {
    let now = 100000; const { target, waitForJobs, dispose } = routerApp({ now: () => now, ttlMs: 100 });
    try {
      const keys = Array.from({ length: 101 }, () => randomUUID());
      for (const key of keys) await request(target).delete(`/api/transcriptions/by-key/${key}`).expect(204);
      // Only the oldest marker is evicted; the latest cancellation remains effective.
      await upload({ target, key: keys[0] }).expect(202); await waitForJobs();
      await upload({ target, key: keys[1] }).expect(409);
      await upload({ target, key: keys[100] }).expect(409);
      now += 101;
      await upload({ target, key: keys[100] }).expect(202); await waitForJobs();
      expect(speech.transcribe).toHaveBeenCalledTimes(2);
    } finally { dispose(); }
  });
  it('expires temporary transcripts and caps retained results at ten', async () => {
    let now = 100000; const { target, waitForJobs, dispose } = routerApp({ now: () => now, ttlMs: 100 });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 11; i++) { ids.push((await upload({ target }).expect(202)).body.id); await waitForJobs(); }
      await request(target).get(`/api/transcriptions/${ids[0]}`).expect(404);
      await request(target).get(`/api/transcriptions/${ids[10]}`).expect(200);
      now += 101; await request(target).get(`/api/transcriptions/${ids[10]}`).expect(404);
    } finally { dispose(); }
  });
  it('reserves the single upload slot before the first recording has finished uploading', async () => {
    const { target, dispose } = routerApp(); const { server, port } = await listen(target); const first = rawUpload(port);
    try {
      const seen = new Promise<void>(resolve => server.once('request', req => req.once('data', () => resolve())));
      first.req.write(wav()); await seen;
      expect((await upload({ target }).expect(429)).body.code).toBe('TRANSCRIPTION_BUSY');
      first.req.end(); expect((await first.result).status).toBe(202);
    } finally { dispose(); first.req.destroy(); await close(server); }
  });
  it('returns an actionable timeout and releases the slot for the next upload', async () => {
    const { target, dispose, waitForJobs } = routerApp({ uploadTimeoutMs: 30 }); const { server, port } = await listen(target); const first = rawUpload(port);
    try {
      first.req.write(wav()); expect(await first.result).toMatchObject({ status: 408, body: { code: 'AUDIO_UPLOAD_TIMEOUT' } }); first.req.end();
      await upload({ target }).expect(202); await waitForJobs();
    } finally { dispose(); first.req.destroy(); await close(server); }
  });
  it('cancels a partially received upload by request key and releases its slot without inference', async () => {
    const { target, dispose, waitForJobs } = routerApp(); const { server, port } = await listen(target);
    const key = randomUUID(); const first = rawUpload(port, key);
    try {
      const seen = new Promise<void>(resolve => server.once('request', req => req.once('data', () => resolve())));
      first.req.write(wav()); await seen;
      // An unrelated cancellation must not stop this reserved upload.
      await request(target).delete(`/api/transcriptions/by-key/${randomUUID()}`).expect(204);
      await upload({ target }).expect(429);
      await request(target).delete(`/api/transcriptions/by-key/${key}`).expect(204);
      expect(await first.result).toMatchObject({ status: 409, body: { code: 'TRANSCRIPTION_CANCELLED' } });
      first.req.end(); expect(speech.transcribe).not.toHaveBeenCalled();
      await upload({ target, key }).expect(409);
      await upload({ target }).expect(202); await waitForJobs();
      expect(speech.transcribe).toHaveBeenCalledTimes(1);
    } finally { dispose(); first.req.destroy(); await close(server); }
  });
  it('bounds chunked uploads even without Content-Length', async () => {
    const { target, dispose } = routerApp(); const { server, port } = await listen(target); const first = rawUpload(port);
    try {
      first.req.write(Buffer.alloc(AUDIO_MAX_BYTES + 1)); first.req.end();
      expect(await first.result).toMatchObject({ status: 413, body: { code: 'AUDIO_TOO_LARGE' } }); expect(speech.transcribe).not.toHaveBeenCalled();
    } finally { dispose(); first.req.destroy(); await close(server); }
  });
  it('aborts active provider work on shutdown and refuses new uploads', async () => {
    let bytes!: Uint8Array;
    speech.transcribe = vi.fn<TranscriptionServices['transcribe']>((audio, _name, parent) => { bytes = audio; return new Promise<TranscriptionResult>((_resolve, reject) => parent.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })); });
    const { target, dispose, waitForJobs } = routerApp(); const job = (await upload({ target }).expect(202)).body;
    dispose(); await waitForJobs(); expect(bytes.every(byte => byte === 0)).toBe(true);
    await request(target).get(`/api/transcriptions/${job.id}`).expect(404); await upload({ target }).expect(503);
  });
  it('cancels a partially received upload on shutdown', async () => {
    const { target, dispose } = routerApp(); const { server, port } = await listen(target); const first = rawUpload(port);
    try {
      const seen = new Promise<void>(resolve => server.once('request', req => req.once('data', () => resolve())));
      first.req.write(wav()); await seen; dispose();
      expect(await first.result).toMatchObject({ status: 503, body: { code: 'TRANSCRIPTION_STOPPING' } });
      expect(speech.transcribe).not.toHaveBeenCalled(); first.req.end();
    } finally { dispose(); first.req.destroy(); await close(server); }
  });
});
