import { campusLocationCatalog } from './voiceNavigation.js';
import { eventAssistantContext } from './eventMode.js';
import { buildWeatherAdvisory, CAMPUS_WEATHER_REGION } from './weather.js';

/** Locations whose destination sits on the open-air 3F platform. */
const OPEN_AIR_PLATFORM_DESTINATIONS = new Set([
  'third-floor-platform',
  'platform-restaurant',
]);

const CACHED_REPLIES = {
  greeting: '你好！我是 LubanNav 校园助手。你可以问我学校简介、出行提醒，或直接说“带我去图书馆”。',
  thanks: '不客气！出发前记得确认手机、校园卡和随身物品，需要时我可以继续帮你规划路线。',
  goodbye: '再见，路上注意安全。离开前记得检查背包，并根据天气应用决定是否带伞。',
  capabilities: '我可以离线解析校内目的地、计算步行或机器人路线，也可以通过语音介绍香港科技大学（广州），并接入 Open-Meteo 实时天气提醒（降雨带伞、晴热防晒）。',
  school: '香港科技大学（广州）于 2022 年 6 月正式设立，位于广州市南沙区，是一所内地与香港合作举办的大学。学校以融合学科教育为特色。',
  hubs: '学校采用“枢纽—学域”融合学科架构，设有功能、信息、系统和社会四大枢纽，以促进跨学科教育、研究与知识转移。',
  location: '香港科技大学（广州）位于广州市南沙区庆盛枢纽区块。需要校内导航时，可以继续告诉我具体建筑或地点。',
  weather: '正在获取实时天气，稍等片刻；如果获取失败，请以可靠的天气应用为准。3 楼平台为露天场地：降雨时带伞防滑，晴热时防晒补水。',
  carry: '出发前建议检查手机、校园卡、钥匙和必要的充电设备；是否带伞以实时天气为准，步行较远时也可以带水。',
};

function normalizeQuery(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？、,.!?：:；;（）()'“”\-_/]/g, '');
}

const EXACT_GROUPS = [
  {
    key: 'greeting',
    values: ['你好', '您好', '嗨', '哈喽', 'hello', 'hi', '早上好', '中午好', '下午好', '晚上好'],
  },
  {
    key: 'thanks',
    values: ['谢谢', '谢谢你', '感谢', '多谢', 'thankyou', 'thanks'],
  },
  {
    key: 'goodbye',
    values: ['再见', '拜拜', '回头见', 'byebye', 'bye'],
  },
  {
    key: 'capabilities',
    values: ['你是谁', '你能做什么', '有什么功能', '介绍一下你自己', '如何使用'],
  },
  {
    key: 'school',
    values: ['学校简介', '介绍一下学校', '港科广简介', '香港科技大学广州简介', '港科广是什么学校'],
  },
  {
    key: 'hubs',
    values: ['四大枢纽', '学校有几个枢纽', '有哪些枢纽', '学校的学术架构', '枢纽和学域'],
  },
  {
    key: 'location',
    values: ['学校在哪里', '港科广在哪里', '学校地址', '港科广地址'],
  },
];

export function getCachedAssistantReply(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  const exact = EXACT_GROUPS.find((group) =>
    group.values.some((value) => normalizeQuery(value) === normalized),
  );
  if (exact) {
    return { key: exact.key, text: CACHED_REPLIES[exact.key], source: 'local-cache' };
  }

  if (/天气|下雨|雨伞|带伞|防晒|温度|热不热|晒不晒/.test(normalized)) {
    return { key: 'weather', text: CACHED_REPLIES.weather, source: 'local-cache' };
  }

  if (/背包|书包|随身物品|出门带什么|要带什么/.test(normalized)) {
    return { key: 'carry', text: CACHED_REPLIES.carry, source: 'local-cache' };
  }

  return null;
}

