import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_CONFIG,
  QwenRealtimeSession,
  VoiceSessionError,
  buildFunctionCallOutput,
  buildResponseCreate,
  buildSessionUpdate,
  requestWebRtcAnswer,
} from './qwenRealtime.js';

/** Minimal fake RTCPeerConnection that resolves offers and answers. */
class FakePeerConnection extends EventTarget {
  constructor() {
    super();
    this.iceGatheringState = 'complete';
    this.connectionState = 'new';
    this.channels = [];
  }

  addTrack() {}

  createDataChannel(name) {
    const channel = new FakeChannel(name);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\noffer' };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  close() {
    this.connectionState = 'closed';
  }
}

class FakeChannel extends EventTarget {
  constructor(name) {
    super();
    this.readyState = 'open';
    this.name = name;
  }

  send() {}

  close() {
    this.readyState = 'closed';
  }
}

function fakeMediaDevices() {
  const track = { enabled: true, stop: vi.fn() };
  return {
    getUserMedia: vi.fn(async () => ({
      getAudioTracks: () => [track],
      getTracks: () => [track],
    })),
  };
}

function fakeGateway(fetchImpl = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ answerSdp: 'v=0\r\nanswer' }),
}))) {
  return fetchImpl;
}

describe('Qwen Realtime configuration', () => {
  it('requests an Answer SDP through the voice gateway', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answerSdp: 'v=0\r\nanswer' }),
    }));
    const result = await requestWebRtcAnswer({
      endpoint: 'https://token.example/voice/session',
      accessCode: 'demo-code',
      offerSdp: 'v=0\r\noffer',
      fetchImpl,
    });

    expect(result).toBe('v=0\r\nanswer');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token.example/voice/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ accessCode: 'demo-code', offerSdp: 'v=0\r\noffer' }),
      }),
    );
  });

  it('maps rate limiting to a friendly message', async () => {
    await expect(
      requestWebRtcAnswer({
        accessCode: 'demo-code',
        offerSdp: 'v=0\r\noffer',
        fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
      }),
    ).rejects.toMatchObject({ code: 'gateway-rejected', status: 429 });
  });

  it('surfaces upstream auth failures relayed by the gateway', async () => {
    const error = await requestWebRtcAnswer({
      accessCode: 'demo-code',
      offerSdp: 'v=0\r\noffer',
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'upstream_rejected', upstreamStatus: 401, upstreamCode: 'InvalidApiKey' }),
      }),
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'gateway-rejected', status: 401 });
    expect(error.message).toContain('授权失败');
  });

  it('explains upstream concurrency pressure as a retryable condition', async () => {
    const error = await requestWebRtcAnswer({
      accessCode: 'demo-code',
      offerSdp: 'v=0\r\noffer',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: 'upstream_rejected', upstreamStatus: 429 }),
      }),
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'gateway-rejected', status: 429 });
    expect(error.message).toContain('百炼并发或限流');
  });

  it('rejects malformed SDP before calling the gateway', async () => {
    await expect(
      requestWebRtcAnswer({ accessCode: 'demo-code', offerSdp: 'not-sdp' }),
    ).rejects.toBeInstanceOf(VoiceSessionError);
  });

  it('creates a concise audio session with semantic VAD and no web search', () => {
    const update = buildSessionUpdate({ instructions: '校园事实与天气边界' });
    expect(update.session).toMatchObject({
      modalities: ['text', 'audio'],
      voice: 'Tina',
      enable_search: false,
      max_tokens: 512,
    });
    expect(update.session.turn_detection.type).toBe('semantic_vad');
    expect(update.session.turn_detection).toMatchObject({ threshold: 0.5, silence_duration_ms: 800 });
    expect(update.session.instructions).toContain('天气边界');
    expect(update.session.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'set_navigation_route' }),
      }),
    ]);
  });

  it('uses a less trigger-happy VAD profile in hold-to-talk mode', () => {
    const update = buildSessionUpdate({
      instructions: 'test',
      interactionMode: 'tap2talk',
    });
    expect(update.session.turn_detection).toMatchObject({
      type: 'semantic_vad',
      threshold: 0.7,
      silence_duration_ms: 2500,
    });
  });

  it('builds the two official events required after a function call', () => {
    const output = buildFunctionCallOutput('call-nav-1', {
      ok: true,
      action: 'navigation_updated',
    });
    expect(output).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-nav-1',
      },
    });
    expect(JSON.parse(output.item.output)).toMatchObject({
      ok: true,
      action: 'navigation_updated',
    });
    expect(buildResponseCreate()).toMatchObject({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] },
    });
  });

  it('executes a navigation function call and returns its result to the model', async () => {
    const handler = vi.fn(async (argumentsValue) => ({
      ok: true,
      action: 'navigation_updated',
      ...argumentsValue,
    }));
    const sent = [];
    const channel = {
      readyState: 'open',
      send: (payload) => sent.push(JSON.parse(payload)),
    };
    const session = new QwenRealtimeSession({
      accessCode: 'demo-code',
      instructions: 'test',
      audioElement: null,
      mediaDevices: {},
      PeerConnection: class {},
      functionHandlers: { set_navigation_route: handler },
    });

    session.handleServerEvent(JSON.stringify({
      event_id: 'event-nav-1',
      type: 'response.function_call_arguments.done',
      call_id: 'call-nav-1',
      name: 'set_navigation_route',
      arguments: JSON.stringify({ from: 'main-entrance', to: 'library' }),
    }), channel);

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(handler).toHaveBeenCalledWith(
      { from: 'main-entrance', to: 'library' },
      expect.objectContaining({ call_id: 'call-nav-1' }),
    );
    expect(sent[0]).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call-nav-1' },
    });
    expect(JSON.parse(sent[0].item.output)).toMatchObject({
      ok: true,
      action: 'navigation_updated',
      to: 'library',
    });
    expect(sent[1]).toMatchObject({ type: 'response.create' });
  });
});

