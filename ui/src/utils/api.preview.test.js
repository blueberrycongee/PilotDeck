// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, authenticatedFetch } from './api';
vi.mock('../constants/config', () => ({ IS_PLATFORM: true }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('preview request errors', () => {
  it('announces refreshed session tokens to same-tab consumers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      headers: { 'X-Refreshed-Token': 'renewed-token' },
    })));
    const refreshed = vi.fn();
    window.addEventListener('pilotdeck:auth-token-refreshed', refreshed);
    try {
      await authenticatedFetch('/api/normal-operation');
      expect(localStorage.getItem('auth-token')).toBe('renewed-token');
      expect(refreshed).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('pilotdeck:auth-token-refreshed', refreshed);
    }
  });

  it('keeps a preview 500 in the preview area while preserving global toasts for other requests', async () => {
    localStorage.setItem('auth-token', 'fixture-token');
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    window.addEventListener('pilotdeck:toast', toast);
    try {
      await api.spreadsheetInteractivePreview('project', 'report.xlsx');
      expect(toast).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');

      await authenticatedFetch('/api/other-operation');
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('pilotdeck:toast', toast);
    }
  });
});
