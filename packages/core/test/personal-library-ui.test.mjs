import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const librarySource = await readFile(new URL('../src/screens/Library.tsx', import.meta.url), 'utf8');
const personalSource = await readFile(new URL('../src/screens/PersonalLibrary.tsx', import.meta.url), 'utf8');
const nowPlayingSource = await readFile(new URL('../src/screens/NowPlaying.tsx', import.meta.url), 'utf8');
const playerSource = await readFile(new URL('../src/lib/player.ts', import.meta.url), 'utf8');

test('the add action belongs to My Library, not Now Playing', () => {
  assert.match(librarySource, /view === 'personal'/);
  assert.match(librarySource, />\s*\+ Add\s*</);
  assert.doesNotMatch(nowPlayingSource, /Add to My Library|\+ Add/);
});

test('the Library shelf tabs expose keyboard and tab-panel relationships', () => {
  assert.match(librarySource, /role="tablist"/);
  assert.match(librarySource, /aria-controls="library-panel-personal"/);
  assert.match(librarySource, /role="tabpanel"/);
  assert.match(librarySource, /ArrowLeft.*ArrowRight.*Home.*End/s);
});

test('the import dialog states local storage and offers the agreed sources', () => {
  assert.match(personalSource, /Documents stay on this device/);
  assert.match(personalSource, /PDF, DOCX, or text/);
  assert.match(personalSource, /Paste text/);
  assert.match(personalSource, /Web page/);
  assert.match(personalSource, /Import backup/);
});

test('device-voice playback holds wake lock without changing prerecorded audio behavior', () => {
  assert.match(playerSource, /const deviceVoice = nowPlaying\.value !== null && !nowPlaying\.value\.hasAudio/);
  assert.match(playerSource, /attachedContainer !== null \|\| deviceVoice/);
});
