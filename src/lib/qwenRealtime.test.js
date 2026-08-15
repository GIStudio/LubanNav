import { describe, expect, it, vi } from 'vitest';
import {
  QwenRealtimeSession,
  VoiceSessionError,
  buildFunctionCallOutput,
  buildResponseCreate,
  buildSessionUpdate,
  requestWebRtcAnswer,
} from './qwenRealtime.js';

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
    expect(update.session.instructions).toContain('天气边界');
    expect(update.session.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'set_navigation_route' }),
      }),
    ]);
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
