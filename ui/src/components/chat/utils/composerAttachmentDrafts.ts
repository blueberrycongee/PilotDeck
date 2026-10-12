import { authenticatedFetch } from '../../../utils/api';
import { safeLocalStorage } from './chatStorage';
import {
  cancelAttachmentUpload,
  uploadAttachmentBatch,
  type AttachmentUploadRecord,
} from './attachmentUpload';

export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed';

export type ComposerAttachmentUpload = {
  uploadId: string;
  attachmentId: string;
  name: string;
  relativePath: string;
  bytes?: number;
  mimeType?: string;
  /** Browser-local image data for the sent bubble. Never persisted. */
  previewData?: string;
};

/**
 * One staged attachment slot. The id is minted when the file enters the
 * composer and stays fixed through upload, retry, draft switches and reloads,
 * so late upload results can only settle a slot that still exists.
 */
export type ComposerAttachment = {
  id: string;
  /** Present for files added in this page; absent after a reload restore. */
  file?: File;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  lastModified?: number;
  status: ComposerAttachmentStatus;
  progress: number;
  error?: string;
  upload?: ComposerAttachmentUpload;
};

type PersistedAttachment = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  lastModified?: number;
  upload: Omit<ComposerAttachmentUpload, 'previewData'>;
};

type UploadBatch = {
  draftKey: string;
  /** Slots still waiting on this batch. Removing one never cancels siblings. */
  slotIds: Set<string>;
  controller: AbortController;
  uploadId?: string;
  cancelled: boolean;
};

export const EXPIRED_ATTACHMENT_ERROR = 'This attachment expired. Remove it and add the file again.';
export const NO_PROJECT_ATTACHMENT_ERROR = 'Select a project before uploading files';

const EMPTY: ComposerAttachment[] = [];
// Drafts outlive the composer that created them: switching sessions or
// unmounting the chat view keeps both the slots and their in-flight uploads.
const drafts = new Map<string, ComposerAttachment[]>();
const batches = new Set<UploadBatch>();
const listeners = new Set<() => void>();
// Last serialized ready set per draft; progress ticks must not rewrite storage.
const persisted = new Map<string, string>();

export function draftAttachmentsStorageKey(draftKey: string): string {
  return `${draftKey}:attachments`;
}

export function subscribeDraftAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function nextAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function attachmentFingerprint(
  attachment: Pick<ComposerAttachment, 'relativePath' | 'size' | 'lastModified'>,
): string {
  return `${attachment.relativePath}::${attachment.size}::${attachment.lastModified ?? ''}`;
}

export function fileFingerprint(file: File): string {
  return attachmentFingerprint({
    relativePath: file.webkitRelativePath || file.name,
    size: file.size,
    lastModified: file.lastModified,
  });
}

function readAttachmentPreview(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = reader.onabort = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

function persist(draftKey: string, attachments: ComposerAttachment[]): void {
  const ready: PersistedAttachment[] = attachments.flatMap((attachment) => {
    if (attachment.status !== 'ready' || !attachment.upload) return [];
    const { previewData: _previewData, ...upload } = attachment.upload;
    return [{
      id: attachment.id,
      name: attachment.name,
      relativePath: attachment.relativePath,
      size: attachment.size,
      mimeType: attachment.mimeType,
      ...(attachment.lastModified !== undefined ? { lastModified: attachment.lastModified } : {}),
      upload,
    }];
  });
  const key = draftAttachmentsStorageKey(draftKey);
  const serialized = ready.length > 0 ? JSON.stringify(ready) : '';
  if (persisted.get(draftKey) === serialized) return;
  persisted.set(draftKey, serialized);
  if (serialized) safeLocalStorage.setItem(key, serialized);
  else safeLocalStorage.removeItem(key);
}

function isPersistedAttachment(value: unknown): value is PersistedAttachment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const upload = item.upload as Record<string, unknown> | undefined;
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string'
    && typeof item.relativePath === 'string'
    && typeof item.size === 'number'
    && typeof item.mimeType === 'string'
    && Boolean(upload && typeof upload === 'object')
    && typeof upload?.uploadId === 'string' && upload.uploadId.length > 0
    && typeof upload?.attachmentId === 'string' && upload.attachmentId.length > 0;
}

function hydrate(draftKey: string): ComposerAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(safeLocalStorage.getItem(draftAttachmentsStorageKey(draftKey)) || 'null');
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(parsed)) return EMPTY;
  const valid = parsed.filter(isPersistedAttachment);
  persisted.set(draftKey, valid.length > 0 ? JSON.stringify(valid) : '');
  const restored = valid.map((item): ComposerAttachment => ({
    id: item.id,
    name: item.name,
    relativePath: item.relativePath,
    size: item.size,
    mimeType: item.mimeType,
    ...(typeof item.lastModified === 'number' ? { lastModified: item.lastModified } : {}),
    status: 'ready',
    progress: 100,
    upload: {
      uploadId: item.upload.uploadId,
      attachmentId: item.upload.attachmentId,
      name: item.upload.name || item.name,
      relativePath: item.upload.relativePath || item.relativePath,
      ...(typeof item.upload.bytes === 'number' ? { bytes: item.upload.bytes } : {}),
      ...(typeof item.upload.mimeType === 'string' ? { mimeType: item.upload.mimeType } : {}),
    },
  }));
  if (restored.length > 0) void verifyRestoredUploads(draftKey, restored);
  return restored.length > 0 ? restored : EMPTY;
}

