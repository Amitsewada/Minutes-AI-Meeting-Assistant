import { getProviderStatuses } from '../server/ai/index.js';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import request from 'supertest';
import assert from 'node:assert/strict';
const provider = process.argv[2];
if (provider !== 'groq' && provider !== 'ollama') {
  console.error('Usage: npm run test:live -- groq|ollama'); process.exit(1);
}
const text = provider === 'groq'
  ? 'Maya: We agreed to launch the pilot.\nMaya will send the brief by Friday.\nThe rollout is blocked by legal review.\nWho will confirm the budget?'
  : 'The team discussed the pilot. No decisions were made. No action items were assigned.';
const start = Date.now();
const db = await openDatabase();
try {
  const status = (await getProviderStatuses()).find(item => item.provider === provider);
  console.log(`${provider}: ${status?.message}`);
  const app = createApp(db);
  const project = (await request(app).post('/api/projects').send({name:'Synthetic live integration test',description:'Temporary in-memory data.'}).expect(201)).body;
  const meeting = (await request(app).post('/api/meetings').send({projectId:project.id,title:'Synthetic provider verification',date:'2026-10-18',participants:['Maya'],transcript:text}).expect(201)).body;
  const job = (await request(app).post(`/api/meetings/${meeting.id}/analyze`).send({provider}).expect(202)).body;
  await app.locals.waitForJobs();
  const completed = (await request(app).get(`/api/jobs/${job.id}`).expect(200)).body;
  assert.equal(completed.status,'completed',completed.error || 'Real analysis did not complete.');
  const draft = (await request(app).get(`/api/meetings/${meeting.id}`).expect(200)).body;
  assert.equal(draft.status,'review'); assert.equal(draft.transcript,text);
  const final = (await request(app).post(`/api/meetings/${meeting.id}/finalize`).send({version:draft.version,record:draft.record}).expect(200)).body;
  assert.equal(final.status,'final');
  const actions = (await request(app).get('/api/actions').expect(200)).body;
  assert.equal(actions.length,final.record.actionItems.length);
  console.log(JSON.stringify({ provider:final.provider, model:final.model, durationMs:Date.now()-start, checks:'Real inference → draft → validation → confirmation → persisted tasks (isolated in-memory PostgreSQL)', record:final.record, warnings:final.warnings },null,2));
} catch(error) {
  console.error(error instanceof Error ? error.message : 'Live inference failed.'); process.exitCode=1;
} finally { await db.close(); }
