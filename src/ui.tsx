import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronRight, LoaderCircle, Plus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Meeting } from '../shared/schema';

const ToastContext = createContext<(message: string) => void>(() => undefined);
export function Notifications({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((value: string) => {
    if (timeout.current) clearTimeout(timeout.current);
    setMessage(value);
    timeout.current = setTimeout(() => setMessage(''), 5000);
  }, []);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);
  return <ToastContext.Provider value={notify}>{children}<div role="status" aria-live="polite" className={`toast ${message ? 'toast-visible' : ''}`}>{message && <><CheckCircle2 size={18} /><span>{message}</span><button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => setMessage('')}><X size={16} /></button></>}</div></ToastContext.Provider>;
}
export const useNotify = () => useContext(ToastContext);

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}
export function Loading({ label = 'Loading your workspace…' }: { label?: string }) {
  return <div className="loading" role="status"><LoaderCircle size={22} className="spin" /><span>{label}</span></div>;
}
export function ErrorBanner({ message, onRetry }: { message: string | null | undefined; onRetry?: () => void }) {
  if (!message) return null;
  return <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{message}</span>{onRetry && <button type="button" className="text-button" onClick={onRetry}>Try again</button>}</div>;
}
export function EmptyState({ icon, title, description, action, compact = false }: { icon: ReactNode; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function StatusBadge({ status }: { status: Meeting['status'] }) {
  return <span className={`badge badge-${status}`}><span className="status-dot" />{status === 'final' ? 'Confirmed' : status === 'review' ? 'Needs review' : 'Transcript ready'}</span>;
}
export function formatDate(value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, options).format(date);
}
export function MeetingRows({ meetings }: { meetings: Meeting[] }) {
  return <div className="meeting-list">{meetings.map(meeting => <Link className="meeting-row" key={meeting.id} to={`/meetings/${meeting.id}`}>
    <div className="meeting-date"><strong>{formatDate(meeting.date, { day: '2-digit' })}</strong><span>{formatDate(meeting.date, { month: 'short' })}</span></div>
    <div className="meeting-row-main"><h3>{meeting.title}</h3><p><span>{meeting.projectName || 'Project'}</span><span className="dot-divider">·</span><span>{meeting.participants.length ? `${meeting.participants.length} participant${meeting.participants.length !== 1 ? 's' : ''}` : 'No participants added'}</span>{meeting.isDemo && <span className="sample-tag">Demo</span>}</p></div>
    <StatusBadge status={meeting.status} /><ChevronRight className="row-chevron" size={18} />
  </Link>)}</div>;
}
export function NewMeetingLink({ children = 'New meeting' }: { children?: ReactNode }) { return <Link to="/meetings/new" className="button primary"><Plus size={17} />{children}</Link>; }
export function InlineLink({ to, children }: { to: string; children: ReactNode }) { return <Link className="inline-link" to={to}>{children}<ArrowRight size={15} /></Link>; }
export function Field({ label, children, hint, required = false }: { label: string; children: (id: string) => ReactNode; hint?: string; required?: boolean }) {
  const id = useId();
  return <div className="field"><label htmlFor={id} data-required={required}>{label}</label>{children(id)}{hint && <p className="field-hint">{hint}</p>}</div>;
}

export function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    (dialog?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select') ?? dialog?.querySelector<HTMLElement>('button'))?.focus();
    return () => { dialog?.close(); previous.current?.focus(); };
  }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === ref.current && !busy) onClose(); }}><div className="dialog-inner"><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={20} /></button></div>{children}</div></dialog>;
}
export function SubmitButton({ busy, disabled = false, children, busyLabel = 'Saving…' }: { busy: boolean; disabled?: boolean; children: ReactNode; busyLabel?: string }) {
  return <button className="button primary" type="submit" disabled={busy || disabled}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? busyLabel : children}</button>;
}
export function prevent(event: FormEvent, callback: () => void) { event.preventDefault(); callback(); }
