import { cleanTitle, buildFilename } from "./util.js";
import {
  Input,
  Output,
  Conversion,
  BlobSource,
  BufferTarget,
  MkvOutputFormat,
  WEBM,
} from "./lib/mediabunny.min.mjs";

const RECORDING_LIMIT_MS = 2 * 60 * 1000; // this extension is for short fragments, not long recordings

let mediaRecorder;
let chunks = [];
let audioEl;
let currentMeta = null;
let maxDurationTimer = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "offscreen-stop") {
    stopCapture();
  }
});

startCapture();

async function startCapture() {
  const params = new URLSearchParams(location.search);
  const streamId = params.get("streamId");
  currentMeta = {
    title: params.get("title"),
    url: params.get("url"),
    startTime: Number(params.get("startTime")),
  };
  chunks = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    // If the captured tab closes, the track ends on its own — stop the
    // recording right away instead of letting the UI timer run on with
    // no more audio actually coming in.
    stream.getAudioTracks()[0].onended = stopCapture;

    // Capturing the tab mutes it, so play the stream back to the speakers.
    audioEl = new Audio();
    audioEl.srcObject = stream;
    audioEl.play();

    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => saveRecording(stream);
    mediaRecorder.start();

    maxDurationTimer = setTimeout(stopCapture, RECORDING_LIMIT_MS);
  } catch (err) {
    console.error("[offscreen] startCapture failed:", err);
    chrome.runtime.sendMessage({
      type: "offscreen-error",
      message: `No se pudo iniciar la grabación: ${err.message || err}`,
    });
  }
}

function stopCapture() {
  clearTimeout(maxDurationTimer);
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    // Nothing is actually recording (e.g. startCapture never got this far) —
    // report it as done anyway so the popup/badge never gets stuck.
    chrome.runtime.sendMessage({ type: "offscreen-error", message: "No había ninguna grabación en curso." });
    return;
  }
  mediaRecorder.stop();
}

async function saveRecording(stream) {
  stream.getTracks().forEach((track) => track.stop());
  audioEl.pause();
  audioEl.srcObject = null;

  const rawBlob = new Blob(chunks, { type: "audio/webm" });
  const { title, url, startTime } = currentMeta;
  const cleaned = cleanTitle(title, url);
  const filename = "TabRecordings/" + buildFilename(new Date(startTime), cleaned);

  let blobToSave = rawBlob;
  try {
    blobToSave = await tagRecording(rawBlob, { title: cleaned, url, startTime });
  } catch (err) {
    // Save the untagged recording rather than losing it if tagging fails.
    console.error("[offscreen] tagging failed, saving untagged file:", err);
  }

  // chrome.downloads isn't available inside an offscreen document, so we
  // create the blob URL here (offscreen documents can do that; service
  // workers can't) and hand it to the service worker to actually download.
  const blobUrl = URL.createObjectURL(blobToSave);
  chrome.runtime.sendMessage({ type: "recording-ready", blobUrl, filename });
}

async function tagRecording(rawBlob, { title, url, startTime }) {
  const input = new Input({
    formats: [WEBM],
    source: new BlobSource(rawBlob),
  });
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat(), target });

  const conversion = await Conversion.init({
    input,
    output,
    tags: {
      title,
      raw: {
        URL: url,
        DATE_RECORDED: new Date(startTime).toISOString().slice(0, 10),
      },
    },
  });
  await conversion.execute();

  return new Blob([target.buffer], { type: "audio/webm" });
}
