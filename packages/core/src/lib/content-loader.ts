import type { ChapterContent, ChapterEntry, ChapterTimings } from './types';
import { contentUrl } from '../brand';
import { personalContent } from './personal-library';

export async function loadChapterContent(chapter: ChapterEntry): Promise<ChapterContent> {
  const local = personalContent(chapter.content);
  if (local) return local;
  const response = await fetch(contentUrl(chapter.content));
  if (!response.ok) throw new Error(`content ${response.status}`);
  return (await response.json()) as ChapterContent;
}

export async function loadChapterTimings(path?: string): Promise<ChapterTimings | null> {
  if (!path) return null;
  const response = await fetch(contentUrl(path));
  if (!response.ok) return null;
  return (await response.json()) as ChapterTimings;
}
