import type { JSX } from 'preact';
import { route } from './router';
import { Home } from './screens/Home';
import { Library } from './screens/Library';
import { Book } from './screens/Book';
import { NowPlaying } from './screens/NowPlaying';
import { Reader } from './screens/Reader';
import { Settings, SignIn } from './screens/Settings';
import { About } from './screens/About';
import { TabBar } from './components/TabBar';
import { UpdateBanner } from './components/UpdateBanner';
import { PRESENTATION, fillCopy } from './presentation';
import { authChecked, user } from './lib/state';
import { BRAND } from './brand';

export function App(): JSX.Element {
  if (PRESENTATION.auth.required && !user.value) return <AuthGate />;
  return (
    <>
      <UpdateBanner />
      <Screen />
      <TabBar />
    </>
  );
}

/**
 * The account gate — presentation `auth.required` (AB#7416 — plan §0b,
 * "Sign-in posture").
 *
 * Off by default: StoryLark has always been browse-and-read anonymously, and
 * §0b is explicit that this is "a genuine per-deployment decision, not a
 * preference" — a subscription library and an open one want opposite first
 * runs, and neither can be talked into the other's.
 *
 * Two things it deliberately does NOT do. It does not render until the session
 * check has come back (`authChecked`), because `user` is null both before the
 * answer and after an empty one, and a gate that cannot tell those apart shows
 * a sign-in form to every already-signed-in reader on every cold start. And it
 * is not a security control — the content origin serves what it serves, and the
 * API's own auth is what protects anything that needs protecting. This is the
 * shape of the front door, not the lock on it.
 */
function AuthGate(): JSX.Element {
  if (!authChecked.value) {
    return (
      <div class="screen">
        <p class="empty-state">{fillCopy(PRESENTATION.emptyState.home)}</p>
      </div>
    );
  }
  return (
    <div class="screen settings-screen">
      <header class="screen-header">
        <h1 class="screen-title">{BRAND.appName}</h1>
        <p class="app-tagline">{BRAND.tagline}</p>
      </header>
      <section class="settings-section settings-account-card">
        <h2>Sign in to continue</h2>
        <SignIn />
      </section>
    </div>
  );
}

function Screen(): JSX.Element {
  const r = route.value;
  switch (r.name) {
    case 'library':
      return <Library />;
    case 'book':
      return <Book bookId={r.bookId} />;
    case 'now-playing':
      return <NowPlaying />;
    case 'reader':
      return <Reader bookId={r.bookId} chapterId={r.chapterId} mode={r.mode} />;
    case 'settings':
      return <Settings />;
    case 'about':
      return <About />;
    default:
      return <Home />;
  }
}
