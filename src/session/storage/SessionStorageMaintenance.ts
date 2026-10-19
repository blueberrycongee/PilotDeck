import { lstat, open, readdir, readFile, writeFile, rename, rm, utimes } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeTranscriptLine } from "../transcript/TranscriptStorageCodec.js";
import { hasOpenTranscriptWriter, withTranscriptFileLock } from "./TranscriptFileLock.js";

export type SessionStorageMaintenanceResult = {
  scanned: number;
  compressed: number;
  bytesBefore: number;
  bytesAfter: number;
  failures: Array<{ path: string; message: string }>;
};

/** Cold history remains JSONL; prompts/metadata stay plain for bounded list reads. */
export async function maintainSessionStorage(options: {
  pilotHome: string;
  idleDays?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  maxFiles?: number;
}): Promise<SessionStorageMaintenanceResult> {
  const days = options.idleDays ?? 30;
  if (!Number.isFinite(days) || days <= 0) throw new Error("idleDays must be positive");
  const maxFiles = options.maxFiles ?? 32;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error("maxFiles must be a positive integer");
  const cursorPath = join(options.pilotHome, ".session-storage-cursor.json");
  const cursor = options.dryRun ? "" : await readFile(cursorPath, "utf8").catch(() => "");
  let lastScanned = "";
  const saveCursor = async (value: string): Promise<void> => {
    if (options.dryRun) return;
    const temporary = `${cursorPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, cursorPath);
    } finally { await rm(temporary, { force: true }); }
  };
  const cutoff = Date.now() - days * 86_400_000;
  const result: SessionStorageMaintenanceResult = { scanned: 0, compressed: 0, bytesBefore: 0, bytesAfter: 0, failures: [] };
  const projects = join(options.pilotHome, "projects");
  const projectDirs = await readdir(projects, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const project of projectDirs.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!project.isDirectory()) continue;
    const chats = join(projects, project.name, "chats");
    for await (const path of transcriptFiles(chats)) {
      if (path <= cursor) continue;
      if (options.signal?.aborted || result.scanned >= maxFiles) {
        await saveCursor(lastScanned || cursor);
        return result;
      }
      lastScanned = path;
      result.scanned++;
      try {
        if (hasOpenTranscriptWriter(path)) continue;
        const initial = await lstat(path);
        if (!initial.isFile() || initial.size < 4096 || initial.size > 50 * 1024 * 1024 || initial.mtimeMs > cutoff) continue;
        await withTranscriptFileLock(path, async () => {
          if (hasOpenTranscriptWriter(path)) return;
          const before = await lstat(path);
          if (!before.isFile() || before.mtimeMs > cutoff || before.size !== initial.size || before.mtimeMs !== initial.mtimeMs) return;
          const markerPath = `${path}.storage-state.json`;
          const fingerprint = (stat: typeof before): string => JSON.stringify([1, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
          if (await readFile(markerPath, "utf8").catch(() => "") === fingerprint(before)) return;
          const markProcessed = async (): Promise<void> => {
            if (!options.dryRun) await writeFile(markerPath, fingerprint(await lstat(path)), { mode: 0o600 });
          };
          // A prepared edit owns the history until commit/rollback completes.
          const names = await readdir(dirname(path));
          const name = basename(path, ".jsonl");
          if (names.some(item => item.startsWith(`.${name}.`) && item.endsWith(".replace.json"))) return;
          const temporary = `${path}.${randomUUID()}.compress.tmp`;
          const output = options.dryRun ? undefined : await open(temporary, "wx", 0o600);
          const stream = createReadStream(path, { encoding: "utf8" });
          const reader = createInterface({ input: stream, crlfDelay: Infinity });
          let bytesAfter = 0;
          let changed = false;
          try {
            for await (const line of reader) {
              options.signal?.throwIfAborted();
              const encoded = encodeTranscriptLine(line);
              changed ||= encoded !== line;
              const data = `${encoded}\n`;
              bytesAfter += Buffer.byteLength(data);
              if (output) await output.writeFile(data);
            }
            if (!changed || bytesAfter >= before.size) {
              await markProcessed();
              return;
            }
            if (output) {
              await output.sync();
              await output.close();
              await utimes(temporary, before.atime, before.mtime);
              const current = await lstat(path);
              if (current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) return;
              await rename(temporary, path);
            }
            await markProcessed();
            result.compressed++;
            result.bytesBefore += before.size;
            result.bytesAfter += bytesAfter;
          } finally {
            reader.close();
            stream.destroy();
            await output?.close();
            if (output) await rm(temporary, { force: true });
          }
        });
      } catch (error) {
        if (options.signal?.aborted) {
          await saveCursor(lastScanned);
          return result;
        }
        result.failures.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (projectDirs.length > 0) await saveCursor("");
  return result;
}

async function* transcriptFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const sortKey = (entry: typeof entries[number]): string => entry.name + (entry.isDirectory() ? "/" : "");
  for (const entry of entries.sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) yield join(directory, entry.name);
    // Session sidechains live at chats/<session>/subagents/*.jsonl.
    if (entry.isDirectory() && !entry.name.endsWith(".storage-lock")) {
      const subagents = join(directory, entry.name, "subagents");
      const children = await readdir(subagents, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) if (child.isFile() && child.name.endsWith(".jsonl")) yield join(subagents, child.name);
    }
  }
}

export function startSessionStorageMaintenance(pilotHome: string): () => void {
  const controller = new AbortController();
  let running = false;
  const run = async (): Promise<void> => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const result = await maintainSessionStorage({ pilotHome, signal: controller.signal });
      for (const failure of result.failures) console.warn("[session-storage]", failure.path, failure.message);
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[session-storage]", error);
    } finally { running = false; }
  };
  const startup = setTimeout(() => void run(), 60_000);
  const interval = setInterval(() => void run(), 6 * 60 * 60_000);
  startup.unref();
  interval.unref();
  return () => { controller.abort(); clearTimeout(startup); clearInterval(interval); };
}
