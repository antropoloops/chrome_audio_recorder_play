# Reading recording metadata (for the web app)

This extension records audio as a standard WebM (Matroska) file. Metadata about the recording's source is stored inside the file itself, as file-level Matroska tags — no separate sidecar file.

## Format

Tags are `SimpleTag` elements at target level 50 ("whole file", not per-track), written via the [Mediabunny](https://mediabunny.dev/) library during a remux step right after recording stops.

## Tags and values

| Tag key | Value | Notes |
|---|---|---|
| `TITLE` | Cleaned tab title (string) | Also exposed as the normalized `common.title` field by most metadata readers |
| `URL` | The tab's URL at the moment recording started (string) | Full `https://...` URL. Not guaranteed to be a deep link — e.g. on Spotify, if the user starts a track from the Home feed rather than the track's own page, this will just be `https://open.spotify.com/` |
| `DATE_RECORDED` | Recording date, `YYYY-MM-DD` (UTC) | Date only, no time component |

## How to read them

Use `music-metadata`'s `parseBlob()` on the uploaded file, then search `metadata.native` (flattened across all its format keys, since the exact native key name isn't guaranteed stable across library versions) for a tag whose `id` matches `URL` / `DATE_RECORDED` case-insensitively. Don't assume a fixed native key path.

```js
import { parseBlob } from "music-metadata";

const metadata = await parseBlob(file);
const allTags = Object.values(metadata.native).flat();
const urlTag = allTags.find((tag) => /^url$/i.test(tag.id));
const url = urlTag?.value;
```

## Handle missing tags gracefully

If the tagging step fails for a given recording (rare, but possible), the extension falls back to saving the raw, **untagged** file rather than losing the recording. So a file can legitimately have none of these tags — check for their presence and show something like "no source info available" instead of assuming every upload has them.
