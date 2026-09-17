# Tab Audio Recorder

A Chrome extension that records short audio fragments (up to 2 minutes) from the current browser tab — for example a YouTube video or a Spotify track — for educational and personal research use. It is designed to use by the users of play.antropoloops.

Each recording keeps its source title and page URL **inside the WebM file itself**, as metadata tags, so there's no separate sidecar file to lose track of.

## How it works

1. Open the tab you want to record, start playback, and click the extension icon.
2. Click **Empezar grabación**. The tab keeps playing sound normally while it's being captured.
3. Click **Detener grabación** (or wait for the 2-minute limit) to stop.
4. The file is saved to `Downloads/TabRecordings/` as a `.webm` file named `YYYY-MM-DD <title>.webm`.

The saved file carries these metadata tags, readable with tools like `ffprobe` or VLC:

| Tag | Value |
|---|---|
| `title` | The cleaned tab title |
| `URL` | The page's URL at the time recording started |
| `DATE_RECORDED` | The recording date (`YYYY-MM-DD`) |

## Installing (unpacked)

This extension is distributed **Unlisted** on the Chrome Web Store, not published for public search. To load it manually instead:

1. Clone or download this repository.
2. Go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabCapture` | Captures the audio of the tab the user explicitly chooses to record |
| `offscreen` | `MediaRecorder` can't run in a Manifest V3 service worker, so recording happens in a hidden offscreen document |
| `downloads` | Saves the recorded file to the Downloads folder |
| `activeTab` | Reads the title and URL of the tab the user just clicked to record, with no extra permission warning |
| `storage` | Remembers that a recording is in progress if the popup is closed and reopened |

No host permissions, no remote code, no analytics, and no network access of any kind.

## Privacy

This extension does not collect, store, or transmit any user data. All processing happens locally in the browser; the recorded file goes straight to the user's own Downloads folder. See the full privacy policy linked from the Chrome Web Store listing.

## Third-party code

Tag writing uses [Mediabunny](https://mediabunny.dev/) (MPL-2.0), bundled locally in [`lib/`](lib/) — see [`lib/LICENSE-mediabunny.txt`](lib/LICENSE-mediabunny.txt).

## Disclaimer

This tool is for educational and personal research use. Recording audio may be restricted by a site's terms of service or by local law — it's the user's responsibility to respect those when choosing what to record.
