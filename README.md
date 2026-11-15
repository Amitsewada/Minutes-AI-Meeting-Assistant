# Minutes — AI Meeting Intelligence

Repository: https://github.com/Amitsewada/Minutes-AI-Meeting-Assistant

A complete local web application that turns meeting transcripts into **reviewable meeting records and trackable follow-up work**. Built from the supplied eight-slide SPM presentation, with the requested Groq and Ollama integrations.

The presentation specifies transcript input, one record per meeting, summary/decisions/actions, owners/deadlines, project history and human review. It originally deferred audio and platform integration. The user subsequently approved **audio upload and Groq speech transcription** to support meetings without an existing transcript. Recording and Google Meet/Zoom/Teams integration remain future work. See [the requirements checklist](docs/requirements.md), [audio guide](docs/audio-transcription.md), [architecture](docs/architecture.md), [test plan](docs/test-plan.md) and [actual test report](docs/test-report.md).

## What is implemented

- Responsive React workspace with real database counts, empty states and an indigo/lavender design system.
- Create projects; paste transcripts or import UTF-8 `.txt` files; save meeting title, date and participants.
- Upload a recording up to 25 MB, explicitly send it to Groq speech-to-text, correct the generated transcript, and use the reviewed text in a meeting. Transcription is separate from the summary provider.
- Search source text and titles; filter meetings by project/status and sort by date.
- Groq cloud analysis, optional Ollama local inference, and explicitly labelled deterministic demo extraction.
- Background analysis jobs with progress, duplicate protection, model provenance and safe failures.
- Editable summary, decisions, actions, blockers and questions alongside the preserved source transcript.
- Evidence quotation validation; unknown owners/deadlines remain null. Explicit human confirmation saves final records and creates tasks transactionally.
- Persistent action descriptions, owners, deadlines, priorities and statuses; project progress; meeting export to Markdown; confirmed deletion with linked task cleanup.
- Model discovery and persistent provider settings. No API key is accepted or stored by the browser.
- Optimistic version checks reject stale edits, rather than overwriting changes from another window.

## Technology and project structure

Node.js 22.12+ (tested with Node 24), TypeScript, Express, React 19, Vite, Zod, PGlite, Vitest, Supertest, Playwright and axe-core.

PGlite runs real PostgreSQL inside the backend process and stores its files locally. This honors the presentation's PostgreSQL choice without making a beginner install a separate database server. It is **one application process per data directory**, not a hosted/multi-user PostgreSQL deployment.

```text
src/                     React pages, API client, reusable controls, design tokens/CSS
server/app.ts            Validated REST API, transactions and job lifecycle
server/db.ts             PostgreSQL startup and migration execution
server/migrations/       Database schema
server/ai/index.ts       Shared AI interface, Groq/Ollama/demo adapters and validation
server/transcription.ts  Bounded audio uploads, Groq speech adapter and temporary jobs
shared/schema.ts         Request and structured-record contracts
tests/                   Unit, database/API, browser and accessibility tests
scripts/                 Local Ollama startup and explicit live inference checks
docs/                    Requirements, architecture, test plan and results
.env.example             Blank configuration template (no real secret)
```

## Quick start on Windows PowerShell

Download the repository ZIP, extract it and open PowerShell in the extracted folder, or clone it:

```powershell
New-Item -ItemType Directory -Force C:\Projects | Out-Null
Set-Location C:\Projects
git clone https://github.com/Amitsewada/Minutes-AI-Meeting-Assistant.git
Set-Location Minutes-AI-Meeting-Assistant
```

Presentation: [Group 43 PowerPoint](output/presentation/Minutes_Group_43_GitHub.pptx). Speaking script: [slide-wise narration](output/presentation/Minutes_Direct_Speaking_Script.md).

### Double-click startup (Windows)

On this computer, double-click the desktop shortcut **Minutes - AI Meeting Assistant**. You can also double-click **Start Minutes.cmd** in this project folder. It installs dependencies if missing, builds the app if relevant sources changed, starts optional installed Ollama without downloading models, starts the server, waits for the database health check, and opens your default browser. It reuses an already-running app/Ollama service. The servers run in the background; no terminal needs to remain open for this launcher.

