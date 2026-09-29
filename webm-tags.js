// webm-tags.js — dependency-free WebM (EBML) metadata for Tab Audio Recorder.
//
// A recording straight out of MediaRecorder is already a complete WebM:
//
//   [EBML header][Segment [Info][Tracks][Cluster ... audio ...]]
//
// Metadata lives in the region BEFORE the first Cluster, so it is embedded
// with byte surgery: the title goes inside Segment > Info (its spec-mandated
// place) and the tags block (Title/URL/DATE_RECORDED as SimpleTags) is
// spliced before the first Cluster. The audio bytes are copied verbatim —
// the recording is never demuxed or re-encoded.
//
// The tags block is serialized exactly like Mediabunny's (the format the
// current spec demuxers display): legacy 0x1254C367 wrapper > modern 0x7373
// master > Targets ("MOVIE") + one SimpleTag per value, with container sizes
// as fixed 4-byte VINTs.
//
// Public API:
//   await embedWebmMetadata(blob, { title, url, dateRecorded }) → Blob (tagged)
//   readWebmMetadata(arrayBufferOrUint8Array) → { docType, title, tags } | null
//
// Robustness: refuses anything that doesn't look like a MediaRecorder-style
// WebM (unknown-size elements in the metadata region, or truncated boundaries).
// Seek structures (SeekHead/Cues) are OPTIONAL in WebM and their stored byte
// offsets would go stale after splicing, so the writer DROPS them and emits a
// minimal, index-free file — the same shape MediaRecorder streams before Stop.
// Callers are expected to keep the untagged recording if this throws.

// Element IDs as byte arrays (byte-wise comparison avoids marker ambiguity).
const ID_EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ID_DOCTYPE = [0x42, 0x82];
const ID_SEGMENT = [0x18, 0x53, 0x80, 0x67];
const ID_INFO = [0x15, 0x49, 0xa9, 0x66];
const ID_TITLE = [0x7b, 0xa9];
const ID_TAGS = [0x12, 0x54, 0xc3, 0x67];
const ID_TAG = [0x67, 0xe8];
const ID_TARGETS = [0x63, 0xc0];
const ID_SIMPLETAG = [0x67, 0xc8];
const ID_TAGNAME = [0x45, 0xa3];
const ID_TAGSTRING = [0x44, 0x87];
const ID_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const ID_SEEKHEAD = [0x11, 0x4d, 0x9b, 0x74];
const ID_CUES = [0x1c, 0x53, 0xbb, 0x6b];
// Inside Targets, a UID element scopes the Tag to a track/edition/etc.
// Global ("whole file") tags carry none of these.
const ID_TRACKUID = [0x63, 0xc4];
const ID_EDITIONUID = [0x63, 0xc9];
const ID_CHAPTERUID = [0x63, 0xc2];
const ID_ATTACHMENTUID = [0x63, 0xc6];

