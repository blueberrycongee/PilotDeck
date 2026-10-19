import { registerTranscriptWriter, withTranscriptFileLock } from "../storage/TranscriptFileLock.js";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, open } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import {
  classifyDurableMessageEntry,
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  type AgentControlBoundaryTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentSubagentCompletedTranscriptEntry,
  type AgentSubagentStartedTranscriptEntry,
  type AgentTranscriptEntry,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type SubagentTranscriptHandle = {
  /** UUID v4 of the subagent (matches sidechain filename). */
  subagentId: string;
  /** The sidechain writer (independent JSONL file). */
  writer: JsonlTranscriptWriter;
  /** Absolute path of the sidechain transcript. */
  transcriptPath: string;
};

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
  /**
   * Optional resolver mapping a subagentId → absolute sidechain path. Wired
   * by the parent session so {@link JsonlTranscriptWriter#forSubagent} can
   * derive a sidechain writer without the caller computing paths. Defaults
   * to `<dirname(path)>/<subagentId>.jsonl`.
   */
  subagentTranscriptPath?: (subagentId: string) => string;
};

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private closed = false;
  private writeChain: Promise<void> = Promise.resolve();
  private lastEntryId: string | null = null;
  private readonly now: () => Date;
  private releaseStorageWriter?: () => void;

  constructor(private readonly options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
    this.releaseStorageWriter = registerTranscriptWriter(options.path);
  }

  /**
   * Re-seed the writer's monotonic counters from a previously persisted
   * transcript so that new entries continue with unique, ascending values.
   * Called by the resume path after `readTranscript` has loaded the
   * existing entries.
   */
  restoreState(maxSequence: number, lastEntryId: string | null): void {
    this.sequence = maxSequence;
    this.lastEntryId = lastEntryId;
  }

  snapshotState(): AgentTranscriptWriterState {
    return {
      sequence: this.sequence,
      lastEntryId: this.lastEntryId,
    };
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.enqueueEntry({
      type: "accepted_input",
      ...this.baseEntry(sessionId, turnId),
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.enqueueEntry({
      type,
      ...this.baseEntry(sessionId, turnId),
      message,
    });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: { event: string; kind: "status" | "error"; text: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    return this.enqueueEntry({
      type: "agent_status_message",
      ...this.baseEntry(sessionId, turnId),
      event: status.event,
      kind: status.kind,
      text: status.text,
      ...(status.detail && Object.keys(status.detail).length > 0 ? { detail: status.detail } : {}),
    });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): Promise<void> {
    if (artifacts.length === 0) return Promise.resolve();
    return this.enqueueEntry({
      type: "file_artifacts",
      ...this.baseEntry(sessionId, turnId),
      artifacts,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.enqueueEntry({
      type: "turn_result",
      ...this.baseEntry(sessionId, turnId),
      result,
    });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.enqueueEntry({
      type: "session_metadata",
      ...this.baseEntry(sessionId, turnId),
      metadata,
    });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void> {
    return this.enqueueEntry({
      type: "control_boundary",
      ...this.baseEntry(sessionId, turnId),
      boundary,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain.catch(() => undefined);
    this.releaseStorageWriter?.();
    this.releaseStorageWriter = undefined;
  }

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    // Imported snapshots retain their explicit identities and sequence values.
    return this.enqueueEntry(entry, false);
  }

  private enqueueEntry(entry: AgentTranscriptEntry, allocateIdentity = true): Promise<void> {
    if (this.closed) return Promise.resolve();
    const captured = JSON.stringify(entry);
    const operation = this.writeChain.then(async () => {
      if (this.closed) return;
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await withTranscriptFileLock(this.options.path, async () => {
        const tail = await this.prepareTail();
        const record = JSON.parse(captured) as AgentTranscriptEntry;
        if (allocateIdentity) {
          record.sequence = Math.max(this.sequence, tail.sequence) + 1;
          record.parentEntryId = tail.lastEntryId ?? this.lastEntryId;
        }
        const flush = record.type === "control_boundary" &&
          (record.boundary.kind === "restore" || (record.boundary.kind === "compact" && record.boundary.subtype === "compact_boundary"));
        await appendFile(this.options.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flush });
        this.sequence = Math.max(this.sequence, record.sequence);
        this.lastEntryId = record.entryId ?? this.lastEntryId;
      });
    });
    this.writeChain = operation;
    return operation;
  }

  private async prepareTail(): Promise<AgentTranscriptWriterState> {
    const file = await open(this.options.path, "a+", 0o600);
    try {
      const { size } = await file.stat();
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        await file.read(lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) {
          // Keep crash debris for diagnostics, but never concatenate the next
          // entry onto it. Also preserves valid JSON lacking a final newline.
          await file.appendFile("\n");
        }
      }
      // Read identity from the physical tail while holding the same lock used
      // for append/replacement. Encoded records keep these fields in plain JSON.
      let position = size;
      let suffix = Buffer.alloc(0);
      while (position > 0) {
        const length = Math.min(position, 64 * 1024);
        position -= length;
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, position);
        const data = Buffer.concat([buffer, suffix]);
        const start = position === 0 ? 0 : data.indexOf(0x0a) + 1;
        if (start > 0 || position === 0) {
          const lines = data.subarray(start).toString("utf8").split("\n");
          for (let index = lines.length - 1; index >= 0; index--) {
            try {
              const record = JSON.parse(lines[index]);
              if (Number.isSafeInteger(record.sequence) && record.sequence >= 0) {
                return { sequence: record.sequence, lastEntryId: typeof record.entryId === "string" ? record.entryId : null };
              }
            } catch { /* Ignore crash debris, retaining it for diagnostics. */ }
          }
        }
        suffix = start > 0 ? data.subarray(0, start - 1) : data;
      }
      return { sequence: 0, lastEntryId: null };
    } finally {
      await file.close();
    }
  }

  /**
   * C3.S1 — record the parent-side `subagent_started` reference. The full
   * directive lives in the sidechain transcript; we keep only a truncated
   * preview to bound the parent transcript size.
   */
  async recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      prompt: string;
      transcriptRelativePath: string;
      subagentSessionId?: string;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.prompt, SUBAGENT_PROMPT_PREVIEW_BYTES);
    const entry: AgentSubagentStartedTranscriptEntry = {
      type: "subagent_started",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      promptPreview: preview,
      promptTruncated: truncated,
      transcriptRelativePath: args.transcriptRelativePath,
      subagentSessionId: args.subagentSessionId,
    };
    return this.enqueueEntry(entry);
  }

  /** C3.S1 — record the parent-side `subagent_completed` reference. */
  async recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      summary: string;
      usage?: AgentSubagentCompletedTranscriptEntry["usage"];
      turns: number;
      durationMs: number;
      errored?: boolean;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.summary, SUBAGENT_SUMMARY_PREVIEW_BYTES);
    const entry: AgentSubagentCompletedTranscriptEntry = {
      type: "subagent_completed",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summaryPreview: preview,
      summaryTruncated: truncated,
      usage: args.usage,
      turns: args.turns,
      durationMs: args.durationMs,
      errored: args.errored,
    };
    return this.enqueueEntry(entry);
  }

  /**
   * C3.S2 — derive a sidechain writer for a forked subagent. The new writer
   * is independent (its own sequence counter, its own file path) so the
   * subagent's turn-by-turn entries do not interleave with the parent.
   */
  forSubagent(subagentId: string, now?: () => Date): SubagentTranscriptHandle {
    const path =
      this.options.subagentTranscriptPath?.(subagentId) ??
      defaultSubagentPath(this.options.path, subagentId);
    const writer = new JsonlTranscriptWriter({ path, now: now ?? this.now });
    return { subagentId, writer, transcriptPath: path };
  }

  /**
   * Helper for emitting the relative path to the sidechain that goes into
   * `subagent_started.transcriptRelativePath`. Computed against the parent
   * transcript's directory.
   */
  relativeSubagentPath(subagentId: string): string {
    const sidechain =
      this.options.subagentTranscriptPath?.(subagentId) ??
      defaultSubagentPath(this.options.path, subagentId);
    return relative(dirname(this.options.path), sidechain);
  }

  private baseEntry(
    sessionId: string,
    turnId: string,
  ): Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"> {
    return {
      sessionId,
      turnId,
      sequence: 0,
      createdAt: this.now().toISOString(),
      entryId: randomUUID(),
      parentEntryId: this.lastEntryId,
    };
  }
}

function defaultSubagentPath(parentPath: string, subagentId: string): string {
  // Default layout: <parentPath dirname>/<parentBaseStem>/subagents/<subagentId>.jsonl
  const dir = dirname(parentPath);
  const stem = basename(parentPath).replace(/\.jsonl$/i, "");
  return join(dir, stem, "subagents", `${subagentId}.jsonl`);
}
