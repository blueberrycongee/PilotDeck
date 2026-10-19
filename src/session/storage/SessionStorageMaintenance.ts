import { lstat, open, readdir, rename, rm, utimes } from "node:fs/promises";
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
  const cutoff = Date.now() - days * 86_400_000;
  const result: SessionStorageMaintenanceResult = { scanned: 0, compressed: 0, bytesBefore: 0, bytesAfter: 0, failures: [] };
  const projects = join(options.pilotHome, "projects");
  const projectDirs = await readdir(projects, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const chats = join(projects, project.name, "chats");
    for await (const path of transcriptFiles(chats)) {
      if (options.signal?.aborted || result.compressed >= (options.maxFiles ?? 32)) return result;
      result.scanned++;
      try {
        if (hasOpenTranscriptWriter(path)) continue;
        const initial = await lstat(path);
        if (!initial.isFile() || initial.size < 4096 || initial.size > 50 * 1024 * 1024 || initial.mtimeMs > cutoff) continue;
        await withTranscriptFileLock(path, async () => {
          if (hasOpenTranscriptWriter(path)) return;
          const before = await lstat(path);
          if (!before.isFile() || before.mtimeMs > cutoff || before.size !== initial.size || before.mtimeMs !== initial.mtimeMs) return;
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
            if (!changed || bytesAfter >= before.size) return;
            if (output) {
              await output.sync();
              await output.close();
              await utimes(temporary, before.atime, before.mtime);
              const current = await lstat(path);
              if (current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) return;
              await rename(temporary, path);
            }
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
        if (options.signal?.aborted) return result;
        result.failures.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}

async function* transcriptFiles(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) yield join(directory, entry.name);
    // Session sidechains live at chats/<session>/subagents/*.jsonl.
    if (entry.isDirectory() && !entry.name.endsWith(".storage-lock")) {
      const subagents = join(directory, entry.name, "subagents");
      const children = await readdir(subagents, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const child of children) if (child.isFile() && child.name.endsWith(".jsonl")) yield join(subagents, child.name);
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
