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
 */

const INACTIVE_STATUSES = ['idle', 'ended', 'error'];

let session = null;
let audioElement = null;
let instructions = '';
let handlers = {};

const initialState = {
  status: 'idle',
  statusMessage: '',
  liveTranscript: '',
  accessCode: '',
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
  patch({ accessCode });
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

export const voiceSession = {
  subscribe,
  snapshot,
  setAccessCode,
  attachAudio,
  setHandlers,
  updateInstructions,
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
  };
}
