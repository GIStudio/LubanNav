import { campusLocationCatalog } from './voiceNavigation.js';
import { eventAssistantContext } from './eventMode.js';
import { buildWeatherAdvisory, CAMPUS_WEATHER_REGION } from './weather.js';
import { distanceAlongPolylineMeters, polylineLengthMeters } from './geo.js';

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
  school: '香港科技大学（广州）于 2022 年 6 月 29 日经国家教育部依法批准正式设立，位于广州市南沙区庆盛枢纽区块，由广州大学和香港科技大学举办，是具有独立法人资格的合作办学机构，也是建设高水平示范性合作大学的有益尝试。校园占地约 1.13 平方公里，以融合学科教育为特色。目前学校二期正在建设当中，总建筑面积约 73 万平方米，建成后全校可容纳万名师生。',
  phase2: '学校二期正在建设当中：总建筑面积约 73 万平方米，用地约 953 亩，总投资约 69.5 亿元，建成后可容纳万名师生。核心的 C11 教学楼计划 2026 年 8 月底率先完工交付，未来将与一期校园形成功能互补。',
  hubs: '学校采用“枢纽—学域”融合学科架构，设有功能、信息、系统和社会四大枢纽，以促进跨学科教育、研究与知识转移。',
  location: '香港科技大学（广州）位于广州市南沙区庆盛枢纽区块。需要校内导航时，可以继续告诉我具体建筑或地点。',
  greenCampus: '校园把绿色理念融进每一个角落：建筑顶层的中央花园像一片空中绿洲，是师生休息交流的好去处；顺着漫步水道走，常常能看到黑天鹅在水面游动；不少楼顶铺设光伏板把阳光转化为电能，场地也会收集雨水循环利用，像行政楼、体育馆这些建筑从设计之初就注重节能。在这里，绿色不是口号，它流淌在水波里、生长在花园的草木间。',
  weather: '正在获取实时天气，稍等片刻；如果获取失败，请以可靠的天气应用为准。3 楼平台为露天场地：降雨时带伞防滑，晴热时防晒补水。',
  carry: '出发前建议检查手机、校园卡、钥匙和必要的充电设备；是否带伞以实时天气为准，步行较远时也可以带水。',
  bagCarry: '如果你有包，可以尝试放在小车的平台上，我们将会一起移动。您可以直接放在我身上。',
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

  if (/绿色|环保|环境|黑天鹅|中央花园|空中花园|低碳|绿化|校园景色/.test(normalized)) {
    return { key: 'greenCampus', text: CACHED_REPLIES.greenCampus, source: 'local-cache' };
  }

  if (/二期|新校区|扩建|扩容/.test(normalized)) {
    return { key: 'phase2', text: CACHED_REPLIES.phase2, source: 'local-cache' };
  }

  // "Can you carry my bag?" — more specific than the general carry checklist,
  // so it must be matched first. The tablet runs the assistant on the robot,
  // so offering the robot's carrier platform is the honest, useful answer.
  if (
    /帮我.{0,3}(背包|拿包|带包|拎包|提包|背东西|拿东西)|帮我背|帮我把包|帮我带一下|包.{0,4}(放|搁|装).{0,6}(车|平台|你|身上|哪|哪里)|放你身上|放我身上|放车上|放平台|包放哪|包放哪里/.test(
      normalized,
    )
  ) {
    return { key: 'bagCarry', text: CACHED_REPLIES.bagCarry, source: 'local-cache' };
  }

  if (/背包|书包|随身物品|出门带什么|要带什么/.test(normalized)) {
    return { key: 'carry', text: CACHED_REPLIES.carry, source: 'local-cache' };
  }

  return null;
}

