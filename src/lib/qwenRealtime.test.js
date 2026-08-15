import { describe, expect, it, vi } from 'vitest';
import {
  VoiceSessionError,
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
  });
});
