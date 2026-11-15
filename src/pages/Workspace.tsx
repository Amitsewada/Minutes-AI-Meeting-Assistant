import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, CalendarDays, Check, CheckCheck, ChevronRight, FileText, FolderOpen, Layers3, MessageSquareText, Plus, Search, Sparkles, Upload, X } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ActionItem, Meeting, Project } from '../../shared/schema';
import { meetingInputSchema } from '../../shared/schema';
import { api, errorMessage, json, queryString, useDebounce, useResource } from '../api';
import { AudioTranscription } from '../AudioTranscription';
import { Dialog, EmptyState, ErrorBanner, Field, formatDate, InlineLink, Loading, MeetingRows, NewMeetingLink, PageHeading, SubmitButton, useNotify } from '../ui';

const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
export const exampleTranscript = `SAMPLE TRANSCRIPT — fictional example for exploring Minutes.
Maya: Today we need to agree on the onboarding changes for our next release.
Alex: The feedback is clear. New users are struggling with the first project setup.
Maya: We decided to replace the three-step setup with a single project form.
Alex: I will prepare the revised onboarding wireframes by Friday.
Sam: I will review the accessibility of the new form. We have not agreed on a deadline yet.
Maya: The release is blocked until we get the final copy from the content team.
Alex: Do we need to migrate the existing onboarding templates?
Maya: That question is still open. Let's confirm it with engineering before making a decision.`;

