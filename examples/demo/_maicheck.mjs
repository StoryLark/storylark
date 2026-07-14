import { pathToFileURL } from 'node:url';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { synthesizeChapter } = await import(pathToFileURL('D:/git/storylark/storylark/tools/tts.mjs').href);
const [voice, out] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(),'mai-'));
const text = 'One dollar and eighty-seven cents. That was all. And sixty cents of it was in pennies, saved one and two at a time by bulldozing the grocer and the vegetable man and the butcher.';
try {
  const { chunks, blockTimings } = await synthesizeChapter({ blocks:[{id:'b001',type:'paragraph',text}] }, voice, dir, { key: process.env.AZURE_SPEECH_KEY, region: 'eastus' });
  const w = blockTimings[0]?.words ?? [];
  if (out) copyFileSync(chunks[0].file, out);
  console.log(voice.padEnd(30), '=> words timed:', String(w.length).padStart(3), w.length ? 'WORD-SYNC OK' : 'NO BOUNDARIES', out?('| '+out.split('/').pop()):'');
} catch (e) { console.log(voice.padEnd(30), '=> ERROR:', (e.message||String(e)).slice(0,80)); }
