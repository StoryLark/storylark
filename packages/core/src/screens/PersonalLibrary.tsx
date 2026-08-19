import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  deletePersonalDocument,
  importPersonalFile,
  importPersonalText,
  importPersonalUrl,
  personalDocuments,
  personalLibraryBackup,
  restorePersonalLibraryBackup,
} from '../lib/personal-library';
import type { PersonalDocument } from '../lib/types';
import { navigate } from '../router';
import { progressKey, progressMap } from '../lib/state';
import { startPlayback } from '../lib/player';

export function PersonalLibraryShelf({ onAdd }: { onAdd: () => void }): JSX.Element {
  const docs = personalDocuments.value;
  const [message, setMessage] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);

  if (docs.length === 0) {
    return (
      <section class="personal-empty" aria-labelledby="personal-empty-title">
        <div class="personal-empty-icon" aria-hidden="true">＋</div>
        <h2 id="personal-empty-title">Your private library</h2>
        <p>Add a PDF, Word document, text file, web page, or pasted text. It stays on this device.</p>
        <button class="btn personal-empty-add" onClick={onAdd}>Add something</button>
        <BackupRestore inputRef={backupInput} onMessage={setMessage} />
        {message && <p role="status" class="settings-note">{message}</p>}
      </section>
    );
  }

  return (
    <section aria-label="My Library">
      <div class="personal-toolbar">
        <p>{docs.length} {docs.length === 1 ? 'item' : 'items'} · stored only on this device</p>
        <div>
          <button class="btn-ghost" aria-label="Export My Library backup" onClick={downloadBackup}>Export</button>
          <BackupRestore inputRef={backupInput} onMessage={setMessage} compact />
        </div>
      </div>
      {message && <p role="status" class="settings-note">{message}</p>}
      <ul class="personal-list">
        {docs.map((doc) => <PersonalCard key={doc.id} doc={doc} />)}
      </ul>
    </section>
  );
}

function PersonalCard({ doc }: { doc: PersonalDocument }): JSX.Element {
  const chapter = doc.book.chapters[0];
  const progress = progressMap.value.get(progressKey(doc.book.id, chapter.id));
  return (
    <li class="personal-card">
      <button class="personal-main" onClick={() => navigate(personalReadPath(doc))}>
        <span class="personal-cover" aria-hidden="true">{sourceIcon(doc.source.kind)}</span>
        <span class="personal-card-body">
          <strong>{doc.title}</strong>
          <span>{doc.book.description}</span>
          <span>{new Date(doc.importedAt).toLocaleDateString()}{progress && progress.percent > 0 ? ` · ${Math.round(progress.percent * 100)}%` : ''}</span>
          {progress && progress.percent > 0 && (
            <span class="chapter-progress" aria-hidden="true"><span class="chapter-progress-fill" style={{ width: `${Math.min(100, progress.percent * 100)}%` }} /></span>
          )}
        </span>
      </button>
      <button class="row-play" aria-label={`Listen to ${doc.title}`} onClick={() => void listen(doc)}>▶</button>
      <button
        class="personal-delete"
        aria-label={`Delete ${doc.title}`}
        onClick={() => {
          if (confirm(`Delete “${doc.title}” from My Library on this device?`)) void deletePersonalDocument(doc.id);
        }}
      >
        Delete
      </button>
    </li>
  );
}

