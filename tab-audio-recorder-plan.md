# Tab Audio Recorder: Project Plan

## Goal

A Chrome extension that records short audio fragments from a browser tab (mainly YouTube and Spotify) for research. Each recording stores its title and the original page URL **inside the WebM file**, so a web app can later read and display the source. The extension will be published as **Unlisted** in the Chrome Web Store and shared by link with people I know, including on Chromebooks.

## Decisions made

| Topic | Decision |
|---|---|
| Distribution | Chrome Web Store, **Unlisted** visibility, shared by link |
| Audio format | **WebM** (Opus codec), recorded with Chrome's built-in `MediaRecorder` |
| Code style | As simple and readable as possible: plain JavaScript, no frameworks, no minification |
| Title source | The tab's own title, read when recording starts, and not updated again even if it changes mid-recording |
| Traceability | The page URL is stored in the WebM file's **`URL` tag**. **No sidecar files.** |
| Reading the URL | A web app in Chrome reads the tag with the **`music-metadata`** library |
| Library for writing tags | **Mediabunny** — see "Why Mediabunny" below |

### Why Mediabunny (resolved open decision)

- It has a real metadata API (`Output.setMetadataTags()`) with normalized fields (`title`, `date`, `comment`, …) plus a `raw` field for arbitrary tags such as our custom `URL` tag.
- `ts-ebml` has no tag-writing API at all — every library built on it (webm-duration-fix, fix-webm-meta, fix-webm-duration) only patches in Duration/Cues. Writing `Tags`/`SimpleTag` elements by hand would mean hand-encoding raw EBML, which is a real corruption risk for a "simple and robust" goal.
- Mediabunny can **remux** the `MediaRecorder` output (`Input` → `Conversion` → `Output`, copying the encoded Opus packets instead of re-encoding them) into a freshly-built, correctly-structured WebM file. This is more robust than patching the original in place: Duration, SeekHead and Cues come out correct as a side effect of building a proper container, and duration-fixing and tag-writing collapse into one library instead of two.
- Zero dependencies, MPL-2.0 licensed, and it ships a script-tag build exposing a global — drops into `lib/` with no build step and no CDN, matching the Web Store rule below. MPL-2.0 only requires keeping its license notice (add a line to Phase 6 prep and a `LICENSE-mediabunny.txt` next to it in `lib/`).

### Why capture the title once, at start (resolved open decision)

Re-reading the title at stop and reconciling it with the start title adds a second code path for a case (a Spotify track change mid-recording) that has no clean "correct" answer anyway — which song should own the clip? Simpler and more robust to capture once at start and document the mid-recording track change as a known limitation (see Risks).

## Metadata written into each WebM file

| Where in the file | Field | Value |
|---|---|---|
| Segment info | `Duration` | The recording length (Chrome leaves this out; Mediabunny fills it in as part of the remux) |
| Tags (`setMetadataTags`) | `title` | The cleaned tab title |
| Tags (`raw`) | `URL` | The page URL |
| Tags (`raw`) | `DATE_RECORDED` | The start date, `YYYY-MM-DD` (UTC) |

**Title cleaning:** for YouTube, remove the "(3) " counter and the " - YouTube" suffix.

**File name pattern:** `YYYY-MM-DD HH-MM-SS <title>.webm`, with characters that are invalid in file names removed and a length limit applied.

## Architecture of the extension (Manifest V3)

| File | Role |
|---|---|
| `manifest.json` | Extension definition and permissions |
| `popup.html` / `popup.js` | Start/Stop button, current title, recording timer |
| `service-worker.js` | Coordinates start/stop, saves the file, sets the "REC" badge |
| `offscreen.html` / `offscreen.js` | Records with `MediaRecorder`, then writes the tags and duration |
| `lib/` | Mediabunny's script-tag build (global `Mediabunny`), **bundled inside the extension**, plus its MPL-2.0 license notice |

