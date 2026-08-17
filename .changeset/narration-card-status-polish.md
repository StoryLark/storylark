---
'storylark-core': patch
---

Polish the admin portal's Narration card (AB#7412 follow-up).

Two real gaps, not cosmetic ones: when every job was `pending`/`running` count
was zero but one or more had actually `failed`, the card said "Nothing is
waiting. Every chapter's audio matches its text." directly above a list of
failed jobs waiting to be retried — true and false in the same breath. It now
says a failed chapter is waiting on a retry instead. And each job's row showed
only the finished audio's own duration; the time the synthesis actually took
(`elapsedMs`, already returned by `GET /api/admin/narration` but never read by
the card) was invisible, so there was no way to tell a normal narration from a
slow one. Done jobs now show both — "took Xs to narrate · Ym of audio" — and a
`running` job shows how long it has been running, computed from `startedAt`,
so a job stuck near the 30-minute stale-claim window is visible before it gets
reclaimed rather than after.

Also brings this card in line with every other admin screen's pattern
(`ContentSection.tsx`, `ThemeSection.tsx`): success and failure messages are
now separate pieces of state, so a failed action (a queue request, a cancel)
renders in the same `admin-error` red the rest of the portal uses instead of
sharing a plain paragraph with ordinary status text.
