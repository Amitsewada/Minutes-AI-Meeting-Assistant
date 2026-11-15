import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function checkAccessibility(page:Page) {
  const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
}

const transcript = [
  'Maya: We decided to use one project form for onboarding.',
  'Alex: I will prepare the wireframes by Friday.',
  'Sam: I will review the form accessibility.',
  'Maya: The release is blocked until content is approved.',
  'Alex: Do we need to migrate existing templates?',
].join('\n');

async function createProject(page: Page, name: string) {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Project name', { exact: false }).fill(name);
  await page.getByLabel('Description', { exact: true }).fill('Isolated browser-test data.');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function createMeeting(page: Page, project: string, title: string, text = transcript) {
  await page.goto('/meetings/new');
  await page.getByLabel('Meeting title').fill(title);
  await page.getByLabel('Project', { exact: true }).selectOption({ label: project });
  await page.getByLabel('Meeting date').fill('2026-10-15');
  await page.getByLabel('Participants').fill('Maya, Alex, Sam');
  await page.getByLabel('Meeting transcript').fill(text);
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[a-f0-9-]{36}$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

test('empty workspace and the complete reviewed-meeting journey persist real database changes', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A clearer day starts here.' })).toBeVisible();
  await expect(page.getByLabel('Workspace statistics').locator('strong')).toHaveText(['0', '0', '0', '0']);
  await createProject(page, 'Product launch — équipe');
  await createMeeting(page, 'Product launch — équipe', 'Onboarding review');
  await expect(page.getByText('Transcript ready', { exact: true })).toBeVisible();
  await page.getByLabel('AI provider').selectOption('demo');
  await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await expect(page.getByLabel('Meeting summary')).toBeVisible();
  await expect(page.getByText('Demo output', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Owner 1', {exact:true})).toHaveValue('');
  await expect(page.getByLabel('Deadline 1', {exact:true})).toHaveValue('');
  await checkAccessibility(page);
  await page.screenshot({path:'.local/review-qa.png',fullPage:true});
  await page.getByLabel('Meeting summary').fill('The team decided to use one project form. Alex will prepare the wireframes by Friday.');
  await page.getByLabel('Owner 1', {exact:true}).fill('Alex');
  await page.getByLabel('Deadline 1', {exact:true}).fill('Friday');
  await expect(page.getByRole('button', {name:'Confirm meeting record'})).toBeDisabled();
  await page.getByRole('checkbox', {name:'I have reviewed this draft against the original transcript.'}).check();
  await page.getByRole('button', {name:'Confirm meeting record'}).click();
  await expect(page.getByText('Reviewed and confirmed.', {exact:true})).toBeVisible();
  const meetingURL=page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Onboarding review', exact: true })).toBeVisible();
  await expect(page.getByText('Reviewed and confirmed.', {exact:true})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  expect((await downloadPromise).suggestedFilename()).toBe('Onboarding review.md');
  await page.goto('/actions');
  const action='Alex: I will prepare the wireframes by Friday.';
  await page.getByRole('button',{name:`Edit ${action}`,exact:true}).click();
  await page.getByLabel('Task description').fill('Prepare the revised wireframes');
  await page.getByLabel('Priority',{exact:true}).selectOption('high');
  await page.getByRole('button',{name:'Save action item',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'Complete Prepare the revised wireframes',exact:true}).click();
  await page.reload();
  await expect(page.getByRole('button',{name:'Reopen Prepare the revised wireframes',exact:true})).toBeVisible();
  await page.getByLabel('Filter actions by status').selectOption('done');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await page.goto('/meetings');
  await page.getByLabel('Search meetings').fill('not found');
  await expect(page.getByText('No meetings match this view.')).toBeVisible();
  await page.getByRole('button',{name:'Clear filters'}).click();
  await expect(page.getByRole('heading',{name:'Onboarding review',exact:true})).toBeVisible();
  await page.goto(meetingURL);
  await page.getByRole('button',{name:'Delete meeting',exact:true}).click();
  await page.getByRole('button',{name:'Keep meeting'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'Delete meeting',exact:true}).click();
  await page.getByRole('button',{name:'Delete permanently'}).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await page.goto('/actions');
  await expect(page.locator('.task-row')).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('project dialog validates whitespace and restores keyboard focus on dismissal', async ({ page }) => {
  await page.goto('/projects');
  const opener = page.getByRole('button', { name: 'New project', exact: true });
  await opener.click();
  await expect(page.getByLabel('Project name')).toBeFocused();
  await page.getByLabel('Project name').fill('   ');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Give this project a name.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test('text import rejects unsafe, empty, invalid-encoding and oversized files and accepts Unicode', async ({ page }) => {
  await page.goto('/meetings/new');
  const input = page.getByLabel('Upload a transcript');
  const cases = [
    { name: 'recording.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('audio'), message: 'Choose a UTF-8 .txt transcript.' },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0), message: 'This file is empty.' },
    { name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe, 0x00]), message: 'This file is not valid UTF-8 text.' },
    { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(480001, 'x'), message: 'This file is too large.' },
  ];
  for (const sample of cases) {
    await input.setInputFiles({ name: sample.name, mimeType: sample.mimeType, buffer: sample.buffer });
    await expect(page.getByRole('alert')).toContainText(sample.message);
  }
  const imported = 'Maya: नमस्ते. We decided to keep the résumé in UTF-8.\nAlex: I will review it.';
  await input.setInputFiles({ name: 'meeting.txt', mimeType: 'text/plain', buffer: Buffer.from(imported) });
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(imported);
  await expect(page.getByText('meeting.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear imported transcript' }).click();
  await expect(page.getByLabel('Meeting transcript')).toHaveValue('');
  await page.getByRole('button', { name: 'Load example transcript' }).click();
  await expect(page.getByLabel('Meeting title')).toHaveValue('[Sample] Onboarding design review');
  await expect(page.getByText('This is a fictional example transcript.', { exact: false })).toBeVisible();
});

test('frontend reports a failed backend request and recovers through retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/projects', async route => {
    if (route.request().method() === 'GET' && fail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test-only service interruption. Retry safely.', code: 'TEST_UNAVAILABLE' }) });
    } else await route.continue();
  });
  await page.goto('/projects');
  await expect(page.getByRole('alert')).toContainText('Test-only service interruption. Retry safely.');
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'A place for every project.' })).toBeVisible();
});

test('mobile/tablet navigation, page wrapping and reduced motion remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/', '/meetings', '/meetings/new', '/actions', '/projects', '/settings']) {
      await page.goto(route);
      await expect(page.locator('h1')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('alert')).not.toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${route} at ${width}px has horizontal overflow`).toBe(true);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('link', { name: 'Meetings', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
});

test('unknown routes provide a working return path', async ({ page }) => {
  await page.goto('/missing-browser-test-route');
  await expect(page.getByRole('heading', { name: 'This page has moved on.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to overview' }).click();
  await expect(page).toHaveURL('/');
});

test('provider preferences persist and unavailable providers do not block demo',async({page})=>{
  await page.goto('/settings');
  await expect(page.getByText('Development demo',{exact:true})).toBeVisible();
  await page.getByLabel('Default AI provider').selectOption('ollama');
  await page.getByRole('button',{name:'Save preferences'}).click();
  await expect(page.getByRole('status')).toContainText('Provider preferences saved.');
  await page.reload();
  await expect(page.getByLabel('Default AI provider')).toHaveValue('ollama');
  await page.getByLabel('Default AI provider').selectOption('demo');
  await page.getByRole('button',{name:'Save preferences'}).click();
  await page.getByRole('button',{name:'Check connections'}).click();
  await expect(page.locator('.provider-row').filter({hasText:'Ollama Local'})).toContainText('Unavailable');
  await expect(page.locator('.provider-row').filter({hasText:'Development demo'})).toContainText('Available');
});

test('automated accessibility scan covers primary views and dialog',async({page})=>{
  for(const route of ['/','/meetings','/meetings/new','/actions','/projects','/settings']) {
    await page.goto(route);await page.waitForLoadState('networkidle');await checkAccessibility(page);
  }
  await page.goto('/projects');await page.getByRole('button',{name:'New project',exact:true}).click();await checkAccessibility(page);
});

test('unexpected server response formats and shapes produce actionable feedback',async({page})=>{
  let invalidShape=false;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/projects',route=>route.fulfill({status:200,contentType:invalidShape?'application/json':'text/plain',body:invalidShape?JSON.stringify({unexpected:true}):'invalid server response'}));
  await page.goto('/projects');
  await expect(page.getByRole('alert')).toContainText('The server returned an unreadable response.');
  invalidShape=true;await page.reload();
  await expect(page.getByRole('alert')).toContainText('The server returned unexpected data.');
  expect(errors).toEqual([]);
});

test('editing the source invalidates the old review draft and regenerates from the changed text', async ({ page }) => {
  await createProject(page, 'Source revision QA');
  await createMeeting(page, 'Source revision QA', 'Revise the meeting source');
  const meetingId = page.url().split('/').at(-1);
  await page.getByLabel('AI provider').selectOption('demo');
  await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await expect(page.getByLabel('Meeting summary')).toHaveValue(/onboarding/);
  await page.getByRole('button', { name: 'Edit meeting source', exact: true }).click();
  const revised = 'Maya: We agreed to run a smaller pilot.\nAlex: I will review the revised budget by Monday.';
  await page.getByLabel('Original transcript', { exact: true }).fill(revised);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Transcript ready', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Meeting summary')).not.toBeVisible();
  const saved = await (await page.request.get(`/api/meetings/${meetingId}`)).json();
  expect(saved).toMatchObject({ transcript: revised, record: null, provider: null, status: 'draft' });
  await page.reload();
  await expect(page.getByLabel('Original meeting transcript')).toHaveText(revised);
  await page.getByLabel('AI provider').selectOption('demo');
  await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await expect(page.getByLabel('Meeting summary')).toHaveValue(revised.replace('\n', ' '));
  await expect(page.getByLabel('Meeting summary')).not.toHaveValue(/onboarding/);
  await expect(page.getByRole('button', { name: 'Confirm meeting record' })).toBeDisabled();
});

test('transcript HTML remains literal text in the source, draft, and final record', async ({ page }) => {
  await createProject(page, 'Literal transcript QA');
  const payload = '<img src=x onerror="window.__minutesXss=1">';
  const source = `Maya: ${payload}\nMaya: We agreed to display source text literally.\nAlex: I will inspect the plain-text export.`;
  await createMeeting(page, 'Literal transcript QA', 'Literal HTML review', source);
  await expect(page.getByLabel('Original meeting transcript')).toContainText(payload);
  await expect(page.getByLabel('Original meeting transcript').locator('img')).toHaveCount(0);
  await page.getByLabel('AI provider').selectOption('demo');
  await page.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await expect(page.getByLabel('Meeting summary')).toHaveValue(source.replaceAll('\n', ' '));
  await page.getByRole('checkbox', { name: 'I have reviewed this draft against the original transcript.' }).check();
  await page.getByRole('button', { name: 'Confirm meeting record' }).click();
  await expect(page.locator('.final-summary')).toContainText(payload);
  await expect(page.locator('.final-summary img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, '__minutesXss'))).toBeUndefined();
  await page.reload();
  await expect(page.locator('.final-summary')).toContainText(payload);
});

test('a lost save response can be retried without creating a duplicate meeting', async ({ page }) => {
  await createProject(page, 'Retry safety QA');
  let loseFirstResponse = true;
  await page.route('**/api/meetings', async route => {
    if (route.request().method() === 'POST' && loseFirstResponse) {
      loseFirstResponse = false;
      // The real backend commits the first request, but the browser loses its response.
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto('/meetings/new');
  await page.getByLabel('Meeting title').fill('Recover a lost save response');
  await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Retry safety QA' });
  await page.getByLabel('Meeting transcript').fill(transcript);
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot reach the server.');
  await expect(page.getByLabel('Meeting transcript')).toHaveValue(transcript);
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/[a-f0-9-]{36}$/);
  const rows = await (await page.request.get('/api/meetings?q=Recover%20a%20lost%20save%20response')).json();
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(page.url().split('/').at(-1));
});
