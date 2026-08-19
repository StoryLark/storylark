# Voices

How narration works day to day — picking narrators, adding more, and what
the free vs. premium tiers actually mean.

## The two tiers

**Free, on-device (Kokoro)** — 28 open voices, synthesized on your own
machine when you publish. No account, no API key, no per-character billing.
This is the default and what most brands should start with.

**Premium, cloud (Azure Speech)** — optional, bring-your-own-key. Set
`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` and use an Azure voice id in
`brand.json`'s `tts.voice`. Costs per character synthesized.

Mixing is fine — your primary narrator can be Kokoro while an additional
voice is Azure, or vice versa; the pipeline handles either per voice id.

## Picking your brand's narrator

`deployment/<id>/deployment.json` — TTS config is per-install, not part of the
portable brand (see [`build-your-own-theme.md`](build-your-own-theme.md)):

```json
"tts": {
  "voice": "bm_george",
  "rate": "0%",
  "outputFormat": "Audio48Khz96KBitRateMonoMp3"
}
```

`voice` is the primary narrator every chapter gets by default. Some example
Kokoro voice ids (all 28 follow the `<accent><gender>_<name>` pattern —
`a` = American, `b` = British, `f`/`m` = gender):

| id | Name |
|---|---|
| `af_heart` | Heart — American, female |
| `af_bella` | Bella — American, female |
| `am_adam` | Adam — American, male |
| `am_michael` | Michael — American, male |
| `bf_emma` | Emma — British, female |
| `bm_george` | George — British, male |
| `bm_fable` | Fable — British, male |

## Adding more narrators (the picker)

Publish more than one voice and a "Narrator" picker appears in the app's
Settings automatically — nothing to build, it's driven entirely by what the
manifest says is available:

```json
"tts": {
  "voice": "af_heart",
  "voices": ["bm_george", "am_adam"]
}
```

`voice` stays the library default (what plays if a reader never picks);
`voices` lists the extras. The publish pipeline synthesizes **every** listed
voice for **every** chapter — expect proportionally longer publish times
with more voices. A reader's chosen narrator syncs across their devices and
stays available offline in their downloads.

### Voice preview samples

StoryLark 0.19+ can publish a short sample sentence for each configured voice.
When a sample exists in the manifest, Settings shows a preview button beside
that narrator so readers can listen before choosing. Samples are generated once
and reused on later publishes. Older manifests without samples remain valid;
the picker simply omits the preview button.

## Cost and time expectations

Kokoro voices run locally during `publish.mjs` — the cost is your own
machine's time (roughly real-time-ish per chapter per voice on a modern
CPU; a GPU speeds this up substantially). Azure Speech bills per character
synthesized — check current Azure Speech pricing before publishing a large
library with it. Either way, `--no-audio` skips narration entirely for a
text-only publish (listen mode falls back to on-device Web Speech).

## Regenerating narration

Editing a chapter and re-publishing re-synthesizes only the blocks whose spoken
text changed; unchanged blocks and chapters reuse their audio. Use
`--renarrate-all` when you intentionally need to rebuild every block, such as
after changing a voice configuration or investigating a bad cached chunk. Full
mechanics: [`content-pipeline.md`](content-pipeline.md).
