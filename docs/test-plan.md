# Test plan

## Approach and isolation

Tests cover the transcript-to-confirmed-record workflow first, then provider failures, data boundaries and the interface. Unit and API suites use Vitest. Browser tests use Playwright against a separate application process with explicit demo mode and a unique data directory. They do not delete or modify the normal workspace database. Provider mock tests inject controlled HTTP responses; they never claim live inference.

The execution report records actual passed/failed/blocked checks. This document defines intended coverage and must not be read as a completed test report.

## Critical workflow

1. Load a new empty workspace; verify useful empty states and zero counts.
2. Create a project using Unicode text.
3. Create a meeting with a title, valid date, participants and a transcript.
4. Run explicitly labelled demo analysis; wait for the review state.
5. Edit the summary and inspect source evidence/unknown ownership.
6. Confirm the meeting and verify the final record plus follow-up tasks.
7. Update task status and refresh the browser; verify persistence.
8. Search/filter history and open the meeting again.
9. Inspect provider settings and switching behavior.
10. Repeat relevant layout checks at desktop, tablet and mobile widths.

## Functional and API matrix

| Area | Cases and assertions |
| --- | --- |
| Projects | Create/list; required name; whitespace; oversized values; invalid/missing identifier; linked history |
| Meetings | Create/retrieve/update/delete; unique record; preserved source; project filter; search/sort; nonexistent record; Unicode and literal HTML |
| Input | Empty transcript; whitespace; over-limit text; invalid date including impossible day; unknown fields; malformed body; invalid UUID; missing project |
| Text import | Supported plain text; empty file; wrong type; excessive size; input contents preserved; actionable errors |
| Analysis | Saved source required; one active job per meeting; progress; completed review; repeated request behavior; failures preserve source; restart interruption |
| Review | Draft marker; editable record; strict structure; unknown owner/deadline; confirmation required; action creation; atomic finalization |
| Follow-up | Description, owner, deadline, priority and status validation; valid transitions; meeting link; stale version conflict; persisted edits |
| Persistence | Reload and fresh retrieval preserve project/meeting/action/settings; isolated database failure returns safe error |
| Settings | Provider enum/model validation; unavailable provider status; model selection; no secrets in response |
| Errors | 4xx for invalid inputs; 404 missing resources; conflict response for stale writes; safe 5xx without stack traces |

## AI provider matrix

| Case | Mock/unit expectation | Live check policy |
| --- | --- | --- |
| Groq available | Model discovery and structured response accepted | Execute only with supplied backend key; record model and actual result without logging the key |
| Missing/invalid Groq key | Clear configuration/auth error; no secret echoed | Missing configuration can be checked locally; do not consume quota for unnecessary invalid calls |
| Groq 429/quota | Clear retry/fallback message; no infinite retry | Simulated with controlled response, not forced against a live quota |
| Groq 5xx/network/timeout | Bounded failure; preserve meeting; expose available local fallback | Simulate deterministic failure |
| Ollama available | Tags/model discovery; API call/parse success | Check installed service and chosen model; execute actual inference if available |
| Ollama unreachable | Actionable status and no crash | Local availability check; mock failure also tested |
| Ollama model missing | Distinct model-not-installed status | Controlled response; do not delete an installed user model |
| Both unavailable | Meeting/project/history still usable; explicit demo option | Local settings/status check |
| Provider switch | Requested provider used and provenance retained | Verify selected provider from job/result |
| Fallback | Offered only for relevant failure and available model; visible explicit retry | Verify with mocked failures; never silently switch |
| Malformed output | Reject invalid JSON, missing fields, incorrect types, unknown keys, excessive lengths | Controlled responses |
| Grounding | Reject invented evidence; keep unknown owners/deadlines null; preserve source | Unit cases plus human inspection of any live result |
| Long transcript | Normalize and chunk without omission; bounded calls; combine valid results | Unit/integration with controlled output; avoid unnecessary quota use |
| Demo | Deterministic output, actual extractive source content, clear demo provenance | Browser tests use demo; reported separately from model inference |

## Security checks

- Parameterized queries with quote-heavy, Unicode and SQL-looking input.
- Transcript/model text is displayed as text, including HTML/script-like strings.
- Untrusted origins cannot perform cross-site mutations; expected request content type enforced.
- Loopback server binding and local-only deployment documentation.
- Secret exclusion from client bundle, source examples, API responses, error messages, logs and Git-tracked files.
- Audio uploads reject unsupported/mismatched media, invalid filenames, empty and excessive bodies, and compressed request bodies. Only the fixed Groq URL is called. No uploaded content is executed or persisted as a file. Plain-text import retains its independent limits.
- Dependency audit with available tooling; record remaining advisories instead of claiming none without evidence.
- Local single-user app has no login/session/cross-user test surface. Authentication/session-expiry/multi-tenant authorization cases are **not applicable to this scope**, not passed.

## UI and accessibility checks

- Desktop, tablet and narrow phone widths: no page-level horizontal overflow or overlapping controls.
- Every visible navigation target opens its intended screen; empty state and error routes remain usable.
- Forms have explicit labels and actionable errors. Buttons have accessible names. Icon controls expose names.
- Keyboard access, visible focus, focus placement and restoration for dialogs, and Escape behavior where applicable.
- Long titles/transcripts/summary text wrap; tables remain usable in narrow viewports.
- Loading/repeated-click protection; network error feedback and recovery.
- `prefers-reduced-motion` disables decorative motion.
- Inspect browser console for runtime errors and failed local assets.
- Automated browser assertions supplement inspection; they are not a complete WCAG audit or proof of screen-reader compatibility.

## Regression and reporting

The approved audio extension adds unit/API checks for speech model discovery, configuration/auth/rate/network/timeout failures, malformed/empty/long results, signature screening, size limits, idempotency/conflicts, single-job capacity, cancellation and expiry. Browser checks mock only speech transport, then verify edited transcript handoff and persistence with the real isolated database; include consent, existing-text replacement, unavailable service, failures, mobile overflow and axe scans. The separate synthetic-WAV live check must be explicitly labelled real speech recognition; its downstream demo summary must not be reported as model inference. It is not a speech-accuracy benchmark or coverage of every supported codec/language.

For each discovered defect, first identify the failing behavior, fix its cause, then rerun the relevant suite and build/type checks where affected. Preserve assertions rather than weakening them to pass. Record test commands, result counts, date, live versus mocked provider outcomes, and unexecuted tests in `docs/test-report.md`.