function weatherInstructionLine(weather) {
  if (weather?.available) {
    return `实时天气（Open-Meteo 开源免密钥接口，${CAMPUS_WEATHER_REGION}·校园中心坐标，可能有数分钟延迟）：${buildWeatherAdvisory(weather)} 可以把伞具、防晒等建议自然地融入对话，但不得编造天气数值。`;
  }
  return '天气边界：当前无法获取实时天气 API。不得声称知道今天、此刻的天气、温度或降雨；应明确说明没有实时数据，并友好提醒用户出发前查看可靠天气应用，降雨时带伞防滑，晴热时防晒补水，雷雨时避开空旷地和水边并遵循校园通知。';
}

function highlightsInstructionLine(routeContext) {
  const highlights = routeContext.highlights ?? [];
  if (!highlights.length) {
    return '当前路线没有明显途经点介绍。';
  }
  const list = highlights
    .map(
      (highlight) =>
        `${highlight.name}（距路线约 ${highlight.distanceMeters} 米）——${highlight.description ?? '校内地点'}`,
    )
    .join('；');
  return `当前路线途经点（按到达顺序）：${list}。当路线较长（约 800 米以上）或用户询问“沿途有什么／现在到哪了／经过哪些地方”时，按顺序用一两句话简要介绍这些途经点的用途；不要一次性把全部途经点念完。`;
}

export function buildCampusAssistantInstructions(routeContext = {}, event = null, weather = null) {
  const from = routeContext.fromName || '当前起点';
  const to = routeContext.toName || '当前目的地';
  const fromId = routeContext.fromId || 'main-entrance';
  const toId = routeContext.toId || 'library';
  const mode = routeContext.modeLabel || '步行';
  const distance = Number.isFinite(routeContext.distanceMeters)
    ? `，地图计算距离约 ${routeContext.distanceMeters} 米`
    : '';
  const openAirDestination = OPEN_AIR_PLATFORM_DESTINATIONS.has(toId);

  return [
    '你是 LubanNav 的校园语音助手，服务于香港科技大学（广州）校内导航。默认使用简洁、自然的普通话，每次回答优先控制在一到三句话。',
    '稳定事实：学校于2022年6月正式设立，位于广州市南沙区，由香港科技大学与广州大学合作举办；学校采用融合学科架构，设功能、信息、系统、社会四大枢纽。',
    '能力边界：不知道的校规、开放时间、活动安排或个人信息不得猜测，应提示用户查询学校官方渠道。不要编造路线距离、建筑入口或室内通行状态，精确路线以 LubanNav 地图计算为准。',
    weatherInstructionLine(weather),
    '会话开场提醒：每次会话开始时，先向用户说一句出发提醒并放在第一句。依据上面的实时天气：正在降雨或今日降水概率较高时，明确提醒“出门带伞、注意湿滑”；晴热或紫外线强时提醒防晒补水；天气平稳时也自然带一句“出门记得带伞”，不要列冗长清单。',
    '到达提醒：当用户表示接近或已到达目的地（例如说“快到了”“还有多远”“到门口了”“到了”），像公交到站提示一样简短提醒“请带好随身物品”（背包、手机、校园卡、钥匙等）。没有到达迹象时不要反复提醒。',
    ...(openAirDestination
      ? [`平台提醒：当前目的地${to}是 3 楼露天平台，天气影响直接：降雨或降水概率较高时主动提醒用户带伞、注意湿滑；晴热或紫外线强时提醒防晒补水；雷雨时提醒推迟前往或避免在空旷平台停留，并遵循校园通知。`]
      : []),
    '导航工具：只要用户表达去某处、从某地到某地、规划路线或让机器人前往某处的意图，必须调用 set_navigation_route；不得只在口头上确认。工具只提取地点 ID 和模式，距离与路径由 LubanNav 本地计算。目的地不明确时先追问，不得猜测。',
    `当前地图路线：${from}到${to}，模式为${mode}${distance}（地点 ID：${fromId} → ${toId}）。用户没有说明起点时，可省略工具的 from 参数以沿用当前起点。`,
    highlightsInstructionLine(routeContext),
    `可导航地点 ID：${campusLocationCatalog()}。`,
    eventAssistantContext(event),
  ].join('\n');
}

export { CACHED_REPLIES };
