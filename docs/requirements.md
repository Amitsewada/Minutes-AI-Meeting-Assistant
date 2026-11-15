# Requirements and scope

## Source and inspection

The primary specification is the supplied `SPM_AI_Meeting_PPT (1).pptx` (8 slides). All eight slide XML files and speaker-note XML files were read directly from the PowerPoint archive. The workflow and architecture are native slide text/shapes; the archive contains no embedded media, charts, or external diagram parts. Speaker notes contain no additional project requirements. The presentation was not edited.

The user's written request adds the visual identity, Groq and Ollama providers, input/output validation, durable operation, tests, and beginner documentation. These additions are distinguished below from the presentation's requirements. Slide 2 contains contextual statistics without source citations. They are not treated as verified facts or displayed as application statistics.

## Problem, users, and outcome

Teams lose decisions and follow-up responsibilities when meeting discussions remain unstructured (slides 2–4). The intended user is a team member reviewing a meeting and tracking its follow-up work. The central outcome is **one persistent, editable, reviewable record for each meeting**, grouped by project, with source transcript, summary, decisions, actions, owners, deadlines, and task status (slides 1, 4–7).

The presentation does not define separate user roles, authentication, calendar scheduling, subscriptions, or a public deployment target. This implementation therefore runs as a single-user application bound to the local computer. “Participants” and task “owners” are descriptive text, not separate accounts.

## Traceability checklist

| ID | Requirement and source | Implementation responsibility | Verification |
| --- | --- | --- | --- |
| PPT-01 | Accept pasted transcript; optionally upload transcript text (5 O1, 6) | Meeting form, text import, shared input validation | Browser creation/import flow; empty, whitespace, length and file-type checks |
| PPT-02 | Create one record per meeting; process meetings independently (1, 5 O2, 6) | Meeting resource, per-meeting analysis jobs | API record isolation, duplicate processing, history retrieval |
| PPT-03 | Clean transcript and split long input when necessary (6) | Common AI preprocessing/chunking pipeline | Unit tests for normalization, long transcripts and bounded chunks |
| PPT-04 | Generate summary and decisions (5 O3, 6–7) | Shared structured AI schema, provider adapters, review editor | Schema validation and malformed output tests; browser review |
| PPT-05 | Extract action items, owners and deadlines (1, 5 O4, 6–7) | AI draft, evidence quotes, nullable owner/deadline, persisted actions | Unknown fields remain null; unsupported evidence rejected; API task retrieval |
| PPT-06 | Group persistent meeting history by project (5 O5, 7) | Projects, PostgreSQL tables, meeting list and project filters | Create project and meeting; reload and retrieve; search and project filtering |
| PPT-07 | Human review and edit before finalization (4, 5 O6, 6–7) | Separate source transcript and draft; edit and confirm workflow | Finalization validation; draft does not create confirmed tasks; browser edit/confirm |
| PPT-08 | Store blockers in the structured record (6) | Evidence-backed blocker list and review fields | Structured output validation and persisted review |
| PPT-09 | Store and update task status (6–7) | Action-item API and follow-up workspace | Status update, conflict handling and reload persistence |
| PPT-10 | Searchable, editable, trackable records (2–3) | Meeting search, review editor and follow-up statuses | Search results, editing and task flow |
| PPT-11 | React frontend, Node.js TypeScript backend, PostgreSQL database, LLM API (7) | React/Vite, Express/TypeScript, embedded PostgreSQL through PGlite, provider layer | Type check, production build, API/database and browser tests |
| USER-01 | Indigo/lavender/warm-white visual identity; responsive and accessible controls | Shared CSS tokens, navigation, forms and review interface | Desktop/mobile browser inspection, focus, labels, contrast review, reduced motion |
| USER-02 | Groq primary, optional Ollama, configurable models, backend-only credentials | Provider adapters, environment variables, provider settings/status | Independent mocked provider tests and separately reported live inference checks |
| USER-03 | Explicit fallback, bounded retries, usable app without either AI service | Provider status, actionable errors, explicit local retry, labelled demo | Rate limit/unavailable provider tests; switching and demo workflow |
| USER-04 | Grounded structured output, unresolved questions, draft review | Shared Zod schema, evidence validation, review editor | Missing fields, invalid JSON, invented evidence, unknown owner/date cases |
| USER-05 | Durable CRUD, safe errors, concurrency and duplicate protection | Validated APIs, parameterized SQL, versions, analysis jobs | API integration and negative tests with isolated data |
| USER-06 | Complete install/run/test documentation and honest reporting | README, architecture, test plan, test report | Commands executed and recorded; blocked checks explicitly listed |
| USER-07 | Subsequently approved audio upload when no transcript exists (18 October 2026) | Groq speech adapter, bounded temporary jobs, explicit cloud sharing, editable transcript review and existing meeting save | Mock speech/API failures, upload boundaries, duplicate/cancel tests, browser review-to-save journey; separately reported real synthetic-speech check |

