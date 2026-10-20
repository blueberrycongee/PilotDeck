import { gzipSync, gunzipSync } from "node:zlib";

const ENCODING = "pilotdeck-gzip-v1";
export const MAX_DECODED_TRANSCRIPT_RECORD_BYTES = 50 * 1024 * 1024;
const COMPRESSIBLE_TYPES = new Set([
  "assistant_message", "tool_result_message", "durable_message", "control_boundary",
]);

/** Keep identity outside the payload so JSONL scans can still identify records. */
export function encodeTranscriptLine(line: string): string {
  if (Buffer.byteLength(line) < 4096) return line;
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(line); } catch { return line; }
  if (!entry || !COMPRESSIBLE_TYPES.has(String(entry.type)) || entry.storageEncoding !== undefined) return line;
  if (Buffer.byteLength(line) > MAX_DECODED_TRANSCRIPT_RECORD_BYTES) return line;
  const { type, sessionId, turnId, sequence, createdAt, entryId, parentEntryId, ...payload } = entry;
  const encoded = JSON.stringify({
    type, sessionId, turnId, sequence, createdAt, entryId, parentEntryId,
    storageEncoding: ENCODING,
    storagePayload: gzipSync(Buffer.from(JSON.stringify(payload)), { level: 1 }).toString("base64"),
  });
  return Buffer.byteLength(encoded) < Buffer.byteLength(line) ? encoded : line;
}

/** Plain and encoded records may coexist, including after resuming a cold session. */
export function parseTranscriptLine(line: string): unknown {
  const entry = JSON.parse(line);
  if (!entry || typeof entry !== "object" || entry.storageEncoding === undefined) return entry;
  if (entry.storageEncoding !== ENCODING || typeof entry.storagePayload !== "string") {
    throw new Error("Unsupported transcript storage encoding");
  }
  const payload = JSON.parse(gunzipSync(Buffer.from(entry.storagePayload, "base64"), {
    maxOutputLength: MAX_DECODED_TRANSCRIPT_RECORD_BYTES,
  }).toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid transcript storage payload");
  const { storageEncoding, storagePayload, ...identity } = entry;
  return { ...payload, ...identity };
}
