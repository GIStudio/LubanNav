import { useI18n } from '../lib/i18n.js';
import { useVoiceSession } from '../lib/voiceSession.js';

/**
 * On-map microphone dock.
 *
 * Reads the shared voice session store directly, so it needs no state or
 * control-ref props from App: start/stop and status/transcript all come from
 * the same session the in-menu VoiceAssistant panel drives. Only the
 * "open settings" callback remains, to reveal the configuration panel.
 *
 * Supports two talk modes: free talk (duplex VAD) and hold-to-talk
 * (tap2talk) for noisy demos — the mic button becomes a press-and-hold
 * control in tap2talk mode.
 */
export function VoiceQuickControl({ onConfigure }) {
  const { t } = useI18n();
  const {
    status,
    statusMessage,
    liveTranscript,
    configured,
    supported,
    active,
    interactionMode,
    setInteractionMode,
    pressTalkStart,
    pressTalkEnd,
    start,
    stop,
  } = useVoiceSession();

  const tapToTalk = interactionMode === 'tap2talk';
  const needsConfiguration = !configured || !supported;
  const headline = active
    ? (t(`voiceQuick.status.${status}`) || t('voiceQuick.headlineActive'))
    : (configured && supported ? t('voiceQuick.headlineReady') : t('voiceQuick.headlineConfig'));
  const detail = liveTranscript
    || (active ? statusMessage : '')
    || (supported ? t('voiceQuick.hintSupported') : t('voiceQuick.hintUnsupported'));
  const actionLabel = active
    ? (tapToTalk ? t('voiceQuick.holdToTalk') : t('voiceQuick.stop'))
    : (needsConfiguration ? t('voiceQuick.configure') : t('voiceQuick.start'));

  function handleToggle() {
    if (active) {
      stop();
      return;
    }
    if (needsConfiguration) {
      onConfigure();
      return;
    }
    start();
  }

  return (
    <section
      class={`voice-quick-dock ${active ? 'active' : ''} ${needsConfiguration ? 'needs-config' : ''} ${tapToTalk ? 'tap2talk' : ''}`}
      aria-label={t('voiceQuick.aria')}
    >
      <div class="voice-quick-copy" aria-live="polite">
        <p class="eyebrow">QWEN REALTIME / QUICK TALK</p>
        <strong>{headline}</strong>
        <small>{detail}</small>
      </div>

      <button
        type="button"
        class="voice-mic-button"
        onClick={handleToggle}
        onPointerDown={active && tapToTalk ? () => pressTalkStart() : undefined}
        onPointerUp={active && tapToTalk ? () => pressTalkEnd() : undefined}
        onPointerLeave={active && tapToTalk ? () => pressTalkEnd() : undefined}
        onPointerCancel={active && tapToTalk ? () => pressTalkEnd() : undefined}
        aria-label={actionLabel}
        aria-pressed={active}
        title={actionLabel}
      >
        <span class="voice-mic-rings" aria-hidden="true" />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75V6.25a3.75 3.75 0 0 0-7.5 0v5.25A3.75 3.75 0 0 0 12 15.25Z" />
          <path d="M5.75 11.25v.25a6.25 6.25 0 0 0 12.5 0v-.25M12 17.75v3M9.25 20.75h5.5" />
        </svg>
        <span class="voice-mic-label">
          {active
            ? (tapToTalk ? t('voiceQuick.holdToTalk') : t('voiceQuick.micStop'))
            : (needsConfiguration ? t('voiceQuick.micConfigure') : t('voiceQuick.micStart'))}
        </span>
      </button>

      <div class="voice-quick-actions">
        <button
          type="button"
          class="voice-quick-mode"
          onClick={() => setInteractionMode(tapToTalk ? 'duplex' : 'tap2talk')}
          title={tapToTalk ? t('voiceQuick.modeDuplexTitle') : t('voiceQuick.modeTapToTalkTitle')}
          aria-pressed={tapToTalk}
        >
          <span aria-hidden="true">{tapToTalk ? '✊' : '◉'}</span>
          {tapToTalk ? t('voiceQuick.modeTapToTalk') : t('voiceQuick.modeDuplex')}
        </button>
        <button type="button" class="voice-quick-settings" onClick={onConfigure}>
          <span>{t('voiceQuick.settings')}</span>
          <b aria-hidden="true">↗</b>
        </button>
      </div>
    </section>
  );
}
