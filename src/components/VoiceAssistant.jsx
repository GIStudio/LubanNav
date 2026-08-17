import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { NODE_BY_ID } from '../data/campus.js';
import { buildCampusAssistantInstructions } from '../lib/assistantKnowledge.js';
import { useI18n } from '../lib/i18n.js';
import { DEFAULT_VOICE_CONFIG, QwenRealtimeSession } from '../lib/qwenRealtime.js';
import { fetchWeather } from '../lib/weather.js';

export function VoiceAssistant({
  route,
  onUserTranscript,
  onAssistantTranscript,
  onNavigationCommand,
  event,
  controlRef,
  onControlStateChange,
}) {
  const { t } = useI18n();
  const [accessCode, setAccessCode] = useState('');
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [weather, setWeather] = useState(null);
  const sessionRef = useRef(null);
  const audioRef = useRef(null);
  const callbacksRef = useRef({
    onUserTranscript,
    onAssistantTranscript,
    onNavigationCommand,
  });
  callbacksRef.current = { onUserTranscript, onAssistantTranscript, onNavigationCommand };

  const routeContext = useMemo(() => ({
    fromId: route?.request?.from,
    fromName: NODE_BY_ID[route?.request?.from]?.name,
    toId: route?.request?.to,
    toName: NODE_BY_ID[route?.request?.to]?.name,
    modeLabel: route?.request?.mode === 'robot' ? '机器人' : '步行',
    distanceMeters: route?.summary?.distanceMeters,
    highlights: route?.highlights ?? [],
  }), [route]);

  // Refresh weather when the route changes. fetchWeather caches for 10 min,
  // and degrades to an "unavailable" object on network failure.
  useEffect(() => {
    let cancelled = false;
    fetchWeather().then((result) => {
      if (!cancelled) setWeather(result);
    });
    return () => {
      cancelled = true;
    };
  }, [route?.request?.from, route?.request?.to, route?.request?.mode]);

  const instructions = useMemo(
    () => buildCampusAssistantInstructions(routeContext, event, weather),
    [event, routeContext, weather],
  );

  const active = !['idle', 'ended', 'error'].includes(status);
  const supported = Boolean(
    window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection,
  );
  const configured = Boolean(accessCode.trim());

  useEffect(() => {
    sessionRef.current?.updateInstructions(instructions);
  }, [instructions]);

  useEffect(() => () => sessionRef.current?.stop('unmount', false), []);

  const startSession = useCallback(async (event = null) => {
    event?.preventDefault();
    if (active) return;
    setLiveTranscript('');

    const session = new QwenRealtimeSession({
      accessCode,
      instructions,
      audioElement: audioRef.current,
      functionHandlers: {
        set_navigation_route: (...argumentsList) =>
          callbacksRef.current.onNavigationCommand?.(...argumentsList),
      },
    });
    sessionRef.current = session;

    session.addEventListener('status', (statusEvent) => {
      setStatus(statusEvent.detail.status);
      setStatusMessage(statusEvent.detail.message || t(`voice.status.${statusEvent.detail.status}`) || '');
    });
    session.addEventListener('user-transcript-delta', (transcriptEvent) => {
      setLiveTranscript((current) => `${current}${transcriptEvent.detail.text}`);
    });
    session.addEventListener('user-transcript', (transcriptEvent) => {
      const text = transcriptEvent.detail.text.trim();
      if (text) callbacksRef.current.onUserTranscript?.(text);
      setLiveTranscript('');
    });
    session.addEventListener('assistant-transcript-delta', (transcriptEvent) => {
      setLiveTranscript((current) => `${current}${transcriptEvent.detail.text}`);
    });
    session.addEventListener('assistant-transcript', (transcriptEvent) => {
      const text = transcriptEvent.detail.text.trim();
      if (text) callbacksRef.current.onAssistantTranscript?.(text);
      setLiveTranscript('');
    });
    session.addEventListener('error', () => {
      sessionRef.current = null;
    });

    try {
      await session.start();
    } catch {
      // The session emits a user-facing status and performs its own cleanup.
    }
  }, [accessCode, active, instructions]);

  const stopSession = useCallback(() => {
    sessionRef.current?.stop('user');
    sessionRef.current = null;
    setLiveTranscript('');
  }, []);

  useEffect(() => {
    if (!controlRef) return undefined;
    const controls = { start: startSession, stop: stopSession };
    controlRef.current = controls;
    return () => {
      if (controlRef.current === controls) controlRef.current = null;
    };
  }, [controlRef, startSession, stopSession]);

  useEffect(() => {
    onControlStateChange?.({
      status,
      active,
      configured,
      supported,
      liveTranscript,
      statusMessage,
    });
  }, [active, configured, liveTranscript, onControlStateChange, status, statusMessage, supported]);

  return (
    <div class="voice-assistant">
      <div class="voice-heading">
        <div>
          <strong>{t('voice.title')}</strong>
          <small>{t('voice.subtitle')}</small>
        </div>
        <span class={`voice-status ${status}`}>{t(`voice.status.${status}`)}</span>
      </div>

      {!supported ? (
        <p class="voice-notice warning">{t('voice.unsupported')}</p>
      ) : (
        <form class="voice-form" onSubmit={startSession}>
          <label>
            <span>{t('voice.accessCode')}</span>
            <input
              type="password"
              value={accessCode}
              onInput={(event) => setAccessCode(event.currentTarget.value)}
              placeholder={t('voice.accessCodePlaceholder')}
              autocomplete="off"
              disabled={active}
            />
          </label>
          <button
            type={active ? 'button' : 'submit'}
            class={active ? 'voice-stop' : 'voice-start'}
            onClick={active ? stopSession : undefined}
            disabled={!active && !accessCode.trim()}
          >
            <span aria-hidden="true">{active ? '■' : '●'}</span>
            {active ? t('voice.stop') : t('voice.start')}
          </button>
        </form>
      )}

      <p class="voice-notice" aria-live="polite">{liveTranscript || statusMessage || t('voice.hintStart')}</p>
      <p class="voice-privacy">{t('voice.privacy')}</p>
      <audio ref={audioRef} autoplay playsinline />
    </div>
  );
}
