import { useEffect, useState } from 'react';
import { ArrowUpRight, AudioLines, CheckCheck, ChevronRight, CircleHelp, FolderOpen, LayoutDashboard, Menu, MessageSquareText, Settings2, X } from 'lucide-react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Dashboard, MeetingsPage, NewMeetingPage, ProjectsPage } from './pages/Workspace';
import { MeetingDetail } from './pages/MeetingDetail';
import { ActionsPage, SettingsPage } from './pages/Management';
import { Notifications } from './ui';

const navigation = [{ to: '/', icon: LayoutDashboard, label: 'Overview', end: true }, { to: '/meetings', icon: MessageSquareText, label: 'Meetings' }, { to: '/actions', icon: CheckCheck, label: 'Action items' }, { to: '/projects', icon: FolderOpen, label: 'Projects' }];

function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const section = location.pathname.startsWith('/meetings') ? 'Meetings' : location.pathname.startsWith('/actions') ? 'Action items' : location.pathname.startsWith('/projects') ? 'Projects' : location.pathname.startsWith('/settings') ? 'Settings' : 'Overview';
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {open && <button className="mobile-overlay" aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`} aria-label="Workspace navigation">
      <Link to="/" className="brand" aria-label="Minutes home"><span className="brand-icon"><AudioLines size={25} strokeWidth={1.8} /></span><span>minutes<span className="brand-period">.</span></span></Link>
      <div className="workspace-label"><span className="workspace-monogram">M</span><div><strong>My workspace</strong><span>Personal workspace</span></div><span className="workspace-online" title="Local workspace" /></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav className="main-nav">{navigation.map(({ to, icon: Icon, label, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? 'nav-active' : ''}`}><Icon size={19} strokeWidth={1.7} /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-note"><span className="note-kicker">A LITTLE MORE CLARITY</span><p>Good conversations.<br />Clear next steps.</p><span className="note-line" /></div>
      <div className="sidebar-bottom"><NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'nav-active' : ''}`}><Settings2 size={19} strokeWidth={1.7} /><span>Settings</span></NavLink><Link to="/settings#setup" className="nav-link"><CircleHelp size={19} strokeWidth={1.7} /><span>Provider setup</span><ArrowUpRight size={14} /></Link><div className="local-profile"><span className="profile-avatar">Y</span><div><strong>Your workspace</strong><span>Saved on this device</span></div></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <X size={21} /> : <Menu size={21} />}</button><span>Workspace</span><ChevronRight size={14} /><strong>{section}</strong></div><div className="topbar-right"><span className="local-status"><span />Local workspace</span><Link to="/settings" className="topbar-avatar" aria-label="Workspace settings">Y</Link></div></header>
      <main id="main-content" tabIndex={-1}><Routes><Route path="/" element={<Dashboard />} /><Route path="/meetings" element={<MeetingsPage />} /><Route path="/meetings/new" element={<NewMeetingPage />} /><Route path="/meetings/:id" element={<MeetingDetail key={location.pathname} />} /><Route path="/actions" element={<ActionsPage />} /><Route path="/projects" element={<ProjectsPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<div className="not-found"><span className="eyebrow">404 · PAGE NOT FOUND</span><h1>This page has moved on.</h1><p>Head back to your workspace to find your meetings.</p><Link className="button primary" to="/">Back to overview</Link></div>} /></Routes></main>
      <footer className="app-footer"><span>Make every conversation count.</span><span>Minutes · Meeting intelligence</span></footer>
    </div>
  </div>;
}
export default function App() { return <Notifications><Shell /></Notifications>; }
