import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, LoaderCircle, Upload } from 'lucide-react';
import { api, ApiError, errorMessage, useResource } from './api';
import type { TranscriptionJob, TranscriptionStatus } from './contracts';
import { Dialog, ErrorBanner, Field } from './ui';

const formats = ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'flac'];

/** A temporary transcription is reviewed here before entering the normal meeting save flow. */
export function AudioTranscription({ currentTranscript, onUse }: {
  currentTranscript: string; onUse: (transcript: string) => void;
}) {
  const status = useResource<TranscriptionStatus>('/transcription-status');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [playbackError, setPlaybackError] = useState(false);
  const [consent, setConsent] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [replace, setReplace] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const uploadRequest = useRef<AbortController | null>(null);
  const activeJob = useRef<TranscriptionJob | null>(null);
  const run = useRef(0);
  const requestId = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const unacknowledgedRequest = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = uploading || job?.status === 'processing' || cancelling;

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => {
    run.current += 1;
    const pending = activeJob.current;
    const incomplete = Boolean(unacknowledgedRequest.current || uploadRequest.current || submitting.current || pending?.status === 'processing');
    uploadRequest.current?.abort();
    if (incomplete) void api(`/transcriptions/by-key/${requestId.current}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!busy && !(job?.status === 'completed' && draft.trim() && draft.trim() !== currentTranscript.trim())) return;
    const protectUnsaved = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectUnsaved);
    return () => window.removeEventListener('beforeunload', protectUnsaved);
  }, [busy, job?.status, draft, currentTranscript]);

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus !== 'processing') return;
    const controller = new AbortController();
    const started = Date.now();
    const pollRun = run.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<TranscriptionJob>(`/transcriptions/${jobId}`, { signal: controller.signal });
        if (controller.signal.aborted || run.current !== pollRun || activeJob.current?.id !== jobId) return;
        activeJob.current = result; setJob(result); setPollError(null);
        if (result.status === 'completed') setDraft(result.transcript!);
        else if (result.status === 'failed') setError(result.error || 'Transcription failed. Check the recording and retry explicitly.');
        else if (result.status === 'cancelled') setCancelled(true);
        else if (result.status === 'processing') {
          if (Date.now() - started > 330000) setPollError('This is taking longer than expected. Check the status or cancel; no new transcription will be started.');
          else timer = setTimeout(() => { void poll(); }, 1500);
        }
      } catch (error) {
        if (controller.signal.aborted || run.current !== pollRun) return;
        if (error instanceof ApiError && error.code === 'TRANSCRIPTION_NOT_FOUND') {
          const expired: TranscriptionJob = { ...activeJob.current!, status: 'failed', transcript: null, error: error.message, errorCode: error.code };
          activeJob.current = expired; setJob(expired); setPollError(null); setError(error.message);
        } else setPollError(`${errorMessage(error)} Check the status to resume watching this request. This will not submit the audio again.`);
      }
    };
    timer = setTimeout(() => { void poll(); }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [jobId, jobStatus, pollRevision]);

  const chooseFile = (selected: File | undefined) => {
    if (!selected || busy) return;
    setError(null); setPollError(null); setCancelled(false);
    const extension = selected.name.split('.').pop()?.toLowerCase();
    if (!extension || !formats.includes(extension)) { setError('Choose an MP3, WAV, M4A, MP4, WebM, OGG, or FLAC recording.'); return; }
    if (!selected.size) { setError('This recording is empty. Choose a file containing speech.'); return; }
    if (selected.size > (status.data?.maxBytes ?? 25000000)) { setError('This recording is too large. Choose a file no larger than 25 MB.'); return; }
    if (attempted && !activeJob.current) void api(`/transcriptions/by-key/${requestId.current}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    unacknowledgedRequest.current = false;
    run.current += 1; requestId.current = crypto.randomUUID(); activeJob.current = null;
    setFile(selected); setJob(null); setDraft(''); setConsent(false); setAttempted(false); setPlaybackError(false);
  };

  const start = async () => {
    if (!file || !consent || !status.data?.available || busy || submitting.current) return;
    submitting.current = true;
    unacknowledgedRequest.current = true;
    const token = ++run.current;
    const controller = new AbortController(); uploadRequest.current = controller;
    // A lost upload response reuses its key. An explicitly retried terminal job gets a new key.
    if (activeJob.current && activeJob.current.status !== 'processing') requestId.current = crypto.randomUUID();
    activeJob.current = null;
    setJob(null); setDraft(''); setError(null); setPollError(null); setCancelled(false); setAttempted(true); setUploading(true);
    try {
      const result = await api<TranscriptionJob>('/transcriptions', {
        method: 'POST', body: file, signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Filename': encodeURIComponent(file.name), 'Idempotency-Key': requestId.current },
      });
      if (run.current !== token || controller.signal.aborted) {
        if (result.status === 'processing') void api(`/transcriptions/${result.id}`, { method: 'DELETE' }).catch(() => undefined);
        return;
      }
      unacknowledgedRequest.current = false;
      activeJob.current = result; setJob(result);
      if (result.status === 'completed') setDraft(result.transcript!);
      if (result.status === 'failed') setError(result.error || 'Transcription failed. Check the recording and retry explicitly.');
      if (result.status === 'cancelled') setCancelled(true);
    } catch (error) {
      if (run.current === token && !controller.signal.aborted) {
        if (error instanceof ApiError && error.code === 'TRANSCRIPTION_CANCELLED') { requestId.current = crypto.randomUUID(); setCancelled(true); }
        setError(errorMessage(error));
      }
    } finally {
      if (run.current === token) { setUploading(false); submitting.current = false; uploadRequest.current = null; }
    }
  };

  const cancel = async () => {
    if (cancelling || (!uploading && activeJob.current?.status !== 'processing')) return;
    const token = ++run.current; const pending = activeJob.current;
    uploadRequest.current?.abort(); uploadRequest.current = null; submitting.current = false; setUploading(false);
    setCancelling(true); setError(null);
    try {
      // The key is known before upload starts, including when its POST response is lost.
      await api(`/transcriptions/by-key/${requestId.current}`, { method: 'DELETE' });
      if (run.current !== token) return;
      const result: TranscriptionJob | null = pending ? { ...pending, status: 'cancelled', transcript: null } : null;
      requestId.current = crypto.randomUUID();
      unacknowledgedRequest.current = false;
      activeJob.current = result; setJob(result); setDraft(''); setPollError(null); setCancelled(true);
    } catch (error) { if (run.current === token) { setError(`Could not confirm cancellation. ${errorMessage(error)}`); setPollRevision(value => value + 1); } }
    finally { if (run.current === token) setCancelling(false); }
  };

  const useDraft = () => {
    if (!draft.trim()) { setError('Add some transcript text before continuing.'); return; }
    if (currentTranscript.trim() && currentTranscript !== draft) setReplace(true);
    else onUse(draft.trim());
  };

  return <section className="audio-transcription" aria-label="Audio transcription">
    <div className="audio-intro"><AudioLines size={21} /><div><h3>Start with a recording.</h3><p>Generate a transcript, correct it, then use it to create your meeting record.</p></div></div>
    <div className="audio-service-status" role="status">
      {status.loading ? 'Checking Groq speech transcription…' : status.data?.available ? <>Groq speech is available <span>· {status.data.model}</span></> : status.data?.message || 'Speech transcription is unavailable.'}
      {!status.loading && !status.data?.available && <button type="button" className="text-button" onClick={status.refresh}>Check availability</button>}
    </div>
    <ErrorBanner message={status.error} onRetry={status.refresh} />
    <div className="audio-upload-row"><button type="button" className="button secondary small" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{file ? 'Change recording' : 'Choose recording'}</button><span>MP3, WAV, M4A, MP4, WebM, OGG, FLAC · up to 25 MB</span><input ref={input} type="file" className="sr-only" accept=".mp3,.wav,.m4a,.mp4,.webm,.ogg,.flac" aria-label="Upload an audio recording" disabled={busy} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
    {file && <div className="audio-preview"><div><strong>{file.name}</strong><span>{(file.size / 1000000).toFixed(2)} MB</span></div>{preview && <audio key={preview} controls preload="metadata" src={preview} aria-label="Recording playback" onError={() => setPlaybackError(true)} />}{playbackError && <p>Your browser cannot preview this format. You can still submit a supported recording for transcription.</p>}</div>}
    <p className="audio-privacy">Transcription sends this recording to Groq, even when you choose Ollama for summaries. Free-tier account limits apply. Audio is processed temporarily and is not saved in the meeting database.</p>
    <label className="checkbox-label audio-consent"><input type="checkbox" checked={consent} disabled={busy || !file} onChange={event => setConsent(event.target.checked)} /><span>I have permission to share this recording with Groq for transcription.</span></label>
    <ErrorBanner message={error} />
    {pollError && <ErrorBanner message={pollError} onRetry={() => { setPollError(null); setPollRevision(value => value + 1); }} />}
    {busy ? <div className="audio-processing"><span role="status"><LoaderCircle size={16} className="spin" />{uploading ? 'Uploading recording…' : cancelling ? 'Cancelling transcription…' : 'Transcribing with Groq. This may take a few minutes…'}</span><button type="button" className="button secondary small" disabled={cancelling} onClick={() => { void cancel(); }}>Cancel transcription</button></div> : job?.status !== 'completed' && <button type="button" className="button primary" disabled={!file || !consent || !status.data?.available || status.loading} onClick={() => { void start(); }}><AudioLines size={16} />{attempted ? 'Retry transcription' : 'Generate transcript'}</button>}
    {cancelled && <p className="audio-status-note" role="status">Transcription cancelled. No transcript was added to your meeting. A request already received by Groq may still count toward usage.</p>}
    {job?.status === 'completed' && <div className="audio-review"><div className="audio-review-heading"><Check size={17} /><strong>Transcript ready for your review</strong><span>Groq · {job.model}</span></div><p>Check names, numbers, and wording against the recording. Speaker labels are not identified automatically. This text has not been saved yet.</p><Field label="Generated transcript" hint="Correct the text before using it. Only the reviewed text is added to your meeting.">{id => <textarea id={id} value={draft} onChange={event => setDraft(event.target.value)} maxLength={120000} rows={10} className="transcript-input" />}</Field><div className="audio-review-footer"><span>{draft.length.toLocaleString()} / 120,000 characters</span><button type="button" className="button primary" disabled={!draft.trim()} onClick={useDraft}><Check size={16} />Use reviewed transcript</button></div></div>}
    {replace && <Dialog title="Replace the existing transcript?" onClose={() => setReplace(false)}><p className="dialog-description">This meeting already has transcript text. Replacing it will use the reviewed audio transcript instead.</p><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setReplace(false)}>Keep existing transcript</button><button type="button" className="button primary" onClick={() => { setReplace(false); onUse(draft.trim()); }}>Replace transcript</button></div></Dialog>}
  </section>;
}
