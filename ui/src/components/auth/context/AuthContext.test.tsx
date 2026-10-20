// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  onboardingStatus: vi.fn(),
  runtimeStatus: vi.fn(),
}));

vi.mock('../../../constants/config', () => ({
  IS_PLATFORM: true,
  DISABLE_LOCAL_AUTH: false,
}));

vi.mock('../../../utils/api', () => ({
  api: {
    auth: {
      status: mocks.status,
    },
    user: {
      onboardingStatus: mocks.onboardingStatus,
      runtimeStatus: mocks.runtimeStatus,
      retryGateway: vi.fn(),
    },
  },
}));

function StateProbe() {
  const { modelConfiguration, token } = useAuth();
  return <div>{modelConfiguration.state}<span data-testid="token">{token}</span></div>;
}

describe('AuthContext model configuration state', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.status.mockReset().mockResolvedValue({ ok: true, json: async () => ({ authDisabled: true, token: 'local-token', user: { username: 'local' } }) });
    mocks.onboardingStatus.mockReset();
    mocks.runtimeStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('refreshes local tokens on a timer and after the tab regains focus', async () => {
    vi.useFakeTimers();
    mocks.onboardingStatus.mockResolvedValue({ ok: true, json: async () => ({ configuration: { state: 'needs_configuration' } }) });
    await act(async () => { render(<AuthProvider><StateProbe /></AuthProvider>); });
    expect(screen.getByTestId('token').textContent).toBe('local-token');
    mocks.status.mockResolvedValue({ ok: true, json: async () => ({ authDisabled: true, token: 'renewed-token', user: { username: 'local' } }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(screen.getByTestId('token').textContent).toBe('renewed-token');
    expect(localStorage.getItem('auth-token')).toBe('renewed-token');
    mocks.status.mockResolvedValue({ ok: true, json: async () => ({ authDisabled: true, token: 'wake-token', user: { username: 'local' } }) });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByTestId('token').textContent).toBe('wake-token');
    expect(mocks.onboardingStatus).toHaveBeenCalledTimes(1);
  });

  it('synchronizes refreshed HTTP tokens with context consumers', async () => {
    mocks.onboardingStatus.mockResolvedValue({ ok: true, json: async () => ({ configuration: { state: 'needs_configuration' } }) });
    await act(async () => { render(<AuthProvider><StateProbe /></AuthProvider>); });
    act(() => {
      localStorage.setItem('auth-token', 'header-token');
      window.dispatchEvent(new Event('pilotdeck:auth-token-refreshed'));
    });
    expect(screen.getByTestId('token').textContent).toBe('header-token');
  });

  it('does not fail open when the configuration status request fails', async () => {
    mocks.onboardingStatus.mockRejectedValueOnce(new Error('server unavailable'));

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('status_error')).toBeTruthy();
    });
  });

  it('preserves the explicit configuration state returned by the server', async () => {
    mocks.onboardingStatus.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        configuration: {
          state: 'needs_configuration',
          reason: 'missing_config',
          configPath: '/tmp/pilotdeck.yaml',
          revision: 'revision',
        },
      }),
    });

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('needs_configuration')).toBeTruthy();
    });
  });

  it('keeps polling while Gateway remains in its starting state', async () => {
    mocks.onboardingStatus.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        configuration: {
          state: 'ready',
          modelRef: 'openai/gpt-5',
          configPath: '/tmp/pilotdeck.yaml',
          revision: 'revision',
        },
        gateway: { state: 'starting' },
      }),
    });
    mocks.runtimeStatus
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          configuration: {
            state: 'ready',
            modelRef: 'openai/gpt-5',
            configPath: '/tmp/pilotdeck.yaml',
            revision: 'revision',
          },
          gateway: { state: 'starting' },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          configuration: {
            state: 'ready',
            modelRef: 'openai/gpt-5',
            configPath: '/tmp/pilotdeck.yaml',
            revision: 'revision',
          },
          gateway: { state: 'ready' },
        }),
      });

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(mocks.runtimeStatus).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000 });
  });
});
