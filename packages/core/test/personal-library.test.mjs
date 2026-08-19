import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const library = await import('../src/lib/personal-library.ts');
const { idb } = await import('../src/lib/db.ts');
const { zip } = await import('../../contracts/zip.mjs');

beforeEach(async () => {
  await idb.clear('personalLibrary');
  library.personalDocuments.value = [];
});

test('plain text becomes one local personal document without publisher ownership', async () => {
  const doc = await library.importPersonalText('First paragraph.\n\nSecond paragraph.', {
    title: 'Road Trip Notes',
    kind: 'paste',
  });

  assert.equal(doc.title, 'Road Trip Notes');
  assert.equal(doc.book.origin, 'personal');
  assert.equal(doc.book.chapters[0].origin, 'personal');
  assert.equal(doc.book.chapters[0].hasAudio, false);
  assert.equal(doc.book.chapters[0].content, `personal:${doc.id}`);
  assert.deepEqual(doc.content.blocks.map((block) => block.type), ['paragraph', 'paragraph']);
  assert.equal(library.personalDocuments.value.length, 1);
});

test('personal documents persist in IndexedDB and reload in newest-first order', async () => {
  const first = await library.importPersonalText('One document', { title: 'First' });
  const second = await library.importPersonalText('Another document', { title: 'Second' });
  library.personalDocuments.value = [];

  await library.loadPersonalLibrary();

  assert.equal(library.personalDocuments.value.length, 2);
  assert.deepEqual(new Set(library.personalDocuments.value.map((doc) => doc.id)), new Set([first.id, second.id]));
});

test('backup export and restore round-trip the local library', async () => {
  const original = await library.importPersonalText('Back me up.', { title: 'Backup Example', kind: 'txt' });
  const backup = library.personalLibraryBackup();
  await library.deletePersonalDocument(original.id);
  assert.equal(library.personalDocuments.value.length, 0);

  const count = await library.restorePersonalLibraryBackup(JSON.parse(JSON.stringify(backup)));

  assert.equal(count, 1);
  assert.equal(library.personalDocuments.value[0].title, 'Backup Example');
  assert.equal(library.personalContent(`personal:${original.id}`)?.blocks[0].type, 'paragraph');
});

test('damaged backups fail closed', async () => {
  await assert.rejects(() => library.restorePersonalLibraryBackup({ schemaVersion: 1, documents: [{ id: 'bad' }] }), /damaged|unsupported/);
  assert.equal(library.personalDocuments.value.length, 0);
});

test('backup restore refuses non-paragraph content', async () => {
  await library.importPersonalText('Safe text', { title: 'Safe' });
  const backup = JSON.parse(JSON.stringify(library.personalLibraryBackup()));
  backup.documents[0].content.blocks = [{ id: 'remote', type: 'image', src: 'https://example.com/track', alt: '' }];
  await idb.clear('personalLibrary');
  library.personalDocuments.value = [];

  await assert.rejects(() => library.restorePersonalLibraryBackup(backup), /damaged|unsupported/);
  assert.equal(library.personalDocuments.value.length, 0);
});

test('PDF files with selectable text import locally', async () => {
  const file = new File([minimalPdf('Road Trip PDF')], 'road-trip.pdf', { type: 'application/pdf' });
  const doc = await library.importPersonalFile(file);

  assert.equal(doc.source.kind, 'pdf');
  assert.match(doc.content.blocks[0].text, /Road Trip PDF/);
});

test('PDF text extraction works when Safari lacks ReadableStream async iteration', async () => {
  let getTextContentCalled = false;
  const page = {
    getTextContent() {
      getTextContentCalled = true;
      throw new TypeError("undefined is not a function (near '...t of e...')");
    },
    streamTextContent() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ items: [{ str: 'First line', hasEOL: true }] });
          controller.enqueue({ items: [{ type: 'beginMarkedContent' }, { str: 'Second line', hasEOL: false }] });
          controller.close();
        },
      });
    },
  };

  const text = await library.extractPdfPageText(page);

  assert.equal(text, 'First line\nSecond line ');
  assert.equal(getTextContentCalled, false, 'the Safari-incompatible getTextContent path must not run');
});

test('DOCX files import their readable text locally', async () => {
  const bytes = await minimalDocx('Road Trip Word Document');
  const file = new File([bytes], 'road-trip.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const doc = await library.importPersonalFile(file);

  assert.equal(doc.source.kind, 'docx');
  assert.match(doc.content.blocks[0].text, /Road Trip Word Document/);
});

test('text normalization keeps paragraphs and removes transport whitespace', () => {
  assert.equal(library.normalizeText('  One\r\n\r\n\r\nTwo\t words  '), 'One\n\nTwo words');
  const content = library.contentFromText('abc', 'Example', 'One\n\nTwo');
  assert.equal(content.bookId, 'personal-abc');
  assert.equal(content.charLength, 6);
});

function minimalPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length + 36} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(body).byteLength);
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(body).byteLength;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

async function minimalDocx(text) {
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}
