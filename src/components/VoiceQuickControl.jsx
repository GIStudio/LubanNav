const STATUS_COPY = {
  authorizing: '正在验证演示访问码',
  'requesting-microphone': '请允许浏览器使用麦克风',
  connecting: '正在连接 Qwen 实时会话',
  listening: '可以说出目的地或校园问题',
  'user-speaking': '正在聆听你的问题',
  thinking: '正在理解并校验导航意图',
  'assistant-speaking': '助手正在回答',
  'audio-blocked': '点击页面以允许播放语音',
  'time-limit': '本次实时会话已到达时限',
  ended: '会话已结束，可再次点击麦克风',
  error: '连接失败，请打开语音设置查看',
};

export function VoiceQuickControl({ state, onToggle, onConfigure }) {
  const active = Boolean(state.active);
  const configured = Boolean(state.configured);
  const supported = state.supported !== false;
  const needsConfiguration = !configured || !supported;
  const headline = active
    ? (STATUS_COPY[state.status] || '实时语音会话进行中')
    : (configured && supported ? '点击麦克风，直接和导航助手说话' : '配置实时语音后即可一键对话');
  const detail = state.liveTranscript
    || (active ? state.statusMessage : '')
    || (supported
      ? '可说“从校门口导航到图书馆”'
      : '当前浏览器不支持麦克风 WebRTC，请查看设置');
  const actionLabel = active ? '结束实时语音' : (needsConfiguration ? '配置实时语音' : '开始实时语音');

  return (
    <section
      class={`voice-quick-dock ${active ? 'active' : ''} ${needsConfiguration ? 'needs-config' : ''}`}
      aria-label="实时语音快捷控制"
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
        <span class="voice-mic-label">{active ? '结束' : (needsConfiguration ? '配置' : '对话')}</span>
      </button>

      <button type="button" class="voice-quick-settings" onClick={onConfigure}>
        <span>语音设置</span>
        <b aria-hidden="true">↗</b>
      </button>
    </section>
  );
}
