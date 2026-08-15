import { useEffect, useRef, useState } from 'preact/hooks';
import { RobotControl } from './RobotControl.jsx';
import { VoiceAssistant } from './VoiceAssistant.jsx';

const PANELS = [
  { id: 'voice', label: '实时语音', code: 'VOICE' },
  { id: 'robot', label: '机器人联络', code: 'BLE' },
];

export function SystemMenu({
  open,
  onClose,
  route,
  event,
  onVoiceUserTranscript,
  onVoiceAssistantTranscript,
  onVoiceNavigationCommand,
  onRobotPosition,
}) {
  const [activePanel, setActivePanel] = useState('voice');
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
            <h2 id="system-menu-title">语音与设备</h2>
            <small>按需启用，不占用地图主视区</small>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            class="system-menu-close"
            onClick={onClose}
            aria-label="关闭语音与设备面板"
          >×</button>
        </header>

        <nav class="system-menu-tabs" role="tablist" aria-label="设置类型">
          {PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              id={`system-menu-tab-${panel.id}`}
              role="tab"
              class={activePanel === panel.id ? 'active' : ''}
              aria-selected={activePanel === panel.id}
              aria-controls={`system-menu-panel-${panel.id}`}
              onClick={() => setActivePanel(panel.id)}
            >
              <span>{panel.code}</span>
              {panel.label}
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
            aria-label="实时语音配置"
          >
            <div class="system-pane-intro">
              <span>01</span>
              <p>连接 Qwen 实时会话，语音中的导航命令仍由页面本地 A* 校验和执行。</p>
            </div>
            <VoiceAssistant
              route={route}
              onUserTranscript={onVoiceUserTranscript}
              onAssistantTranscript={onVoiceAssistantTranscript}
              onNavigationCommand={onVoiceNavigationCommand}
              event={event}
            />
          </section>

          <section
            id="system-menu-panel-robot"
            class="system-menu-pane"
            role="tabpanel"
            aria-labelledby="system-menu-tab-robot"
            hidden={activePanel !== 'robot'}
            aria-label="机器人联络配置"
          >
            <div class="system-pane-intro">
              <span>02</span>
              <p>连接 BLE/GATT 小车、下发当前路线并查看 WGS84 位置回传。</p>
            </div>
            <RobotControl route={route} onRobotPosition={onRobotPosition} />
          </section>
        </div>
      </aside>
    </div>
  );
}
