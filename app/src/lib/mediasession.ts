import { BRAND, contentUrl } from '../brand';

export function setupMediaSession(opts: {
  title: string;
  book: string;
  cover?: string;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (deltaSec: number) => void;
  onPrev?: () => void;
  onNext?: () => void;
}): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: opts.title,
    artist: BRAND.author,
    album: opts.book,
    artwork: opts.cover ? [{ src: contentUrl(opts.cover), sizes: '512x512' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', opts.onPlay);
  navigator.mediaSession.setActionHandler('pause', opts.onPause);
  navigator.mediaSession.setActionHandler('seekbackward', () => opts.onSeek(-15));
  navigator.mediaSession.setActionHandler('seekforward', () => opts.onSeek(30));
  navigator.mediaSession.setActionHandler('previoustrack', opts.onPrev ?? null);
  navigator.mediaSession.setActionHandler('nexttrack', opts.onNext ?? null);
}

export function updatePlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
}
