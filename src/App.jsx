import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CampusMap } from './components/CampusMap.jsx';
import { ChatAssistant } from './components/ChatAssistant.jsx';
import { EventPanel } from './components/EventPanel.jsx';
import { SystemMenu } from './components/SystemMenu.jsx';
import { DEFAULT_EVENT_ID } from './data/events.js';
import { DATASET, MODES, NODE_BY_ID, PUBLIC_LOCATIONS } from './data/campus.js';
import { getCachedAssistantReply } from './lib/assistantKnowledge.js';
import { parseNavigationQuery } from './lib/destinationParser.js';
import {
  loadEventProfiles,
  normalizeEventConfig,
  resolveEventNavigationQuery,
  restoreDefaultEvent,
  saveEventProfiles,
  upsertEventProfile,
} from './lib/eventMode.js';
import { findRoute, formatDuration } from './lib/pathfinding.js';
import { resolveNavigationCommand } from './lib/voiceNavigation.js';

const DEFAULT_MESSAGES = [
  {
    role: 'assistant',
    text: '你好，我可以离线解析校园地点和常见问题，也可以连接实时语音。试试说“从主入口到图书馆”或问“今天要带伞吗”。',
  },
];

function validPublicLocation(id) {
  return Boolean(NODE_BY_ID[id]?.public);
}