The launcher uses the existing `.env`, including `PORT` and `DATA_DIR`. It never prints API keys or changes the machine-wide PowerShell execution policy. If startup fails, its window stays open with the error. Logs are under `.local\launcher\`. An old database lock is recovered only after both Windows process inventories confirm its owner has stopped; unknown or live-owner locks remain protected. No meeting database files are deleted. Keep the project at its current location for the desktop shortcut to work; the `.cmd` inside the folder also works if the project folder is moved.

### Manual startup

Node and npm must be installed. Check with `node --version` and `npm.cmd --version`. Commands below use `npm.cmd` to avoid PowerShell execution-policy problems with npm.ps1.

Open a PowerShell terminal in this directory:

```powershell
Set-Location 'C:\Projects\Minutes-AI-Meeting-Assistant'
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

A fresh clone contains no credentials or meeting data. Add your own Groq key to the ignored backend `.env`, or select demo mode. Never commit a populated `.env`. Existing local users should preserve their configuration.

For a normal local run, build once and start **one process** in this terminal:

```powershell
npm.cmd run build
npm.cmd start
```

Open `http://127.0.0.1:3001`. Keep this terminal open. Press `Ctrl+C` to stop. A fresh installation starts with no records; choose **New project**, then **New meeting**. The example transcript is fictional and loads only when explicitly selected.

### Development: separate frontend and backend terminals

Terminal 1:

```powershell
Set-Location 'C:\Projects\Minutes-AI-Meeting-Assistant'
npm.cmd run dev:server
```

Terminal 2:

```powershell
Set-Location 'C:\Projects\Minutes-AI-Meeting-Assistant'
npm.cmd run dev:client
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to backend port 3001. Alternatively `npm.cmd run dev` starts both. Stop the production server before starting the development backend so they do not share a port/database.

## Configuration

All values below are **backend** environment variables, without a `VITE_` prefix. `.env` and runtime data are ignored by Git. After changing `.env`, restart the backend. Settings saved in the UI override the default provider and model names; changing `.env` does not erase those saved choices.

| Variable | Meaning |
| --- | --- |
| `AI_PROVIDER` | `groq`, `ollama` or `demo`. When absent, a configured Groq key takes precedence, then configured Ollama, then demo. No automatic failure-based switching. |
| `GROQ_API_KEY` | Your Groq API key. Required only for Groq. |
| `GROQ_MODEL` | Model ID from your account. Blank discovers a candidate; choose a suitable chat model in Settings and verify its output. |
| `GROQ_TRANSCRIPTION_MODEL` | Speech model ID, separate from `GROQ_MODEL`. Blank discovers an available Whisper model from the account catalog; configure an exact available speech model to override. |
| `TRANSCRIPTION_TIMEOUT_MS` | Speech request timeout including model discovery; default 120000, constrained to 5000–300000 ms. No automatic inference retry. |
| `OLLAMA_BASE_URL` | Local HTTP API address, normally `http://127.0.0.1:11434`. Only loopback hosts accepted. |
| `OLLAMA_MODEL` | Installed model tag, e.g. `qwen3:0.6b`. |
| `AI_TIMEOUT_MS` | Per-request inference timeout; default 120000, constrained to 1000–300000 ms. |
| `DATA_DIR` | Persistent database directory; example uses `./data/minutes`. |
| `PORT` | Backend port, normally 3001. |
| `CLIENT_PORT` | Trusted frontend development port, normally 5173. If changed, also update the Vite port/proxy. |

### Groq

