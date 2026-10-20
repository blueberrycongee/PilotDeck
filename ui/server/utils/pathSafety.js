import path from 'path';
import { realpath, lstat } from 'node:fs/promises';

export function isPathInsideOrEqual(rootPath, candidatePath, pathApi = path) {
  const root = pathApi.resolve(rootPath);
  const candidate = pathApi.resolve(candidatePath);
  const relative = pathApi.relative(root, candidate);
  return (
    relative === '' ||
    (
      relative !== '..' &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative)
    )
  );
}

/** Resolve existing ancestors before checking containment, including new files. */
export async function resolvePathWithinRoot(rootPath, candidatePath, { allowMissing = false } = {}) {
  const denied = () => Object.assign(new Error('Path is outside the allowed directory'), { status: 403, code: 'PATH_FORBIDDEN' });
  if (!isPathInsideOrEqual(rootPath, candidatePath)) throw denied();
  const root = await realpath(rootPath);
  let candidate = path.resolve(candidatePath);
  const missing = [];
  for (;;) {
    try {
      // A dangling symlink must not be treated as an ordinary missing file.
      await lstat(candidate);
      candidate = await realpath(candidate);
      break;
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      const info = await lstat(candidate).catch(() => null);
      if (info?.isSymbolicLink()) throw denied();
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
  const resolved = path.join(candidate, ...missing);
  if (!isPathInsideOrEqual(root, resolved)) throw denied();
  return resolved;
}

export function normalizePathForComparison(value, pathApi = path, platform = process.platform) {
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