// The inner 0x7373 "Tags" master (modern Matroska spec) that demuxers read.
const ID_TAGSMODERN = [0x73, 0x73];

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function concatParts(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function idMatches(bytes, at, id) {
  if (at + id.length > bytes.length) return false;
  for (let i = 0; i < id.length; i++) if (bytes[at + i] !== id[i]) return false;
  return true;
}

// EBML data-size VINT. Pass fixedWidth (>0) to force a non-minimal width —
// mediabunny writes container sizes as fixed 4-byte VINTs and we mirror it.
function vintSize(value, fixedWidth = 0) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Bad element size: ${value}`);
  let width = fixedWidth;
  if (!width) {
    width = 1;
    while (value > 2 ** (7 * width) - 2) width++; // all-ones would mean "unknown"
  }
  if (value > 2 ** (7 * width) - 2) {
    throw new Error(`Value ${value} does not fit a ${width}-byte VINT.`);
  }
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i > 0; i--) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  out[0] = (0x80 >> (width - 1)) | rest;
  return out;
}

function el(id, payload) {
  return concatParts([Uint8Array.from(id), vintSize(payload.length), payload]);
}

// Element with a forced size-VINT width.
function elw(id, payload, width) {
  return concatParts([Uint8Array.from(id), vintSize(payload.length, width), payload]);
}

// Copy bytes [a, b) while dropping the given sorted, non-overlapping [s,e) ranges.
function copySkipping(bytes, a, b, skips) {
  const parts = [];
  let pos = a;
  for (const [s, e] of skips) {
    if (e <= pos || s >= b) continue;
    if (s > pos) parts.push(bytes.subarray(pos, Math.min(s, b)));
    pos = Math.max(pos, Math.min(e, b));
    if (pos >= b) break;
  }
  if (pos < b) parts.push(bytes.subarray(pos, b));
  return parts;
}

// Reads one element header; returns { hdrStart, payloadStart, payloadEnd, known }.
// Size VINTs: the first byte carries (8 - width) value bits, the rest full
// bytes; all value bits set == "unknown size" (MediaRecorder's Segment).
function readElementHeader(bytes, pos, end) {
  if (pos >= end) return null;
  const first = bytes[pos];
  if (first === 0) throw new Error(`Invalid EBML element at offset ${pos} (corrupt file).`);
  const idLength = Math.clz32(first) - 23;
  const idEnd = pos + idLength;
  if (idEnd >= end) throw new Error("Truncated EBML header.");
  const sizeFirst = bytes[idEnd];
  const sizeLength = Math.clz32(sizeFirst) - 23;
  if (sizeLength > 8) throw new Error(`Invalid EBML size field (width ${sizeLength}) at offset ${idEnd}.`);
  const payloadStart = idEnd + sizeLength;
  if (payloadStart > end) throw new Error("Truncated EBML size field.");
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === (0xff >> sizeLength);
  for (let i = idEnd + 1; i < payloadStart; i++) {
    size = size * 256 + bytes[i];
    allOnes = allOnes && bytes[i] === 0xff;
  }
  if (!allOnes && size > Number.MAX_SAFE_INTEGER) {
    throw new Error("EBML element size exceeds safe integer range (corrupt file).");
  }
  const known = !allOnes;
  return {
    hdrStart: pos,
    payloadStart,
    payloadEnd: known ? payloadStart + size : end,
    known,
  };
}

// Yields consecutive same-level elements; an unknown-size element runs to the
// end of the scan region and terminates the iteration.
function* iterateElements(bytes, start, end) {
  let pos = start;
  while (pos < end) {
    const current = readElementHeader(bytes, pos, end);
    if (!current) break;
    if (!current.known) {
      current.payloadEnd = end;
      yield current;
      break;
    }
    yield current;
    pos = current.payloadEnd;
  }
}

function decodeUtf8(bytes, from, to) {
  return dec.decode(bytes.subarray(from, to));
}

// ---------------------------------------------------------------------------
// Tags serialization (mirror of the layout real demuxers read back)
// ---------------------------------------------------------------------------

// Tags block in mediabunny's verified shape:
//   1254c367 (legacy wrapper) > 7373 (modern master, title/url/date…) >
//   Targets (one per file: type "MOVIE") + one SimpleTag per pair.
// Container size VINTs are fixed 4-byte; leaf strings use minimal VINTs.
function buildTagsElement(pairs) {
  const simpleTags = pairs.map(([name, value]) =>
    elw(ID_SIMPLETAG, concatParts([
      el(ID_TAGNAME, enc.encode(name)),
      el(ID_TAGSTRING, enc.encode(value)),
    ]), 4)
  );
  const targets = elw(ID_TARGETS, concatParts([
    elw([0x68, 0xca], Uint8Array.of(50), 1),
    elw([0x63, 0xca], enc.encode("MOVIE"), 1),
  ]), 4);
  return elw(ID_TAGS, elw(ID_TAGSMODERN, concatParts([targets, ...simpleTags]), 4), 4);
}

// ---------------------------------------------------------------------------
// Reader (used by webapp-metadata-spec.md consumers; inverse of the writer)
// ---------------------------------------------------------------------------

// Reads back the metadata embedded by embedWebmMetadata (and by Mediabunny
// files, which use the same modern tags block). Returns
//   { docType, title, tags: { TITLE, URL, DATE_RECORDED, ... } }
// or null when the input is not a WebM/Matroska file. The tags object has a
// null prototype, so names colliding with Object.prototype keys are safe.
export function readWebmMetadata(source) {
  try {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (!idMatches(bytes, 0, ID_EBML)) return null;
    const head = readElementHeader(bytes, 0, bytes.length);
    if (!head) return null;
    let docType = null;
    for (const c of iterateElements(bytes, head.payloadStart, head.payloadEnd)) {
      if (idMatches(bytes, c.hdrStart, ID_DOCTYPE)) {
        docType = decodeUtf8(bytes, c.payloadStart, c.payloadEnd).trim();
        break;
      }
    }
    const segment = readElementHeader(bytes, head.payloadEnd, bytes.length);
    if (!segment || !idMatches(bytes, segment.hdrStart, ID_SEGMENT)) return null;
    const scanEnd = segment.known
      ? Math.min(segment.payloadEnd, bytes.length)
      : bytes.length;

    let title = null; // spec location: Segment > Info > Title
    let legacyTitle = null; // files written by earlier revisions (Segment-level)
    const tags = Object.create(null);
    for (const child of iterateElements(bytes, segment.payloadStart, scanEnd)) {
      if (idMatches(bytes, child.hdrStart, ID_CLUSTER)) break;

      if (idMatches(bytes, child.hdrStart, ID_TITLE) && child.known && legacyTitle === null) {
        legacyTitle = decodeUtf8(bytes, child.payloadStart, child.payloadEnd);
        continue;
      }
      if (idMatches(bytes, child.hdrStart, ID_INFO) && child.known && title === null) {
        for (const ic of iterateElements(bytes, child.payloadStart, child.payloadEnd)) {
          if (!ic.known) continue;
          if (idMatches(bytes, ic.hdrStart, ID_TITLE)) {
            title = decodeUtf8(bytes, ic.payloadStart, ic.payloadEnd);
            break;
          }
        }
        continue;
      }
      if (!idMatches(bytes, child.hdrStart, ID_TAGS) || !child.known) continue;

      // Tags container, both real-world shapes:
      //  - legacy: 0x1254C367 > 0x67E8 Tag > [Targets, SimpleTag]
      //  - modern: 0x1254C367 > 0x7373 > [Targets, SimpleTag…] (Mediabunny)
      for (const tag of iterateElements(bytes, child.payloadStart, child.payloadEnd)) {
        if (tag.known && idMatches(bytes, tag.hdrStart, ID_TAGSMODERN)) {
          for (const inner of iterateElements(bytes, tag.payloadStart, tag.payloadEnd)) {
            if (inner.known && idMatches(bytes, inner.hdrStart, ID_SIMPLETAG)) {
              collectSimpleTag(bytes, inner, tags);
            }
          }
        } else if (tag.known && idMatches(bytes, tag.hdrStart, ID_TAG)) {
          if (tagIsScoped(bytes, tag)) continue; // track/chapter-scoped: skip
          for (const st of iterateElements(bytes, tag.payloadStart, tag.payloadEnd)) {
            if (st.known && idMatches(bytes, st.hdrStart, ID_SIMPLETAG)) {
              collectSimpleTag(bytes, st, tags);
            }
          }
        }
      }
    }
    title = title ?? legacyTitle;
    return { docType, title: title ?? tags["TITLE"] ?? null, tags };
  } catch {
    return null; // corrupt/unparseable input is a read failure, not fatal
  }
}

function collectSimpleTag(bytes, st, tags) {
  let name = null;
  let value = null;
  for (const f of iterateElements(bytes, st.payloadStart, st.payloadEnd)) {
    if (!f.known) continue;
    if (name === null && idMatches(bytes, f.hdrStart, ID_TAGNAME)) {
      name = decodeUtf8(bytes, f.payloadStart, f.payloadEnd);
    } else if (idMatches(bytes, f.hdrStart, ID_TAGSTRING)) {
      value = decodeUtf8(bytes, f.payloadStart, f.payloadEnd);
    }
  }
  if (name !== null && !Object.hasOwn(tags, name)) tags[name] = value ?? "";
}

// A Tag scoped to a track/edition/chapter/attachment carries a UID in its
// Targets. Global tags don't.
function tagIsScoped(bytes, tag) {
  for (const tc of iterateElements(bytes, tag.payloadStart, tag.payloadEnd)) {
    if (!idMatches(bytes, tc.hdrStart, ID_TARGETS) || !tc.known) continue;
    for (const tt of iterateElements(bytes, tc.payloadStart, tc.payloadEnd)) {
      if (idMatches(bytes, tt.hdrStart, ID_TRACKUID)
        || idMatches(bytes, tt.hdrStart, ID_EDITIONUID)
        || idMatches(bytes, tt.hdrStart, ID_CHAPTERUID)
        || idMatches(bytes, tt.hdrStart, ID_ATTACHMENTUID)) {
        return true;
      }
    }
    break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Writer (extension)
// ---------------------------------------------------------------------------

// Embeds { title, url, dateRecorded } into a MediaRecorder WebM and returns a
// tagged Blob. The audio payload is byte-identical to the input. Throws for
// anything that isn't a writable MediaRecorder-style WebM — callers should
// fall back to saving the untagged file.
export async function embedWebmMetadata(source, { title, url, dateRecorded, extraTags = {} } = {}) {
  const bytes = await asBytes(source);

  if (!idMatches(bytes, 0, ID_EBML)) throw new Error("Not an EBML/WebM file.");
  const head = readElementHeader(bytes, 0, bytes.length);
  if (!head) throw new Error("Truncated EBML header.");
  const segment = readElementHeader(bytes, head.payloadEnd, bytes.length);
  if (!segment || !idMatches(bytes, segment.hdrStart, ID_SEGMENT)) {
    throw new Error("No Segment found.");
  }
  if (segment.known && segment.payloadEnd > bytes.length) {
    throw new Error("Truncated file: Segment size exceeds file length.");
  }

  const scanEnd = segment.known ? segment.payloadEnd : bytes.length;
  let clusterAt = null;
  let info = null;
  const skipRanges = []; // existing Segment-level Title / Tags — replaced
  const infoTitleSkips = []; // existing Title INSIDE Info (its spec location)
  let sawCluster = false;
  for (const child of iterateElements(bytes, segment.payloadStart, scanEnd)) {
    if (idMatches(bytes, child.hdrStart, ID_CLUSTER)) {
      if (!sawCluster) clusterAt = child.hdrStart;
      sawCluster = true;
      continue; // walk on: Cues often live AFTER the clusters
    }
    // Seek structures (SeekHead/Cues) are optional in WebM. Splicing bytes
    // would leave their stored offsets stale, so DROP them entirely and emit
    // a minimal, index-free file — the shape MediaRecorder streams before
    // Stop. An unknown-size one can't be bounded safely: refuse loudly.
    if (idMatches(bytes, child.hdrStart, ID_SEEKHEAD) || idMatches(bytes, child.hdrStart, ID_CUES)) {
      if (!child.known) throw new Error("Unknown-size SeekHead/Cues cannot be dropped safely.");
      skipRanges.push([child.hdrStart, child.payloadEnd]);
      continue;
    }
    if (!sawCluster) {
      // Metadata region, before the first Cluster — the layout matters here.
      if (!child.known) throw new Error("Unknown-size element before first Cluster.");
      if (child.payloadEnd > scanEnd) throw new Error("Truncated file: element extends past its parent.");
      if (idMatches(bytes, child.hdrStart, ID_INFO) && child.known) {
        info = child;
        for (const ic of iterateElements(bytes, child.payloadStart, child.payloadEnd)) {
          if (ic.known && idMatches(bytes, ic.hdrStart, ID_TITLE)) {
            infoTitleSkips.push([ic.hdrStart, ic.payloadEnd]);
          }
        }
      }
      if (idMatches(bytes, child.hdrStart, ID_TITLE) || idMatches(bytes, child.hdrStart, ID_TAGS)) {
        skipRanges.push([child.hdrStart, child.payloadEnd]);
      }
    }
  }
  skipRanges.sort((a, b) => a[0] - b[0]);
  const removed = [...skipRanges, ...infoTitleSkips].reduce((n, [s, e]) => n + (e - s), 0);

  const pairs = [];
  if (title) pairs.push(["TITLE", String(title)]);
  if (url) pairs.push(["URL", String(url)]);
  if (dateRecorded) pairs.push(["DATE_RECORDED", String(dateRecorded)]);
  for (const [name, value] of Object.entries(extraTags)) {
    if (value != null) pairs.push([name, String(value)]);
  }
  // Spec: Title lives inside Segment > Info — requires a known-size Info.
  const titleEl = title && info && info.known
    ? el(ID_TITLE, enc.encode(String(title)))
    : null;
  const tagsEl = pairs.length ? buildTagsElement(pairs) : null;
  const touchesInfo = info && info.known && (titleEl || infoTitleSkips.length > 0);
  if (!titleEl && !tagsEl && !touchesInfo) {
    return source; // nothing to embed — untouched
  }

  // Inserting inside Info changes its payload: Info's size field is
  // re-encoded (its VINT width may change).
  const infoOldSize = info ? info.payloadEnd - info.payloadStart : 0;
  const infoRemoved = infoTitleSkips.reduce((n, [s, e]) => n + (e - s), 0);
  const rebuildInfo = info && info.known && (titleEl || infoRemoved > 0);
  const infoNewVint = rebuildInfo
    ? vintSize(infoOldSize - infoRemoved + (titleEl?.length ?? 0))
    : null;
  const infoSizeVintDelta = rebuildInfo
    ? infoNewVint.length - (info.payloadStart - info.hdrStart - ID_INFO.length)
    : 0;
  const added = (titleEl?.length ?? 0) + (tagsEl?.length ?? 0);
  const tailStart = clusterAt ?? scanEnd;

  const parts = [];
  if (segment.known) {
    const size = (segment.payloadEnd - segment.payloadStart) - removed + added + infoSizeVintDelta;
    parts.push(
      bytes.subarray(0, segment.hdrStart),
      Uint8Array.from(ID_SEGMENT),
      vintSize(size),
    );
  } else {
    parts.push(bytes.subarray(0, segment.payloadStart)); // unknown size: verbatim
  }
  if (rebuildInfo) {
    parts.push(
      ...copySkipping(bytes, segment.payloadStart, info.hdrStart, skipRanges),
      Uint8Array.from(ID_INFO),
      infoNewVint,
      ...copySkipping(bytes, info.payloadStart, info.payloadEnd, infoTitleSkips),
      ...(titleEl ? [titleEl] : []), // last child of Info — spec placement
      ...copySkipping(bytes, info.payloadEnd, tailStart, skipRanges),
      ...(tagsEl ? [tagsEl] : []),
      ...copySkipping(bytes, tailStart, bytes.length, skipRanges),
    );
  } else {
    parts.push(
      ...copySkipping(bytes, segment.payloadStart, tailStart, skipRanges),
      ...(tagsEl ? [tagsEl] : []),
      ...copySkipping(bytes, tailStart, bytes.length, skipRanges),
    );
  }
  return new Blob([concatParts(parts)], { type: "audio/webm" });
}

async function asBytes(source) {
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof Uint8Array) return source;
  throw new Error("embedWebmMetadata: Blob, ArrayBuffer or Uint8Array expected.");
}