function weatherInstructionLine(weather) {
  if (weather?.available) {
    return `实时天气（Open-Meteo 开源免密钥接口，${CAMPUS_WEATHER_REGION}·校园中心坐标，可能有数分钟延迟）：${buildWeatherAdvisory(weather)} 天气建议只在直接相关时提及一次：正在降雨或今日降水概率较高时才说带伞防滑，晴热或紫外线强时才说防晒补水，雷雨时提醒避开空旷平台；天气平稳时不要主动提起伞具或防晒。不得编造天气数值。`;
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

// ── live navigation context (auto-refreshed) ─────────────────────────────

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
/** Asia/Shanghai is fixed UTC+8 (no DST), so shifting UTC is exact. */
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiParts(now) {
  const local = new Date(now + SHANGHAI_UTC_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday: WEEKDAYS_ZH[local.getUTCDay()],
    hours: String(local.getUTCHours()).padStart(2, '0'),
    minutes: String(local.getUTCMinutes()).padStart(2, '0'),
  };
}

/** "2026年8月18日 星期二 16:50" in Asia/Shanghai for a timestamp. */
export function formatCampusDateTime(now = Date.now()) {
  const { year, month, day, weekday, hours, minutes } = shanghaiParts(now);
  return `${year}年${month}月${day}日 ${weekday} ${hours}:${minutes}`;
}

/** "16:50" in Asia/Shanghai for a timestamp. */
export function formatCampusTime(now = Date.now()) {
  const { hours, minutes } = shanghaiParts(now);
  return `${hours}:${minutes}`;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

const NEAR_ARRIVAL_PERCENT = 90;
const NEAR_ARRIVAL_REMAINING_METERS = 50;

function robotProgressSentence(routeContext, robotPosition) {
  const path = routeContext.path;
  if (!Array.isArray(path) || path.length < 2) return '';
  const { latitude, longitude } = robotPosition;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const total = polylineLengthMeters(path);
  if (total <= 0) return '';
  const along = distanceAlongPolylineMeters({ longitude, latitude }, path);
  const percent = clampPercent((along / total) * 100);
  const remaining = Math.max(0, total - along);
  const sentence =
    `机器人最新位置沿路线约 ${Math.round(along)} 米，路线进度约 ${percent}%，距终点约 ${Math.round(remaining)} 米（进度来自 BLE 遥测位置）。`;
  if (percent >= NEAR_ARRIVAL_PERCENT || remaining <= NEAR_ARRIVAL_REMAINING_METERS) {
    return `${sentence} 用户已接近目的地——若尚未提醒，可主动提醒带好随身物品。`;
  }
  return sentence;
}

function timeProgressSentence({ now, startedAt, routeContext }) {
  const durationSeconds = routeContext.durationSeconds;
  if (!startedAt || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return '';
  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const percent = clampPercent((elapsedSeconds / durationSeconds) * 100);
  const remainingSeconds = Math.max(0, durationSeconds - elapsedSeconds);
  const durationMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
  const head = `导航于 ${formatCampusTime(startedAt)} 开始，全程约 ${durationMinutes} 分钟`;
  if (remainingSeconds <= 60 || percent >= NEAR_ARRIVAL_PERCENT) {
    return `${head}；按匀速估算应已到达或接近目的地（估算，不代表实际位置）。 若尚未提醒，可主动提醒用户带好随身物品。`;
  }
  const remainingMinutes = Math.max(1, Math.ceil(remainingSeconds / 60));
  return `${head}；按匀速估算当前进度约 ${percent}%，预计剩余约 ${remainingMinutes} 分钟（估算，不代表实际位置）。`;
}

/**
 * Auto-refreshed voice context: current Asia/Shanghai date/time plus
 * navigation progress. Progress is either the real BLE telemetry position of
 * the robot along the route, or a time-based estimate since the route was
 * set (always framed as an estimate — the page has no GPS for pedestrians).
 */
export function buildLiveContext({
  now = Date.now(),
  startedAt = null,
  routeContext = {},
  robotPosition = null,
} = {}) {
  const time = `当前时间：${formatCampusDateTime(now)}（Asia/Shanghai）。`;
  const progress = robotPosition
    ? robotProgressSentence(routeContext, robotPosition)
    : timeProgressSentence({ now, startedAt, routeContext });
  return progress ? `${time} ${progress}` : time;
}

export function buildCampusAssistantInstructions(routeContext = {}, event = null, weather = null, liveContext = '') {
  const from = routeContext.fromName || '当前起点';
  const to = routeContext.toName || '当前目的地';
  const fromId = routeContext.fromId || 'main-entrance';
  const toId = routeContext.toId || 'library';
  const mode = routeContext.modeLabel || '步行';
  const isRobotMode = routeContext.mode === 'robot';
  const distance = Number.isFinite(routeContext.distanceMeters)
    ? `，地图计算距离约 ${routeContext.distanceMeters} 米`
    : '';
  const openAirDestination = OPEN_AIR_PLATFORM_DESTINATIONS.has(toId);

  return [
    '你是 LubanNav 的校园语音助手，服务于香港科技大学（广州）校内导航。每次回答优先控制在一到三句话。语言规则：始终使用用户提问所用的语言——用户说普通话就用普通话、说英文就用英文，全程只用一种语言，绝不混用或来回切换；即使用户在英文句子里夹带中文地点名（如图书馆、饭堂），也要保持英文回答。',
    '稳定事实：学校于2022年6月正式设立，位于广州市南沙区，由香港科技大学与广州大学合作举办；学校采用融合学科架构，设功能、信息、系统、社会四大枢纽。',
    '能力边界：不知道的校规、开放时间、活动安排或个人信息不得猜测，应提示用户查询学校官方渠道。不要编造路线距离、建筑入口或室内通行状态，精确路线以 LubanNav 地图计算为准。',
    weatherInstructionLine(weather),
    '会话开场：每次会话开始时，第一句先询问用户想去哪里（例如“您好，请问您想去哪里？”），不要一上来就长篇介绍或提醒。用户给出目的地后再调用 set_navigation_route 规划路线；若页面当前已有路线，可先一句确认现有路线，再询问是否需要改道。路线确定后，若本会话尚未提醒过，且当前天气确实需要——正在降雨或今日降水概率较高时提醒“出门带伞、注意湿滑”，晴热或紫外线强时提醒防晒补水——才用一句话带过；天气平稳时不要提伞具或防晒。',
    ...(isRobotMode
      ? [
          '出发放包提醒：出发前，若用户携带背包等随身物品，提醒可先将包放到随行小车的载物平台上，由小车携带出发；不要编造载物平台未确认的信息（如容量、承重、固定方式）。',
        ]
      : []),
    '背包代带：用户问“你能不能帮我背包/拿包/带包”“包可以放在哪”“能放你身上吗”等时，直接回答：“如果你有包，可以尝试放在小车的平台上，我们将会一起移动”；因为本设备（平板电脑）直接安装在小车上，也可以自然地说“您可以直接放在我身上”。不要编造载物平台的容量、承重、固定方式等未确认信息。',
    '到达提醒：当用户表示接近或已到达目的地（例如说“快到了”“还有多远”“到门口了”“到了”），像公交到站提示一样简短提醒“请带好随身物品”（背包、手机、校园卡、钥匙等）。没有到达迹象时不要反复提醒。',
    ...(openAirDestination
      ? [`平台提醒：当前目的地${to}是 3 楼露天平台，天气影响直接：降雨或降水概率较高时主动提醒用户带伞、注意湿滑；晴热或紫外线强时提醒防晒补水；雷雨时提醒推迟前往或避免在空旷平台停留，并遵循校园通知。`]
      : []),
    '导航工具：只要用户表达去某处、从某地到某地、规划路线或让机器人前往某处的意图，必须调用 set_navigation_route；不得只在口头上确认。工具只提取地点 ID 和模式，距离与路径由 LubanNav 本地计算。目的地不明确时先追问，不得猜测。',
    `当前地图路线：${from}到${to}，模式为${mode}${distance}（地点 ID：${fromId} → ${toId}）。用户没有说明起点时，可省略工具的 from 参数以沿用当前起点。`,
    ...(liveContext
      ? [`实时导航上下文（由网页自动刷新，进度为估算或 BLE 遥测，不得当作精确位置）：${liveContext}`]
      : []),
    highlightsInstructionLine(routeContext),
    `可导航地点 ID：${campusLocationCatalog()}。`,
    eventAssistantContext(event),
  ].join('\n');
}

export { CACHED_REPLIES };
