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

  it('describes the green campus from the introduction copy', () => {
    const reply = getCachedAssistantReply('学校环境怎么样');
    expect(reply.key).toBe('greenCampus');
    expect(reply.text).toContain('中央花园');
    expect(reply.text).toContain('黑天鹅');
    expect(reply.text).toContain('光伏');
    expect(reply.text).toContain('雨水');
    expect(getCachedAssistantReply('绿色校园')).toMatchObject({ key: 'greenCampus' });
    expect(getCachedAssistantReply('校园里有黑天鹅吗')).toMatchObject({ key: 'greenCampus' });
  });

  it('keeps the school overview accurate after enrichment', () => {
    const overview = getCachedAssistantReply('学校简介').text;
    expect(overview).toContain('2022 年 6 月 29 日');
    expect(overview).toContain('庆盛枢纽');
    expect(overview).toContain('具有独立法人资格');
    expect(overview).toContain('高水平示范性合作大学');
    expect(overview).toContain('1.13 平方公里');
    expect(overview).toContain('二期正在建设');
    expect(overview).toContain('万名师生');
  });

  it('answers phase-2 construction with the official scale', () => {
    const reply = getCachedAssistantReply('学校二期有多大');
    expect(reply.key).toBe('phase2');
    expect(reply.text).toContain('73 万平方米');
    expect(reply.text).toContain('953 亩');
    expect(reply.text).toContain('69.5 亿元');
    expect(reply.text).toContain('万名');
    expect(getCachedAssistantReply('二期工程')).toMatchObject({ key: 'phase2' });
  });

  it('offers the robot carrier platform when asked to carry the bag', () => {
    const reply = getCachedAssistantReply('你可以帮我背包吗？');
    expect(reply.key).toBe('bagCarry');
    expect(reply.text).toContain('放在小车的平台上');
    expect(reply.text).toContain('我们将会一起移动');
    expect(reply.text).toContain('您可以直接放在我身上');
    expect(getCachedAssistantReply('帮我拿包')).toMatchObject({ key: 'bagCarry' });
    expect(getCachedAssistantReply('包可以放你身上吗')).toMatchObject({ key: 'bagCarry' });
    expect(getCachedAssistantReply('包可以放在哪？')).toMatchObject({ key: 'bagCarry' });
    expect(getCachedAssistantReply('包放哪')).toMatchObject({ key: 'bagCarry' });
  });

  it('keeps the general carry checklist for packing questions', () => {
    expect(getCachedAssistantReply('出门带什么')).toMatchObject({ key: 'carry' });
    expect(getCachedAssistantReply('背包')).toMatchObject({ key: 'carry' });
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

  it('opens the session by asking where the user wants to go and follows the user language', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null);
    expect(instructions).toContain('会话开场');
    expect(instructions).toContain('先询问用户想去哪里');
    expect(instructions).toContain('语言规则');
    expect(instructions).toContain('说英文就用英文');
    expect(instructions).toContain('绝不混用或来回切换');
  });

  it('does not push umbrella advice when the weather is calm', () => {
    const calmWeather = {
      available: true,
      temperatureC: 24,
      conditionLabel: '多云',
      precipitationMm: 0,
      precipitationProbabilityMax: 20,
      rainExpected: false,
      rainingNow: false,
      sunny: false,
      uvIndexMax: 3,
      umbrella: false,
      sunscreen: false,
      cold: false,
      thunderstorm: false,
    };
    const instructions = buildCampusAssistantInstructions(
      { fromId: 'main-entrance', toId: 'library', modeLabel: '步行' },
      null,
      calmWeather,
    );
    expect(instructions).toContain('天气平稳时不要主动提起伞具或防晒');
    expect(instructions).toContain('天气平稳时不要提伞具或防晒');
    expect(instructions).not.toContain('出门记得带伞');
  });

  it('keeps umbrella advice for rainy weather only', () => {
    const rainyWeather = {
      available: true,
      temperatureC: 26,
      conditionLabel: '中雨',
      precipitationMm: 2,
      precipitationProbabilityMax: 80,
      rainExpected: true,
      rainingNow: true,
      sunny: false,
      uvIndexMax: 2,
      umbrella: true,
      sunscreen: false,
      cold: false,
      thunderstorm: false,
    };
    const instructions = buildCampusAssistantInstructions(
      { fromId: 'main-entrance', toId: 'library', modeLabel: '步行' },
      null,
      rainyWeather,
    );
    expect(instructions).toContain('出门带伞、注意湿滑');
  });

  it('directs a take-your-belongings reminder when the user nears the destination', () => {
    const instructions = buildCampusAssistantInstructions({}, null, null);
    expect(instructions).toContain('到达提醒');
    expect(instructions).toContain('带好随身物品');
    expect(instructions).toContain('背包、手机、校园卡、钥匙');
  });

  it('directs a bag-on-robot reminder before departure in robot mode only', () => {
    const instructions = buildCampusAssistantInstructions({ mode: 'robot' }, null, null);
    expect(instructions).toContain('出发放包提醒');
    expect(instructions).toContain('随行小车的载物平台');
    expect(instructions).toContain('不要编造载物平台未确认的信息');
  });

  it('omits the bag reminder for pedestrian routes', () => {
    const instructions = buildCampusAssistantInstructions({ mode: 'pedestrian' }, null, null);
    expect(instructions).not.toContain('出发放包提醒');
  });

  it('answers "can you carry my bag" by offering the robot platform in every mode', () => {
    const instructions = buildCampusAssistantInstructions({ mode: 'pedestrian' }, null, null);
    expect(instructions).toContain('背包代带');
    expect(instructions).toContain('放在小车的平台上');
    expect(instructions).toContain('您可以直接放在我身上');
    expect(instructions).toContain('不要编造载物平台的容量、承重');
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

    expect(instructions).toContain('我们将要离开');
    expect(instructions).toContain('走到室外');
    expect(instructions).toContain('饭堂（距路线约 40 米）');
    expect(instructions).toContain('演讲厅 A/B/C（距路线约 12 米）');
    expect(instructions).toContain('除非用户明确询问');
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
