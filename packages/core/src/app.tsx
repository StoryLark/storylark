import type { JSX } from 'preact';
import { route } from './router';
import { Home } from './screens/Home';
import { Library } from './screens/Library';
import { Book } from './screens/Book';
import { NowPlaying } from './screens/NowPlaying';
import { Reader } from './screens/Reader';
import { Settings } from './screens/Settings';
import { About } from './screens/About';
import { Admin } from './screens/Admin';
import { TabBar } from './components/TabBar';
import { UpdateBanner } from './components/UpdateBanner';

export function App(): JSX.Element {
  return (
    <>
      <UpdateBanner />
      <Screen />
      <TabBar />
    </>
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
    case 'admin':
      return <Admin />;
    default:
      return <Home />;
  }
}
