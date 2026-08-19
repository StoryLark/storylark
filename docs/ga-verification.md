# StoryLark 1.0 verification record

This is the release evidence for the reader-facing StoryLark 1.0 candidate. It
separates automated proof from checks that require a real browser or device; a
row is never marked passed from source inspection alone.

## Automated quality gate

| Check | Result | Evidence |
|---|---|---|
| TypeScript | Pass | `npm run typecheck` across app, core, and Worker |
| Production PWA build | Pass | `npm run build`; personal PDF and DOCX parsers are lazy chunks |
| Full automated suite | Pass on the release worktree | `npm test`, including import, persistence, backup safety, accessibility contracts, Worker, pipeline, contracts, and theme packaging |
| Dependency audit | Pass with documented upstream exception | `npm audit fix` applied every available non-breaking fix. Three high findings remain in `sharp <0.35.0`, transitively required by the optional Kokoro/Hugging Face narration toolchain; npm reports no fix. The reader import dependencies add no finding. |
| Built-app HTTP smoke | Pass | Production preview returns HTTP 200 for `/library` |

CI repeats typecheck, production build, and the full suite on Ubuntu with Node
22 for every pull request and every push to `main`. Release automation runs the
same gate again before it can publish or package an engine.

## Personal-library functional coverage

Automated tests cover:

- My Library placement and the absence of an Add action on Now Playing;
- paste normalization and IndexedDB persistence;
- selectable-text PDF extraction;
- DOCX raw-text extraction;
- backup round trip and rejection of damaged or non-paragraph injected data;
- local reader lookup and device-voice wake-lock selection; and
- keyboard semantics for shelf tabs and the Reader playback position.

## Browser and device matrix

The feature is intentionally one responsive implementation: phone, tablet, and
desktop use the same IndexedDB, import, Reader, and device-voice code. Platform
file pickers and voice availability still require real-device checks.

| Surface | Automated/build | Interactive smoke | Required release smoke |
|---|---|---|---|
| iPhone installed PWA / Safari | Shared code built and tested | Not run in this worktree | Add a PDF from Files; Read; Start listening; confirm visible screen remains awake; pause; relaunch and confirm persistence |
| iPad installed PWA / Safari | Shared code built and tested | Not run in this worktree | Repeat iPhone flow and rotate once with Add open |
| Android installed PWA / Chrome | Shared code built and tested | Not run in this worktree | Repeat phone flow and verify the chosen system voice speaks |
| Desktop Chrome or Edge | Production preview HTTP smoke passed | Browser connection unavailable in this worktree | Paste text; import PDF and DOCX; export; delete; restore; keyboard-only tab/dialog/Reader flow |
| Desktop Firefox | Production bundle built | Not run in this worktree | Paste/import/read; confirm unsupported wake-lock UI is omitted if the API is absent |
| Desktop Safari | Production bundle built | Not run in this worktree | Paste/import/read/listen and persistence after restart |

The final column is the manual release smoke. It must be recorded as passed on
the release pull request before AB#7392 is closed; lack of a connected browser
is not evidence of failure, but it is also not evidence of a pass.

## WCAG 2.1 AA accessibility audit

Scope: reader app navigation, Library and My Library, import dialog, Reader, and
Now Playing. Admin is outside AB#7393's reader-facing GA scope.

### Remediated

- Added a skip link, `main` landmark, and focus transfer after client-side route
  changes.
- Added accessible names and pressed state to icon-only Reader mode controls.
- Made the Reader playback position a named keyboard-operable slider.
- Added complete tab/tab-panel relationships and arrow/Home/End operation to
  the Library shelves.
- Named and described the import dialog; import progress and errors use live
  status/alert semantics.
- Preserved visible focus for the transparent file picker and every new action;
  new targets are at least 44 CSS pixels tall.
- Honored reduced-motion preferences.
- Corrected theme tokens. Automated contrast checks now enforce at least 4.5:1
  for normal text, muted/faint text, links, and accents on every shipped light
  and dark background. The lowest shipped text-token pair is 5.33:1; Wireless's
  corrected light accent is 4.67:1.

### Remaining manual audit

Keyboard-only traversal, 200% zoom/reflow, VoiceOver on iOS, and one desktop
screen-reader pass require an interactive browser/device. Record those results
on the release pull request before AB#7393 is closed.