1. Obtain a key from [Groq Console](https://console.groq.com/keys) and enter it in `.env`.
2. Start/restart the backend, open Settings, and click **Check connections**.
3. Select a model returned by your account and save preferences.
4. On a meeting, explicitly select Groq and generate a draft. This sends the transcript to Groq.

There is no paid subscription requirement in this application. Free-tier usage still has token/request/quota limits; verify your account's current plan. The application does not silently retry inference, upgrade plans or buy credits. The source code has no fixed Groq model name. A real test succeeded with account-listed `openai/gpt-oss-20b` on 15 October 2026, and that model was saved in the local configuration. Availability can change. An earlier discovered model failed structured validation; catalog availability is not a guarantee of extraction quality.

Groq JSON-object output is validated with Zod before any draft is stored. See [Groq models](https://console.groq.com/docs/models), [structured output documentation](https://console.groq.com/docs/structured-outputs) and [rate limits](https://console.groq.com/docs/rate-limits).

### Optional lightweight Ollama setup

Ollama is **not required to start Minutes**. Install it using the official [Windows instructions](https://docs.ollama.com/windows) if it is not already present. Restart your terminal after installation.

The requested lightweight model, [`qwen3:0.6b`](https://ollama.com/library/qwen3/tags), was downloaded here. It occupies approximately **523 MB**, stored under this project's `.local\ollama-models`. Model runtime, context and caches need additional RAM. This laptop has 16 GB physical RAM; available memory varies. Allow roughly 1–2 GB of free memory as an estimate for this small configuration, and more for other models. Close memory-heavy applications if inference fails. A larger model can improve quality but uses more storage/RAM; the app never downloads one automatically.

To reuse this project-local model store, start **Terminal 3**:

```powershell
Set-Location 'C:\Projects\Minutes-AI-Meeting-Assistant'
powershell -ExecutionPolicy Bypass -File .\scripts\start-ollama.ps1
```

This script only sets variables in that process and starts the existing Ollama executable; it does not install anything or change machine-wide execution policy. Keep that terminal open. If port 11434 is already in use, an Ollama server is running; use it or stop the duplicate. The normal Ollama tray app may use a different model directory. For this delivered model, use the supplied script.

On a fresh machine, after starting Ollama, explicitly download the model from another terminal:

```powershell
ollama pull qwen3:0.6b
ollama list
```

The running server determines the model store. Configure `OLLAMA_MODEL=qwen3:0.6b`, refresh connections in Minutes, select Ollama, and save preferences. Local inference was tested: the small model passed a simple no-decisions transcript but produced unsupported evidence on a more complex example, which was correctly rejected. Treat it as a lightweight, limited-quality option; review all successful outputs. [Ollama structured output API](https://docs.ollama.com/capabilities/structured-outputs).

If Groq returns a rate limit or temporary failure and the selected local model is available, the meeting page offers **Try with Ollama instead**. You decide whether to switch. If both are unavailable, select **Demo · No model** explicitly. Demo uses repeatable text-extraction rules; it never claims to call an AI model.

## Database initialization and backups

For meetings without a transcript, see [Audio upload and transcription](docs/audio-transcription.md). In **New meeting**, choose **Audio recording**, select a supported file, check the permission/cloud-sharing box, and choose **Generate transcript**. Correct the text and select **Use reviewed transcript**, then **Save transcript**. After saving, choose any available summary provider. Ollama/demo summary selection does not make the preceding Groq speech step local or offline.

Startup automatically creates `DATA_DIR`, runs the SQL migration, and initializes empty tables. There is no seed command and no fake production data. Source transcripts are stored separately from AI and reviewed records. Test databases use temporary directories and never replace the normal data folder.

For a consistent backup, stop the backend and copy the complete configured database directory to a secure location. Do not copy individual internal PostgreSQL files, delete the data directory to fix an error, or run two backends against one directory. This workspace is under OneDrive: avoid concurrent sync edits or opening the same database from another computer; for sustained use choose a local non-synced `DATA_DIR` and back it up while stopped.

## Tests

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
$env:E2E_CHANNEL = 'chrome'
npm.cmd run test:e2e
```

Browser tests use installed Google Chrome and launch their own server on port 3101 with a fresh isolated database and demo AI. If Chrome is unavailable, install Playwright's Chromium with `npx.cmd playwright install chromium` (a browser download), then remove `E2E_CHANNEL` with `Remove-Item Env:E2E_CHANNEL -ErrorAction SilentlyContinue`.

Explicit real inference tests, which may consume Groq's quota or local resources:

```powershell
npm.cmd run test:live -- groq
npm.cmd run test:live -- ollama
```

To verify real speech recognition using a fictional Windows-generated recording:

```powershell
powershell.exe -NoProfile -File scripts\make-test-audio.ps1
npm.cmd run test:transcription:live
```

The first command uses an installed English Windows text-to-speech voice without recording a microphone. The second sends that fictional WAV to Groq using the backend key and consumes account speech quota. It checks recognized keywords and real isolated database persistence, then exercises the handoff with a clearly labelled **demo** summary. It does not claim live LLM summarization in that speech test. No audio is sent by the ordinary unit/browser test suites.

These use synthetic transcripts through the real API, inference, review-state validation, finalization and task-storage workflow in isolated in-memory PostgreSQL. They do not change your workspace records. Unit/API tests use mocked AI transport separately from real PostgreSQL operations. Browser tests verify persistence, review, task updates, imports, failures, focus, responsive behavior and accessibility. Actual outcomes and limitations are in [the test report](docs/test-report.md).

## Troubleshooting and limits

- **Port already used:** stop the other backend or Ollama instance. Do not start duplicate processes against the same database.
- **Database locked:** an exclusive lock beside `DATA_DIR` prevents two backends from opening the same database. Closing normally releases it; a valid lock from a demonstrably stopped process is recovered automatically. Unknown/malformed locks are left untouched. Follow the exact lock-file path in the startup error, verify every backend using that directory has stopped, then remove only that lock file if necessary. Never delete the database folder. A leftover `.recovering` marker also requires checking that startup recovery has stopped before removing that exact marker.
- **Blank/failed frontend:** run `npm.cmd run build` before `npm.cmd start`; development needs both terminals. Check `/api/health` at the backend URL.
- **Provider unavailable:** check environment variables, restart, then refresh connections. Ollama must be running with the selected model installed. Groq authentication failures require a valid key; a catalog response alone does not test inference.
- **Rate limit/timeout:** no automatic quota-consuming retries occur. Wait or explicitly select a different provider. The saved transcript stays intact.
- **Unsupported evidence/malformed JSON:** the application rejects the entire new draft. Try a stronger available model or use demo and manually review/edit. No failed response is promoted to a final record.
- **Conflict:** another window changed the record. Refresh before saving again. Changing a source transcript invalidates its generated draft and tasks; the UI allows source editing before confirmation.
- **Text imports:** `.txt`, valid UTF-8, up to 480,000 bytes and 120,000 characters. Use the separate Audio recording option for recordings. Relative deadlines remain text; the application does not guess dates or calculate overdue status from “Friday.”
- **Audio imports:** MP3, WAV, M4A, MP4, WebM, OGG or FLAC; maximum 25,000,000 bytes. File signatures are screened and Groq decodes the media. Large files must be exported/compressed/split outside the app. No automatic chunking, microphone capture, diarization or offline speech engine is included. Temporary transcription results expire; review and save before leaving the form.
- **Long meetings:** chunking is sequential and uses bounded context; per-part summaries are combined. Cross-part relationships can be missed. Output collections are capped at 100 entries and combined summary at 8,000 characters; review source for omissions. Large-history load testing has not been performed; lists are currently unpaginated.
- **Draft edits:** local until confirmation. Leaving the review page can discard unsaved edits. Confirmed meeting records remain snapshots; subsequent action edits are tracked in the task table.
- **Security scope:** a single local workspace, loopback-only, no login or multi-user permissions. Database content is unencrypted. Do not expose this server to the public internet. Parameterized SQL, schemas, origin/Host validation, CSP and escaped text provide local application protections, not a production security certification.
- **AI accuracy:** exact-quote checks detect unsupported evidence and remove unsupported owners/dates. They cannot prove the meaning of every summary or decision. Human review is mandatory; no factual-completeness guarantee is claimed.
- **Future work:** microphone capture, offline speech recognition, large-audio chunking, calendar/platform integration, multi-user accounts, notifications, hosted PostgreSQL, pagination and independent cross-browser/screen-reader evaluation.

## Design system

`src/styles.css` defines indigo `#413694`, lavender surfaces, warm off-white `#f8f8f5`, neutral text/borders, shared spacing, controls, list layouts, loading/disabled/error states and responsive rules. DM Sans and Manrope are bundled locally, so fonts require no external requests. All workflows use native labels, visible focus, keyboard-operable controls and reduced-motion rules. Automated accessibility findings are scoped to the tested views, not a full accessibility certification.

