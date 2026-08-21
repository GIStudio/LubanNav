import { useSyncExternalStore } from 'preact/compat';
import { QwenRealtimeSession } from './qwenRealtime.js';

/**
 * Shared realtime-voice session controller.
 *
 * Both voice UIs (the in-menu VoiceAssistant panel and the on-map
 * VoiceQuickControl dock) consume this single store, so the App shell no
 * longer bridges control refs and state between them. VoiceAssistant
 * registers the audio element, instruction builder output, and transcript /
 * navigation handlers; either UI can then start/stop the session.
 *
 * The demo access code is persisted to localStorage (key
 * `luban-nav:voice-access-code`) so returning visitors do not have to type
 * it again; clearing the input removes the stored value.
 */

const INACTIVE_STATUSES = ['idle', 'ended', 'error'];

const ACCESS_CODE_STORAGE_KEY = 'luban-nav:voice-access-code';
const INTERACTION_MODE_STORAGE_KEY = 'luban-nav:interaction-mode';
export const INTERACTION_MODES = ['duplex', 'tap2talk'];

function loadStoredAccessCode() {
  try {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(ACCESS_CODE_STORAGE_KEY) ?? '';
  } catch {
    // localStorage may be unavailable (private mode, disabled storage)
    return '';
  }
}

function loadStoredInteractionMode() {
  try {
    if (typeof window === 'undefined') return 'duplex';
    const stored = window.localStorage.getItem(INTERACTION_MODE_STORAGE_KEY);
    return INTERACTION_MODES.includes(stored) ? stored : 'duplex';
  } catch {
    return 'duplex';
  }
}

let session = null;
let audioElement = null;
let instructions = '';
let handlers = {};

const initialState = {
  status: 'idle',
  statusMessage: '',
  liveTranscript: '',
  accessCode: loadStoredAccessCode(),
  interactionMode: loadStoredInteractionMode(),
  supported: Boolean(
    typeof window !== 'undefined'
      && window.isSecureContext
      && navigator.mediaDevices?.getUserMedia
      && window.RTCPeerConnection,
  ),
};

let state = initialState;

const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

function patch(partial) {
  state = { ...state, ...partial };
  emit();
}

function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function snapshot() {
  return state;
}

function setAccessCode(accessCode) {
  const next = String(accessCode ?? '').trim();
  try {
    if (typeof window === 'undefined') return patch({ accessCode: next });
    if (next) window.localStorage.setItem(ACCESS_CODE_STORAGE_KEY, next);
    else window.localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
  } catch {
    // ignore persistence failures (private mode, disabled storage)
  }
  patch({ accessCode: next });
}

function setInteractionMode(mode) {
  if (!INTERACTION_MODES.includes(mode)) return;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INTERACTION_MODE_STORAGE_KEY, mode);
    }
  } catch {
    // ignore persistence failures
  }
  patch({ interactionMode: mode });
  session?.updateInteractionMode(mode);
}

function attachAudio(element) {
  audioElement = element;
}

function setHandlers(nextHandlers) {
  handlers = nextHandlers ?? {};
}

function updateInstructions(nextInstructions) {
  instructions = nextInstructions ?? '';
  session?.updateInstructions(instructions);
}

function isActive() {
  return !INACTIVE_STATUSES.includes(state.status);
}

async function start() {
  if (isActive() || !state.supported || !state.accessCode.trim()) return;
  patch({ liveTranscript: '' });

  const next = new QwenRealtimeSession({
    accessCode: state.accessCode,
    instructions,
    audioElement,
    interactionMode: state.interactionMode,
    functionHandlers: {
      set_navigation_route: (...argumentsList) =>
        handlers.onNavigationCommand?.(...argumentsList),
    },
  });
  session = next;

  next.addEventListener('status', (statusEvent) => {
    patch({
      status: statusEvent.detail.status,
      statusMessage: statusEvent.detail.message || '',
    });
  });
  next.addEventListener('user-transcript-delta', (transcriptEvent) => {
    patch({ liveTranscript: `${state.liveTranscript}${transcriptEvent.detail.text}` });
  });
  next.addEventListener('user-transcript', (transcriptEvent) => {
    const text = transcriptEvent.detail.text.trim();
    if (text) handlers.onUserTranscript?.(text);
    patch({ liveTranscript: '' });
  });
  next.addEventListener('assistant-transcript-delta', (transcriptEvent) => {
    patch({ liveTranscript: `${state.liveTranscript}${transcriptEvent.detail.text}` });
  });
  next.addEventListener('assistant-transcript', (transcriptEvent) => {
    const text = transcriptEvent.detail.text.trim();
    if (text) handlers.onAssistantTranscript?.(text);
    patch({ liveTranscript: '' });
  });
  next.addEventListener('error', () => {
    if (session === next) session = null;
  });

  try {
    await next.start();
  } catch {
    // The session emits a user-facing status and performs its own cleanup.
  }
}

function stop() {
  session?.stop('user');
  session = null;
  patch({ liveTranscript: '' });
}

function pressTalkStart() {
  session?.pressTalkStart();
}

function pressTalkEnd() {
  session?.pressTalkEnd();
}

export const voiceSession = {
  subscribe,
  snapshot,
  setAccessCode,
  setInteractionMode,
  attachAudio,
  setHandlers,
  updateInstructions,
  pressTalkStart,
  pressTalkEnd,
  start,
  stop,
};

export function useVoiceSession() {
  const current = useSyncExternalStore(subscribe, snapshot);
  return {
    ...current,
    active: !INACTIVE_STATUSES.includes(current.status),
    configured: Boolean(current.accessCode.trim()),
    start,
    stop,
    setAccessCode,
    setInteractionMode,
    pressTalkStart,
    pressTalkEnd,
  };
}
