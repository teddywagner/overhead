import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { api, unwrap } from './api';
import { Aircraft } from './pages/Aircraft';
import { Artwork } from './pages/Artwork';
import { Coverage } from './pages/Coverage';
import { FrameDetail } from './pages/FrameDetail';
import { Frames } from './pages/Frames';
import { Images } from './pages/Images';
import { Locations } from './pages/Locations';
import { Login } from './pages/Login';
import { Posters } from './pages/Posters';
import { Users } from './pages/Users';
import { supabase, supabaseConfigured } from './supabase';

function useHashRoute(): string[] {
  const read = () =>
    (window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const onChange = () => setParts(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parts;
}

type Access = 'checking' | 'admin' | 'denied' | 'error';

const NAV = [
  ['frames', 'Frames'],
  ['aircraft', 'Aircraft'],
  ['artwork', 'Artwork'],
  ['coverage', 'Coverage'],
  ['images', 'Images'],
  ['posters', 'Posters'],
  ['locations', 'My locations'],
  ['users', 'Users'],
] as const;

function page(section: string, id: string | undefined, userId: string) {
  switch (section) {
    case 'aircraft':
      return <Aircraft />;
    case 'artwork':
      return <Artwork />;
    case 'coverage':
      return <Coverage />;
    case 'images':
      return <Images />;
    case 'posters':
      return <Posters />;
    case 'locations':
      return <Locations />;
    case 'users':
      return <Users currentUserId={userId} />;
    default:
      return id ? (
        <FrameDetail id={id} />
      ) : (
        <Frames ownerId={new URLSearchParams(window.location.hash.split('?')[1]).get('owner')} />
      );
  }
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [access, setAccess] = useState<Access>('checking');
  const [accessError, setAccessError] = useState('');
  const route = useHashRoute();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    setAccess('checking');
    unwrap(api.GET('/admin/v1/me'))
      .then(() => setAccess('admin'))
      .catch((e: { status?: number; message: string }) => {
        setAccess(e.status === 403 ? 'denied' : 'error');
        setAccessError(e.message);
      });
  }, [userId]);

  if (!supabaseConfigured) {
    return (
      <main className="center">
        <p className="notice error">
          SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing from the repo-root .env.
        </p>
      </main>
    );
  }
  if (session === undefined) return null;
  if (!session) return <Login />;

  const [section = 'frames', id] = route;
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">Overhead admin</strong>
        <nav>
          {NAV.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={section === key ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <span className="muted small">{session.user.email}</span>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <main>
        {access === 'checking' && <p className="muted">Checking access…</p>}
        {access === 'denied' && (
          <p className="notice error">
            This account is not an admin. Grant access with <code>bun run admin:grant EMAIL</code>.
          </p>
        )}
        {access === 'error' && (
          <p className="notice error">Could not reach the API: {accessError}. Is it running?</p>
        )}
        {access === 'admin' && page(section, id, session.user.id)}
      </main>
    </div>
  );
}
