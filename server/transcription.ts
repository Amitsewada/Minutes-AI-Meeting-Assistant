import { Router, type Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const AUDIO_MAX_BYTES = 25_000_000;
export const AUDIO_FORMATS = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac'];
const MAX_RESPONSE_BYTES = 1_000_000;
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const idSchema = z.string().uuid();
export class TranscriptionError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export interface TranscriptionStatus { available: boolean; model: string; message: string; maxBytes: number; formats: string[] }
export interface TranscriptionResult { transcript: string; model: string }
export interface TranscriptionServices {
  getStatus(): Promise<TranscriptionStatus>;
  transcribe(audio: Uint8Array, filename: string, signal: AbortSignal): Promise<TranscriptionResult>;
}
export interface TranscriptionJob {
  id: string; status: 'processing' | 'completed' | 'failed' | 'cancelled'; transcript: string | null;
  model: string; provider: 'groq'; error: string | null; errorCode: string | null; createdAt: string;
}
function unavailable(status: number) {
  if (status === 401 || status === 403) return new TranscriptionError(503, 'TRANSCRIPTION_AUTH', 'Groq rejected the API key or access to this speech model. Check the backend configuration.');
  if (status === 429) return new TranscriptionError(429, 'TRANSCRIPTION_RATE_LIMIT', 'Groq speech quota or rate limit was reached. Wait and retry explicitly; no automatic retry was made.');
  if (status === 413) return new TranscriptionError(413, 'AUDIO_TOO_LARGE', 'Groq rejected the file size. Use a recording smaller than 25 MB.');
  if (status === 400 || status === 422) return new TranscriptionError(422, 'AUDIO_REJECTED', 'Groq could not decode this recording. Check that it contains audible speech and export it as WAV or MP3.');
  if (status === 404) return new TranscriptionError(503, 'TRANSCRIPTION_MODEL_MISSING', 'The configured speech model is unavailable. Check GROQ_TRANSCRIPTION_MODEL or leave it blank to discover a model.');
  return new TranscriptionError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Groq speech transcription is temporarily unavailable. Your meeting data is unchanged; retry later.');
}
function safeError(error: unknown): TranscriptionError {
  return error instanceof TranscriptionError ? error : new TranscriptionError(503, 'TRANSCRIPTION_NETWORK', 'Could not reach Groq speech transcription. Check your connection and retry explicitly.');
}
async function boundedJson(response: globalThis.Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw unavailable(response.status); }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new TranscriptionError(502, 'TRANSCRIPTION_RESPONSE_TOO_LARGE', 'The speech service response is too large. Use a shorter recording.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TranscriptionError(502, 'INVALID_TRANSCRIPTION_RESPONSE', 'The speech service returned no response. Retry explicitly.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new TranscriptionError(502, 'TRANSCRIPTION_RESPONSE_TOO_LARGE', 'The speech service response is too large. Use a shorter recording.'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new TranscriptionError(502, 'INVALID_TRANSCRIPTION_RESPONSE', 'The speech service returned malformed data. No transcript was saved.'); }
  } finally { reader.releaseLock(); }
}
function validateResult(value: unknown): TranscriptionResult {
  const parsed = z.object({ transcript: z.string(), model: z.string().trim().min(1).max(200) }).safeParse(value);
  if (!parsed.success) throw new TranscriptionError(502, 'INVALID_TRANSCRIPTION_RESPONSE', 'The speech service returned incomplete data. No transcript was saved.');
  const transcript = parsed.data.transcript.replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0), '').trim();
  if (!transcript) throw new TranscriptionError(422, 'EMPTY_TRANSCRIPTION', 'No speech was recognized. Check the recording and try a clearer audio file.');
  if (transcript.length > 120000) throw new TranscriptionError(422, 'TRANSCRIPT_TOO_LONG', 'The transcript exceeds 120,000 characters. Split the recording into shorter meetings and retry.');
  return { transcript, model: parsed.data.model };
}
/** Uses only the fixed Groq host. Credentials and recordings never enter application logs. */
export function createGroqTranscriptionServices(options: {
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number;
} = {}): TranscriptionServices {
  const fetcher = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  let cached: { model: string; key: string; configured: string; expires: number } | undefined;
  let statusPending: Promise<TranscriptionStatus> | undefined;
  const timeoutMs = options.timeoutMs ?? Math.max(5000, Math.min(300000, Number(env.TRANSCRIPTION_TIMEOUT_MS) || 120000));
  async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, limit = timeoutMs): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) controller.abort(); else parent?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
    try { return await fn(controller.signal); }
    catch (error) {
      if (parent?.aborted) throw new TranscriptionError(409, 'TRANSCRIPTION_CANCELLED', 'Transcription was cancelled.');
      if (timedOut) throw new TranscriptionError(504, 'TRANSCRIPTION_TIMEOUT', 'Speech transcription timed out. Try a shorter recording or retry explicitly.');
      throw safeError(error);
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
  }
  async function model(signal: AbortSignal) {
    const key = env.GROQ_API_KEY?.trim(); const configured = env.GROQ_TRANSCRIPTION_MODEL?.trim() ?? '';
    if (!key) throw new TranscriptionError(503, 'TRANSCRIPTION_NOT_CONFIGURED', 'Set GROQ_API_KEY in the backend .env file to transcribe recordings. You can still paste a transcript.');
    if (cached && cached.key === key && cached.configured === configured && cached.expires > Date.now()) return cached.model;
    const response = await fetcher(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal, redirect: 'error' });
    const data = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200), active: z.boolean().optional() })) }).safeParse(await boundedJson(response));
    if (!data.success) throw new TranscriptionError(502, 'INVALID_TRANSCRIPTION_RESPONSE', 'Groq returned an invalid model list. Retry later.');
    const models = data.data.data.filter(entry => entry.active !== false && /whisper/i.test(entry.id)).map(entry => entry.id).sort();
    const selected = configured ? models.find(id => id === configured) : models.find(id => /turbo/i.test(id)) ?? models[0];
    if (!selected) throw new TranscriptionError(503, 'TRANSCRIPTION_MODEL_MISSING', 'No available Whisper speech model matches the configuration. Check GROQ_TRANSCRIPTION_MODEL or leave it blank to discover a model.');
    cached = { model: selected, key, configured, expires: Date.now() + 60000 };
    return selected;
  }
  return {
    getStatus() {
      // Coalesce simultaneous UI probes; cached discovery does not consume speech inference quota.
      statusPending ??= withTimeout(async signal => {
        const selected = await model(signal);
        return { available: true, model: selected, message: 'Groq speech transcription is available. Recordings are sent to Groq; account limits apply.', maxBytes: AUDIO_MAX_BYTES, formats: [...AUDIO_FORMATS] };
      }, undefined, Math.min(timeoutMs, 10000)).catch(error => ({ available: false, model: '', message: safeError(error).message, maxBytes: AUDIO_MAX_BYTES, formats: [...AUDIO_FORMATS] })).finally(() => { statusPending = undefined; });
      return statusPending;
    },
    transcribe(audio, filename, parent) {
      return withTimeout(async signal => {
        const selected = await model(signal);
        const form = new FormData();
        const extension = filename.split('.').pop();
        // The local filename may contain identifying information. Only send a neutral filename.
        form.append('file', new Blob([new Uint8Array(audio)], { type: 'application/octet-stream' }), `recording.${extension}`);
        form.append('model', selected); form.append('response_format', 'json'); form.append('temperature', '0');
        const response = await fetcher(`${GROQ_BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${env.GROQ_API_KEY?.trim()}` }, body: form, signal, redirect: 'error' });
        const result = z.object({ text: z.string() }).safeParse(await boundedJson(response));
        if (!result.success) throw new TranscriptionError(502, 'INVALID_TRANSCRIPTION_RESPONSE', 'The speech service returned incomplete data. No transcript was saved.');
        return validateResult({ transcript: result.data.text, model: selected });
      }, parent);
    },
  };
}
function filenameFrom(req: Request) {
  const raw = req.header('X-Audio-Filename');
  if (!raw || raw.length > 1500) throw new TranscriptionError(400, 'INVALID_AUDIO_FILENAME', 'Choose an audio file with a valid filename.');
  let filename: string; try { filename = decodeURIComponent(raw); } catch { throw new TranscriptionError(400, 'INVALID_AUDIO_FILENAME', 'The audio filename is not valid.'); }
  if (filename.length > 255 || /[/\\:]/.test(filename) || [...filename].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || filename.startsWith('.')) throw new TranscriptionError(400, 'INVALID_AUDIO_FILENAME', 'Use a filename without path separators or control characters.');
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!AUDIO_FORMATS.includes(extension)) throw new TranscriptionError(415, 'UNSUPPORTED_AUDIO_FORMAT', `Choose ${AUDIO_FORMATS.join(', ')} audio, up to 25 MB.`);
  return { filename, extension };
}
/** Lightweight signature screening; Groq's decoder remains responsible for complete media validation. */
export function validateAudioSignature(bytes: Uint8Array, extension: string) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (offset: number, value: string) => b.subarray(offset, offset + value.length).toString('latin1') === value;
  const valid = b.length >= 12 && (
    (extension === 'wav' && at(0, 'RIFF') && at(8, 'WAVE')) ||
    (extension === 'mp3' && (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0))) ||
    (['mp4', 'm4a'].includes(extension) && at(4, 'ftyp')) ||
    (extension === 'ogg' && at(0, 'OggS')) ||
    (extension === 'flac' && at(0, 'fLaC')) ||
    (extension === 'webm' && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && b.subarray(0, 4096).includes(Buffer.from('webm')))
  );
  if (!valid) throw new TranscriptionError(415, 'INVALID_AUDIO_CONTENT', 'The file contents do not match its audio format. Export a valid recording; renaming a file is not enough.');
}