This is a requirements map, not a claim that every row has passed. Actual executed checks and limitations are recorded in `docs/test-report.md`.

## Explicit presentation boundaries

- Slide 5 says the initial system begins with transcript input. Audio upload and direct Google Meet, Zoom, and Teams integrations are planned later.
- Slide 7 repeats that audio and meeting-platform integrations follow the reliable transcript-to-record pipeline.
- These are the original PPT boundaries. The user's later approval extends this version to audio-file upload, browser playback where supported, and Groq speech recognition. Recording, speaker diarization, calendar integrations, invitation delivery, automatic bot attendance, and email sending remain outside this version.
- Slide 8 assigns student work areas. It does not add product functionality or evaluation criteria.
- The presentation specifies no numerical performance target, availability SLA, formal grading rubric, or required deployment service.

## Engineering decisions and assumptions

1. **Local single-user scope.** No account management is introduced. The server binds to loopback and is not suitable for direct internet exposure. Multi-user deployment needs authentication and per-user authorization first.
2. **Embedded PostgreSQL.** PGlite provides real PostgreSQL query/storage semantics in a local data directory and avoids requiring a beginner to install a separate PostgreSQL service. It is one server process per data directory. A shared multi-user deployment should move to a supported PostgreSQL server.
3. **Durability before AI.** Meeting metadata and the original transcript can be saved before analysis. Only explicit confirmation creates the final record and follow-up tasks. A failed AI call leaves the source intact.
4. **No inferred commitments.** Unknown owners/deadlines stay unknown. A deadline may retain the transcript's wording, such as “next Friday,” instead of silently guessing a calendar date. Extracted decisions, actions, blockers, and questions carry source evidence. Evidence matching is a guardrail; human review remains necessary for semantic accuracy.
5. **Small local model is optional.** The model name is configurable. Local availability is checked, and no browser action downloads a model automatically. Storage/RAM and quality tradeoffs are documented before a requested download.
6. **Demo is explicit.** Demo mode uses deterministic extractive logic and labels its results. It verifies workflows without pretending to invoke an AI model.
7. **Bounded input.** Transcript length is limited to 120,000 characters. Limits protect local resources and cloud quota. Processing splits longer valid transcripts into bounded chunks; provider errors do not trigger unlimited retries.
8. **Useful supporting fields.** Meeting title/date/participants, project description, task priority, and settings are implementation choices supporting the workflow. They are not represented as fields explicitly enumerated by the PPT.
9. **No fabricated business data.** New installations begin empty. Dashboard counts derive from persisted records. Sample content is user-selected and clearly labelled.
10. **Speech is a separate input stage.** Groq transcribes audio regardless of the selected summary provider. The user must explicitly share the recording and review the generated text. The app does not identify speakers automatically or reconstruct missing recordings. It stores only the reviewed transcript when the user saves the meeting; raw audio is not stored on disk by the application. Temporary results are bounded and expire. See the audio guide for service-side privacy and operational limits.

## Acceptance journey

A user creates a project, pastes or imports a transcript, saves a meeting, selects an available provider, and requests analysis. The application shows processing or a recoverable error. A successful result is visibly marked as a draft, with original transcript separately available. The user reviews/edits the draft, confirms the meeting, and tracks its tasks. Returning to the application preserves the meeting, source transcript, final record, project grouping, and task state. Provider status and demo mode remain understandable when cloud/local AI is unavailable.
