import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Speech responses are deterministic test doubles. Project/meeting writes below use
// the actual backend and the isolated database provisioned by playwright.config.ts.
const speechStatus = {
  available: true, model: 'test-whisper', message: 'Test speech service is available.',
  maxBytes: 25_000_000, formats: ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac'],
};
const recognized = 'Maya: We agreed to keep the pilot small.\nAlex: I will review the budget by Friday.';
const jobId = '2e330343-91d0-4ac7-85ab-260efab44a38';
function job(status = 'processing', values: Record<string, unknown> = {}) {
  return { id: jobId, status, transcript: null, model: '', provider: 'groq', error: null,
    errorCode: null, createdAt: '2026-10-18T06:00:00.000Z', ...values };
}
function wav() {
  // A real 0.1-second mono PCM WAV (silence). No external audio fixture or service.
  const dataBytes = 1600;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(dataBytes, 40);
  return { name: 'meeting.wav', mimeType: 'audio/wav', buffer: bytes };
}
async function mockSpeech(page: Page, initial: unknown = job()) {
  const state = { result: initial, posts: 0, polls: 0, deletes: 0, status: { ...speechStatus }, bodies: [] as Buffer[], keys: [] as string[] };
  await page.route('**/api/transcription-status', route => route.fulfill({ json: state.status }));
  await page.route('**/api/transcriptions**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      state.posts += 1;
      expect(request.headers()['content-type']).toBe('application/octet-stream');
      expect(request.headers()['x-audio-filename']).toBe('meeting.wav');
      state.keys.push(request.headers()['idempotency-key']);
      state.bodies.push(request.postDataBuffer() ?? Buffer.alloc(0));
      await route.fulfill({ status: 202, json: job() });
    } else if (request.method() === 'DELETE') {
      state.deletes += 1;
      await route.fulfill({ status: 204 });
    } else {
      state.polls += 1;
      await route.fulfill({ json: state.result });
    }
  });
  return state;
}
async function openAudio(page: Page) {
  await page.goto('/meetings/new');
  await page.getByRole('button', { name: 'Audio recording', exact: true }).click();
  await expect(page.getByLabel('Upload an audio recording')).toBeAttached();
}
async function prepareAudio(page: Page) {
  await page.getByLabel('Upload an audio recording').setInputFiles(wav());
  await page.getByRole('checkbox', { name: 'I have permission to share this recording with Groq for transcription.' }).check();
}
async function checkAccessibility(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
}

test('audio upload, consent, polling and reviewed corrections persist as a real meeting', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const state = await mockSpeech(page);
  const response = await page.request.post('/api/projects', { data: { name: 'Audio browser QA', description: 'Isolated audio workflow test.' } });
  expect(response.status()).toBe(201);
  const project = await response.json() as { id: string };
  await openAudio(page);
  await page.getByLabel('Meeting title').fill('Reviewed recording — नमस्ते');
  await page.getByLabel('Project', { exact: true }).selectOption(project.id);
  await page.getByLabel('Upload an audio recording').setInputFiles(wav());
  await expect.poll(() => page.getByLabel('Recording playback').evaluate((element: HTMLMediaElement) => element.duration)).toBe(0.1);
  const start = page.getByRole('button', { name: 'Generate transcript', exact: true });
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have permission to share this recording with Groq for transcription.' }).check();
  await start.click();
  await expect(page.getByRole('button', { name: 'Cancel transcription', exact: true })).toBeVisible();
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  expect(state.posts).toBe(1);
  expect(state.bodies[0]).toEqual(wav().buffer);
  expect(state.keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  state.result = job('completed', { transcript: recognized, model: 'test-whisper' });
  await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
  const corrected = recognized.replace('Friday', 'Monday');
  await page.getByLabel('Generated transcript').fill(corrected);
  await checkAccessibility(page);
  await page.screenshot({ path: '.local/audio-review-qa.png', fullPage: true });
  await page.getByRole('button', { name: 'Use reviewed transcript', exact: true }).click();
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(corrected);
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[a-f0-9-]{36}$/);
  const meetingId = page.url().split('/').at(-1);
  try {
    await page.reload();
    await expect(page.getByLabel('Original meeting transcript')).toHaveText(corrected);
    const saved = await (await page.request.get(`/api/meetings/${meetingId}`)).json();
    expect(saved).toMatchObject({ title: 'Reviewed recording — नमस्ते', transcript: corrected, status: 'draft', record: null });
    expect(state.posts).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    const saved = await (await page.request.get(`/api/meetings/${meetingId}`)).json();
    expect((await page.request.delete(`/api/meetings/${meetingId}?version=${saved.version}`)).status()).toBe(204);
  }
});

