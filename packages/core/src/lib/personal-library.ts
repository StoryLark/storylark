import { signal } from '@preact/signals';
import type { Block, BookEntry, ChapterContent, ChapterEntry, PersonalDocument, PersonalLibraryBackup } from './types';
import { idb } from './db';

const STORE = 'personalLibrary';
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export const personalDocuments = signal<PersonalDocument[]>([]);

export async function loadPersonalLibrary(): Promise<void> {
  const docs = await idb.getAll<PersonalDocument>(STORE);
  personalDocuments.value = docs.filter(validDocument).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export function findPersonalEntry(bookId: string, chapterId: string): { book: BookEntry; chapter: ChapterEntry } | null {
  const doc = personalDocuments.value.find((item) => item.book.id === bookId);
  const chapter = doc?.book.chapters.find((item) => item.id === chapterId);
  return doc && chapter ? { book: doc.book, chapter } : null;
}

export function personalContent(path: string): ChapterContent | null {
  if (!path.startsWith('personal:')) return null;
  const id = path.slice('personal:'.length);
  return personalDocuments.value.find((item) => item.id === id)?.content ?? null;
}

export function isPersonalBook(bookId: string): boolean {
  return personalDocuments.value.some((item) => item.book.id === bookId);
}

export async function importPersonalText(
  text: string,
  options: { title?: string; author?: string; kind?: PersonalDocument['source']['kind']; name?: string; url?: string } = {}
): Promise<PersonalDocument> {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('No readable text was found.');
  if (new TextEncoder().encode(normalized).byteLength > MAX_TEXT_BYTES) {
    throw new Error('This document contains more than 10 MB of text. Split it into smaller documents and try again.');
  }

  const id = crypto.randomUUID();
  const title = cleanTitle(options.title) || titleFromText(normalized) || 'Untitled document';
  const now = new Date().toISOString();
  const content = contentFromText(id, title, normalized);
  const words = wordCount(normalized);
  const chapter: ChapterEntry = {
    id: `${id}-document`,
    title: 'Full document',
    wordCount: words,
    readingTime: `${Math.max(1, Math.ceil(words / 220))} min read`,
    audioDurationMs: 0,
    contentHash: await sha256(normalized),
    content: `personal:${id}`,
    hasAudio: false,
    publishedAt: now,
    origin: 'personal',
  };
  const book: BookEntry = {
    id: `personal-${id}`,
    title,
    author: cleanTitle(options.author) || 'My Library',
    description: `Imported ${sourceLabel(options.kind ?? 'paste').toLowerCase()} · ${words.toLocaleString()} words`,
    publishDate: now.slice(0, 10),
    chapters: [chapter],
    origin: 'personal',
    single: true,
  };
  const doc: PersonalDocument = {
    schemaVersion: 1,
    id,
    title,
    author: cleanTitle(options.author) || undefined,
    source: { kind: options.kind ?? 'paste', name: options.name, url: options.url },
    importedAt: now,
    updatedAt: now,
    book,
    content,
  };
  await saveDocument(doc);
  return doc;
}

export async function importPersonalFile(file: File): Promise<PersonalDocument> {
  const lower = file.name.toLowerCase();
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error('Choose a file smaller than 50 MB.');
  const title = file.name.replace(/\.(pdf|docx|txt|text|md)$/i, '').trim();
  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    return importPersonalText(await extractPdf(await file.arrayBuffer()), { title, kind: 'pdf', name: file.name });
  }
  if (lower.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const arrayBuffer = await file.arrayBuffer();
    const { unzip } = await import('storylark-contracts/zip');
    try {
      // Reject zip bombs, path traversal, unsupported compression, and damaged
      // CRCs before Mammoth expands the Word archive.
      await unzip(arrayBuffer);
    } catch {
      throw new Error('This Word document is damaged or exceeds StoryLark’s safe archive limits.');
    }
    const { default: mammoth } = await import('mammoth');
    // Mammoth's Vite/browser build accepts ArrayBuffer; its Node build accepts
    // Buffer. Supporting both keeps the extractor covered by the same tests
    // that gate the browser bundle.
    const result = await mammoth.extractRawText(
      typeof Buffer === 'undefined' ? { arrayBuffer } : { buffer: Buffer.from(arrayBuffer) }
    );
    return importPersonalText(result.value, { title, kind: 'docx', name: file.name });
  }
  if (file.size > MAX_TEXT_BYTES) throw new Error('Choose a text file smaller than 10 MB.');
  return importPersonalText(await file.text(), { title, kind: 'txt', name: file.name });
}

export async function importPersonalUrl(value: string): Promise<PersonalDocument> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete web address beginning with https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https web addresses can be imported.');
  try {
    const response = await fetch(url.href);
    if (!response.ok) throw new Error(`That page answered ${response.status}.`);
    const page = await response.blob();
    if (page.size > MAX_DOCUMENT_BYTES) throw new Error('That page is larger than 50 MB. Copy and paste the part you want instead.');
    const html = await page.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('script,style,noscript,nav,header,footer,form,svg').forEach((node) => node.remove());
    const root = parsed.querySelector('article,main') ?? parsed.body;
    const title = parsed.querySelector('meta[property="og:title"]')?.getAttribute('content') || parsed.title || url.hostname;
    return await importPersonalText(root?.textContent ?? '', { title, kind: 'url', name: url.hostname, url: url.href });
  } catch (error) {
    if (error instanceof TypeError) throw new Error('That site does not permit direct browser import. Copy and paste the text instead.');
    throw error;
  }
}

