import { useI18n } from '../lib/i18n.js';

export function VoiceQuickControl({ state, onToggle, onConfigure }) {
  const { t } = useI18n();
  const active = Boolean(state.active);
  const configured = Boolean(state.configured);
  const supported = state.supported !== false;
  const needsConfiguration = !configured || !supported;
  const headline = active
    ? (t(`voiceQuick.status.${state.status}`) || t('voiceQuick.headlineActive'))
    : (configured && supported ? t('voiceQuick.headlineReady') : t('voiceQuick.headlineConfig'));
  const detail = state.liveTranscript
    || (active ? state.statusMessage : '')
    || (supported ? t('voiceQuick.hintSupported') : t('voiceQuick.hintUnsupported'));
  const actionLabel = active
    ? t('voiceQuick.stop')
    : (needsConfiguration ? t('voiceQuick.configure') : t('voiceQuick.start'));

  return (
    <section
      class={`voice-quick-dock ${active ? 'active' : ''} ${needsConfiguration ? 'needs-config' : ''}`}
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
        onClick={onToggle}
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
          {active ? t('voiceQuick.micStop') : (needsConfiguration ? t('voiceQuick.micConfigure') : t('voiceQuick.micStart'))}
        </span>
      </button>

      <button type="button" class="voice-quick-settings" onClick={onConfigure}>
        <span>{t('voiceQuick.settings')}</span>
        <b aria-hidden="true">↗</b>
      </button>
    </section>
  );
}