export function createTranscriptionRouter(services: TranscriptionServices, options: { now?: () => number; ttlMs?: number; uploadTimeoutMs?: number } = {}) {
  const router = Router(); const now = options.now ?? Date.now; const ttl = options.ttlMs ?? 30 * 60 * 1000;
  type Entry = { job: TranscriptionJob; key: string; digest: string; controller: AbortController; expires: number };
  const entries = new Map<string, Entry>(); const running = new Set<Promise<void>>();
  // Remember cancellations that arrive before an upload or its response. This is
  // deliberately bounded like the temporary results, rather than durable history.
  const cancelledKeys = new Map<string, number>();
  let active: Entry | undefined; let uploadReserved = false; let disposed = false;
  let uploadKey: string | undefined;
  let cancelUpload: ((reason: TranscriptionError) => void) | undefined;
  const cancelledError = () => new TranscriptionError(409, 'TRANSCRIPTION_CANCELLED', 'Transcription was cancelled. Start a new request to transcribe this recording.');
  function purge() {
    for (const [id, entry] of entries) if (entry !== active && entry.expires <= now()) entries.delete(id);
    for (const [key, expires] of cancelledKeys) if (expires <= now()) cancelledKeys.delete(key);
  }
  function cancelKey(key: string) {
    purge(); cancelledKeys.delete(key); cancelledKeys.set(key, now() + ttl);
    while (cancelledKeys.size > 100) {
      const oldest = [...cancelledKeys.keys()].find(value => value !== uploadKey && value !== active?.key)!;
      cancelledKeys.delete(oldest);
    }
    if (uploadKey === key) cancelUpload?.(cancelledError());
    for (const entry of entries.values()) if (entry.key === key) {
      entry.controller.abort(); entry.job.status = 'cancelled'; entry.job.transcript = null;
      entry.job.error = null; entry.job.errorCode = null;
    }
  }
  function lookup(id: unknown) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new TranscriptionError(400, 'INVALID_TRANSCRIPTION_ID', 'The transcription identifier is invalid.');
    purge(); const entry = entries.get(parsed.data);
    if (!entry) throw new TranscriptionError(404, 'TRANSCRIPTION_NOT_FOUND', 'This temporary transcription expired or the server restarted. Upload the recording again.');
    return entry;
  }
  router.get('/transcription-status', async (_req, res, next) => { try { res.set('Cache-Control', 'no-store').json(await services.getStatus()); } catch (error) { next(safeError(error)); } });
  router.get('/transcriptions/:id', (req, res, next) => { try { res.set('Cache-Control', 'no-store').json(lookup(req.params.id).job); } catch (error) { next(error); } });
  router.delete('/transcriptions/by-key/:key', (req, res, next) => {
    try {
      const key = idSchema.safeParse(req.params.key);
      if (!key.success) throw new TranscriptionError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid request identifier is required to cancel transcription.');
      if (!disposed) cancelKey(key.data);
      res.status(204).set('Cache-Control', 'no-store').end();
    } catch (error) { next(error); }
  });
  router.delete('/transcriptions/:id', (req, res, next) => {
    try {
      const entry = lookup(req.params.id); cancelKey(entry.key);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.post('/transcriptions', async (req, res, next) => {
    let ownsReservation = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    try {
      if (disposed) throw new TranscriptionError(503, 'TRANSCRIPTION_STOPPING', 'The server is stopping. Restart it before uploading a recording.');
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new TranscriptionError(415, 'INVALID_AUDIO_UPLOAD', 'Upload the recording as a binary audio file.');
      if (req.header('Content-Encoding') && req.header('Content-Encoding') !== 'identity') throw new TranscriptionError(415, 'INVALID_AUDIO_UPLOAD', 'Compressed request bodies are not supported. Upload the original media file.');
      const { filename, extension } = filenameFrom(req);
      const key = req.header('Idempotency-Key');
      if (!idSchema.safeParse(key).success) throw new TranscriptionError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid request identifier is required. Refresh and retry the upload.');
      purge(); if (cancelledKeys.has(key!)) throw cancelledError();
      const declared = req.header('Content-Length');
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > AUDIO_MAX_BYTES)) throw new TranscriptionError(413, 'AUDIO_TOO_LARGE', 'Recordings must be no larger than 25 MB. Export or split a smaller file.');
      if (declared === '0') throw new TranscriptionError(400, 'EMPTY_AUDIO', 'The selected recording is empty. Choose a file containing speech.');
      const previous = [...entries.values()].find(entry => entry.key === key);
      if (uploadReserved || (active && active !== previous)) throw new TranscriptionError(429, 'TRANSCRIPTION_BUSY', 'One recording is already uploading or transcribing. Wait for it to finish.');
      // Reserve before reading any bytes. Duplicate uploads are hashed without retaining another audio copy.
      uploadReserved = true; ownsReservation = true; uploadKey = key;
      const hash = createHash('sha256').update(filename).update('\0'); let size = 0;
      await new Promise<void>((resolve, reject) => {
        // Do not destroy the socket on a size limit or timeout: the client needs
        // the actionable JSON error. Drain any remaining bytes without retaining them.
        const cleanup = () => {
          req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort);
          if (timer) clearTimeout(timer); timer = undefined; cancelUpload = undefined;
        };
        const fail = (error: TranscriptionError) => { cleanup(); req.once('error', () => undefined); req.resume(); reject(error); };
        const onData = (bytes: Buffer) => {
          size += bytes.length;
          if (size > AUDIO_MAX_BYTES) { fail(new TranscriptionError(413, 'AUDIO_TOO_LARGE', 'Recordings must be no larger than 25 MB. Export or split a smaller file.')); return; }
          hash.update(bytes); if (!previous) chunks.push(bytes);
        };
        const onEnd = () => { cleanup(); resolve(); };
        const onError = () => fail(new TranscriptionError(400, 'AUDIO_UPLOAD_INTERRUPTED', 'The audio upload was interrupted. Select the recording and retry.'));
        const onAbort = onError;
        cancelUpload = fail;
        timer = setTimeout(() => fail(new TranscriptionError(408, 'AUDIO_UPLOAD_TIMEOUT', 'The upload timed out. Retry with a smaller recording.')), options.uploadTimeoutMs ?? 30000);
        req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
      });
      clearTimeout(timer); timer = undefined;
      if (cancelledKeys.has(key!)) throw cancelledError();
      if (!size) throw new TranscriptionError(400, 'EMPTY_AUDIO', 'The selected recording is empty. Choose a file containing speech.');
      const digest = hash.digest('hex');
      if (previous) {
        if (previous.digest !== digest) throw new TranscriptionError(409, 'IDEMPOTENCY_CONFLICT', 'This request identifier was already used for a different recording. Select the new file and retry.');
        res.status(202).set('Cache-Control', 'no-store').json(previous.job); return;
      }
      const audio = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0); chunks.length = 0;
      try { validateAudioSignature(audio, extension); } catch (error) { audio.fill(0); throw error; }
      while (entries.size >= 10) entries.delete(entries.keys().next().value!);
      const entry: Entry = { key: key!, digest, controller: new AbortController(), expires: now() + ttl, job: { id: randomUUID(), status: 'processing', transcript: null, model: '', provider: 'groq', error: null, errorCode: null, createdAt: new Date(now()).toISOString() } };
      entries.set(entry.job.id, entry); active = entry;
      res.status(202).set('Cache-Control', 'no-store').json(entry.job);
      const work = (async () => {
        try {
          const result = validateResult(await services.transcribe(audio, filename, entry.controller.signal));
          if (entry.job.status !== 'cancelled') { entry.job.status = 'completed'; entry.job.transcript = result.transcript; entry.job.model = result.model; }
        } catch (error) {
          if (entry.job.status !== 'cancelled') { const safe = safeError(error); entry.job.status = 'failed'; entry.job.error = safe.message; entry.job.errorCode = safe.code; }
        } finally { audio.fill(0); if (active === entry) active = undefined; entry.expires = now() + ttl; }
      })();
      running.add(work); void work.finally(() => running.delete(work));
    } catch (error) { req.resume(); next(error); }
    finally { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; if (timer) clearTimeout(timer); if (ownsReservation) { uploadReserved = false; uploadKey = undefined; } }
  });
  function dispose() {
    disposed = true; cancelUpload?.(new TranscriptionError(503, 'TRANSCRIPTION_STOPPING', 'The server is stopping. Restart it before uploading a recording.'));
    for (const entry of entries.values()) { entry.job.status = 'cancelled'; entry.job.transcript = null; entry.controller.abort(); }
    entries.clear(); cancelledKeys.clear(); uploadKey = undefined;
  }
  return { router, dispose, waitForJobs: async () => { await Promise.all([...running]); } };
}
