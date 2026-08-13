import { useEffect, useMemo, useState } from 'preact/hooks';
import { CampusMap } from './components/CampusMap.jsx';
import { ChatAssistant } from './components/ChatAssistant.jsx';
import { DATASET, MODES, NODE_BY_ID, PUBLIC_LOCATIONS } from './data/campus.js';
import { parseNavigationQuery } from './lib/destinationParser.js';
import { findRoute, formatDuration } from './lib/pathfinding.js';

const DEFAULT_MESSAGES = [
  {
    role: 'assistant',
    text: '你好，我可以离线解析校园地点。试试说“从主入口到图书馆”，或直接在地图上点一个目的地。',
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
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [mode, setMode] = useState(initialMode);
  const [messages, setMessages] = useState(DEFAULT_MESSAGES);
  const [showDetails, setShowDetails] = useState(false);

  const route = useMemo(() => findRoute(from, to, mode), [from, to, mode]);
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
    url.searchParams.delete('q');
    window.history.replaceState({}, '', url);
  }, [from, to, mode]);

  function handleQuery(query, includeUser = true) {
    const parsed = parseNavigationQuery(query, from);
    if (includeUser) setMessages((items) => [...items, { role: 'user', text: query }]);

    if (parsed.intent === 'greeting') {
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: '你好！告诉我从哪里出发、要去哪里；只说目的地时，我会使用当前起点。' },
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
        <div class="system-status">
          <span class="status-dot" />
          <span>STATIC · OFFLINE READY</span>
          <span class="version">V0.1</span>
        </div>
      </header>

      <div class="workspace">
        <aside class="control-rail">
          <section class="route-control" aria-labelledby="route-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">ROUTE / A*</p>
                <h1 id="route-title">去哪里？</h1>
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
                <span>路径节点</span>
                <strong>{route.path.length}<small> 个</small></strong>
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
          </section>

          <ChatAssistant messages={messages} onSend={handleQuery} route={route} />
        </aside>

        <CampusMap route={route} destination={to} onSelectDestination={selectDestination} />
      </div>

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
