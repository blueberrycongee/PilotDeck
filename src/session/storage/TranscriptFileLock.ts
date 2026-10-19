import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const openWriters = new Map<string, number>();

export function registerTranscriptWriter(path: string): () => void {
  openWriters.set(path, (openWriters.get(path) ?? 0) + 1);
  return () => {
    const count = (openWriters.get(path) ?? 1) - 1;
    if (count === 0) openWriters.delete(path);
    else openWriters.set(path, count);
  };
}

export function hasOpenTranscriptWriter(path: string): boolean {
  return openWriters.has(path);
}

/** Shared by append, replacement and maintenance, including separate PD processes. */
export async function withTranscriptFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.storage-lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try { await writeFile(`${lockPath}/owner`, owner, { mode: 0o600 }); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a live writer's lock. A crash before owner publication is
      // reported as a timeout instead of guessing whether that writer is alive.
      const previous = await readFile(`${lockPath}/owner`, "utf8").catch(() => "");
      const pid = Number(previous.split(":")[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            // Recovery itself must have a single owner to avoid removing a
            // newly acquired lock when multiple processes see the stale one.
            try { await mkdir(`${lockPath}/recovery`); }
            catch {
              if (Date.now() >= deadline) throw new Error(`Timed out recovering transcript storage lock: ${path}`);
              await setTimeout(25);
              continue;
            }
            if (await readFile(`${lockPath}/owner`, "utf8").catch(() => "") === previous) {
              await rm(lockPath, { recursive: true, force: true });
            } else {
              await rm(`${lockPath}/recovery`, { recursive: true, force: true });
            }
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for transcript storage lock: ${path}`);
      await setTimeout(25);
    }
  }
  try { return await action(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}
