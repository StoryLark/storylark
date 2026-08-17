---
'storylark-core': minor
'storylark-worker': minor
'storylark-contracts': minor
---

Readers can choose one of the gallery's sample themes, and an admin can force
one (AB#7412).

The Settings screen's Theme control offered light, dark, and "brand default" —
three views of one stylesheet. It now offers the five looks this engine already
ships (Daybreak, Loveletter, Nebula, Weatherglass, Wireless) alongside the
library's own, with light and dark still working inside whichever one is
active.

This is deliberately NOT the existing "one imported brand per deployment"
system, and the two do not touch. A look is the CSS custom-property values —
the colours and the font stacks — of one of the sample brands, applied as
inline properties on `<html>` for that one reader. It never reaches the app
name, the icons, the PWA manifest, `themes/active.json`, or any other reader.
Switching back to the library's own look removes every property it set, so the
deployment's `theme.css` is unopposed again. The values are flattened from the
real `brands/*/theme.css` and a test re-parses those stylesheets and fails if a
single token has drifted, so a designer retuning a sample brand cannot leave
the bundle quietly disagreeing with the theme it is named after.

The offer is a new presentation key, `readerTheme`, with `options` (which looks
are offered — `[]` removes the picker) and `forced` (fix one for everyone).
Forcing genuinely overrides a reader's saved preference rather than hiding the
control while a stale value carries on applying, and it is applied before the
first paint rather than after storage has been read, so a forced deployment
does not flash its own palette first.

`readerTheme` is the one presentation key whose default is not "what the app
did before it existed": all five looks are offered out of the box, because what
it turns on is an offer — the picker's first entry is the library's own look,
selected — and nothing about an existing deployment changes until a reader
changes it. `{"readerTheme": {"options": []}}` opts out, and
`{"settings": {"theme": false}}` removes the whole control as before.

Operators set both from the admin portal's Brand & themes card, through a new
`PUT /api/admin/themes/presentation` that writes a normal theme version — same
history, same one-click rollback, same downloadable package. `GET
/api/admin/themes` now also returns the installed `presentation`, so the portal
renders from what the server holds rather than from the copy injected into the
page when it loaded.
