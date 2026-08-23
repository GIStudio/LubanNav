import { useEffect, useRef } from 'preact/hooks';
import { useFullscreen } from '../lib/fullscreen.js';
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
  robotPosition,
  browserPosition,
  routeStartedAt,
}) {
  const { t } = useI18n();
  const closeButtonRef = useRef(null);
  const fullscreen = useFullscreen();

  useEffect(() => {
    if (!open) return undefined;
    closeButtonRef.current?.focus();
    const handleKeyDown = (keyboardEvent) => {
      if (keyboardEvent.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  function handleFullscreen() {
    const entering = fullscreen.toggle();
    // Entering fullscreen hides the browser UI — close the menu so the demo
    // view is unobstructed; exiting keeps the menu open.
    if (entering) onClose();
  }

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

        <button
          type="button"
          class={`system-menu-fullscreen ${fullscreen.isFullscreen ? 'active' : ''}`}
          onClick={handleFullscreen}
          disabled={!fullscreen.supported}
          aria-pressed={fullscreen.isFullscreen}
          title={fullscreen.supported ? t('system.fullscreenHint') : t('system.fullscreenUnsupported')}
        >
          <span class="system-menu-fullscreen-icon" aria-hidden="true">
            {fullscreen.isFullscreen ? '⤢' : '⛶'}
          </span>
          <span class="system-menu-fullscreen-copy">
            <strong>
              {fullscreen.isFullscreen ? t('system.exitFullscreen') : t('system.fullscreen')}
            </strong>
            <small>
              {fullscreen.supported ? t('system.fullscreenHint') : t('system.fullscreenUnsupported')}
            </small>
          </span>
          <span class="system-menu-fullscreen-state" aria-hidden="true" />
        </button>

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
              routeStartedAt={routeStartedAt}
              robotPosition={robotPosition}
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
            <RobotControl
              route={route}
              onRobotPosition={onRobotPosition}
              browserPosition={browserPosition}
            />
          </section>
        </div>
      </aside>
    </div>
  );
}
