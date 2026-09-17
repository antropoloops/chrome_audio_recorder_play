async function offscreenDocumentExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function openOffscreenDocument(startParams) {
  // Closing any leftover document first guarantees a fresh one, so the
  // params below are always read by the document we're about to create.
  if (await offscreenDocumentExists()) {
    await chrome.offscreen.closeDocument();
  }
  const query = new URLSearchParams(startParams).toString();
  await chrome.offscreen.createDocument({
    url: `offscreen.html?${query}`,
    reasons: ["USER_MEDIA"],
    justification: "Record and play back captured tab audio.",
  });
}

async function handleStart({ tabId, title, url }) {
  if (!/^https?:\/\//.test(url)) {
    return { error: "Esta pestaña no se puede grabar (no es una página web)." };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return { error: `No se puede grabar esta pestaña: ${err.message}` };
  }

  const startTime = Date.now();
  await chrome.storage.session.set({ recording: { tabId, title, url, startTime } });
  // Passing the start data via the document's URL (read synchronously on
  // load) instead of a follow-up message avoids a race where the message
  // could arrive before the offscreen document's listener was ready.
  await openOffscreenDocument({ streamId, title, url, startTime: String(startTime) });

  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#c00000" });
  return { ok: true };
}

async function handleStop() {
  chrome.runtime.sendMessage({ type: "offscreen-stop" }).catch(() => {});
  return { ok: true };
}

async function closeOffscreenDocumentIfOpen() {
  if (await offscreenDocumentExists()) {
    await chrome.offscreen.closeDocument();
  }
}

async function resetState() {
  await chrome.storage.session.remove("recording");
  chrome.action.setBadgeText({ text: "" });
  await closeOffscreenDocumentIfOpen();
}

function waitForDownloadToFinish(downloadId) {
  return new Promise((resolve) => {
    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function handleDownload({ blobUrl, filename }) {
  const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });

  // Update the UI right away, but keep the offscreen document (and the blob
  // URL it owns) alive until Chrome has actually finished reading the file —
  // closing it too early breaks the download mid-read.
  await chrome.storage.session.remove("recording");
  chrome.action.setBadgeText({ text: "" });

  await waitForDownloadToFinish(downloadId);
  await closeOffscreenDocumentIfOpen();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "start-recording") {
    handleStart(message).then(sendResponse);
    return true;
  }
  if (message.type === "stop-recording") {
    handleStop().then(sendResponse);
    return true;
  }
  if (message.type === "recording-ready") {
    handleDownload(message);
  }
  if (message.type === "offscreen-error") {
    console.error("Recording failed:", message.message);
    chrome.storage.session.set({ lastError: message.message }).then(resetState);
  }
});
