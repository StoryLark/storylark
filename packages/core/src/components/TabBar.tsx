import type { JSX } from 'preact';
import { route, navigate } from '../router';
import { nowPlaying, playerPlaying } from '../lib/player';
import { PRESENTATION, navLabel } from '../presentation';
import type { NavItem } from '../lib/types';

/**
 * The navigation bar, from `nav.items` / `nav.position` / `nav.labels`
 * (AB#7416 — plan §0b).
 *
 * It used to be four hardcoded <Tab> elements along the bottom. It is now a map
 * over the presentation's item list, so a deployment chooses WHICH entries
 * exist and IN WHAT ORDER by editing one line of presentation.json. Core's
 * default is the same four, in the same order, so nothing moves for an existing
 * library — see DEFAULT_PRESENTATION.
 *
 * `about` is offered as an item but is not in the default list: About has
 * always been reached from the Settings footer, and putting a fifth tab on
 * every existing deployment is not a default's job.
 */

/** Everything an item needs to render, in one table rather than five branches. */
const ITEMS: Record<NavItem, { path: string; routes: string[]; icon: () => JSX.Element }> = {
  home: { path: '/', routes: ['home'], icon: HomeIcon },
  // The Library tab stays lit while you are inside a collection or reading —
  // those screens are reached from it and have no tab of their own.
  library: { path: '/library', routes: ['library', 'book', 'reader'], icon: LibraryIcon },
  nowPlaying: { path: '/now-playing', routes: ['now-playing'], icon: PlayIcon },
  // Settings covers About for the same reason, when About has no tab of its own.
  settings: { path: '/settings', routes: ['settings', 'about'], icon: SettingsIcon },
  about: { path: '/about', routes: ['about'], icon: AboutIcon },
};

/**
 * Which item the current route lights up.
 *
 * Computed against the items this deployment actually shows, not against a
 * fixed list: with `about` in the bar, /about belongs to About; without it,
 * /about keeps lighting Settings, which is where you got there from. A fixed
 * mapping would leave one of those two arrangements with a dead tab bar.
 */
function activeItem(items: NavItem[]): NavItem | null {
  const name = route.value.name;
  for (const item of items) {
    if (item === 'settings' && name === 'about' && items.includes('about')) continue;
    if (ITEMS[item]?.routes.includes(name)) return item;
  }
  return null;
}

export function TabBar(): JSX.Element | null {
  const nav = PRESENTATION.nav;
  const items = nav.items.filter((item) => ITEMS[item]);
  if (items.length === 0) return null; // a deployment may state no navigation at all
  const active = activeItem(items);
  const hasItem = nowPlaying.value !== null;
  return (
    <nav class={`tab-bar tab-bar-${nav.position}`} aria-label="Main navigation">
      {items.map((item) => {
        const Icon = ITEMS[item].icon;
        return (
          <Tab
            key={item}
            label={navLabel(item)}
            active={active === item}
            dimmed={item === 'nowPlaying' && !hasItem}
            badge={item === 'nowPlaying' && playerPlaying.value}
            onTap={() => navigate(ITEMS[item].path)}
          >
            <Icon />
          </Tab>
        );
      })}
    </nav>
  );
}

function Tab(props: {
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

/** Only rendered when a deployment puts `about` in its nav. */
function AboutIcon(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.6" />
    </svg>
  );
}
