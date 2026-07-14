import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { synthesizeChapter } = await import(pathToFileURL('D:/git/storylark/storylark/packages/pipeline/tts.mjs').href);
const voice = process.argv[2];
const dir = mkdtempSync(join(tmpdir(),'vc-'));
const chapter = { blocks: [{ id:'b001', type:'paragraph', text:'One dollar and eighty-seven cents. That was all.' }] };
try {
  const { blockTimings } = await synthesizeChapter(chapter, voice, dir, { key: process.env.AZURE_SPEECH_KEY, region: 'eastus' });
  const w = blockTimings[0]?.words ?? [];
  console.log(voice, '=> words timed:', w.length, w.length? '(WORD-SYNC OK)':'(NO WORD BOUNDARIES)');
} catch (e) { console.log(voice, '=> ERROR:', (e.message||String(e)).slice(0,100)); }
