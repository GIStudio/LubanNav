import { NAVIGATION_TOOL } from './voiceNavigation.js';

const DEFAULT_GATEWAY_ENDPOINT =
  'https://lubannace-token-wwdlyxygjx.cn-hangzhou.fcapp.run/voice/session';

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  gatewayEndpoint:
    import.meta.env.VITE_VOICE_GATEWAY_URL
    || import.meta.env.VITE_VOICE_TOKEN_URL
    || DEFAULT_GATEWAY_ENDPOINT,
  model: 'qwen3.5-omni-flash-realtime',
  voice: 'Tina',
  // A walking navigation session can run for minutes, so the session cap is
  // generous; when it is reached the session renews itself automatically.
  maxSessionMs: 10 * 60 * 1000,
});

export class VoiceSessionError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'VoiceSessionError';
    this.code = code;
    this.status = status;
  }
}

export async function requestWebRtcAnswer({
  endpoint = DEFAULT_VOICE_CONFIG.gatewayEndpoint,
  accessCode,
  offerSdp,
  fetchImpl = fetch,
}) {
  const code = String(accessCode || '').trim();
  if (!code) {
    throw new VoiceSessionError('access-code', '请输入演示访问码。');
  }
  if (!String(offerSdp || '').startsWith('v=0')) {
    throw new VoiceSessionError('offer-sdp', '浏览器没有生成有效的 WebRTC Offer。');
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: code, offerSdp }),
    });
  } catch {
    throw new VoiceSessionError('gateway-network', '语音网关暂时无法访问，请检查网络后重试。');
  }

  let body = {};
  try {
    body = await response.json();
  } catch {
    // A non-JSON gateway error is handled by the status branch below.
  }

  if (!response.ok) {
    const upstreamStatus = body?.upstreamStatus;
    let message;
    if (body?.error === 'invalid_access_code') {
      message = '访问码无效，请重新输入。';
    } else if (body?.error === 'origin_not_allowed') {
      message = '当前网页来源未被允许。';
    } else if (body?.error === 'rate_limited') {
      message = '请求过于频繁，请稍后再试。';
    } else if (response.status === 429 || upstreamStatus === 429) {
      message = '百炼并发或限流，正在等待后自动重试。';
    } else if (upstreamStatus === 401 || upstreamStatus === 403) {
      message = '百炼授权失败，请检查语音网关的 API Key 与 Workspace 配置。';
    } else if (response.status === 502 || response.status >= 500) {
      message = '百炼语音服务暂时拒绝连接，正在自动重试。';
    } else {
      message = body?.error || '语音网关建立会话失败。';
    }
    throw new VoiceSessionError('gateway-rejected', message, response.status);
  }

  if (!body.answerSdp || typeof body.answerSdp !== 'string' || !body.answerSdp.startsWith('v=0')) {
    throw new VoiceSessionError('gateway-payload', '语音网关响应缺少有效的 Answer SDP。');
  }

  return body.answerSdp;
}

export function buildSessionUpdate({ instructions, voice = DEFAULT_VOICE_CONFIG.voice, interactionMode = 'duplex' }) {
  // "Hold to talk" keeps server VAD (no protocol risk) but makes it far less
  // trigger-happy and relies on the client muting the mic while not held:
  // noisy demos (robot riding) no longer cut the user off mid-sentence.
  const tapToTalk = interactionMode === 'tap2talk';
  return {
    event_id: `lubannav-${crypto.randomUUID()}`,
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice,
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16000 } },
        output: { format: { type: 'pcm', sample_rate: 24000 } },
      },
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      instructions,
      turn_detection: tapToTalk
        ? { type: 'semantic_vad', threshold: 0.7, silence_duration_ms: 2500 }
        : { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800 },
      max_tokens: 512,
      temperature: 0.6,
      enable_search: false,
      tools: [NAVIGATION_TOOL],
    },
  };
}

export function buildFunctionCallOutput(callId, output) {
  return {
    event_id: `lubannav-${crypto.randomUUID()}`,
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    },
  };
}

export function buildResponseCreate() {
  return {
    event_id: `lubannav-${crypto.randomUUID()}`,
    type: 'response.create',
    response: { modalities: ['text', 'audio'] },
  };
}

