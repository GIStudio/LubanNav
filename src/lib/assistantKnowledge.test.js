import { describe, expect, it } from 'vitest';
import { defaultEventProfiles } from './eventMode.js';
import {
  buildCampusAssistantInstructions,
  buildLiveContext,
  formatCampusDateTime,
  formatCampusTime,
  getCachedAssistantReply,
} from './assistantKnowledge.js';

describe('assistant knowledge cache', () => {
  it('answers common greetings without a model call', () => {
    expect(getCachedAssistantReply(' 你好！ ')).toMatchObject({
      key: 'greeting',
      source: 'local-cache',
    });
  });

  it('answers weather questions with a conservative fallback until live data arrives', () => {
    const reply = getCachedAssistantReply('今天要带伞吗？');
    expect(reply.key).toBe('weather');
    expect(reply.text).toContain('正在获取实时天气');
    expect(reply.text).toContain('3 楼平台为露天场地');
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

  it('adds the active event manifest without inventing an unbound destination', () => {
    const instructions = buildCampusAssistantInstructions({}, defaultEventProfiles()[0]);

    expect(instructions).toContain('八月真机展示活动');
    expect(instructions).toContain('主会场：三楼主会场，3F，地图地点未绑定');
    expect(instructions).toContain('未绑定时应说明并请组织者配置');
  });

  it('embeds live weather advice and a 3F platform reminder when weather is available', () => {
    const instructions = buildCampusAssistantInstructions(
      {
        fromId: 'main-entrance',
        fromName: '主入口',
        toId: 'third-floor-platform',
        toName: '三楼中央',
        modeLabel: '步行',
        distanceMeters: 900,
      },
      null,
      {
        available: true,
        temperatureC: 31,
        conditionLabel: '晴',
        precipitationMm: 0,
        precipitationProbabilityMax: 70,
        rainExpected: true,
        rainingNow: false,
        sunny: true,
        uvIndexMax: 8,
        umbrella: true,
        sunscreen: true,
        cold: false,
        thunderstorm: false,
      },
    );

    expect(instructions).toContain('实时天气');
    expect(instructions).toContain('广州南沙区');
    expect(instructions).toContain('建议带伞');
    expect(instructions).toContain('3 楼露天平台');
  });

  it('directs an umbrella departure reminder at session start', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null);
    expect(instructions).toContain('会话开场提醒');
    expect(instructions).toContain('出门带伞');
    expect(instructions).toContain('出门记得带伞');
  });

  it('directs a take-your-belongings reminder when the user nears the destination', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null);
    expect(instructions).toContain('到达提醒');
    expect(instructions).toContain('带好随身物品');
    expect(instructions).toContain('背包、手机、校园卡、钥匙');
  });

  it('introduces route highlights in arrival order for the voice agent', () => {
    const instructions = buildCampusAssistantInstructions({
      fromId: 'main-entrance',
      fromName: '主入口',
      toId: 'library',
      toName: '图书馆',
      modeLabel: '步行',
      distanceMeters: 990,
      highlights: [
        { id: 'food-court', name: '饭堂', distanceMeters: 40, description: '校园主要餐饮区。' },
        { id: 'lecture-halls', name: '演讲厅 A/B/C', distanceMeters: 12, description: '讲座与活动场地。' },
      ],
    });

    expect(instructions).toContain('途经点');
    expect(instructions).toContain('饭堂（距路线约 40 米）');
    expect(instructions).toContain('演讲厅 A/B/C（距路线约 12 米）');
    expect(instructions).toContain('不要一次性把全部途经点念完');
  });

  it('embeds an auto-refreshed live context line when provided', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null, '当前时间：2026年8月18日 星期二 16:50（Asia/Shanghai）。');
    expect(instructions).toContain('实时导航上下文');
    expect(instructions).toContain('不得当作精确位置');
    expect(instructions).toContain('当前时间：2026年8月18日 星期二 16:50');
  });

  it('omits the live context line when none is provided', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null);
    expect(instructions).not.toContain('实时导航上下文');
  });
});

describe('live navigation context', () => {
  const NOW = Date.UTC(2026, 7, 18, 8, 50, 0); // 2026-08-18 16:50 Asia/Shanghai

  it('formats Asia/Shanghai date and time deterministically', () => {
    expect(formatCampusDateTime(NOW)).toBe('2026年8月18日 星期二 16:50');
    expect(formatCampusTime(NOW)).toBe('16:50');
  });

  it('reports the current time even without progress data', () => {
    const context = buildLiveContext({ now: NOW });
    expect(context).toContain('当前时间：2026年8月18日 星期二 16:50');
  });

  it('estimates progress and remaining time from the route clock', () => {
    const context = buildLiveContext({
      now: NOW,
      startedAt: NOW - 3 * 60 * 1000, // 3 minutes into a 6-minute walk
      routeContext: { durationSeconds: 360 },
    });
    expect(context).toContain('进度约 50%');
    expect(context).toContain('剩余约 3 分钟');
    expect(context).toContain('估算，不代表实际位置');
  });

  it('flags near-arrival and prompts a proactive belongings reminder', () => {
    const context = buildLiveContext({
      now: NOW,
      startedAt: NOW - 6 * 60 * 1000, // elapsed == duration
      routeContext: { durationSeconds: 360 },
    });
    expect(context).toContain('已到达或接近目的地');
    expect(context).toContain('主动提醒用户带好随身物品');
  });

  it('uses the BLE robot telemetry for real progress along the route', () => {
    const path = [
      { longitude: 113.474, latitude: 22.8855 },
      { longitude: 113.479, latitude: 22.89025 },
    ];
    const robotAt = { longitude: 113.4765, latitude: 22.887875 }; // ~middle of the route
    const context = buildLiveContext({
      now: NOW,
      routeContext: { path },
      robotPosition: robotAt,
    });
    expect(context).toContain('机器人最新位置沿路线约');
    expect(context).toContain('进度约 50%');
    expect(context).toContain('BLE 遥测');
  });

  it('prompts a proactive belongings reminder when the robot nears the end', () => {
    const path = [
      { longitude: 113.474, latitude: 22.8855 },
      { longitude: 113.479, latitude: 22.89025 },
    ];
    const robotNearEnd = { longitude: 113.4789, latitude: 22.8901 };
    const context = buildLiveContext({
      now: NOW,
      routeContext: { path },
      robotPosition: robotNearEnd,
    });
    expect(context).toContain('主动提醒带好随身物品');
  });
});