export function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialFrom = validPublicLocation(params.get('from')) ? params.get('from') : 'main-entrance';
  const initialTo = validPublicLocation(params.get('to')) ? params.get('to') : 'library';
  const initialMode = MODES[params.get('mode')] ? params.get('mode') : 'pedestrian';
  const initialEvents = useMemo(() => loadEventProfiles(window.localStorage), []);
  const requestedEventId = params.get('event');
  const initialEventId = requestedEventId === 'none'
    ? null
    : (initialEvents.some((event) => event.id === requestedEventId)
      ? requestedEventId
      : DEFAULT_EVENT_ID);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [mode, setMode] = useState(initialMode);
  const [events, setEvents] = useState(initialEvents);
  const [activeEventId, setActiveEventId] = useState(initialEventId);
  const [messages, setMessages] = useState(DEFAULT_MESSAGES);
  const [showDetails, setShowDetails] = useState(false);
  const [robotPosition, setRobotPosition] = useState(null);
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const systemMenuButtonRef = useRef(null);

  const closeSystemMenu = useCallback(() => {
    setSystemMenuOpen(false);
    window.requestAnimationFrame(() => systemMenuButtonRef.current?.focus());
  }, []);

  const route = useMemo(() => findRoute(from, to, mode), [from, to, mode]);
  const activeEvent = useMemo(
    () => events.find((event) => event.id === activeEventId) || null,
    [activeEventId, events],
  );
  const staticApiUrl = `./api/v1/routes/${from}/${to}.${mode}.json`;

  useEffect(() => {
    const query = params.get('q');
    if (query) handleQuery(query, false);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('mode', mode);
    url.searchParams.set('event', activeEventId || 'none');
    url.searchParams.delete('q');
    window.history.replaceState({}, '', url);
  }, [activeEventId, from, to, mode]);

  function parseQueryWithEvent(query) {
    const eventParsed = resolveEventNavigationQuery(query, activeEvent, from, mode);
    return eventParsed.detected ? eventParsed : parseNavigationQuery(query, from);
  }

  function handleQuery(query, includeUser = true) {
    const parsed = parseQueryWithEvent(query);
    if (includeUser) setMessages((items) => [...items, { role: 'user', text: query }]);

    if (parsed.understood) {
      const nextRoute = findRoute(parsed.from, parsed.to, parsed.mode);
      setFrom(parsed.from);
      setTo(parsed.to);
      setMode(parsed.mode);
      setMessages((items) => [
        ...items,
        {
          role: 'assistant',
          text: `已解析：${NODE_BY_ID[parsed.from].name} → ${NODE_BY_ID[parsed.to].name}。约 ${nextRoute.summary.distanceMeters} 米，${formatDuration(nextRoute.summary.durationSeconds)}。`,
        },
      ]);
      return;
    }

    if (parsed.detected) {
      setMessages((items) => [
        ...items,
        {
          role: 'assistant',
          text: parsed.error === 'ambiguous_event_place'
            ? '这个活动配置了多个匹配地点，请说出具体会场或地点名称。'
            : '活动信息已记录，但这个场所尚未绑定地图地点。请先在“活动专属导航”中完成配置。',
        },
      ]);
      return;
    }

    const cachedReply = getCachedAssistantReply(query);
    if (cachedReply) {
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: cachedReply.text, source: cachedReply.source },
      ]);
      return;
    }

    if (!parsed.understood) {
      const missing = parsed.from ? '目的地' : '出发地或目的地';
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: `我还没识别出${missing}。可以试试“从宿舍 3 到体育馆”。` },
      ]);
      return;
    }
  }

  function handleVoiceUserTranscript(query) {
    setMessages((items) => [...items, { role: 'user', text: query, source: 'voice' }]);
    const parsed = parseQueryWithEvent(query);
    if (!parsed.understood) return;
    setFrom(parsed.from);
    setTo(parsed.to);
    setMode(parsed.mode);
  }

  function handleSaveEvent(input) {
    const event = normalizeEventConfig(input);
    if (!event) return;
    setEvents((current) => {
      const next = upsertEventProfile(current, event);
      saveEventProfiles(next, window.localStorage);
      return next;
    });
    setActiveEventId(event.id);
  }

  function handleRestoreDefaultEvent(eventId) {
    setEvents((current) => {
      const next = restoreDefaultEvent(current, eventId);
      saveEventProfiles(next, window.localStorage);
      return next;
    });
  }

  function handleEventNavigate(place) {
    if (!NODE_BY_ID[place.locationId]?.public) return;
    selectDestination(place.locationId);
  }

  function handleVoiceAssistantTranscript(text) {
    setMessages((items) => [...items, { role: 'assistant', text, source: 'voice' }]);
  }

  function handleVoiceNavigationCommand(argumentsValue) {
    const parsed = resolveNavigationCommand(argumentsValue, from, mode);
    if (!parsed.understood) {
      return {
        ok: false,
        error: parsed.error,
        message: '没有识别出有效的校内目的地，请向用户追问具体建筑或地点。',
      };
    }

    const nextRoute = findRoute(parsed.from, parsed.to, parsed.mode);
    if (nextRoute.status !== 'ok') {
      return {
        ok: false,
        error: 'no_route',
        message: '本地寻路图暂时找不到这两个地点之间的可用路线。',
      };
    }

    setFrom(parsed.from);
    setTo(parsed.to);
    setMode(parsed.mode);

    return {
      ok: true,
      action: 'navigation_updated',
      from: { id: parsed.from, name: NODE_BY_ID[parsed.from].name },
      to: { id: parsed.to, name: NODE_BY_ID[parsed.to].name },
      mode: parsed.mode,
      distanceMeters: nextRoute.summary.distanceMeters,
      durationSeconds: nextRoute.summary.durationSeconds,
      message: 'LubanNav 页面已使用本地寻路图更新路线，请简短告知用户。',
    };
  }

  function selectDestination(id) {
    setTo(id);
    const nextRoute = findRoute(from, id, mode);
    setMessages((items) => [
      ...items,
      {
        role: 'assistant',
        text: `目的地已设为${NODE_BY_ID[id].name}，推荐路线约 ${nextRoute.summary.distanceMeters} 米。`,
      },
    ]);
  }

  function swapRoute() {
    setFrom(to);
    setTo(from);
  }

  async function copyShareLink() {
    await navigator.clipboard.writeText(window.location.href);
    setMessages((items) => [...items, { role: 'assistant', text: '可复现的导航链接已复制。' }]);
  }

  return (
    <main class="app-shell">
      <header class="topbar">
        <a class="brand" href="./" aria-label="LubanNav 首页">
          <span class="brand-mark">LN</span>
          <span>
            <strong>LUBAN NAV</strong>
            <small>HKUST(GZ) CAMPUS</small>
          </span>
        </a>
        <div class="topbar-actions">
          <div class="system-status">
            <span class="status-dot" />
            <span>STATIC · OFFLINE READY</span>
            <span class="version">V0.2.1</span>
          </div>
          <button
            ref={systemMenuButtonRef}
            type="button"
            class="system-menu-trigger"
            aria-label="打开实时语音与机器人联络"
            aria-haspopup="dialog"
            aria-expanded={systemMenuOpen}
            onClick={() => setSystemMenuOpen(true)}
          >
            <span class="system-menu-trigger-label">VOICE / ROBOT</span>
            <span class="hamburger" aria-hidden="true"><i /><i /><i /></span>
          </button>
        </div>
      </header>

      <div class="workspace">
        <aside class="control-rail">
          <section class="route-control navigation-assistant" aria-labelledby="route-title">
            <div class="section-heading">
              <div class="navigation-title">
                <span class="assistant-icon" aria-hidden="true">路</span>
                <div>
                  <p class="eyebrow">ASK / ROUTE / A*</p>
                  <h1 id="route-title">去哪里？ <small>AI 导航助手</small></h1>
                </div>
              </div>
              <button class="icon-button" onClick={copyShareLink} title="复制导航链接" aria-label="复制导航链接">↗</button>
            </div>

            <div class="mode-switch" aria-label="导航对象">
              {Object.values(MODES).map((item) => (
                <button key={item.id} class={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)}>
                  <span>{item.id === 'pedestrian' ? '◉' : '◇'}</span>{item.label}
                </button>
              ))}
            </div>

            <div class="route-fields">
              <label>
                <span class="field-index">A</span>
                <span class="field-label">出发地</span>
                <select value={from} onChange={(event) => setFrom(event.currentTarget.value)}>
                  {PUBLIC_LOCATIONS.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </label>
              <button class="swap-button" onClick={swapRoute} aria-label="交换出发地和目的地">⇅</button>
              <label>
                <span class="field-index destination">B</span>
                <span class="field-label">目的地</span>
                <select value={to} onChange={(event) => setTo(event.currentTarget.value)}>
                  {PUBLIC_LOCATIONS.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </label>
            </div>

            <div class="route-summary">
              <div>
                <span>预计距离</span>
                <strong>{route.summary.distanceMeters}<small> m</small></strong>
              </div>
              <div>
                <span>预计耗时</span>
                <strong>{formatDuration(route.summary.durationSeconds)}</strong>
              </div>
              <div>
                <span>{route.summary.indoorDistanceMeters > 0 ? '室内路段' : '路径节点'}</span>
                <strong>
                  {route.summary.indoorDistanceMeters > 0
                    ? route.summary.indoorDistanceMeters
                    : route.path.length}
                  <small>{route.summary.indoorDistanceMeters > 0 ? ' m' : ' 个'}</small>
                </strong>
              </div>
            </div>

            <button class="details-toggle" onClick={() => setShowDetails((value) => !value)}>
              {showDetails ? '收起路线详情' : '查看路线详情'} <span>{showDetails ? '−' : '+'}</span>
            </button>

            {showDetails && (
              <ol class="route-steps">
                {route.instructions.map((instruction, index) => (
                  <li key={`${index}-${instruction}`}><span>{String(index + 1).padStart(2, '0')}</span>{instruction}</li>
                ))}
              </ol>
            )}

            <ChatAssistant messages={messages} onSend={handleQuery} />
          </section>

          <EventPanel
            events={events}
            activeEventId={activeEventId}
            onSelectEvent={setActiveEventId}
            onSaveEvent={handleSaveEvent}
            onRestoreDefault={handleRestoreDefaultEvent}
            onNavigate={handleEventNavigate}
          />
        </aside>

        <CampusMap
          route={route}
          destination={to}
          robotPosition={robotPosition}
          onSelectDestination={selectDestination}
        />
      </div>

      <SystemMenu
        open={systemMenuOpen}
        onClose={closeSystemMenu}
        route={route}
        event={activeEvent}
        onVoiceUserTranscript={handleVoiceUserTranscript}
        onVoiceAssistantTranscript={handleVoiceAssistantTranscript}
        onVoiceNavigationCommand={handleVoiceNavigationCommand}
        onRobotPosition={setRobotPosition}
      />

      <footer class="footer">
        <p><strong>工程演示：</strong>{DATASET.disclaimer}</p>
        <div>
          <a href={DATASET.sourceUrl} target="_blank" rel="noreferrer">公开地图来源</a>
          <a href="./api/">API 文档</a>
          <a href={staticApiUrl} target="_blank" rel="noreferrer">当前路线 JSON</a>
        </div>
      </footer>
    </main>
  );
}
