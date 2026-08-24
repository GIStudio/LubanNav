import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLAY_ID, currentReplay, detectThirdFloorIntent } from './trajectoryReplay.js';

describe('trajectoryReplay', () => {
  it('currentReplay returns the configured default demo replay', () => {
    expect(currentReplay().id).toBe(DEFAULT_REPLAY_ID);
    expect(currentReplay().file).toMatch(/\.json$/);
  });

  it('detects "带我去三楼平台" intents', () => {
    expect(detectThirdFloorIntent('我现在在E1，请你带我去三楼平台')).toBe(true);
    expect(detectThirdFloorIntent('请带我前往三楼中央')).toBe(true);
    expect(detectThirdFloorIntent('麻烦带我到3楼平台')).toBe(true);
  });

  it('does not false-positive on unrelated text', () => {
    expect(detectThirdFloorIntent('你好')).toBe(false);
    expect(detectThirdFloorIntent('帮我导航到图书馆')).toBe(false);
    expect(detectThirdFloorIntent('今天天气怎么样')).toBe(false);
  });
});
