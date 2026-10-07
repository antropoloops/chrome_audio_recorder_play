# Reading recording metadata (for the web app)

This extension records audio as a standard WebM (Matroska) file. Metadata about the recording's source is stored inside the file itself, as file-level Matroska tags — no separate sidecar file.

## Format
Tags are `SimpleTag` elements written directly by the extension's own
byte-level serializer ([`webm-tags.js`](webm-tags.js), no external library)
right after recording stops, spliced into the WebM without touching the audio.

The splice also drops the optional `SeekHead` / `Cues` seek index, because
inserting bytes would leave their stored offsets stale. Both elements are
optional in WebM (MediaRecorder's own live output has neither), so the result
is still a fully valid, playable WebM — just with a minimal, index-free layout.
For these short clips the only effect is that seeking is marginally slower.

The title is stored both as the Matroska `Info > Title` element and as the
`TITLE` tag; targets carry the type string `MOVIE`, so some readers (e.g.
`ffprobe`) display these tags with a `MOVIE/` prefix.

## Tags and values

| Tag key | Value | Notes |
|---|---|---|
| `TITLE` | Cleaned tab title (string) | Also exposed as the normalized `common.title` field by most metadata readers |
| `URL` | The tab's URL at the moment recording started (string) | Full `https://...` URL. Not guaranteed to be a deep link: on single-page apps (players that change what they play without changing the address), this may just be the site's landing URL |
| `DATE_RECORDED` | Recording date, `YYYY-MM-DD` (UTC) | Date only, no time component |

## How to read them

Each `.webm` may carry three Matroska tags: `TITLE`, `URL`, `DATE_RECORDED`. Read them with `music-metadata` and look them up in the **native** tag bag, matching the tag id case-insensitively — don't assume a fixed key path. Any of them may be absent (an untagged recording is legitimate), so render "no source info available" instead of assuming they exist.

```js
import { parseBlob } from "music-metadata";

const meta = await parseBlob(file);
const tags = Object.values(meta.native ?? {}).flat();
const get = (name) =>
  tags.find((t) => new RegExp(`(^|/)${name}$`, "i").test(String(t.id)))?.value ?? null;

const title = meta.common?.title ?? get("title");  // "Hizo • Amina Cyu"
const url = get("url");                            // "https://example.com/page"
const date = get("date_recorded");                 // "2026-09-30" (UTC, date only)
```

## Handle missing tags gracefully

If the tagging step fails for a given recording (rare, but possible), the extension falls back to saving the raw, **untagged** file rather than losing the recording. So a file can legitimately have none of these tags — check for their presence and show something like "no source info available" instead of assuming every upload has them.
