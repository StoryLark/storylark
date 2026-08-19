# My Library — listen to a document you already have

My Library is an optional reader feature for personal documents. It requires no
publisher backend, account, or content repository.

## What the reader sees

Open **Library**, choose **My Library**, then choose **+ Add**. The action is on
Library rather than Now Playing because adding and organizing content is library
work; Now Playing remains a playback screen.

The Add sheet accepts:

- a PDF with selectable text;
- a `.docx`, `.txt`, `.text`, or `.md` file;
- pasted text; or
- an `http` or `https` page when that site permits direct browser access.

After import, choose **Read**, **Start listening**, or **Done**. Reading uses the
normal StoryLark Reader. Listening uses the browser's installed device voice.
With **Keep screen awake** enabled, StoryLark requests a screen wake lock while
that device voice is playing and the PWA remains visible.

The behavior is the same in an installed phone, tablet, or desktop PWA. The
platform's file picker looks different, but the resulting shelf and playback
flow are the same.

## Local means local

Personal documents are extracted in the browser and stored in that browser's
IndexedDB. StoryLark does not upload them to the deployment, add them to the
publisher manifest, send them through the content API, or include them in
account progress sync. Clearing site data removes them.

**Export** downloads a JSON backup and **Import backup** restores it. That is an
explicit transfer controlled by the reader; automatic cross-device sync is a
post-1.0 roadmap item.

Direct URL import is constrained by browser CORS rules. If a page refuses the
request, copy and paste its readable text instead. Image-only scanned PDFs have
no selectable text and need OCR, which 1.0 does not include.

## Enable it for a presentation

Existing customer presentations remain unchanged. Enable My Library only where
it is wanted:

```json
{
  "features": {
    "personalImports": { "enabled": true, "placement": "library" }
  }
}
```

The official `storylark` and `storylark-local` presentations enable it. An
absent entry is treated as disabled for this feature.
