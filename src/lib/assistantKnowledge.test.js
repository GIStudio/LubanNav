import { describe, expect, it } from 'vitest';
import { buildCampusAssistantInstructions, getCachedAssistantReply } from './assistantKnowledge.js';

describe('assistant knowledge cache', () => {
  it('answers common greetings without a model call', () => {
    expect(getCachedAssistantReply(' 你好！ ')).toMatchObject({
      key: 'greeting',
      source: 'local-cache',
    });
  });

  it('states the weather limitation instead of inventing live conditions', () => {
    const reply = getCachedAssistantReply('今天要带伞吗？');
    expect(reply.key).toBe('weather');
    expect(reply.text).toContain('没有接入实时天气');
    expect(reply.text).toContain('天气应用');
  });

  it('returns stable campus facts from the local cache', () => {
    expect(getCachedAssistantReply('学校简介').text).toContain('2022 年 6 月');
    expect(getCachedAssistantReply('四大枢纽').text).toContain('功能、信息、系统和社会');
  });

  it('does not overmatch arbitrary navigation text', () => {
    expect(getCachedAssistantReply('带我去图书馆')).toBeNull();
  });
});

describe('campus assistant instructions', () => {
  it('includes route context and explicit evidence boundaries', () => {
    const instructions = buildCampusAssistantInstructions({
      fromName: '主入口',
      toName: '图书馆',
      modeLabel: '步行',
      distanceMeters: 430,
    });

    expect(instructions).toContain('主入口到图书馆');
    expect(instructions).toContain('约 430 米');
    expect(instructions).toContain('不得声称知道今天、此刻的天气');
    expect(instructions).toContain('功能、信息、系统、社会四大枢纽');
  });
});