export function Dashboard() {
  const meetings = useResource<Meeting[]>('/meetings');
  const actions = useResource<ActionItem[]>('/actions');
  const projects = useResource<Project[]>('/projects');
  const list = meetings.data ?? [];
  const allActions = actions.data ?? [];
  const pending = allActions.filter(action => action.status !== 'done');
  const reviews = list.filter(meeting => meeting.status === 'review');
  const upcoming = list.filter(meeting => meeting.date > today()).sort((a, b) => a.date.localeCompare(b.date));
  const isEmpty = !meetings.loading && list.length === 0;
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  return <div className="page dashboard-page">
    <PageHeading eyebrow={date} title={isEmpty ? 'A clearer day starts here.' : 'Your conversations, connected.'} description={isEmpty ? 'A little less note-taking. A lot more moving forward.' : 'The decisions, details, and next steps that keep your work moving.'} actions={<NewMeetingLink />} />
    <ErrorBanner message={meetings.error || actions.error || projects.error} onRetry={() => { meetings.refresh(); actions.refresh(); projects.refresh(); }} />
    <section className="overview-hero" aria-label="Meeting workflow"><div className="hero-content"><span className="hero-eyebrow"><span />MEET YOUR SECOND SET OF EARS</span><h2>Stay in the conversation.<br /><span>We’ll keep the details.</span></h2><p>Turn your meeting transcript into a focused summary, clear decisions, and next steps you can actually follow.</p><div className="hero-actions"><Link to="/meetings/new" className="button primary">Capture a meeting<ArrowRight size={16} /></Link><Link to="/meetings/new?example=1" className="hero-example">Try an example<ArrowUpRight size={15} /></Link></div><div className="hero-fineprint"><Check size={13} />Your transcript. Your review. Your final word.</div></div><div className="hero-visual" aria-hidden="true"><div className="visual-orbit" /><div className="conversation-paper"><div className="paper-header"><span className="paper-icon"><AudioLines size={20} /></span><div><strong>A good conversation</strong><span>From discussion to direction</span></div></div><div className="waveform">{[12, 22, 17, 31, 42, 25, 52, 37, 58, 44, 28, 49, 34, 20, 39, 54, 31, 43, 24, 15, 29, 19, 11].map((height, i) => <span key={i} style={{ height }} />)}</div><div className="paper-line" /><div className="paper-outcome"><span className="outcome-check"><Check size={13} /></span><span>Decisions worth remembering</span></div><div className="paper-outcome"><span className="outcome-check"><Check size={13} /></span><span>Next steps with a clear owner</span></div><div className="paper-bottom"><span>READY FOR YOUR REVIEW</span><Sparkles size={14} /></div></div><span className="visual-caption">A little clarity goes a long way.</span></div></section>
    <section className="stats-strip" aria-label="Workspace statistics"><div><span className="stat-label"><MessageSquareText size={16} />Meetings captured</span><strong>{meetings.loading ? '—' : list.length}</strong><span>In your workspace</span></div><div><span className="stat-label"><FileText size={16} />Ready to review</span><strong>{meetings.loading ? '—' : reviews.length}</strong><span>{reviews.length ? <Link to="/meetings?status=review">Give them your final word<ArrowUpRight size={12} /></Link> : 'All caught up'}</span></div><div><span className="stat-label"><CheckCheck size={16} />Open action items</span><strong>{actions.loading ? '—' : pending.length}</strong><span>{allActions.length ? `${allActions.filter(action => action.status === 'done').length} completed` : 'Next steps live here'}</span></div><div><span className="stat-label"><FolderOpen size={16} />Active projects</span><strong>{projects.loading ? '—' : (projects.data ?? []).length}</strong><span>One place for the context</span></div></section>
    <div className="dashboard-columns"><section className="recent-section"><div className="section-heading"><div><h2>Recent meetings</h2><p>Pick up right where you left off.</p></div><InlineLink to="/meetings">View all</InlineLink></div>{meetings.loading ? <Loading label="Finding your meetings…" /> : list.length ? <MeetingRows meetings={list.slice(0, 5)} /> : <div className="first-meeting"><div className="empty-meeting-lines"><MessageSquareText size={25} strokeWidth={1.4} /><span /><span /></div><h3>Your next great idea belongs here.</h3><p>Add your first transcript and make room for what comes next.</p><Link className="text-button" to="/meetings/new">Create your first meeting<ArrowRight size={15} /></Link></div>}</section><aside className="next-steps"><div className="section-heading"><div><h2>Your next steps</h2><p>A little focus for your day.</p></div><span className="count-badge">{pending.length}</span></div>{actions.loading ? <Loading label="Loading actions…" /> : pending.length ? <div className="dashboard-tasks">{pending.slice(0, 4).map(action => <Link key={action.id} to="/actions" className="dashboard-task"><span className="task-outline" /><div><strong>{action.description}</strong><span>{action.owner || 'Unassigned'}{action.deadline ? ` · ${action.deadline}` : ''}</span></div><ArrowUpRight size={14} /></Link>)}<InlineLink to="/actions">All action items</InlineLink></div> : <div className="quiet-empty"><span className="quiet-icon"><CheckCheck size={24} strokeWidth={1.5} /></span><h3>A clean slate.</h3><p>Action items will appear here after you review and confirm a meeting.</p></div>}<div className="review-note"><span><Sparkles size={17} /></span><p><strong>AI drafts. You decide.</strong>Every summary stays a draft until you review and confirm it.</p></div></aside></div>
    {upcoming.length > 0 && <section className="upcoming-section"><div className="section-heading"><h2>Upcoming meetings</h2><CalendarDays size={18} /></div><MeetingRows meetings={upcoming.slice(0, 3)} /></section>}
  </div>;
}