export function PersonalImporter({ onClose }: { onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'choose' | 'paste' | 'url'>('choose');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<PersonalDocument | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function run(action: () => Promise<PersonalDocument>): Promise<void> {
    setWorking(true);
    setError('');
    try {
      setAdded(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'StoryLark could not import that document.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      class="personal-dialog"
      aria-labelledby="personal-dialog-title"
      aria-describedby="personal-dialog-description"
      onClose={onClose}
      onCancel={(event) => working && event.preventDefault()}
    >
      <div class="personal-dialog-head">
        <div>
          <h2 id="personal-dialog-title">Add to My Library</h2>
          <p id="personal-dialog-description">Documents stay on this device.</p>
        </div>
        <button class="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()} disabled={working}>×</button>
      </div>

      {added ? (
        <div class="personal-added">
          <span aria-hidden="true">✓</span>
          <h3 role="status">Added “{added.title}”</h3>
          <p>You can read it now or listen with this device's voice.</p>
          <div class="personal-dialog-actions">
            <button class="btn" onClick={() => navigate(personalReadPath(added))}>Read</button>
            <button class="btn" onClick={() => void listen(added)}>Start listening</button>
            <button class="btn-ghost" onClick={() => dialog.current?.close()}>Done</button>
          </div>
        </div>
      ) : mode === 'choose' ? (
        <div class="personal-source-list">
          <label class="personal-source">
            <span aria-hidden="true">PDF</span>
            <strong>Choose a document</strong>
            <small>PDF, DOCX, or text from Files</small>
            <input
              type="file"
              accept=".pdf,.docx,.txt,.text,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              disabled={working}
              onChange={(event) => {
                const file = (event.currentTarget as HTMLInputElement).files?.[0];
                if (file) void run(() => importPersonalFile(file));
              }}
            />
          </label>
          <button class="personal-source" onClick={() => setMode('paste')}>
            <span aria-hidden="true">Aa</span><strong>Paste text</strong><small>Type or paste anything readable</small>
          </button>
          <button class="personal-source" onClick={() => setMode('url')}>
            <span aria-hidden="true">↗</span><strong>Web page</strong><small>Works when the site permits browser access</small>
          </button>
        </div>
      ) : mode === 'paste' ? (
        <form onSubmit={(event) => { event.preventDefault(); void run(() => importPersonalText(text, { title, kind: 'paste' })); }}>
          <label class="personal-field"><span>Title <small>(optional)</small></span><input value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
          <label class="personal-field"><span>Text</span><textarea rows={12} required value={text} onInput={(event) => setText(event.currentTarget.value)} /></label>
          <div class="personal-dialog-actions"><button type="button" class="btn-ghost" onClick={() => setMode('choose')}>Back</button><button class="btn" disabled={working}>{working ? 'Adding…' : 'Add to My Library'}</button></div>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void run(() => importPersonalUrl(url)); }}>
          <label class="personal-field"><span>Web address</span><input type="url" required placeholder="https://example.com/article" value={url} onInput={(event) => setUrl(event.currentTarget.value)} /></label>
          <p class="settings-note">Some sites prevent direct import. When that happens, copy and paste the text instead.</p>
          <div class="personal-dialog-actions"><button type="button" class="btn-ghost" onClick={() => setMode('choose')}>Back</button><button class="btn" disabled={working}>{working ? 'Importing…' : 'Add web page'}</button></div>
        </form>
      )}

      {working && <p role="status" class="personal-import-status">Preparing your document… Keep StoryLark open.</p>}
      {error && <p role="alert" class="personal-import-error">{error}</p>}
    </dialog>
  );
}

function BackupRestore({ inputRef, onMessage, compact = false }: { inputRef: { current: HTMLInputElement | null }; onMessage: (message: string) => void; compact?: boolean }): JSX.Element {
  return (
    <>
      <button class={compact ? 'btn-ghost' : 'btn-ghost personal-restore'} onClick={() => inputRef.current?.click()}>Import backup</button>
      <input
        ref={inputRef}
        class="visually-hidden"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (!file) return;
          void file.text().then(JSON.parse).then(restorePersonalLibraryBackup).then((count) => onMessage(`Imported ${count} ${count === 1 ? 'item' : 'items'}.`)).catch((reason) => onMessage(reason instanceof Error ? reason.message : 'Could not import that backup.')).finally(() => { input.value = ''; });
        }}
      />
    </>
  );
}

function downloadBackup(): void {
  const blob = new Blob([JSON.stringify(personalLibraryBackup(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `storylark-my-library-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function personalReadPath(doc: PersonalDocument): string {
  return `/read/${encodeURIComponent(doc.book.id)}/${encodeURIComponent(doc.book.chapters[0].id)}?mode=read`;
}

async function listen(doc: PersonalDocument): Promise<void> {
  const chapter = doc.book.chapters[0];
  await startPlayback(doc.book.id, chapter.id);
  navigate('/now-playing');
}

function sourceIcon(kind: PersonalDocument['source']['kind']): string {
  return ({ paste: 'Aa', txt: 'TXT', pdf: 'PDF', docx: 'DOC', url: 'WEB' })[kind];
}