export async function deletePersonalDocument(id: string): Promise<void> {
  await idb.delete(STORE, id);
  personalDocuments.value = personalDocuments.value.filter((doc) => doc.id !== id);
}

export function personalLibraryBackup(): PersonalLibraryBackup {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), documents: personalDocuments.value };
}

export async function restorePersonalLibraryBackup(value: unknown): Promise<number> {
  if (!value || typeof value !== 'object') throw new Error('This is not a StoryLark personal-library backup.');
  const backup = value as Partial<PersonalLibraryBackup>;
  if (backup.schemaVersion !== 1 || !Array.isArray(backup.documents) || !backup.documents.every(validDocument)) {
    throw new Error('This backup is damaged or uses an unsupported format.');
  }
  for (const doc of backup.documents) await idb.put(STORE, doc);
  await loadPersonalLibrary();
  return backup.documents.length;
}

export function contentFromText(id: string, title: string, text: string): ChapterContent {
  const paragraphs = normalizeText(text).split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const blocks: Block[] = paragraphs.map((part, index) => ({ id: `${id}-p${index + 1}`, type: 'paragraph', text: part }));
  return {
    id: `${id}-document`,
    bookId: `personal-${id}`,
    title,
    blocks,
    charLength: blocks.reduce((total, block) => total + ('text' in block ? block.text.length : 0), 0),
  };
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v]+/g, ' ').replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function titleFromText(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length <= 100 ? first : `${first.slice(0, 97)}…`;
}

function cleanTitle(value?: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function wordCount(value: string): number {
  return value.match(/\p{L}[\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

function sourceLabel(kind: PersonalDocument['source']['kind']): string {
  return ({ paste: 'Pasted text', txt: 'Text file', pdf: 'PDF', docx: 'Word document', url: 'Web page' })[kind];
}

async function saveDocument(doc: PersonalDocument): Promise<void> {
  await idb.put(STORE, doc);
  personalDocuments.value = [doc, ...personalDocuments.value.filter((item) => item.id !== doc.id)];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
  }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const pageText = await extractPdfPageText(page);
    if (pageText.trim()) pages.push(pageText.trim());
  }
  if (!pages.length) throw new Error('This PDF has no selectable text. Scanned-image PDFs need OCR, which is not included yet.');
  return pages.join('\n\n');
}

/**
 * Read PDF.js text chunks through the standard stream reader API.
 *
 * Safari exposes ReadableStream#getReader but, in affected WebKit releases,
 * not the async iterator that PDFPageProxy#getTextContent uses internally.
 * Reading the same stream explicitly works on Safari and every browser that
 * PDF.js supports, without user-agent detection or a second extraction path.
 */
export async function extractPdfPageText(page: { streamTextContent(): ReadableStream<unknown> }): Promise<string> {
  const reader = page.streamTextContent().getReader();
  let pageText = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const items = value && typeof value === 'object' && 'items' in value && Array.isArray(value.items) ? value.items : [];
      for (const item of items) {
        if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string') continue;
        pageText += `${item.str}${'hasEOL' in item && item.hasEOL ? '\n' : ' '}`;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return pageText;
}

function validDocument(value: unknown): value is PersonalDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<PersonalDocument>;
  if (
    doc.schemaVersion !== 1 ||
    typeof doc.id !== 'string' ||
    !doc.id ||
    typeof doc.title !== 'string' ||
    typeof doc.importedAt !== 'string' ||
    typeof doc.updatedAt !== 'string' ||
    !doc.source ||
    typeof doc.source.kind !== 'string' ||
    !['paste', 'txt', 'pdf', 'docx', 'url'].includes(doc.source.kind)
  ) return false;
  if (!doc.book || doc.book.origin !== 'personal' || !Array.isArray(doc.book.chapters) || doc.book.chapters.length !== 1) return false;
  const chapter = doc.book.chapters[0];
  if (
    doc.book.id !== `personal-${doc.id}` ||
    !chapter ||
    chapter.origin !== 'personal' ||
    chapter.hasAudio !== false ||
    chapter.content !== `personal:${doc.id}` ||
    !doc.content ||
    doc.content.id !== chapter.id ||
    doc.content.bookId !== doc.book.id ||
    !Array.isArray(doc.content.blocks)
  ) return false;
  // Personal imports only create plain paragraphs. Keep backup restore equally
  // narrow so a hand-edited JSON file cannot inject images, links, or markup.
  if (!doc.content.blocks.every(
    (block) =>
      block &&
      typeof block === 'object' &&
      'id' in block &&
      typeof block.id === 'string' &&
      'type' in block &&
      block.type === 'paragraph' &&
      'text' in block &&
      typeof block.text === 'string'
  )) return false;
  return new TextEncoder().encode(doc.content.blocks.map((block) => ('text' in block ? block.text : '')).join('\n')).byteLength <= MAX_TEXT_BYTES;
}