export function MeetingsPage() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const debounced = useDebounce(query);
  const projectId = params.get('projectId') || '';
  const status = params.get('status') || '';
  const sort = params.get('sort') || 'newest';
  const projects = useResource<Project[]>('/projects');
  const search = queryString({ q: debounced, projectId, status, sort });
  const meetings = useResource<Meeting[]>(`/meetings?${search}`);
  const filter = (key: string, value: string) => setParams(current => { const next = new URLSearchParams(current); if(value) next.set(key, value); else next.delete(key); return next; });
  const activeFilter = query || projectId || status;
  return <div className="page"><PageHeading eyebrow="THE WORKSPACE LIBRARY" title="Every conversation, in context." description="A searchable home for your transcripts, decisions, and next steps." actions={<NewMeetingLink />} /><div className="filter-bar"><label className="search-field"><Search size={18} /><input aria-label="Search meetings" placeholder="Search meetings or transcripts…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={15} /></button>}</label><select aria-label="Filter by project" value={projectId} onChange={event => filter('projectId', event.target.value)}><option value="">All projects</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select aria-label="Filter by meeting status" value={status} onChange={event => filter('status', event.target.value)}><option value="">All statuses</option><option value="draft">Transcript ready</option><option value="review">Needs review</option><option value="final">Confirmed</option></select><select aria-label="Sort meetings" value={sort} onChange={event => filter('sort', event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div><ErrorBanner message={meetings.error || projects.error} onRetry={() => { meetings.refresh(); projects.refresh(); }} /><section className="list-surface"><div className="list-title"><span>{meetings.loading ? 'Loading meetings' : `${meetings.data?.length ?? 0} meeting${meetings.data?.length === 1 ? '' : 's'}`}</span><span>YOUR MEETING MEMORY</span></div>{meetings.loading ? <Loading /> : meetings.data?.length ? <MeetingRows meetings={meetings.data} /> : <EmptyState icon={<MessageSquareText size={27} strokeWidth={1.5} />} title={activeFilter ? 'No meetings match this view.' : 'The beginning of a clearer workspace.'} description={activeFilter ? 'Try a different search or clear your filters to see more conversations.' : 'Create a project, add a transcript, and turn your first meeting into something useful.'} action={activeFilter ? <button className="button secondary" onClick={() => { setQuery(''); setParams({}); }}>Clear filters</button> : <NewMeetingLink>Create your first meeting</NewMeetingLink>} />}</section></div>;
}

export function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    if (!name.trim()) { setError('Give this project a name.'); return; }
    setBusy(true); setError(null);
    try { const project = await api<Project>('/projects', json({ name: name.trim(), description: description.trim() })); onCreated(project); } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  return <Dialog title="A home for the bigger picture." onClose={onClose} busy={busy}><p className="dialog-description">Keep related meetings and action items together in a project.</p><form onSubmit={submit}><ErrorBanner message={error} /><Field label="Project name" required>{id => <input id={id} autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Product launch" />}</Field><Field label="Description" hint="Optional. A little context for future you.">{id => <textarea id={id} maxLength={1000} rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="What are you working toward?" />}</Field><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Create project</SubmitButton></div></form></Dialog>;
}

