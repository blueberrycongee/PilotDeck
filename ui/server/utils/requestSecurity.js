import { isIP } from 'node:net';

export function isLoopbackHost(value = '') {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const address = host.startsWith('::ffff:') ? host.slice(7) : host;
  return isIP(address) === 4 && address.startsWith('127.');
}

export function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && url.origin === origin && url.host === req.headers.host.toLowerCase();
  } catch { return false; }
}

export function isTrustedLocalRequest(req) {
  if (!isLoopbackHost(req.socket?.remoteAddress) || !isSameOriginRequest(req)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    return !host.username && !host.password && isLoopbackHost(host.hostname);
  } catch { return false; }
}

export function isAllowedBrowserRequest(req, localOnly = false) {
  if (localOnly) return isTrustedLocalRequest(req);
  if (isSameOriginRequest(req)) return true;
  const allowed = (process.env.PILOTDECK_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  return typeof req.headers.origin === 'string' && allowed.includes(req.headers.origin);
}
