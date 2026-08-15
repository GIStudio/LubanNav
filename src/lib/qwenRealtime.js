const DEFAULT_GATEWAY_ENDPOINT =
  'https://lubannace-token-wwdlyxygjx.cn-hangzhou.fcapp.run/voice/session';

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  gatewayEndpoint:
    import.meta.env.VITE_VOICE_GATEWAY_URL
    || import.meta.env.VITE_VOICE_TOKEN_URL
    || DEFAULT_GATEWAY_ENDPOINT,
  model: 'qwen3.5-omni-flash-realtime',
  voice: 'Tina',
  maxSessionMs: 3 * 60 * 1000,
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
    const knownMessages = {
      401: '访问码无效，请重新输入。',
      403: '当前网页来源未被允许。',
      429: '请求过于频繁，请稍后再试。',
      502: '百炼语音服务暂时拒绝连接，请稍后重试。',
    };
    throw new VoiceSessionError(
      'gateway-rejected',
      knownMessages[response.status] || body.error || '语音网关建立会话失败。',
      response.status,
    );
  }

  if (!body.answerSdp || typeof body.answerSdp !== 'string' || !body.answerSdp.startsWith('v=0')) {
    throw new VoiceSessionError('gateway-payload', '语音网关响应缺少有效的 Answer SDP。');
  }

  return body.answerSdp;
}

export function buildSessionUpdate({ instructions, voice = DEFAULT_VOICE_CONFIG.voice }) {
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
      turn_detection: {
        type: 'semantic_vad',
        threshold: 0.5,
        silence_duration_ms: 800,
      },
      max_tokens: 512,
      temperature: 0.6,
      enable_search: false,
    },
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
    this.seenEventIds = new Set();
    this.started = false;
  }

  emitStatus(status, message = '') {
    this.dispatchEvent(eventDetail('status', { status, message }));
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

      this.peerConnection = new this.PeerConnection({ iceServers: [] });
      this.peerConnection.addTrack(track, this.stream);
      this.peerConnection.addEventListener('track', (event) => {
        if (!this.audioElement) return;
        this.audioElement.srcObject = event.streams[0];
        this.audioElement.play().catch(() => {
          this.emitStatus('audio-blocked', '请点击页面后允许播放语音');
        });
      });
      this.peerConnection.addEventListener('connectionstatechange', () => {
        const state = this.peerConnection?.connectionState;
        if (state === 'failed' || state === 'disconnected') {
          this.fail(new VoiceSessionError('webrtc-disconnected', '语音连接已断开，请重新连接。'));
        }
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
      this.stopTimer = setTimeout(() => {
        this.emitStatus('time-limit', '单次语音会话已达到 3 分钟上限');
        this.stop('time-limit');
      }, this.maxSessionMs);
    } catch (error) {
      this.fail(this.normalizeError(error));
      throw error;
    }
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
        this.send(buildSessionUpdate({ instructions: this.instructions }), channel);
        break;
      case 'session.updated':
        this.setMicrophoneEnabled(true);
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
    this.send(buildSessionUpdate({ instructions }));
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
    this.stream?.getTracks().forEach((track) => track.stop());
    this.dataChannel?.close();
    this.peerConnection?.close();
    if (this.audioElement) this.audioElement.srcObject = null;
    this.started = false;
    if (emitEnded) this.emitStatus('ended', reason === 'time-limit' ? '会话已自动结束' : '语音会话已结束');
  }
}
