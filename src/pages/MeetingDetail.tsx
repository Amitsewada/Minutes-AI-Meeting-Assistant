import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Cpu, Download, FileText, GitBranch, ListChecks, LoaderCircle, MessageSquareText, Pencil, Plus, Quote, RefreshCw, ShieldCheck, Sparkles, Trash2, Users, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Job, Meeting, MeetingRecord, Provider, ProviderStatus, Settings } from '../../shared/schema';
import { meetingInputSchema, recordSchema } from '../../shared/schema';
import { ApiError, api, errorMessage, json, useResource } from '../api';
import { Dialog, ErrorBanner, Field, formatDate, Loading, StatusBadge, SubmitButton, useNotify } from '../ui';

interface ProviderResponse { providers: ProviderStatus[]; defaultProvider: Provider; }
type EvidenceKey = 'decisions' | 'blockers' | 'questions';
function savedJob(meetingId: string | undefined) {
  try { return meetingId ? sessionStorage.getItem(`minutes-job-${meetingId}`) : null; } catch { return null; }
}
function rememberJob(meetingId: string, jobId: string | null) {
  try { if (jobId) sessionStorage.setItem(`minutes-job-${meetingId}`, jobId); else sessionStorage.removeItem(`minutes-job-${meetingId}`); } catch { /* Processing still works if browser storage is unavailable. */ }
}
const evidenceLabels: Record<EvidenceKey, { title: string; singular: string; empty: string }> = {
  decisions: { title: 'Key decisions', singular: 'decision', empty: 'No explicit decisions were identified.' },
  blockers: { title: 'Blockers', singular: 'blocker', empty: 'No explicit blockers were identified.' },
  questions: { title: 'Open questions', singular: 'question', empty: 'No unresolved questions were identified.' },
};
function Evidence({ text }: { text: string }) { return <details className="evidence"><summary><Quote size={12} />Source evidence<ChevronDown size={12} /></summary><blockquote>{text || 'No evidence provided. Add the exact supporting words from the transcript.'}</blockquote></details>; }