// Staged uploads expire on the server. A restored slot that can no longer be
// sent is shown as failed instead of failing later at submit time.
async function verifyRestoredUploads(draftKey: string, restored: ComposerAttachment[]): Promise<void> {
  const uploadIds = [...new Set(restored.map((attachment) => attachment.upload!.uploadId))];
  await Promise.all(uploadIds.map(async (uploadId) => {
    let expired = false;
    try {
      const response = await authenticatedFetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'GET',
        suppressServerErrorToast: true,
      });
      if (response.status === 404 || response.status === 410) {
        expired = true;
      } else if (response.ok) {
        const record = await response.json().catch(() => ({})) as Partial<AttachmentUploadRecord>;
        expired = typeof record.status === 'string' && record.status !== 'completed';
      }
    } catch {
      // Offline or transient failures keep the slot; submit verifies again.
      return;
    }
    if (!expired) return;
    restored
      .filter((attachment) => attachment.upload?.uploadId === uploadId)
      .forEach((attachment) => {
        updateAttachment(draftKey, attachment.id, (current) => (
          current.upload?.uploadId === uploadId
            ? { ...current, status: 'failed', error: EXPIRED_ATTACHMENT_ERROR }
            : current
        ));
      });
  }));
}

export function getDraftAttachments(draftKey: string | null | undefined): ComposerAttachment[] {
  if (!draftKey) return EMPTY;
  const existing = drafts.get(draftKey);
  if (existing) return existing;
  const restored = hydrate(draftKey);
  drafts.set(draftKey, restored);
  return restored;
}

function setDraft(draftKey: string, next: ComposerAttachment[]): void {
  drafts.set(draftKey, next.length > 0 ? next : EMPTY);
  persist(draftKey, next);
  notify();
}

/** Apply a change to a slot that still exists; never recreate a removed one. */
function updateAttachment(
  draftKey: string,
  id: string,
  update: (attachment: ComposerAttachment) => ComposerAttachment,
): void {
  const current = drafts.get(draftKey);
  if (!current || !current.some((attachment) => attachment.id === id)) return;
  let changed = false;
  const next = current.map((attachment) => {
    if (attachment.id !== id) return attachment;
    const updated = update(attachment);
    if (updated !== attachment) changed = true;
    return updated;
  });
  if (changed) setDraft(draftKey, next);
}

function cancelBatch(batch: UploadBatch): void {
  if (batch.cancelled) return;
  batch.cancelled = true;
  if (batch.uploadId) {
    void cancelAttachmentUpload(batch.uploadId).catch((error) => {
      console.warn('Failed to cancel attachment upload cleanly:', error);
    });
  }
  batch.controller.abort();
  batches.delete(batch);
}

function applyBatchProgress(
  batch: UploadBatch,
  record: Pick<AttachmentUploadRecord, 'percent' | 'status' | 'errorMessage'>,
): void {
  if (record.status === 'created') return;
  const failed = record.status === 'failed' || record.status === 'expired' || record.status === 'cancelled';
  const rawPercent = Number(record.percent);
  // Transport completion can precede attachment metadata. Only the settled
  // slot reaches 100, so the composer never advertises an unusable file.
  const percent = record.status === 'completed' || rawPercent >= 100
    ? 99
    : Math.max(0, Math.min(99, Number.isFinite(rawPercent) ? rawPercent : 0));
  for (const id of batch.slotIds) {
    updateAttachment(batch.draftKey, id, (attachment) => {
      if (attachment.status !== 'uploading') return attachment;
      if (failed) {
        return { ...attachment, status: 'failed', error: record.errorMessage || `Upload ${record.status}` };
      }
      const progress = Math.max(attachment.progress, percent);
      return progress === attachment.progress ? attachment : { ...attachment, progress };
    });
  }
}

