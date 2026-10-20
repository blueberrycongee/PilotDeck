// Ensure unified YAML config is applied before reading flags.
import '../load-env.js';
import { isLoopbackHost } from '../utils/requestSecurity.js';

export const WEB_HOST = process.env.HOST || '127.0.0.1';

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * When true, skip JWT login/register in the web UI (single-user local mode).
 * Only loopback listeners can use this mode. Network listeners require login.
 * @type {boolean}
 */
const authFlag = process.env.PILOTDECK_DISABLE_LOCAL_AUTH;
if ((authFlag === '1' || authFlag === 'true') && !isLoopbackHost(WEB_HOST)) {
  throw new Error('PILOTDECK_DISABLE_LOCAL_AUTH requires a loopback HOST. Set PILOTDECK_DISABLE_LOCAL_AUTH=0 for network access.');
}
export const DISABLE_LOCAL_AUTH = isLoopbackHost(WEB_HOST) && authFlag !== '0' && authFlag !== 'false';