function SourceEditor({ meeting, onClose, onSaved }: { meeting: Meeting; onClose: () => void; onSaved: (meeting: Meeting) => void }) {
  const [title, setTitle] = useState(meeting.title);
  const [date, setDate] = useState(meeting.date);
  const [participants, setParticipants] = useState(meeting.participants.join(', '));
  const [transcript, setTranscript] = useState(meeting.transcript);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const parsed = meetingInputSchema.safeParse({ title, date, participants: participants.split(',').map(value => value.trim()).filter(Boolean), transcript, projectId: meeting.projectId });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${String(issue.path[0])}: ${issue.message}`).join(' ')); return; }
    setBusy(true); setError(null);
    try { onSaved(await api<Meeting>(`/meetings/${meeting.id}`, json({ version: meeting.version, title: parsed.data.title, date: parsed.data.date, participants: parsed.data.participants, transcript: parsed.data.transcript }, 'PATCH'))); } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  return <Dialog title="Edit meeting source" onClose={onClose} busy={busy}><p className="dialog-description">Changing the transcript resets the AI draft. Generate a new draft after saving your changes.</p><form onSubmit={save}><ErrorBanner message={error} /><Field label="Meeting title" required>{id => <input id={id} required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} />}</Field><Field label="Meeting date" required>{id => <input id={id} type="date" required value={date} onChange={event => setDate(event.target.value)} />}</Field><Field label="Participants">{id => <input id={id} value={participants} onChange={event => setParticipants(event.target.value)} />}</Field><Field label="Original transcript" required>{id => <textarea id={id} required maxLength={120000} rows={10} value={transcript} onChange={event => setTranscript(event.target.value)} />}</Field><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Save changes</SubmitButton></div></form></Dialog>;
}

export function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const meeting = useResource<Meeting>(id ? `/meetings/${id}` : null);
  const providers = useResource<ProviderResponse>('/providers');
  const settings = useResource<Settings>('/settings');
  const [provider, setProvider] = useState<Provider>('groq');
  const [model, setModel] = useState('');
  const initialized = useRef(false);
  const [record, setRecord] = useState<MeetingRecord | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => savedJob(id));
  const [job, setJob] = useState<Job | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const notify = useNotify();
  const current = meeting.data;
  const selected = providers.data?.providers.find(item => item.provider === provider);
  const isFinal = current?.status === 'final';
  const working = busy || Boolean(jobId);
  const ready = provider === 'demo' || Boolean(model && selected?.models.includes(model));
  const savedRecord = JSON.stringify(current?.record ?? null);
  const hasUnsavedEdits = !isFinal && record !== null && JSON.stringify(record) !== savedRecord;

  useEffect(() => {
    if (!initialized.current && providers.data && settings.data) {
      const value = settings.data.provider || providers.data.defaultProvider;
      setProvider(value);
      const status = providers.data.providers.find(item => item.provider === value);
      setModel(status?.selectedModel || status?.models[0] || '');
      initialized.current = true;
    }
  }, [providers.data, settings.data]);
  // Metadata-only changes must not overwrite an in-progress human review.
  useEffect(() => { setRecord(JSON.parse(savedRecord)); setConfirmed(false); }, [savedRecord]);
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedEdits]);
  useEffect(() => {
    if (!jobId || !id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>(`/jobs/${jobId}`);
        if (stopped) return;
        setJob(next); setPollError(null);
        if (next.status === 'completed' || next.status === 'failed') {
          rememberJob(id, null);
          setJobId(null);
          if (next.status === 'completed') { meeting.refresh(); notify('Draft ready. Review it against the original transcript.'); }
        } else timer = setTimeout(() => { void poll(); }, 1200);
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 404) {
          rememberJob(id, null); setJobId(null); setJob(null);
          setError('The previous analysis job no longer exists. Your saved transcript is safe; generate a new draft.');
          meeting.refresh();
        } else setPollError(`${errorMessage(error)} Your processing job may still be running.`);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobId, id, pollRevision, meeting.refresh, notify]);

  const chooseProvider = (value: Provider) => {
    setProvider(value);
    const status = providers.data?.providers.find(item => item.provider === value);
    setModel(status?.selectedModel || status?.models[0] || '');
    setError(null);
  };
  const analyze = async (chosen = provider) => {
    if (!current || working) return;
    setBusy(true); setError(null); setJob(null);
    const chosenStatus = providers.data?.providers.find(item => item.provider === chosen);
    const chosenModel = chosen === provider ? model : chosenStatus?.selectedModel || chosenStatus?.models[0] || '';
    try {
      const next = await api<Job>(`/meetings/${current.id}/analyze`, json({ provider: chosen, ...(chosenModel && chosen !== 'demo' ? { model: chosenModel } : {}) }));
      setJob(next); setJobId(next.id); rememberJob(current.id, next.id);
      setConfirmed(false);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  };
  const finalize = async (event: FormEvent) => {
    event.preventDefault(); if (!current || !record || !confirmed || working) return;
    const parsed = recordSchema.safeParse(record);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join(' ')}: ${issue.message}`).join(' ')); return; }
    setBusy(true); setError(null);
    try { const value = await api<Meeting>(`/meetings/${current.id}/finalize`, json({ version: current.version, record: parsed.data })); meeting.setData(value); notify('Meeting confirmed. Action items are ready to follow through.'); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!current || busy) return;
    setBusy(true); setError(null);
    try { await api(`/meetings/${current.id}?version=${current.version}`, { method: 'DELETE' }); notify('Meeting and its action items deleted.'); navigate('/meetings'); } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  const editEvidence = (key: EvidenceKey, index: number, field: 'text' | 'evidence', value: string) => {
    setConfirmed(false);
    setRecord(current => current && ({ ...current, [key]: current[key].map((entry, i) => i === index ? { ...entry, [field]: value } : entry) }));
  };
  const editAction = (index: number, field: keyof MeetingRecord['actionItems'][number], value: string | null) => {
    setConfirmed(false);
    setRecord(current => current && ({ ...current, actionItems: current.actionItems.map((entry, i) => i === index ? { ...entry, [field]: value } : entry) }));
  };
  const download = () => {
    if (!current?.record) return;
    const value = current.record;
    const content = `# ${current.title}\n\n${current.date} · ${current.projectName || 'Meeting'}\n${current.isDemo ? '\nDEMO OUTPUT — generated by the deterministic development provider.\n' : ''}\n## Summary\n${value.summary}\n\n## Decisions\n${value.decisions.map(item => `- ${item.text}\n  Evidence: ${item.evidence}`).join('\n')}\n\n## Action items\n${value.actionItems.map(item => `- ${item.description} | Owner: ${item.owner || 'Unknown'} | Deadline: ${item.deadline || 'Unknown'} | Priority: ${item.priority}\n  Evidence: ${item.evidence}`).join('\n')}\n\n## Blockers\n${value.blockers.map(item => `- ${item.text}`).join('\n')}\n\n## Open questions\n${value.questions.map(item => `- ${item.text}`).join('\n')}\n\n## Original transcript\n${current.transcript}\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${current.title.replace(/[^\p{L}\p{N}\-_ ]/gu, '').slice(0, 80) || 'meeting'}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Meeting exported as Markdown.');
  };

  if (meeting.loading && !current) return <div className="page"><Loading label="Opening your meeting…" /></div>;
  if (!current) return <div className="page"><Link to="/meetings" className="back-link"><ArrowLeft size={15} />Back to meetings</Link><ErrorBanner message={meeting.error || 'This meeting could not be found.'} onRetry={meeting.refresh} /></div>;
  const renderEvidence = (key: EvidenceKey) => {
    const label = evidenceLabels[key];
    const Icon = key === 'decisions' ? GitBranch : key === 'blockers' ? ShieldCheck : CircleHelp;
    return <section className="record-section" key={key}><div className="record-section-heading"><h2><Icon size={18} />{label.title}<span className="count-badge">{record?.[key].length ?? 0}</span></h2>{!isFinal && <button type="button" className="text-button" disabled={working} onClick={() => { setConfirmed(false); setRecord(current => current && ({ ...current, [key]: [...current[key], { text: '', evidence: '' }] })); }}><Plus size={14} />Add {label.singular}</button>}</div>{!record?.[key].length && <p className="record-empty">{label.empty}</p>}{record?.[key].map((item, index) => <div className="evidence-item" key={index}>{isFinal ? <><p>{item.text}</p><Evidence text={item.evidence} /></> : <><div className="editable-row"><textarea aria-label={`${label.singular} ${index + 1}`} required rows={2} maxLength={2000} value={item.text} onChange={event => editEvidence(key, index, 'text', event.target.value)} /><button type="button" className="icon-button danger-icon" aria-label={`Remove ${label.singular} ${index + 1}`} disabled={working} onClick={() => { setConfirmed(false); setRecord(current => current && ({ ...current, [key]: current[key].filter((_, i) => index !== i) })); }}><X size={16} /></button></div><details className="evidence"><summary><Quote size={12} />Source evidence<ChevronDown size={12} /></summary><textarea aria-label={`Evidence for ${label.singular} ${index + 1}`} required rows={2} maxLength={3000} value={item.evidence} onChange={event => editEvidence(key, index, 'evidence', event.target.value)} /></details></>}</div>)}</section>;
  };
  return <div className="page meeting-detail"><div className="detail-breadcrumb"><Link to="/meetings">Meetings</Link><ChevronRight size={14} /><Link to={`/meetings?projectId=${current.projectId}`}>{current.projectName || 'Project'}</Link><ChevronRight size={14} /><span>Meeting record</span></div><header className="detail-header"><div><div className="detail-badges"><StatusBadge status={current.status} />{current.isDemo && <span className="badge badge-demo">Demo output</span>}</div><h1>{current.title}</h1><div className="detail-meta"><span>{formatDate(current.date)}</span><span className="dot-divider">·</span><span><Users size={14} />{current.participants.length ? current.participants.join(', ') : 'Participants not specified'}</span></div></div><div className="detail-actions">{isFinal && <button className="button secondary small" onClick={download}><Download size={15} />Export</button>}<button className="icon-button outlined danger-icon" aria-label="Delete meeting" disabled={working} onClick={() => { setError(null); setDeleteOpen(true); }}><Trash2 size={17} /></button></div></header><ErrorBanner message={meeting.error} onRetry={meeting.refresh} />
    {!isFinal && <section className="analysis-panel"><div className="analysis-title"><span className="analysis-icon"><Sparkles size={19} /></span><div><h2>{record ? 'A fresh perspective, if you need it.' : 'Find the signal in the conversation.'}</h2><p>{record ? 'Generating again replaces the current draft, including unsaved edits.' : 'Choose a provider to turn this transcript into a reviewable draft.'}</p></div></div><div className="analysis-controls"><div><label htmlFor="analysis-provider">AI provider</label><select id="analysis-provider" disabled={working} value={provider} onChange={event => chooseProvider(event.target.value as Provider)}><option value="groq">Groq · Cloud</option><option value="ollama">Ollama · Local</option><option value="demo">Demo · No model</option></select></div>{provider !== 'demo' && <div className="model-choice"><label htmlFor="analysis-model">Model</label><select id="analysis-model" value={model} disabled={working || !selected?.models.length} onChange={event => setModel(event.target.value)}><option value="">Choose a model</option>{selected?.models.map(name => <option key={name} value={name}>{name}</option>)}</select></div>}<button className="button primary" disabled={working || !ready || providers.loading} onClick={() => { void analyze(); }}>{working ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{working ? 'Processing…' : record ? 'Regenerate draft' : 'Generate draft'}</button></div><div className={`provider-context ${provider === 'demo' ? 'demo-context' : ''}`}><span className={`connection-dot ${ready ? 'connected' : ''}`} />{provider === 'demo' ? 'Demo mode uses deterministic rules, not an AI model. Results are labeled for development and testing.' : providers.loading ? 'Checking provider availability…' : !selected?.available ? selected?.message || 'Provider unavailable. Check your backend configuration.' : provider === 'groq' ? 'Your transcript will be sent to Groq. Free-tier rate and quota limits apply.' : 'Analysis runs through your local Ollama server and uses your computer’s resources.'}<Link to="/settings">Provider settings<ArrowRight size={12} /></Link></div><ErrorBanner message={providers.error || settings.error} onRetry={() => { providers.refresh(); settings.refresh(); }} />
      {jobId && <div className="job-progress" role="status" aria-live="polite"><div><span>{pollError ? 'Status check interrupted' : job?.status === 'queued' ? 'Your analysis is queued…' : 'Reading the transcript and preparing your draft…'}</span><strong>{Math.round(job?.progress || 0)}%</strong></div><progress max={100} value={job?.progress || 0} aria-label="Analysis progress" /><p>You can leave this page. Processing continues on the backend.</p></div>}<ErrorBanner message={pollError} onRetry={() => setPollRevision(value => value + 1)} />{job?.status === 'failed' && <div className="analysis-failure"><ErrorBanner message={job.error || 'Analysis failed. Your original transcript is safe.'} /><div className="failure-actions"><button className="button secondary small" disabled={working || !ready} onClick={() => { void analyze(); }}><RefreshCw size={14} />Retry {provider === 'groq' ? 'Groq' : provider === 'ollama' ? 'Ollama' : 'demo'}</button>{job.fallbackAvailable && <button className="button secondary small" disabled={working} onClick={() => { chooseProvider('ollama'); void analyze('ollama'); }}><Cpu size={15} />Try with Ollama instead</button>}<span>Providers never switch automatically.</span></div></div>}</section>}
    {current.warnings.length > 0 && <div className="review-warnings" role="note"><ShieldCheck size={18} /><div><strong>Keep these notes in mind</strong><ul>{current.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></div>}
    {isFinal && <div className="confirmed-banner"><CheckCircle2 size={20} /><div><strong>Reviewed and confirmed.</strong><span>Your final record is saved. Follow through on the action items in your workspace.</span></div><Link to="/actions" className="text-button">View action items<ArrowRight size={15} /></Link></div>}
    <div className="detail-columns"><div className="record-main">{record ? <form onSubmit={finalize} className="record-form"><div className="record-topline"><span className="eyebrow">{isFinal ? 'THE MEETING RECORD' : 'YOUR DRAFT · READY FOR A HUMAN EYE'}</span><span>{current.provider === 'demo' ? 'Deterministic demo' : current.provider === 'groq' ? 'Groq' : 'Ollama'}{current.model ? ` / ${current.model}` : ''}</span></div><section className="record-section summary-section"><div className="record-section-heading"><h2><MessageSquareText size={19} />The short version</h2>{!isFinal && <span className="editable-label"><Pencil size={12} />Editable draft</span>}</div>{isFinal ? <p className="final-summary">{record.summary}</p> : <><label className="sr-only" htmlFor="meeting-summary">Meeting summary</label><textarea id="meeting-summary" required maxLength={8000} className="summary-editor" rows={5} value={record.summary} onChange={event => { setRecord({ ...record, summary: event.target.value }); setConfirmed(false); }} /></>}</section>{renderEvidence('decisions')}<section className="record-section"><div className="record-section-heading"><h2><ListChecks size={19} />Action items<span className="count-badge">{record.actionItems.length}</span></h2>{!isFinal && <button className="text-button" type="button" disabled={working} onClick={() => { setConfirmed(false); setRecord({ ...record, actionItems: [...record.actionItems, { description: '', owner: null, deadline: null, priority: 'medium', evidence: '' }] }); }}><Plus size={14} />Add action item</button>}</div>{!record.actionItems.length && <p className="record-empty">No explicit commitments were identified. Add an action only if the transcript supports it.</p>}{record.actionItems.map((action, index) => <div className="draft-action" key={index}><span className="action-number">{String(index + 1).padStart(2, '0')}</span><div className="action-content">{isFinal ? <><h3>{action.description}</h3><div className="action-attributes"><span>{action.owner || 'Owner unknown'}</span><span>{action.deadline || 'Deadline unknown'}</span><span className={`priority priority-${action.priority}`}>{action.priority}</span></div><Evidence text={action.evidence} /></> : <><div className="editable-row"><textarea aria-label={`Action item ${index + 1}`} required maxLength={2000} rows={2} value={action.description} onChange={event => editAction(index, 'description', event.target.value)} /><button className="icon-button danger-icon" type="button" aria-label={`Remove action item ${index + 1}`} disabled={working} onClick={() => { setConfirmed(false); setRecord({ ...record, actionItems: record.actionItems.filter((_, i) => index !== i) }); }}><X size={16} /></button></div><div className="action-edit-grid"><Field label={`Owner ${index + 1}`}>{id => <input id={id} placeholder="Unknown" maxLength={200} value={action.owner || ''} onChange={event => editAction(index, 'owner', event.target.value || null)} />}</Field><Field label={`Deadline ${index + 1}`}>{id => <input id={id} placeholder="Unknown" maxLength={100} value={action.deadline || ''} onChange={event => editAction(index, 'deadline', event.target.value || null)} />}</Field><Field label={`Priority ${index + 1}`}>{id => <select id={id} value={action.priority} onChange={event => editAction(index, 'priority', event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>}</Field></div><details className="evidence"><summary><Quote size={12} />Source evidence<ChevronDown size={12} /></summary><textarea aria-label={`Evidence for action item ${index + 1}`} required maxLength={3000} rows={2} value={action.evidence} onChange={event => editAction(index, 'evidence', event.target.value)} /></details></>}</div></div>)}</section>{renderEvidence('blockers')}{renderEvidence('questions')}<ErrorBanner message={!deleteOpen ? error : null} />{!isFinal && <section className="confirmation-panel"><div><ShieldCheck size={23} /><div><h3>Your review makes it reliable.</h3><p>Compare the draft with the transcript. Keep owners and deadlines unknown unless the source supports them.</p></div></div><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I have reviewed this draft against the original transcript.</span></label><button className="button primary" type="submit" disabled={!confirmed || working}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? 'Saving…' : 'Confirm meeting record'}</button><p className="save-note">Confirming saves the final record and creates its action items. Draft edits are local until you confirm.</p></section>}</form> : <div className="awaiting-draft"><span className="awaiting-icon"><FileText size={35} strokeWidth={1.3} /></span><span className="eyebrow">A LITTLE SPACE FOR CLARITY</span><h2>The important parts,<br />all in one place.</h2><p>Generate a draft to see your summary, key decisions, action items, and open questions here.</p><div className="awaiting-tags"><span><Check size={12} />Source-backed evidence</span><span><Pencil size={12} />Fully editable</span></div><ErrorBanner message={error} /></div>}</div><aside className="source-panel"><div className="source-heading"><div><FileText size={18} /><h2>Original transcript</h2></div>{!isFinal && <button className="icon-button" aria-label="Edit meeting source" disabled={working} onClick={() => setSourceOpen(true)}><Pencil size={15} /></button>}</div><span className="source-caption">THE SOURCE OF TRUTH · {current.transcript.length.toLocaleString()} CHARACTERS</span><div className="transcript-text" tabIndex={0} aria-label="Original meeting transcript">{current.transcript}</div><div className="source-footnote"><Quote size={14} /><span>Always check generated details against these original words.</span></div></aside></div>
    {deleteOpen && <Dialog title="Delete this meeting?" onClose={() => setDeleteOpen(false)} busy={busy}><p className="dialog-description">“{current.title}” and its associated action items will be permanently deleted. This cannot be undone.</p><ErrorBanner message={error} /><div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>Keep meeting</button><button className="button danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}Delete permanently</button></div></Dialog>}
    {sourceOpen && <SourceEditor meeting={current} onClose={() => setSourceOpen(false)} onSaved={value => { meeting.setData(value); setSourceOpen(false); notify('Meeting source updated.'); }} />}
  </div>;
}