test('unsupported, empty and oversized recordings are rejected before upload', async ({ page }) => {
  const state = await mockSpeech(page);
  await openAudio(page);
  const input = page.getByLabel('Upload an audio recording');
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Not audio.') });
  await expect(page.getByRole('alert')).toContainText('Choose an MP3, WAV, M4A, MP4, WebM, OGG, or FLAC recording.');
  await input.setInputFiles({ name: 'empty.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(0) });
  await expect(page.getByRole('alert')).toContainText(/empty/i);
  await input.setInputFiles({ name: 'large.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(25_000_001) });
  await expect(page.getByRole('alert')).toContainText(/25 MB|too large/i);
  expect(state.posts).toBe(0);
});

test('an unavailable speech provider leaves the paste workflow usable', async ({ page }) => {
  const state = await mockSpeech(page);
  state.status = { ...speechStatus, available: false, model: '', message: 'Set GROQ_API_KEY to transcribe recordings. You can still paste a transcript.' };
  await openAudio(page);
  await expect(page.getByText(state.status.message, { exact: false })).toBeVisible();
  await prepareAudio(page);
  await expect(page.getByRole('button', { name: 'Generate transcript', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Paste transcript', exact: true }).click();
  await page.getByLabel('Meeting transcript').fill(recognized);
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(recognized);
  expect(state.posts).toBe(0);
});

test('failed transcription requires explicit retry and can then be cancelled', async ({ page }) => {
  const state = await mockSpeech(page, job('failed', { error: 'Speech quota reached. Wait and retry explicitly.', errorCode: 'TRANSCRIPTION_RATE_LIMIT' }));
  await openAudio(page); await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Speech quota reached.');
  await expect(page.getByRole('button', { name: 'Retry transcription', exact: true })).toBeVisible();
  expect(state.posts).toBe(1);
  state.result = job();
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await expect.poll(() => state.posts).toBe(2);
  expect(state.keys[1]).not.toBe(state.keys[0]);
  await page.getByRole('button', { name: 'Cancel transcription', exact: true }).click();
  await expect.poll(() => state.deletes).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Cancel transcription', exact: true })).not.toBeVisible();
  await expect(page.getByLabel('Generated transcript')).not.toBeVisible();
  expect(state.posts).toBe(2);
});

test('unexpected speech payloads are reported without crashing or filling the source', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await mockSpeech(page, { status: 'completed', transcript: { unsafe: true } });
  await openAudio(page); await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/unexpected data|invalid.*response/i);
  await expect(page.getByLabel('Generated transcript')).not.toBeVisible();
  await page.getByRole('button', { name: 'Paste transcript', exact: true }).click();
  await expect(page.getByLabel('Meeting transcript')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('a failed status request can resume polling without submitting audio again', async ({ page }) => {
  const state = await mockSpeech(page);
  let disconnected = true;
  await page.route(`**/api/transcriptions/${jobId}`, async route => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    if (disconnected) await route.abort('failed');
    else await route.fulfill({ json: job('completed', { transcript: recognized, model: 'test-whisper' }) });
  });
  await openAudio(page); await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot reach the server.');
  await expect(page.getByRole('alert')).toContainText('This will not submit the audio again.');
  disconnected = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
  expect(state.posts).toBe(1);
});

test('using a recording cannot silently replace an existing transcript', async ({ page }) => {
  await mockSpeech(page, job('completed', { transcript: recognized, model: 'test-whisper' }));
  await page.goto('/meetings/new');
  const original = 'Original notes that must not be lost.';
  await page.getByLabel('Meeting transcript').fill(original);
  await page.getByRole('button', { name: 'Audio recording', exact: true }).click();
  await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
  await page.getByRole('button', { name: 'Use reviewed transcript', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace the existing transcript?' });
  await expect(dialog).toBeVisible();
  await checkAccessibility(page);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Paste transcript', exact: true }).click();
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(original);
  await page.getByRole('button', { name: 'Audio recording', exact: true }).click();
  await page.getByRole('button', { name: 'Use reviewed transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Replace transcript', exact: true }).click();
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(recognized);
});

test('expired temporary jobs release the form and allow an explicit fresh retry', async ({ page }) => {
  const state = await mockSpeech(page, job('completed', { transcript: recognized, model: 'test-whisper' }));
  let missing = true;
  await page.route(`**/api/transcriptions/${jobId}`, async route => {
    if (route.request().method() === 'GET' && missing) {
      await route.fulfill({ status: 404, json: { code: 'TRANSCRIPTION_NOT_FOUND', error: 'This temporary transcription expired or the server restarted. Upload the recording again.' } });
    } else await route.fallback();
  });
  await openAudio(page); await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('server restarted');
  await expect(page.getByRole('button', { name: 'Change recording', exact: true })).toBeEnabled();
  missing = false;
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
  expect(state.posts).toBe(2);
  expect(state.keys[0]).not.toBe(state.keys[1]);
});

test('cancelling before the upload response arrives uses its request key', async ({ page }) => {
  await mockSpeech(page, job('completed', { transcript: recognized, model: 'test-whisper' }));
  let release: () => void = () => undefined;
  let key = ''; let posted = 0; let cancellationKey = '';
  await page.route('**/api/transcriptions', async route => {
    posted += 1;
    if (posted > 1) { await route.fallback(); return; }
    key = route.request().headers()['idempotency-key'];
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 202, json: job() }).catch(() => undefined);
  });
  await page.route('**/api/transcriptions/by-key/*', async route => {
    expect(route.request().method()).toBe('DELETE');
    cancellationKey = route.request().url().split('/').at(-1)!;
    await route.fulfill({ status: 204 }); release();
  });
  await openAudio(page); await prepareAudio(page);
  await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
  await expect.poll(() => posted).toBe(1);
  await page.getByRole('button', { name: 'Cancel transcription', exact: true }).click();
  await expect(page.getByText('Transcription cancelled.', { exact: false })).toBeVisible();
  expect(cancellationKey).toBe(key);
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
  expect(posted).toBe(2);
});

test('audio selection and review remain accessible without mobile or tablet overflow', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await mockSpeech(page, job('completed', { transcript: recognized, model: 'test-whisper' }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await openAudio(page); await prepareAudio(page);
    await checkAccessibility(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Generate transcript', exact: true }).click();
    await expect(page.getByLabel('Generated transcript')).toHaveValue(recognized);
    await checkAccessibility(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 390) await page.screenshot({ path: '.local/audio-mobile-qa.png', fullPage: true });
  }
  expect(errors).toEqual([]);
});