export function NewMeetingPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useResource<Project[]>('/projects');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today());
  const [projectId, setProjectId] = useState(params.get('projectId') ?? '');
  const [participants, setParticipants] = useState('');
  const [transcript, setTranscript] = useState('');
  const [showProject, setShowProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState('');
  const [source, setSource] = useState<'text' | 'audio'>('text');
  const [audioOpened, setAudioOpened] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const notify = useNotify();
  const loadExample = () => { setTitle('[Sample] Onboarding design review'); setParticipants('Maya, Alex, Sam'); setTranscript(exampleTranscript); setUploaded(''); };
  useEffect(() => { if (params.get('example') === '1') { setTitle('[Sample] Onboarding design review'); setParticipants('Maya, Alex, Sam'); setTranscript(exampleTranscript); } }, [params]);
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!file.name.toLowerCase().endsWith('.txt')) { setError('Choose a UTF-8 .txt transcript. To transcribe a recording, switch to Audio recording.'); return; }
    if (!file.size) { setError('This file is empty. Choose a transcript with some text.'); return; }
    if (file.size > 480000) { setError('This file is too large. Transcripts can contain up to 120,000 characters.'); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim() || text.includes('\u0000')) { setError('This file does not contain a readable text transcript.'); return; }
      if (text.length > 120000) { setError('This transcript exceeds 120,000 characters. Split it into smaller meetings first.'); return; }
      setTranscript(text); setUploaded(file.name); notify('Transcript imported. Check the details before saving.');
    } catch { setError('This file is not valid UTF-8 text. Save it as a UTF-8 .txt file and try again.'); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const input = { title, projectId, date, participants: participants.split(',').map(value => value.trim()).filter(Boolean), transcript };
    if (source === 'audio') { setError('Use the reviewed transcript or switch to Paste transcript before saving.'); return; }
    const parsed = meetingInputSchema.safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${String(issue.path[0])}: ${issue.message}`).join(' ')); return; }
    setError(null); setBusy(true);
    try { const meeting = await api<Meeting>('/meetings', { ...json(parsed.data), headers: { 'Idempotency-Key': requestId.current } }); notify('Meeting saved. Your transcript is ready for analysis.'); navigate(`/meetings/${meeting.id}`); } catch (error) { setError(errorMessage(error)); setBusy(false); }
  };
  return <div className="page new-meeting-page"><Link to="/meetings" className="back-link">Meetings<ChevronRight size={14} /><span>New meeting</span></Link><PageHeading eyebrow="START WITH THE CONVERSATION" title="Give your meeting a little clarity." description="Bring a transcript or a recording. We’ll help you find the decisions and the next steps." /><div className="creation-layout"><form onSubmit={submit} className="meeting-form"><section className="form-section"><div className="form-section-heading"><span>01</span><div><h2>The essentials</h2><p>A few details to help you find this conversation later.</p></div></div><Field label="Meeting title" required>{id => <input id={id} required maxLength={160} placeholder="e.g. Weekly product sync" value={title} onChange={event => setTitle(event.target.value)} />}</Field><div className="form-grid"><Field label="Project" required>{id => <div className="project-selector"><select id={id} required value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.data?.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select><button type="button" className="icon-button outlined" title="Create a project" aria-label="Create a project" onClick={() => setShowProject(true)}><Plus size={19} /></button></div>}</Field><Field label="Meeting date" required>{id => <input id={id} type="date" required value={date} onChange={event => setDate(event.target.value)} />}</Field></div>{projects.data?.length === 0 && <p className="inline-note">First things first: <button type="button" className="text-button" onClick={() => setShowProject(true)}>create a project</button> to keep your meetings organized.</p>}<ErrorBanner message={projects.error} onRetry={projects.refresh} /><Field label="Participants" hint="Optional. Separate names with commas.">{id => <input id={id} maxLength={10000} placeholder="e.g. Maya, Alex, Sam" value={participants} onChange={event => setParticipants(event.target.value)} />}</Field></section>
      <section className="form-section"><div className="form-section-heading"><span>02</span><div><h2>The conversation</h2><p>Paste text, import a transcript, or transcribe a recording.</p></div></div><div className="transcript-source" role="group" aria-label="Transcript source"><button type="button" aria-pressed={source === 'text'} onClick={() => setSource('text')}><FileText size={16} />Paste transcript</button><button type="button" aria-pressed={source === 'audio'} onClick={() => { setAudioOpened(true); setSource('audio'); }}><AudioLines size={16} />Audio recording</button></div>{audioOpened && <div hidden={source !== 'audio'}><AudioTranscription currentTranscript={transcript} onUse={text => { setTranscript(text); setUploaded(''); setSource('text'); notify('Reviewed transcript added. Save the meeting to keep it.'); }} /></div>}<div hidden={source !== 'text'}><div className="transcript-tools"><button type="button" className="button secondary small" onClick={() => fileInput.current?.click()}><Upload size={15} />Import .txt</button><button type="button" className="text-button" onClick={loadExample}>Load example transcript<ArrowUpRight size={14} /></button><input ref={fileInput} type="file" accept=".txt,text/plain" className="sr-only" aria-label="Upload a transcript" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div>{uploaded && <p className="imported-note"><FileText size={14} />{uploaded}<button type="button" aria-label="Clear imported transcript" className="icon-button" onClick={() => { setUploaded(''); setTranscript(''); }}><X size={14} /></button></p>}{transcript.startsWith('SAMPLE TRANSCRIPT') && <div className="info-banner">This is a fictional example transcript. The meeting title is marked [Sample] to keep it identifiable.</div>}<Field label="Meeting transcript" required>{id => <textarea id={id} className="transcript-input" required={source === 'text'} maxLength={120000} rows={13} value={transcript} onChange={event => setTranscript(event.target.value)} placeholder={'Maya: What should we focus on for the next release?\nAlex: Let’s start with the onboarding experience…'} />}</Field><div className="transcript-meta"><span>Speaker names help identify action owners.</span><span>{transcript.length.toLocaleString()} / 120,000</span></div></div></section><ErrorBanner message={error} /><div className="form-footer"><Link to="/meetings" className="button secondary">Cancel</Link><SubmitButton busy={busy} disabled={source === 'audio'} busyLabel="Saving meeting…">Save transcript</SubmitButton></div></form><aside className="creation-aside"><div className="aside-symbol"><Layers3 size={27} strokeWidth={1.3} /></div><h3>From words to<br />what comes next.</h3><ol className="workflow-steps"><li><span>1</span><div><strong>Add your transcript</strong><p>Paste text or transcribe a recording, then check the words before saving.</p></div></li><li><span>2</span><div><strong>Choose your AI</strong><p>Use Groq, a local Ollama model, or a clearly labeled demo.</p></div></li><li><span>3</span><div><strong>Review, then confirm</strong><p>Check the draft and its evidence. You always have the final say.</p></div></li></ol><div className="privacy-note"><ArrowDownToLine size={16} /><p>Records stay in your local database. Audio transcription sends your recording to Groq with your permission. Summary generation uses the provider you choose.</p></div></aside></div>{showProject && <ProjectDialog onClose={() => setShowProject(false)} onCreated={project => { setProjectId(project.id); projects.refresh(); setShowProject(false); notify('Project created.'); }} />}</div>;
}

export function ProjectsPage() {
  const projects = useResource<Project[]>('/projects');
  const meetings = useResource<Meeting[]>('/meetings');
  const actions = useResource<ActionItem[]>('/actions');
  const [creating, setCreating] = useState(false);
  const notify = useNotify();
  return <div className="page"><PageHeading eyebrow="KEEP THE BIGGER PICTURE CLOSE" title="A place for every project." description="Bring related conversations and commitments into one clear view." actions={<button className="button primary" onClick={() => setCreating(true)}><Plus size={17} />New project</button>} /><ErrorBanner message={projects.error || meetings.error || actions.error} onRetry={() => { projects.refresh(); meetings.refresh(); actions.refresh(); }} />{projects.loading ? <Loading /> : projects.data?.length ? <div className="project-list">{projects.data.map((project, index) => {
    const projectMeetings = meetings.data?.filter(meeting => meeting.projectId === project.id) ?? [];
    const projectActions = actions.data?.filter(action => action.projectId === project.id) ?? [];
    const done = projectActions.filter(action => action.status === 'done').length;
    return <article className="project-row" key={project.id}><div className={`project-symbol project-symbol-${index % 3}`}><FolderOpen size={22} strokeWidth={1.5} /></div><div className="project-info"><Link to={`/meetings?projectId=${project.id}`}><h2>{project.name}</h2></Link><p>{project.description || 'A home for related conversations and next steps.'}</p><div className="project-meta"><span>{projectMeetings.length} meetings</span><span>Created {formatDate(project.createdAt)}</span></div></div><div className="project-progress"><span>{done} of {projectActions.length} actions complete</span><progress aria-label={`${project.name} action completion`} max={projectActions.length || 1} value={done} /></div><Link to={`/meetings/new?projectId=${project.id}`} className="button secondary small"><Plus size={15} />Add meeting</Link><Link to={`/meetings?projectId=${project.id}`} className="icon-button" aria-label={`View ${project.name} meetings`}><ArrowUpRight size={20} /></Link></article>;
  })}</div> : <div className="list-surface"><EmptyState icon={<FolderOpen size={30} strokeWidth={1.5} />} title="Big ideas need a place to land." description="Create your first project to keep related meetings and their next steps together." action={<button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />Create a project</button>} /></div>}{creating && <ProjectDialog onClose={() => setCreating(false)} onCreated={() => { projects.refresh(); setCreating(false); notify('Project created.'); }} />}</div>;
}
