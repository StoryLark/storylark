// Opens an item in its chosen consumption mode: per-item override first,
// then the Settings default. LISTEN goes to Now Playing; READ and
// READ + LISTEN go to the Reader.

import type { ConsumptionMode } from './types';
import { modeFor, setItemMode } from './state';
import { startPlayback } from './player';
import { navigate } from '../router';

export function openItem(bookId: string, chapterId: string, mode?: ConsumptionMode): void {
  const m = mode ?? modeFor(bookId, chapterId);
  if (mode) void setItemMode(bookId, chapterId, mode);
  if (m === 'listen') {
    void startPlayback(bookId, chapterId);
    navigate('/now-playing');
  } else {
    navigate(`/read/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}?mode=${m === 'both' ? 'both' : 'read'}`);
  }
}
