// Explicit opt-in live Groq call. Default fixture is fictional speech generated locally.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';

const customPath = process.argv[2];
const audioPath = resolve(customPath || '.local/audio-verification/fictional-meeting.wav');
const bytes = await readFile(audioPath).catch(() => {
  console.error('Audio file not found. First run: powershell.exe -NoProfile -File scripts/make-test-audio.ps1');
  process.exit(1);
});
const db = await openDatabase();
const app = createApp(db);
let jobId: string | undefined;
const started = Date.now();
try {
  const status = (await request(app).get('/api/transcription-status').expect(200)).body;
  assert.equal(status.available, true, status.message);
  const key = randomUUID();
  const upload = await request(app).post('/api/transcriptions')
    .set('Content-Type', 'application/octet-stream').set('X-Audio-Filename', encodeURIComponent(basename(audioPath)))
    .set('Idempotency-Key', key).send(bytes).expect(202);
  jobId = upload.body.id;
  let job = upload.body;
  while (job.status === 'processing' && Date.now() - started < 200_000) {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = (await request(app).get(`/api/transcriptions/${jobId}`).expect(200)).body;
  }
  assert.equal(job.status, 'completed', job.error || 'Transcription did not complete.');
  assert.equal(typeof job.transcript, 'string');
  assert.ok(job.transcript.trim().length > 0);
  if (!customPath) {
    assert.match(job.transcript, /pilot/i);
    assert.match(job.transcript, /friday/i);
  }
  // Saving and reload use real isolated PostgreSQL, with no changes to the normal workspace.
  const project = (await request(app).post('/api/projects').send({name:'Fictional audio verification'}).expect(201)).body;
  const meeting = (await request(app).post('/api/meetings').send({projectId:project.id,title:'Reviewed transcription verification',date:'2026-10-18',participants:[],transcript:job.transcript}).expect(201)).body;
  const saved = (await request(app).get(`/api/meetings/${meeting.id}`).expect(200)).body;
  assert.equal(saved.transcript, job.transcript);
  // Demo analysis verifies handoff; it is deliberately not a second paid/model inference.
  await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({provider:'demo'}).expect(202);
  await app.locals.waitForJobs();
  const draft = (await request(app).get(`/api/meetings/${meeting.id}`).expect(200)).body;
  assert.equal(draft.status, 'review');
  assert.equal(draft.isDemo, true);
  await request(app).post(`/api/meetings/${meeting.id}/finalize`).send({version:draft.version,record:draft.record}).expect(200);
  console.log(JSON.stringify({transcription:'Real Groq inference',model:job.model,durationMs:Date.now()-started,audioBytes:bytes.length,transcriptCharacters:job.transcript.length,syntheticKeywordChecks:!customPath,downstream:'Real isolated database save/reload, then labelled deterministic demo summary and confirmation'}, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live transcription verification failed.');
  process.exitCode = 1;
} finally {
  if (jobId) await request(app).delete(`/api/transcriptions/${jobId}`);
  await db.close();
}