function startBatch(draftKey: string, projectKey: string, slots: ComposerAttachment[]): void {
  const uploadable = slots.filter((slot) => slot.file);
  if (uploadable.length === 0) return;
  const batch: UploadBatch = {
    draftKey,
    slotIds: new Set(uploadable.map((slot) => slot.id)),
    controller: new AbortController(),
    cancelled: false,
  };
  batches.add(batch);

  void (async () => {
    try {
      const result = await uploadAttachmentBatch({
        projectKey,
        files: uploadable.map((slot) => slot.file!),
        clientFileIds: uploadable.map((slot) => slot.id),
        signal: batch.controller.signal,
        onCreated: (uploadId) => {
          batch.uploadId = uploadId;
          if (batch.cancelled) {
            void cancelAttachmentUpload(uploadId).catch((error) => {
              console.warn('Failed to cancel attachment upload cleanly:', error);
            });
          }
        },
        onStatus: (record) => {
          if (!batch.cancelled) applyBatchProgress(batch, record);
        },
      });
      if (batch.cancelled) return;

      const attachments = Array.isArray(result.attachments) ? result.attachments : [];
      const claimed = new Set<string>();
      for (const slot of uploadable) {
        if (!batch.slotIds.has(slot.id)) continue;
        // attachmentId echoes the clientFileId we sent; name matching is only
        // a fallback for servers that mint their own ids.
        const attachment = attachments.find((item) => item.attachmentId === slot.id)
          ?? attachments.find((item) => !claimed.has(item.attachmentId) && item.relativePath === slot.relativePath)
          ?? attachments.find((item) => !claimed.has(item.attachmentId) && item.name === slot.name);
        if (!attachment) {
          updateAttachment(draftKey, slot.id, (current) => ({
            ...current,
            status: 'failed',
            error: `Upload completed without attachment metadata: ${slot.name}`,
          }));
          continue;
        }
        claimed.add(attachment.attachmentId);
        const previewData = slot.file ? await readAttachmentPreview(slot.file) : undefined;
        if (batch.cancelled || !batch.slotIds.has(slot.id)) continue;
        updateAttachment(draftKey, slot.id, (current) => ({
          ...current,
          status: 'ready',
          progress: 100,
          error: undefined,
          upload: {
            uploadId: result.uploadId,
            attachmentId: attachment.attachmentId,
            name: attachment.name || slot.name,
            relativePath: attachment.relativePath || attachment.name || slot.name,
            bytes: attachment.bytes,
            mimeType: attachment.mimeType,
            previewData,
          },
        }));
      }
    } catch (error) {
      const aborted = batch.cancelled
        || batch.controller.signal.aborted
        || (error instanceof DOMException && error.name === 'AbortError');
      if (aborted) return;
      console.error('Attachment upload failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      for (const id of batch.slotIds) {
        updateAttachment(draftKey, id, (current) => (
          current.status === 'ready' ? current : { ...current, status: 'failed', error: message }
        ));
      }
    } finally {
      batches.delete(batch);
    }
  })();
}

function createSlot(file: File, projectKey: string): ComposerAttachment {
  return {
    id: nextAttachmentId(),
    file,
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    lastModified: file.lastModified,
    status: projectKey ? 'uploading' : 'failed',
    progress: 0,
    ...(projectKey ? {} : { error: NO_PROJECT_ATTACHMENT_ERROR }),
  };
}

export function addDraftAttachmentFiles(
  draftKey: string,
  projectKey: string,
  files: File[],
  maxAttachments: number,
): { added: ComposerAttachment[]; droppedCount: number } {
  const current = getDraftAttachments(draftKey);
  const seen = new Set(current.map(attachmentFingerprint));
  const unique = files.filter((file) => {
    const key = fileFingerprint(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const room = Math.max(0, maxAttachments - current.length);
  const added = unique.slice(0, room).map((file) => createSlot(file, projectKey));
  const droppedCount = unique.length - added.length;
  if (added.length > 0) {
    setDraft(draftKey, [...current, ...added]);
    if (projectKey) startBatch(draftKey, projectKey, added);
  }
  return { added, droppedCount };
}

export function removeDraftAttachments(draftKey: string, ids: Iterable<string>): void {
  const removed = new Set(ids);
  const current = getDraftAttachments(draftKey);
  if (!current.some((attachment) => removed.has(attachment.id))) return;
  for (const batch of [...batches]) {
    if (batch.draftKey !== draftKey) continue;
    removed.forEach((id) => batch.slotIds.delete(id));
    if (batch.slotIds.size === 0) cancelBatch(batch);
  }
  setDraft(draftKey, current.filter((attachment) => !removed.has(attachment.id)));
}

export function removeDraftAttachment(draftKey: string, id: string): void {
  removeDraftAttachments(draftKey, [id]);
}

export function retryDraftAttachment(draftKey: string, projectKey: string, id: string): void {
  const slot = getDraftAttachments(draftKey).find((attachment) => attachment.id === id);
  if (!slot || slot.status !== 'failed' || !slot.file) return;
  if (!projectKey) {
    updateAttachment(draftKey, id, (current) => ({ ...current, error: NO_PROJECT_ATTACHMENT_ERROR }));
    return;
  }
  const retrying: ComposerAttachment = { ...slot, status: 'uploading', progress: 0, error: undefined, upload: undefined };
  updateAttachment(draftKey, id, () => retrying);
  startBatch(draftKey, projectKey, [retrying]);
}

export function clearDraftAttachments(draftKey: string): void {
  for (const batch of [...batches]) {
    if (batch.draftKey === draftKey) cancelBatch(batch);
  }
  if (getDraftAttachments(draftKey).length > 0) setDraft(draftKey, EMPTY);
}

export function resetComposerAttachmentDraftsForTests(): void {
  for (const batch of [...batches]) cancelBatch(batch);
  drafts.clear();
  persisted.clear();
  notify();
}
