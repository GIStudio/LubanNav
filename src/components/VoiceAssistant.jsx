import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { NODE_BY_ID } from '../data/campus.js';
import { buildCampusAssistantInstructions } from '../lib/assistantKnowledge.js';
import { DEFAULT_VOICE_CONFIG, QwenRealtimeSession } from '../lib/qwenRealtime.js';

const STATUS_LABELS = {
  idle: '等待连接',
  authorizing: '验证访问码',
  'requesting-microphone': '请求麦克风',
  connecting: '连接模型',
  listening: '正在聆听',
  'user-speaking': '正在聆听',
  thinking: '正在理解',
  'assistant-speaking': '正在回答',
  'audio-blocked': '等待播放权限',
  'time-limit': '到达时限',
  ended: '会话已结束',
  error: '连接失败',
};

export function VoiceAssistant({
  route,
  onUserTranscript,
  onAssistantTranscript,
  onNavigationCommand,
}) {
  const [accessCode, setAccessCode] = useState('');
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('点击后会请求麦克风权限');
  const [liveTranscript, setLiveTranscript] = useState('');
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
  }), [route]);
  const instructions = useMemo(
    () => buildCampusAssistantInstructions(routeContext),
    [routeContext],
  );

  const active = !['idle', 'ended', 'error'].includes(status);
  const supported = Boolean(
    window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection,
  );

  useEffect(() => {
    sessionRef.current?.updateInstructions(instructions);
  }, [instructions]);

  useEffect(() => () => sessionRef.current?.stop('unmount', false), []);

  async function startSession(event) {
    event.preventDefault();
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
      setStatusMessage(statusEvent.detail.message || STATUS_LABELS[statusEvent.detail.status] || '');
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
  }

  function stopSession() {
    sessionRef.current?.stop('user');
    sessionRef.current = null;
    setLiveTranscript('');
  }

  return (
    <div class="voice-assistant">
      <div class="voice-heading">
        <div>
          <strong>实时语音</strong>
          <small>QWEN REALTIME · 最长 3 分钟</small>
        </div>
        <span class={`voice-status ${status}`}>{STATUS_LABELS[status] || status}</span>
      </div>

      {!supported ? (
        <p class="voice-notice warning">当前浏览器或页面环境不支持麦克风 WebRTC，请使用 HTTPS 下的最新版 Chrome 或 Edge。</p>
      ) : (
        <form class="voice-form" onSubmit={startSession}>
          <label>
            <span>演示访问码</span>
            <input
              type="password"
              value={accessCode}
              onInput={(event) => setAccessCode(event.currentTarget.value)}
              placeholder="仅保存在当前页面内存"
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
            {active ? '结束会话' : '开始语音'}
          </button>
        </form>
      )}

      <p class="voice-notice" aria-live="polite">{liveTranscript || statusMessage}</p>
      <p class="voice-privacy">仅 SDP 经函数计算代理，通话音频直连百炼；请勿在对话中提供敏感信息。</p>
      <audio ref={audioRef} autoplay playsinline />
    </div>
  );
}
