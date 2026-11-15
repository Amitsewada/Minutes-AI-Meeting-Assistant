# Audio upload and transcription

This extension was approved on 18 October 2026 after the initial PPT implementation. It addresses meetings that have a recording but no transcript. It does not reconstruct meetings that were never recorded, join meeting platforms, or capture a microphone.

## Use it

1. Open **New meeting** and enter the title, project, date, and participants if known.
2. Under the conversation input, choose **Audio recording**.
3. Select an MP3, WAV, M4A, MP4, WebM, OGG or FLAC recording no larger than **25,000,000 bytes (25 MB)**. Playback depends on the browser's codec support; a valid file can still be transcribed if the browser cannot play it.
4. Check the permission box only when you have permission to share this recording with Groq. The audio leaves your computer for this step even when you intend to summarize with Ollama.
5. Choose **Generate transcript**. The page shows processing until the speech service returns a result or a recoverable error. **Cancel transcription** stops local processing and asks the provider request to abort; it cannot undo a request already processed by Groq or refund quota.
6. Listen to the recording and correct the **Generated transcript**. Verify names, numbers, dates, negations and who committed to each action. Speech recognition does not supply reliable speaker identity here.
7. Choose **Use reviewed transcript**. Existing transcript text requires explicit replacement confirmation. Then choose **Save transcript** to save the meeting in the database.
8. On the saved meeting, choose Groq, Ollama, or labelled demo summarization. Review and confirm the resulting meeting record as before.

Neither generation nor “Use reviewed transcript” saves a meeting automatically. Save the meeting before leaving the form. Unsaved transcript edits are held in the browser and may be lost on refresh/navigation. The speech result is not a second archival copy of the recording.

## Backend configuration

The existing `GROQ_API_KEY` is used only on the backend. Never put the key in a browser form or frontend environment variable. No new paid subscription is required by the app; actual speech access and quotas depend on the account.

```dotenv
GROQ_TRANSCRIPTION_MODEL=
TRANSCRIPTION_TIMEOUT_MS=120000
```

An empty speech model setting discovers an active Whisper model in the account's Groq model catalog, preferring a Turbo variant when available. An explicitly configured speech model must be returned by that catalog. This is independent from `GROQ_MODEL`, which controls text analysis. Availability can change, and catalog access does not guarantee sufficient inference quota. Restart the backend after environment changes. If speech is unavailable, **Check availability** in the audio panel refreshes its status without sending a recording.

The official [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text) documents the audio endpoint, supported media and current free-tier file size. [Groq rate limits](https://console.groq.com/docs/rate-limits) apply. This application deliberately supports the listed seven common extensions and a fixed 25 MB maximum; it does not assume unlimited free usage or silently retry failed inference.

## Processing and privacy

- The browser sends the selected file as binary to the local backend. The backend screens the size, filename, extension and container signature before calling the fixed HTTPS Groq endpoint. It does not accept arbitrary remote recording URLs.
- Raw audio is held in bounded memory and is not written to the application's disk storage. Original filenames are replaced with a neutral filename before forwarding to Groq. This application-side policy does not describe Groq's service-side retention; consult [Groq's data documentation](https://console.groq.com/docs/your-data).
- One recording may upload/transcribe at a time. Up to ten temporary job results are retained for up to thirty minutes, with expired entries cleaned on subsequent requests. Restarting the backend loses those temporary results. The reviewed transcript becomes durable only through the normal meeting-save endpoint.
- A request key prevents repeated uploads/retries from starting the same speech job twice while its job is retained. A deliberate retry of a known failed job uses a new key and can consume quota. Once a temporary job expires or is evicted, uploading again starts new work.
- Cancellation uses that request key even when the upload response has not arrived, so it can stop work across the upload-to-job transition. Up to 100 cancellation markers are kept for thirty minutes to reject late uploads of cancelled requests. Aborting a cloud request is best effort and cannot reverse usage already incurred by Groq.
- Provider requests have a bounded timeout; malformed, empty and overlong transcripts are rejected. The app never fabricates text to replace a failed transcription. Speech-recognition errors that look like valid text can still pass structural checks, so human review remains necessary.
- Choosing Ollama or demo for summaries does not provide offline transcription. Those providers continue to work with pasted/imported transcripts when Groq speech is unavailable.

## Failure recovery

| Message / situation | What to do |
| --- | --- |
| Speech is not configured | Set the backend key; restart and check the connection. Pasting/importing text still works. |
| Model missing | Set an available speech model or leave `GROQ_TRANSCRIPTION_MODEL` blank, then restart. |
| Empty, wrong type or mismatched content | Export a genuine supported recording. Renaming another file to `.wav` will not fix it. |
| File exceeds 25 MB | Export/compress/split it in an audio editor. Large-audio chunking is not implemented here. |
| No speech, decoding error or empty output | Verify the recording contains clear audible speech and try WAV or MP3. |
| Quota/rate limit | Wait for your account's limit to reset, then explicitly retry; use a text transcript in the meantime. |
| Network timeout | Check the connection and try a shorter recording. The app does not retry inference automatically. |
| Temporary result expired / server restarted | Upload the original recording again. Previously saved meetings remain in the database. |

## Verification

Ordinary automated tests use controlled speech responses and an isolated database. A separate live script sends a fictional Windows-generated recording to the actual Groq API; it never records people or uses normal workspace data. Run these commands from the project folder in PowerShell:

```powershell
powershell.exe -NoProfile -File scripts\make-test-audio.ps1
npm.cmd run test:transcription:live
```

The first command requires an installed English Windows text-to-speech voice. The live check verifies expected words, saves/reloads the real transcript in isolated PostgreSQL, and uses **deterministic demo analysis** for the subsequent summary/confirmation check. Speech inference and demo summarization are reported separately. See [test-report.md](test-report.md) for actual outcomes and limits.
