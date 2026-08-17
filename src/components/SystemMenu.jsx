import { useEffect, useRef } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';
import { RobotControl } from './RobotControl.jsx';
import { VoiceAssistant } from './VoiceAssistant.jsx';

const PANELS = [
  { id: 'voice', code: 'VOICE' },
  { id: 'robot', code: 'BLE' },
];

export function SystemMenu({
  open,
  onClose,
  activePanel,
  onSelectPanel,
  route,
  event,
  onVoiceUserTranscript,
  onVoiceAssistantTranscript,
  onVoiceNavigationCommand,
  onRobotPosition,
  voiceControlRef,
  onVoiceControlStateChange,
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    closeButtonRef.current?.focus();
    const handleKeyDown = (keyboardEvent) => {
      if (keyboardEvent.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  return (
    <div
      class="system-menu-backdrop"
      hidden={!open}
      aria-hidden={!open}
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget) onClose();
      }}
    >
      <aside class="system-menu" role="dialog" aria-modal="true" aria-labelledby="system-menu-title">
        <header class="system-menu-header">
          <div>
            <p class="eyebrow">LIVE SERVICES / DEVICE LINK</p>
            <h2 id="system-menu-title">{t('system.title')}</h2>
            <small>{t('system.subtitle')}</small>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            class="system-menu-close"
            onClick={onClose}
            aria-label={t('system.close')}
          >×</button>
        </header>

        <nav class="system-menu-tabs" role="tablist" aria-label={t('system.tabsAria')}>
          {PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              id={`system-menu-tab-${panel.id}`}
              role="tab"
              class={activePanel === panel.id ? 'active' : ''}
              aria-selected={activePanel === panel.id}
              aria-controls={`system-menu-panel-${panel.id}`}
              onClick={() => onSelectPanel(panel.id)}
            >
              <span>{panel.code}</span>
              {t(`system.panels.${panel.id}`)}
            </button>
          ))}
        </nav>

        <div class="system-menu-content">
          <section
            id="system-menu-panel-voice"
            class="system-menu-pane"
            role="tabpanel"
            aria-labelledby="system-menu-tab-voice"
            hidden={activePanel !== 'voice'}
            aria-label={t('system.voiceAria')}
          >
            <div class="system-pane-intro">
              <span>01</span>
              <p>{t('system.voiceIntro')}</p>
            </div>
            <VoiceAssistant
              route={route}
              onUserTranscript={onVoiceUserTranscript}
              onAssistantTranscript={onVoiceAssistantTranscript}
              onNavigationCommand={onVoiceNavigationCommand}
              event={event}
              controlRef={voiceControlRef}
              onControlStateChange={onVoiceControlStateChange}
            />
          </section>

          <section
            id="system-menu-panel-robot"
            class="system-menu-pane"
            role="tabpanel"
            aria-labelledby="system-menu-tab-robot"
            hidden={activePanel !== 'robot'}
            aria-label={t('system.robotAria')}
          >
            <div class="system-pane-intro">
              <span>02</span>
              <p>{t('system.robotIntro')}</p>
            </div>
            <RobotControl route={route} onRobotPosition={onRobotPosition} />
          </section>
        </div>
      </aside>
    </div>
  );
}
