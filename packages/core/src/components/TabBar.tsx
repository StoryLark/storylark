import type { JSX } from 'preact';
import { route, navigate } from '../router';
import { nowPlaying, playerPlaying } from '../lib/player';

type TabName = 'home' | 'library' | 'now-playing' | 'settings';

function activeTab(): TabName {
  switch (route.value.name) {
    case 'home':
      return 'home';
    case 'library':
    case 'book':
    case 'reader':
      return 'library';
    case 'now-playing':
      return 'now-playing';
    case 'settings':
    case 'about':
      return 'settings';
  }
}

export function TabBar(): JSX.Element {
  const active = activeTab();
  const hasItem = nowPlaying.value !== null;
  return (
    <nav class="tab-bar" aria-label="Main navigation">
      <Tab name="home" label="Home" active={active === 'home'} onTap={() => navigate('/')}>
        <HomeIcon />
      </Tab>
      <Tab name="library" label="Library" active={active === 'library'} onTap={() => navigate('/library')}>
        <LibraryIcon />
      </Tab>
      <Tab
        name="now-playing"
        label="Now Playing"
        active={active === 'now-playing'}
        dimmed={!hasItem}
        badge={playerPlaying.value}
        onTap={() => navigate('/now-playing')}
      >
        <PlayIcon />
      </Tab>
      <Tab name="settings" label="Settings" active={active === 'settings'} onTap={() => navigate('/settings')}>
        <SettingsIcon />
      </Tab>
    </nav>
  );
}

function Tab(props: {
  name: TabName;
  label: string;
  active: boolean;
  dimmed?: boolean;
  badge?: boolean;
  onTap: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      class={`tab${props.active ? ' tab-active' : ''}${props.dimmed ? ' tab-dimmed' : ''}`}
      onClick={props.onTap}
      aria-label={props.label}
      aria-current={props.active ? 'page' : undefined}
    >
      <span class="tab-icon">
        {props.children}
        {props.badge && <span class="tab-badge" aria-label="Playing" />}
      </span>
      <span class="tab-label">{props.label}</span>
    </button>
  );
}

const S = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const };

function HomeIcon(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  );
}

function LibraryIcon(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 4h4v16H4zM10 4h4v16h-4z" />
      <path d="m16.5 4.5 3.8 1-3.9 14.6-3.8-1z" />
    </svg>
  );
}

function PlayIcon(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l6-3.5z" />
    </svg>
  );
}

function SettingsIcon(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4z" />
    </svg>
  );
}