export function waitForIceGatheringComplete(peerConnection, timeoutMs = 8000) {
  if (peerConnection.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      peerConnection.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (peerConnection.iceGatheringState === 'complete') finish();
    };
    timer = setTimeout(finish, timeoutMs);
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

function eventDetail(type, detail = {}) {
  return new CustomEvent(type, { detail });
}

export class QwenRealtimeSession extends EventTarget {
  constructor({
    accessCode,
    instructions,
    audioElement,
    gatewayEndpoint = DEFAULT_VOICE_CONFIG.gatewayEndpoint,
    fetchImpl = fetch,
    mediaDevices = navigator.mediaDevices,
    PeerConnection = RTCPeerConnection,
    maxSessionMs = DEFAULT_VOICE_CONFIG.maxSessionMs,
    functionHandlers = {},
    autoReconnect = true,
    disconnectGraceMs = 4000,
    interactionMode = 'duplex',
  }) {
    super();
    this.accessCode = accessCode;
    this.instructions = instructions;
    this.audioElement = audioElement;
    this.gatewayEndpoint = gatewayEndpoint;
    this.fetchImpl = fetchImpl;
    this.mediaDevices = mediaDevices;
    this.PeerConnection = PeerConnection;
    this.maxSessionMs = maxSessionMs;
    this.functionHandlers = functionHandlers;
    this.autoReconnect = autoReconnect;
    this.disconnectGraceMs = disconnectGraceMs;
    this.interactionMode = interactionMode;
    this.tapToTalk = interactionMode === 'tap2talk';
    this.seenEventIds = new Set();
    this.completedFunctionCalls = new Set();
    this.started = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.disconnectGraceTimer = null;
    this.slowMode = false;
    // Aggressive backoff: chattier sessions must resume quickly after a
    // hiccup. 1s→2s→3s→5s→8s→12s, then a 15s ceiling (the gateway rate
    // limit is 30 requests / 5 min, so 15s spacing stays well below it).
    this.reconnectDelayMs = [1000, 2000, 3000, 5000, 8000, 12000];
    // Auth failures and upstream quota/concurrency pressure (401/403/429)
    // recover on a slower clock; hammering the gateway would only make the
    // outage worse.
    this.slowReconnectDelayMs = 60_000;
  }

  emitStatus(status, message = '') {
    this.dispatchEvent(eventDetail('status', { status, message }));
  }

  /** Delay before the next reconnect attempt. */
  nextReconnectDelay() {
    if (this.slowMode) return this.slowReconnectDelayMs;
    if (this.reconnectAttempts < this.reconnectDelayMs.length) {
      return this.reconnectDelayMs[this.reconnectAttempts];
    }
    return 15_000;
  }

  handleConnectionStateChange() {
    const state = this.peerConnection?.connectionState;
    if (state === 'connected') {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
      this.reconnectAttempts = 0;
      return;
    }
    if (state === 'disconnected') {
      // ICE may recover on its own; only reconnect after a grace period.
      if (!this.disconnectGraceTimer) {
        this.disconnectGraceTimer = setTimeout(() => {
          this.disconnectGraceTimer = null;
          if (this.peerConnection?.connectionState !== 'connected') {
            void this.reconnect('network');
          }
        }, this.disconnectGraceMs);
      }
      return;
    }
    if (state === 'failed') {
      void this.reconnect('network');
    }
  }

  /** Create the peer connection, media channel, offer and gateway exchange. */
  async connectPeerConnection() {
    this.peerConnection = new this.PeerConnection({ iceServers: [] });
    const [track] = this.stream.getAudioTracks();
    if (!track) throw new VoiceSessionError('microphone', '没有找到可用的麦克风。');

    this.peerConnection.addTrack(track, this.stream);
    this.peerConnection.addEventListener('track', (event) => {
      if (!this.audioElement) return;
      this.audioElement.srcObject = event.streams[0];
      this.audioElement.play().catch(() => {
        this.emitStatus('audio-blocked', '请点击页面后允许播放语音');
      });
    });
    this.peerConnection.addEventListener('connectionstatechange', () => {
      this.handleConnectionStateChange();
    });
    this.peerConnection.addEventListener('datachannel', (event) => this.attachChannel(event.channel));

    this.dataChannel = this.peerConnection.createDataChannel('oai-events');
    this.attachChannel(this.dataChannel);

    this.emitStatus('connecting', '正在连接语音模型');
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.peerConnection);

    this.emitStatus('authorizing', '正在通过语音网关建立会话');
    const answerSdp = await requestWebRtcAnswer({
      endpoint: this.gatewayEndpoint,
      accessCode: this.accessCode,
      offerSdp: this.peerConnection.localDescription.sdp,
      fetchImpl: this.fetchImpl,
    });
    await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // Renew the session clock on every (re)connection, so a walking session
    // is not cut short by an old connection attempt.
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.handleSessionLimit(), this.maxSessionMs);
  }

  async start() {
    if (this.started) return;
    this.started = true;

    try {
      if (!this.mediaDevices?.getUserMedia || !this.PeerConnection) {
        throw new VoiceSessionError(
          'unsupported-browser',
          '当前浏览器不支持 WebRTC 麦克风会话，请使用最新版 Chrome 或 Edge。',
        );
      }

      this.emitStatus('requesting-microphone', '请允许使用麦克风');
      this.stream = await this.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const [track] = this.stream.getAudioTracks();
      if (!track) throw new VoiceSessionError('microphone', '没有找到可用的麦克风。');
      track.enabled = false;

      await this.connectPeerConnection();
    } catch (error) {
      this.fail(this.normalizeError(error));
      throw error;
    }
  }

  /**
   * Reconnect after a network hiccup or when the session cap is reached.
   * Backs off 1→2→3→5→8→12 s, then stays at 15 s and keeps retrying until
   * the link is back or the user stops the session — walking demos must not
   * die silently on a weak campus network, and chatty sessions need fast
   * recovery.
   */
  async reconnect(reason) {
    if (!this.autoReconnect || this.reconnecting || !this.started) return;
    this.reconnecting = true;
    clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.emitStatus(
      'reconnecting',
      reason === 'time-limit'
        ? '会话已到时限，正在自动续接…'
        : '网络波动，正在自动重连…',
    );

    while (this.started) {
      const delay = this.nextReconnectDelay();
      this.reconnectAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!this.started) break;
      try {
        await this.connectPeerConnection();
        this.reconnectAttempts = 0;
        this.slowMode = false;
        this.reconnecting = false;
        this.emitStatus('listening', '正在聆听');
        return;
      } catch (error) {
        // Auth / quota errors recover slowly; switch to the slow clock and
        // surface the specific reason instead of hammering the gateway.
        if ([401, 403, 429].includes(error?.status)) {
          this.slowMode = true;
          this.emitStatus('reconnecting', error?.message || '授权或限流问题，等待后自动重试…');
        }
      }
    }
    this.reconnecting = false;
  }

  handleSessionLimit() {
    if (!this.started || this.reconnecting) return;
    void this.reconnect('time-limit');
  }

  attachChannel(channel) {
    if (channel.__lubanNavAttached) return;
    channel.__lubanNavAttached = true;
    channel.addEventListener('message', (event) => this.handleServerEvent(event.data, channel));
  }

  handleServerEvent(raw, channel) {
    let serverEvent;
    try {
      serverEvent = JSON.parse(raw);
    } catch {
      return;
    }
    if (serverEvent.event_id && this.seenEventIds.has(serverEvent.event_id)) return;
    if (serverEvent.event_id) this.seenEventIds.add(serverEvent.event_id);

    switch (serverEvent.type) {
      case 'session.created':
        this.send(buildSessionUpdate({
          instructions: this.instructions,
          interactionMode: this.interactionMode,
        }), channel);
        break;
      case 'session.updated':
        // In hold-to-talk mode the mic stays muted until the user holds the
        // button; VAD would otherwise re-enable it right after start.
        this.setMicrophoneEnabled(!this.tapToTalk);
        this.emitStatus('listening', '正在聆听');
        break;
      case 'input_audio_buffer.speech_started':
        this.emitStatus('user-speaking', '正在聆听');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emitStatus('thinking', '正在理解');
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.dispatchEvent(eventDetail('user-transcript-delta', { text: serverEvent.delta || '' }));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.dispatchEvent(eventDetail('user-transcript', { text: serverEvent.transcript || '' }));
        break;
      case 'response.audio_transcript.delta':
        this.emitStatus('assistant-speaking', '正在回答');
        this.dispatchEvent(eventDetail('assistant-transcript-delta', { text: serverEvent.delta || '' }));
        break;
      case 'response.audio_transcript.done':
        this.dispatchEvent(eventDetail('assistant-transcript', { text: serverEvent.transcript || '' }));
        break;
      case 'response.function_call_arguments.done':
        void this.handleFunctionCall(serverEvent, channel);
        break;
      case 'response.done':
        this.emitStatus('listening', '正在聆听');
        break;
      case 'error':
        this.fail(
          new VoiceSessionError(
            'model-error',
            serverEvent.error?.message || '语音模型返回错误。',
          ),
        );
        break;
      default:
        break;
    }
  }

  async handleFunctionCall(serverEvent, channel) {
    const { call_id: callId, name } = serverEvent;
    if (!callId || this.completedFunctionCalls.has(callId)) return;
    this.completedFunctionCalls.add(callId);

    let output;
    try {
      const handler = this.functionHandlers[name];
      if (typeof handler !== 'function') {
        output = { ok: false, error: 'unsupported_tool', message: `不支持工具 ${name || 'unknown'}。` };
      } else {
        const argumentsValue = JSON.parse(serverEvent.arguments || '{}');
        output = await handler(argumentsValue, serverEvent);
        if (!output || typeof output !== 'object') output = { ok: true };
      }
    } catch (error) {
      output = {
        ok: false,
        error: 'tool_execution_failed',
        message: error instanceof SyntaxError ? '导航参数不是有效 JSON。' : '页面执行导航命令失败。',
      };
    }

    this.send(buildFunctionCallOutput(callId, output), channel);
    this.send(buildResponseCreate(), channel);
    this.dispatchEvent(eventDetail('function-call', { name, callId, output }));
  }

  send(payload, preferredChannel = this.dataChannel) {
    const channel = preferredChannel?.readyState === 'open'
      ? preferredChannel
      : this.dataChannel;
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(payload));
    return true;
  }

  updateInstructions(instructions) {
    this.instructions = instructions;
    this.send(buildSessionUpdate({
      instructions,
      interactionMode: this.interactionMode,
    }));
  }

  /** Switch talk mode mid-session (duplex ↔ hold-to-talk) and re-push it. */
  updateInteractionMode(mode) {
    this.interactionMode = mode;
    this.tapToTalk = mode === 'tap2talk';
    if (!this.started) return;
    this.send(buildSessionUpdate({
      instructions: this.instructions,
      interactionMode: mode,
    }));
    if (this.tapToTalk) this.setMicrophoneEnabled(false);
  }

  /** Hold-to-talk: open the mic while the user holds the button. */
  pressTalkStart() {
    if (!this.tapToTalk || !this.started) return;
    this.setMicrophoneEnabled(true);
    this.emitStatus('user-speaking', '正在聆听');
  }

  /** Hold-to-talk: mute the mic on release; VAD commits the turn. */
  pressTalkEnd() {
    if (!this.tapToTalk || !this.started) return;
    this.setMicrophoneEnabled(false);
  }

  setMicrophoneEnabled(enabled) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  normalizeError(error) {
    if (error instanceof VoiceSessionError) return error;
    if (error?.name === 'NotAllowedError') {
      return new VoiceSessionError('microphone-denied', '未获得麦克风权限，请在浏览器设置中允许。');
    }
    if (error?.name === 'NotFoundError') {
      return new VoiceSessionError('microphone-missing', '没有找到可用的麦克风。');
    }
    return new VoiceSessionError('voice-session', '语音会话启动失败，请重试。');
  }

  fail(error) {
    this.emitStatus('error', error.message);
    this.dispatchEvent(eventDetail('error', { error }));
    this.stop('error', false);
  }

  stop(reason = 'user', emitEnded = true) {
    clearTimeout(this.stopTimer);
    clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
    this.reconnecting = false;
    this.slowMode = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.dataChannel?.close();
    this.peerConnection?.close();
    if (this.audioElement) this.audioElement.srcObject = null;
    this.started = false;
    if (emitEnded) this.emitStatus('ended', reason === 'time-limit' ? '会话已自动结束' : '语音会话已结束');
  }
}