describe('QwenRealtimeSession resilience', () => {
  function makeSession({ fetchImpl, maxSessionMs = 60_000, disconnectGraceMs = 50 } = {}) {
    const gateway = fakeGateway(fetchImpl);
    const session = new QwenRealtimeSession({
      accessCode: 'demo-code',
      instructions: 'test',
      audioElement: null,
      gatewayEndpoint: 'https://token.example/voice/session',
      fetchImpl: gateway,
      mediaDevices: fakeMediaDevices(),
      PeerConnection: FakePeerConnection,
      maxSessionMs,
      disconnectGraceMs,
    });
    return { session, gateway };
  }

  it('defaults to a 10-minute session cap for walking navigation', () => {
    expect(DEFAULT_VOICE_CONFIG.maxSessionMs).toBe(10 * 60 * 1000);
  });

  it('auto-reconnects through the gateway after the connection fails', async () => {
    const { session, gateway } = makeSession();
    const statuses = [];
    session.addEventListener('status', (event) => statuses.push(event.detail.status));
    await session.start();
    expect(gateway).toHaveBeenCalledTimes(1);

    session.peerConnection.connectionState = 'failed';
    session.peerConnection.dispatchEvent(new Event('connectionstatechange'));
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(session.peerConnection).not.toBeNull();
    expect(session.peerConnection.remoteDescription).toMatchObject({ type: 'answer' });
    expect(statuses).toContain('reconnecting');
    expect(statuses).toContain('listening');
    session.stop('user');
  });

  it('waits through the grace period before reconnecting on disconnected', async () => {
    const { session, gateway } = makeSession();
    await session.start();

    session.peerConnection.connectionState = 'disconnected';
    session.peerConnection.dispatchEvent(new Event('connectionstatechange'));
    expect(gateway).toHaveBeenCalledTimes(1); // grace period: no immediate reconnect

    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(2), { timeout: 4000 });
    session.stop('user');
  });

  it('renews the session automatically when the session cap is reached', async () => {
    const { session, gateway } = makeSession({ maxSessionMs: 50 });
    await session.start();
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(session.started).toBe(true);
    session.stop('time-limit');
  });

  it('stops retrying once the user ends the session', async () => {
    const { session, gateway } = makeSession();
    await session.start();
    session.peerConnection.connectionState = 'failed';
    session.peerConnection.dispatchEvent(new Event('connectionstatechange'));
    session.stop('user'); // immediately after the drop
    const callsAfterStop = gateway.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(gateway.mock.calls.length).toBe(callsAfterStop);
  });
});
