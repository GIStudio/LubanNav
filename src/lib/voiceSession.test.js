import { describe, expect, it, vi } from 'vitest';

/**
 * The shared voice-session store is module-level, so every test gets a fresh
 * module instance (and an optional fake `window.localStorage`) via
 * freshStore().
 */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

async function freshStore(windowStub) {
  vi.resetModules();
  if (windowStub === undefined) delete globalThis.window;
  else globalThis.window = windowStub;
  const mod = await import('./voiceSession.js');
  return mod.voiceSession;
}

describe('voiceSession store', () => {
  it('starts idle with an empty access code', async () => {
    const store = await freshStore();
    expect(store.snapshot().status).toBe('idle');
    expect(store.snapshot().accessCode).toBe('');
    expect(store.snapshot().liveTranscript).toBe('');
  });

  it('tracks the access code and notifies subscribers', async () => {
    const store = await freshStore();
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
    const store = await freshStore();
    expect(store.snapshot().supported).toBe(false);
    await expect(store.start()).resolves.toBeUndefined();
    expect(store.snapshot().status).toBe('idle');
  });

  it('stop() without an active session is a safe no-op', async () => {
    const store = await freshStore();
    expect(() => store.stop()).not.toThrow();
    expect(store.snapshot().liveTranscript).toBe('');
  });

  it('updateInstructions without a session only stores the text', async () => {
    const store = await freshStore();
    expect(() => store.updateInstructions('new instructions')).not.toThrow();
  });

  it('setHandlers accepts a partial handler map', async () => {
    const store = await freshStore();
    expect(() => store.setHandlers({ onUserTranscript: () => {} })).not.toThrow();
  });
});

describe('voiceSession access-code persistence', () => {
  it('initializes the access code from localStorage when present', async () => {
    const storage = fakeStorage({ 'luban-nav:voice-access-code': 'saved-code' });
    const store = await freshStore({ localStorage: storage });
    expect(store.snapshot().accessCode).toBe('saved-code');
  });

  it('persists setAccessCode to localStorage and trims whitespace', async () => {
    const storage = fakeStorage();
    const store = await freshStore({ localStorage: storage });
    store.setAccessCode('  demo-456  ');
    expect(store.snapshot().accessCode).toBe('demo-456');
    expect(storage.getItem('luban-nav:voice-access-code')).toBe('demo-456');
  });

  it('removes the stored code when the field is cleared', async () => {
    const storage = fakeStorage({ 'luban-nav:voice-access-code': 'old' });
    const store = await freshStore({ localStorage: storage });
    store.setAccessCode('');
    expect(store.snapshot().accessCode).toBe('');
    expect(storage.getItem('luban-nav:voice-access-code')).toBeNull();
  });

  it('degrades gracefully when localStorage is unavailable', async () => {
    const storage = fakeStorage();
    Object.defineProperty(storage, 'setItem', { value: () => { throw new Error('blocked'); } });
    const store = await freshStore({ localStorage: storage });
    expect(() => store.setAccessCode('demo-789')).not.toThrow();
    expect(store.snapshot().accessCode).toBe('demo-789');
  });
});
