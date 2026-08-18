import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared voice-session store is module-level, so each test gets a fresh
 * module instance via vi.resetModules().
 */
let store;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('./voiceSession.js');
  store = mod.voiceSession;
});

describe('voiceSession store', () => {
  it('starts idle with an empty access code', () => {
    expect(store.snapshot().status).toBe('idle');
    expect(store.snapshot().accessCode).toBe('');
    expect(store.snapshot().liveTranscript).toBe('');
  });

  it('tracks the access code and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setAccessCode('demo-123');
    expect(store.snapshot().accessCode).toBe('demo-123');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setAccessCode('other');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('start() is a safe no-op in non-browser environments', async () => {
    expect(store.snapshot().supported).toBe(false);
    await expect(store.start()).resolves.toBeUndefined();
    expect(store.snapshot().status).toBe('idle');
  });

  it('stop() without an active session is a safe no-op', () => {
    expect(() => store.stop()).not.toThrow();
    expect(store.snapshot().liveTranscript).toBe('');
  });

  it('updateInstructions without a session only stores the text', () => {
    expect(() => store.updateInstructions('new instructions')).not.toThrow();
  });

  it('setHandlers accepts a partial handler map', () => {
    expect(() => store.setHandlers({ onUserTranscript: () => {} })).not.toThrow();
  });
});
