const MEDIA_EXTENSIONS = /\.(mov|mp4|m4v|avi|mkv|wmv|flv|wav|mp3|webm|flac|m4a|ogg)$/i;

export function cleanTitle(title, url) {
  let cleaned = (title || "").trim();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a real URL (e.g. a chrome:// page); leave the title as-is.
  }

  if (host === "www.youtube.com" || host === "youtube.com" || host === "youtu.be") {
    cleaned = cleaned.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "");
  }

  // Some uploaders leave the original filename (extension included) as the
  // title; that extension has no place in our own filename or tags.
  return cleaned.replace(MEDIA_EXTENSIONS, "");
}

const INVALID_FILENAME_CHARS = new RegExp(`[\\\\/:*?"<>|${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");

export function sanitizeFilename(str) {
  return str.replace(INVALID_FILENAME_CHARS, "").trim().slice(0, 150);
}

export function buildFilename(date, title) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const safeTitle = sanitizeFilename(title) || "recording";
  return `${stamp} ${safeTitle}.webm`;
}
