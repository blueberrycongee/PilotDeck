import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComposerAttachment } from '../../utils/composerAttachmentDrafts';

const MIME_FRIENDLY_LABELS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/msword': 'DOC',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/x-tar': 'TAR',
  'application/gzip': 'GZ',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
  'application/json': 'JSON',
  'application/xml': 'XML',
};

function getFileTypeLabel(name: string, mimeType: string): string {
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : undefined;
  if (ext && ext !== name.toUpperCase()) return ext;
  const friendly = MIME_FRIENDLY_LABELS[mimeType.toLowerCase()];
  if (friendly) return friendly;
  if (mimeType.includes('/')) {
    const sub = mimeType.split('/').pop() || '';
    if (sub.length <= 10 && !sub.includes('.')) return sub.toUpperCase();
  }
  return 'FILE';
}

interface ImageAttachmentProps {
  attachment: ComposerAttachment;
  /** Server preview for slots restored after a reload (no local File). */
  previewSrc?: string;
  onRemove: () => void;
  onRetry?: () => void;
  uploadProgress?: number;
  error?: string;
}

const ImageAttachment = ({
  attachment,
  previewSrc,
  onRemove,
  onRetry,
  uploadProgress,
  error,
}: ImageAttachmentProps) => {
  const { t } = useTranslation('chat');
  const { file, name, mimeType } = attachment;
  const [localPreview, setLocalPreview] = useState<string | undefined>(undefined);
  const isImage = mimeType.startsWith('image/');

  useEffect(() => {
    if (!isImage || !file) {
      setLocalPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  const preview = localPreview || previewSrc || attachment.upload?.previewData;
  // A restored image renders as a file card until its server preview loads.
  const showImage = isImage && Boolean(file || preview);

  const isUploadComplete = uploadProgress !== undefined && uploadProgress >= 100 && !error;
  const showProgressOverlay = uploadProgress !== undefined && uploadProgress < 100 && !error;

  return (
    <div className="group relative">
      {showImage ? (
        <img src={preview} alt={name} className="h-20 w-20 rounded object-cover" />
      ) : (
        <div className="flex h-20 w-44 items-center gap-2 rounded border border-neutral-200 bg-white p-2 text-neutral-900 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13H7z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v5h5" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{name}</div>
            <div className="mt-0.5 text-[11px] uppercase text-neutral-500">
              {getFileTypeLabel(name, mimeType)}
            </div>
          </div>
        </div>
      )}
      {showProgressOverlay ? (
        <div className="absolute inset-x-0 bottom-0 overflow-hidden rounded-b bg-black/55 px-2 pb-1.5 pt-1 text-white">
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
            <span>{t('input.uploading', { defaultValue: 'Uploading…' })}</span>
            <span className="tabular-nums">{Math.round(uploadProgress)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/30">
            <div
              className="h-full rounded-full bg-[var(--pd-accent,#c4b5fd)] transition-[width] duration-150"
              style={{ width: `${Math.max(0, Math.min(100, uploadProgress))}%` }}
            />
          </div>
        </div>
      ) : null}
      {isUploadComplete ? (
        <div
          className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
          title={t('input.uploadComplete', { defaultValue: 'Upload complete' })}
          aria-label={t('input.uploadComplete', { defaultValue: 'Upload complete' })}
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-red-600/85 px-2 text-center text-white">
          <svg className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span className="line-clamp-2 text-[10px]" title={error}>{error}</span>
          {onRetry && file ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded bg-white/95 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-white"
            >
              {t('input.retryUpload', { defaultValue: 'Retry' })}
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white opacity-100 transition-opacity focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={uploadProgress !== undefined && uploadProgress < 100
          ? t('input.cancelUpload', { file: name, defaultValue: `Cancel upload ${name}` })
          : t('input.removeAttachment', { file: name, defaultValue: `Remove attachment ${name}` })}
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

export default ImageAttachment;

