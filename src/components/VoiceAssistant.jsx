import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MODES, NODE_BY_ID } from '../data/campus.js';
import { buildCampusAssistantInstructions } from '../lib/assistantKnowledge.js';
import { useI18n } from '../lib/i18n.js';
import { voiceSession, useVoiceSession } from '../lib/voiceSession.js';
import { fetchWeather } from '../lib/weather.js';

/**
 * Voice configuration + session panel (shown inside the system menu).
 *
 * The realtime session itself lives in the shared `voiceSession` store, so the
 * on-map VoiceQuickControl dock and this panel drive the exact same session
 * without App bridging control refs or state between them. This component only
 * registers its audio element, transcript/navigation callbacks and the
 * instruction stream with the store, and renders the access-code form.
 */
export function VoiceAssistant({
  route,
  onUserTranscript,
  onAssistantTranscript,
  onNavigationCommand,
  event,
}) {
  const { t } = useI18n();
  const {
    status,
    statusMessage,
    liveTranscript,
    accessCode,
    supported,
    active,
    start,
    stop,
    setAccessCode,
  } = useVoiceSession();
  const [weather, setWeather] = useState(null);
  const audioRef = useRef(null);
  const callbacksRef = useRef({
    onUserTranscript,
    onAssistantTranscript,
    onNavigationCommand,
  });
  callbacksRef.current = { onUserTranscript, onAssistantTranscript, onNavigationCommand };

  const routeContext = useMemo(() => {
    const mode = MODES[route?.request?.mode];
    return {
      fromId: route?.request?.from,
      fromName: NODE_BY_ID[route?.request?.from]?.name,
      toId: route?.request?.to,
      toName: NODE_BY_ID[route?.request?.to]?.name,
      modeLabel: mode?.label ?? '步行',
      distanceMeters: route?.summary?.distanceMeters,
      highlights: route?.highlights ?? [],
    };
  }, [route]);

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

  // Register this panel's audio element, callbacks and instruction stream with
  // the shared session store.
  useEffect(() => {
    voiceSession.attachAudio(audioRef.current);
  }, []);

  useEffect(() => {
    voiceSession.setHandlers({
      onUserTranscript: (text) => callbacksRef.current.onUserTranscript?.(text),
      onAssistantTranscript: (text) => callbacksRef.current.onAssistantTranscript?.(text),
      onNavigationCommand: (...argumentsList) =>
        callbacksRef.current.onNavigationCommand?.(...argumentsList),
    });
  }, []);

  useEffect(() => {
    voiceSession.updateInstructions(instructions);
  }, [instructions]);

  function startSession(event) {
    event?.preventDefault();
    start();
  }

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
            onClick={active ? stop : undefined}
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
