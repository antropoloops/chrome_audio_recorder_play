const titleEl = document.getElementById("title");
const statusEl = document.getElementById("status");
const button = document.getElementById("toggle");
const errorEl = document.getElementById("error");
const hintEl = document.getElementById("hint");

const SPOTIFY_HINT =
  "Si grabas en Spotify, busca la página de la canción hasta que te aparezca aquí el título";

let timerInterval;

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  clearInterval(timerInterval);
  button.disabled = false;

  const { recording } = await chrome.storage.session.get("recording");
  document.body.classList.toggle("recording", !!recording);
  hintEl.style.display = "none";

  if (recording) {
    titleEl.textContent = recording.title || "(sin título)";
    button.textContent = "Detener grabación";
    button.onclick = stopRecording;
    const tick = () => {
      statusEl.textContent = `Grabando… ${formatElapsed(Date.now() - recording.startTime)}`;
    };
    tick();
    timerInterval = setInterval(tick, 500);
    return;
  }

  statusEl.textContent = "";
  const tab = await getActiveTab();
  titleEl.textContent = tab?.title || "(sin pestaña activa)";
  button.textContent = "Empezar grabación";
  button.onclick = () => startRecording(tab);

  const isSpotify = tab?.url && new URL(tab.url).hostname.endsWith("open.spotify.com");
  hintEl.textContent = SPOTIFY_HINT;
  hintEl.style.display = isSpotify ? "block" : "none";
}

async function startRecording(tab) {
  errorEl.style.display = "none";
  button.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "start-recording",
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
  });
  if (response?.error) {
    errorEl.textContent = response.error;
    errorEl.style.display = "block";
  }
  render();
}

async function stopRecording() {
  button.disabled = true;
  statusEl.textContent = "Deteniendo…";
  await chrome.runtime.sendMessage({ type: "stop-recording" });
  // Don't render() here: saving still runs in the background, and
  // `recording` is only cleared from storage once it's done. The
  // storage.onChanged listener below refreshes the UI at that point.
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session") return;
  if (changes.lastError) {
    errorEl.textContent = changes.lastError.newValue;
    errorEl.style.display = "block";
    chrome.storage.session.remove("lastError");
  }
  render();
});

render();