**Web Store rule:** the library must be a local file in the extension, never loaded from a CDN. Loading remote code is a common removal reason. Mediabunny ships a browser build usable via a plain `<script>` tag, so no build step is needed.

### Permissions and their justification (needed for the Web Store dashboard)

| Permission | Why |
|---|---|
| `tabCapture` | Capture the audio of the current tab |
| `offscreen` | Record in a hidden page, since the service worker can't use `MediaRecorder` |
| `downloads` | Save the recording to the Downloads folder |
| `activeTab` | Read the title and URL of the tab the user chose to record, with no warning |
| `storage` | Remember that a recording is in progress when the popup is reopened |

The extension needs no host permissions, no remote code, no analytics and no network access.

## How a recording works

1. The user opens the page, starts playback, and clicks the extension icon.
2. The popup reads the tab's title and URL and asks Chrome for a capture stream ID.
3. The service worker opens the offscreen document and passes it the stream ID and metadata.
4. The offscreen document records the audio and plays it back to the speakers, since capture mutes the tab otherwise.
5. When the user clicks Stop, the offscreen document writes the title, URL, date and duration into the WebM file.
6. The file is saved to `Downloads/TabRecordings/`, then the badge is cleared and the offscreen document is closed.

## Web app: reading the URL

The browser has no built-in API for WebM tags, so the web app uses `music-metadata` to parse the uploaded file. Sketch (not final; I'm not 100% certain of the exact shape of `metadata.native` for WebM, so the code searches for the tag instead of assuming its key):

```js
import { parseBlob } from "https://cdn.jsdelivr.net/npm/music-metadata/+esm";

input.addEventListener("change", async () => {
  const file = input.files[0];
  const metadata = await parseBlob(file);

  const allTags = Object.values(metadata.native).flat();
  const urlTag = allTags.find((tag) => /url$/i.test(tag.id));
  const url = urlTag ? String(urlTag.value) : null;

  if (url && /^https?:\/\//.test(url)) {
    link.href = url;
    link.textContent = metadata.common.title || url;
  } else {
    link.textContent = "No source URL found";
  }
});
```

Rules for the web app:

- **Links:** only show the URL as a link if it starts with `http://` or `https://`, to block harmful `javascript:` links.
- **Missing tags:** handle files without a `URL` tag, since converting or re-encoding a file may drop its tags.
- **CDN loading:** loading the library from a CDN is fine here, because this rule only applies to the extension. I believe current `music-metadata` works directly in the browser, but I'm not certain; older versions needed a separate browser package.
- **Tag names:** the extension and the web app must agree on the tag name `URL`. The search above ignores capitalization in case a tool changes it.

## Phases

0. **Spotify capture sanity check.** Before building anything, manually confirm `tabCapture` actually captures Spotify web player audio (a few lines in the DevTools console are enough). If it doesn't, the plan's scope changes, so this needs to be settled first, cheaply.
1. **Prove the reading side first.** Create one test WebM with a `URL` tag on a computer (for example with `ffmpeg`), then confirm the web app code reads it. Log `metadata.native` once to see the exact tag structure.
2. **Core recording.** Start/Stop, audio playback while recording, saving the WebM file.
3. **Tag writing.** Bundle Mediabunny into `lib/`, and use its remux pipeline (`Input` → `Conversion` → `Output` with `setMetadataTags()`) to write the title, URL, date and duration.
4. **End-to-end check.** Record with the extension, then load the file in the web app and confirm the URL appears. Also check with `ffprobe` or VLC.
5. **Testing.** Run the checklist below on my own Chromebook, loading the extension unpacked.
6. **Web Store preparation.** Create the developer account, icons (128 px), a screenshot, the description, the permission justifications, the privacy form ("no data collected"), a short privacy policy, and the Mediabunny MPL-2.0 attribution notice.
7. **Publishing.** Submit as Unlisted, share the link, and publish updates by increasing the version number and resubmitting.

## Test checklist

- [x] YouTube video: the audio is recorded, and the `URL` and `Title` tags are correct. (confirmed via `ffprobe`)
- [x] Spotify web player: the audio is recorded, and the title is correct. (confirmed; see the generic-URL limitation in Risks)
- [x] The saved file shows its duration and can be read by `ffprobe`.
- [x] The tab keeps playing sound while recording.
- [x] A recording that hits the 2-minute limit auto-stops cleanly and still saves correctly, including tags.
- [x] Closing the tab during a recording still saves a tagged file. (fixed: the audio track's `ended` event now auto-stops the recording instead of leaving the UI timer running with no more audio coming in)
- [x] Reopening the popup during a recording shows the timer and the Stop button.
- [x] Starting on a page where capture isn't allowed (for example `chrome://` pages) shows a clear error. (fixed: non-`http(s)` tabs are now rejected upfront with a clear message, since `tabCapture` itself doesn't error there — it just captures silence)
- [x] Titles with unusual characters (emoji, accents) are stored and read correctly, confirmed via `ffprobe`.

(The original checklist's "web app shows the correct URL" item is dropped — the companion web app is out of scope per decision. "30+ minute recording" is superseded by the 2-minute limit.)

## Risks and uncertainties

- **Spotify copy protection:** resolved — `tabCapture` does record Spotify's audio, confirmed in testing.
- **Spotify title format:** confirmed as "Song • Artist" while playing.
- **Mid-recording track change:** since the title is only captured at start (see decision above), a Spotify recording that spans a track change will be tagged with the song that was playing when Start was clicked, not the one playing at Stop.
- **Spotify's generic home-page URL:** Spotify's web player is a single-page app, so playing a track straight from the Home feed doesn't change the tab's URL — the recorded `URL` tag will just be `https://open.spotify.com/`, not a link to that track. To get a real per-track link, navigate into the track's/album's/artist's own page in Spotify before hitting Start. Not fixed in code on purpose: a real fix would need a content script scraping Spotify's "now playing" DOM, which requires a host permission and is fragile against Spotify UI changes — not worth it for this extension's scope.
- **Tag visibility:** many music players and file browsers don't display WebM tags. The web app and tools like VLC or `ffprobe` should, which I believe but haven't verified.
- **Lost tags:** converting or re-encoding a recording may remove the URL.
- **Memory:** the remux step processes the whole file in memory, which is fine for short research fragments (this plan's actual use case) but would need a streaming/chunked approach if the scope ever grows to long recordings (e.g. full podcasts) — treat that as a scope change, not something to design for now.
- **Web Store removal:** a minimal, transparent extension is unlikely to be removed, but there's no guarantee. The manifest `description` and the popup now both state the educational/personal-research purpose explicitly (see "Educational-use framing" below). This is a transparency step, not a guarantee: Chrome Web Store review is driven by the extension's actual behavior and permissions, not by a self-declared purpose, so it doesn't by itself exempt the extension from copyright or ToS scrutiny.
- **Developer fee:** I believe it's a one-time $5, but I'm not certain that's still current.
- **Review time:** it varies, typically days to a couple of weeks (not certain).
- **Privacy policy:** I'm not certain it's required when no data is collected, but including one avoids problems.
- **Managed Chromebooks:** a school or work administrator may block the extension.
- **Legal and terms of service:** recording may be restricted by site terms or local law. The popup footer now carries a one-line reminder ("Respeta los derechos de autor").

### Educational-use framing

To keep the extension's stated purpose explicit and consistent everywhere a reviewer or user would see it:
- `manifest.json`'s `description` states it's for educational and personal research use.
- The popup footer repeats this plus a copyright reminder, visible on every open.

## Note

A draft implementation was written earlier in this conversation, before this plan was approved. It saves a JSON sidecar file, which this plan replaces with WebM tags, so treat it as a prototype to revise rather than final code.
