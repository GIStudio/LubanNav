import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CampusInsights } from './components/CampusInsights.jsx';
import { CampusMap } from './components/CampusMap.jsx';
import { ChatAssistant } from './components/ChatAssistant.jsx';
import { EventPanel } from './components/EventPanel.jsx';
import { LandingPage } from './components/LandingPage.jsx';
import { SystemMenu } from './components/SystemMenu.jsx';
import { VoiceQuickControl } from './components/VoiceQuickControl.jsx';
import { DATASET, MODES, NODE_BY_ID, PUBLIC_LOCATIONS } from './data/campus.js';
import { DEFAULT_EVENT_ID } from './data/events.js';
import { getCachedAssistantReply } from './lib/assistantKnowledge.js';
import { parseNavigationQuery } from './lib/destinationParser.js';
import { resolveEventNavigationQuery } from './lib/eventMode.js';
import { useI18n, localizedName } from './lib/i18n.js';
import { useTheme } from './lib/theme.js';
import { findRoute, formatDuration } from './lib/pathfinding.js';
import { locateCurrentPlace } from './lib/locate.js';
import { createPositionStore } from './lib/positionStore.js';
import { resolveNavigationCommand } from './lib/voiceNavigation.js';
import { buildWeatherAdvisory, fetchWeather } from './lib/weather.js';
import { useEventProfiles } from './lib/useEventProfiles.js';
import { useRouteQueryState } from './lib/useRouteQueryState.js';
import { voiceSession } from './lib/voiceSession.js';

export function App() {
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const { from, to, mode, setFrom, setTo, setMode, applyNavigation } = useRouteQueryState(params);
  const {
    events,
    activeEventId,
    activeEvent,
    setActiveEventId,
    saveEvent,
    restoreDefault,
  } = useEventProfiles(params);
  const [messages, setMessages] = useState(() => [
    { role: 'assistant', text: t('chat.welcome') },
  ]);
  const [showDetails, setShowDetails] = useState(false);
  const [routeStartedAt, setRouteStartedAt] = useState(() => Date.now());
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const [systemMenuPanel, setSystemMenuPanel] = useState('voice');
  const systemMenuButtonRef = useRef(null);

  // Position fusion store: car RTK telemetry is the primary source, the
  // browser's geolocation is the fallback (see lib/positionStore.js). The
  // robot marker follows RTK positions; the browser dot stays as fallback.
  const positionStoreRef = useRef(null);
  if (!positionStoreRef.current) {
    positionStoreRef.current = createPositionStore({
      geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : null,
    });
  }
  const positionStore = positionStoreRef.current;
  const [posState, setPosState] = useState(() => positionStore.getState());
  useEffect(() => {
    const unsubscribe = positionStore.subscribe(setPosState);
    positionStore.startBrowserWatch();
    return () => {
      unsubscribe();
      positionStore.stopBrowserWatch();
    };
  }, [positionStore]);

  function handleRobotPosition(position) {
    positionStore.setRobotPosition(position);
  }

  // Two-phase UI: a voice-first welcome screen until a route exists, then the
  // full navigation workspace. Only *non-default* route params (real share
  // links) or an explicit ?q= deep link skip the welcome; the URL is
  // otherwise rewritten with default from/to/mode on load, which must not
  // force the navigation view on refresh.
  const [phase, setPhase] = useState(() => {
    const query = params.get('q');
    const nonDefaultRoute =
      (params.get('from') && params.get('from') !== 'main-entrance')
      || (params.get('to') && params.get('to') !== 'library')
      || (MODES[params.get('mode')] && params.get('mode') !== 'pedestrian')
      || (params.get('event') && params.get('event') !== DEFAULT_EVENT_ID);
    return query || nonDefaultRoute ? 'nav' : 'landing';
  });

  const openSystemMenu = useCallback((panel = systemMenuPanel) => {
    setSystemMenuPanel(panel);
    setSystemMenuOpen(true);
  }, [systemMenuPanel]);

  const closeSystemMenu = useCallback(() => {
    setSystemMenuOpen(false);
    window.requestAnimationFrame(() => systemMenuButtonRef.current?.focus());
  }, []);

  const route = useMemo(() => findRoute(from, to, mode), [from, to, mode]);
  const staticApiUrl = `./api/v1/routes/${from}/${to}.${mode}.json`;

  // Restart the navigation progress clock whenever the route changes, so the
  // voice assistant's live context estimates progress from this moment.
  useEffect(() => {
    setRouteStartedAt(Date.now());
  }, [from, to, mode]);

  useEffect(() => {
    const query = params.get('q');
    if (query) handleQuery(query, false);
  }, []);

  // Seed the demo access code from the shared link (?accessCode=...) so
  // visitors do not have to type it, then strip the credential from the
  // address bar, browser history and any subsequently copied share links.
  useEffect(() => {
    const accessCode = params.get('accessCode');
    if (accessCode?.trim()) {
      voiceSession.setAccessCode(accessCode.trim());
      const url = new URL(window.location.href);
      url.searchParams.delete('accessCode');
      window.history.replaceState({}, '', url);
    }
  }, []);

  // Default the origin to the user's current position when possible: an
  // explicitly shared ?from= link wins, an explicit user choice (manual
  // select, typed/voice query) wins, and the main gate remains the final
  // fallback when there is no fix and no user input.
  useEffect(() => {
    if (params.get('from')) return undefined;
    let cancelled = false;
    locateCurrentPlace().then((place) => {
      if (cancelled || !place) return;
      setFrom((current) => {
        if (current !== 'main-entrance') return current; // user already chose
        return place.id;
      });
      setMessages((items) => [
        ...items,
        {
          role: 'assistant',
          text: t('app.originLocated', {
            name: localizedName(NODE_BY_ID[place.id], lang),
          }),
        },
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function parseQueryWithEvent(query) {
    const eventParsed = resolveEventNavigationQuery(query, activeEvent, from, mode);
    return eventParsed.detected ? eventParsed : parseNavigationQuery(query, from);
  }

  async function handleQuery(query, includeUser = true) {
    const parsed = parseQueryWithEvent(query);
    if (includeUser) setMessages((items) => [...items, { role: 'user', text: query }]);

    if (parsed.understood) {
      const nextRoute = applyNavigation(parsed);
      setPhase('nav');
      const highlightsTeaser =
        nextRoute.highlights.length > 0
          ? t('app.viaHighlights', {
            list: nextRoute.highlights.slice(0, 3).map((item) => localizedName(item, lang)).join(lang === 'en' ? ', ' : '、'),
          })
          : '';
      setMessages((items) => [
        ...items,
        {
          role: 'assistant',
          text: t('app.parsed', {
            from: localizedName(NODE_BY_ID[parsed.from], lang),
            to: localizedName(NODE_BY_ID[parsed.to], lang),
            distance: nextRoute.summary.distanceMeters,
            duration: formatDuration(nextRoute.summary.durationSeconds, lang),
            highlights: highlightsTeaser,
          }),
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
            ? t('app.ambiguousEvent')
            : t('app.unboundPlace'),
        },
      ]);
      return;
    }

    const cachedReply = getCachedAssistantReply(query);
    if (cachedReply) {
      if (cachedReply.key === 'weather') {
        const weather = await fetchWeather();
        setMessages((items) => [
          ...items,
          {
            role: 'assistant',
            text: weather.available ? buildWeatherAdvisory(weather) : cachedReply.text,
            source: weather.available ? 'open-meteo' : cachedReply.source,
          },
        ]);
        return;
      }
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: cachedReply.text, source: cachedReply.source },
      ]);
      return;
    }

    if (/(沿途|途经|经过|路过|沿线|顺路).*(什么|介绍|哪里|哪些|地方|建筑|楼)|(什么|介绍|哪里|哪些).*(沿途|经过|途经|沿线|路过)/.test(query)) {
      const highlights = route.highlights ?? [];
      setMessages((items) => [
        ...items,
        {
          role: 'assistant',
          text: highlights.length
            ? t('app.alongRoute', {
              to: localizedName(NODE_BY_ID[to], lang),
              list: highlights.map((item) => t('app.alongRouteItem', {
                name: localizedName(item, lang),
                distance: item.distanceMeters,
                desc: item.description ?? t('app.defaultPlaceDesc'),
              })).join(lang === 'en' ? '; ' : '；'),
            })
            : t('app.noHighlights', { distance: route.summary.distanceMeters }),
          source: 'route-highlights',
        },
      ]);
      return;
    }

    if (!parsed.understood) {
      const missing = parsed.from ? t('app.missingDest') : t('app.missingEither');
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: t('app.missing', { what: missing }) },
      ]);
      return;
    }
  }

  // Language of the most recent voice utterance, so navigation receipts can
  // instruct the model in the same language the user speaks.
  const lastVoiceLangRef = useRef('zh');

  function handleVoiceUserTranscript(query) {
    lastVoiceLangRef.current = /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en';
    setMessages((items) => [...items, { role: 'user', text: query, source: 'voice' }]);
    const parsed = parseQueryWithEvent(query);
    if (!parsed.understood) return;
    applyNavigation(parsed);
    setPhase('nav');
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
    const en = lastVoiceLangRef.current !== 'zh';
    if (!parsed.understood) {
      return {
        ok: false,
        error: parsed.error,
        message: en
          ? 'No valid campus destination was recognised. Ask the user which building or place they mean.'
          : '没有识别出有效的校内目的地，请向用户追问具体建筑或地点。',
      };
    }

    const nextRoute = applyNavigation(parsed);
    if (nextRoute.status !== 'ok') {
      return {
        ok: false,
        error: 'no_route',
        message: en
          ? 'The local routing graph has no usable route between these two places right now.'
          : '本地寻路图暂时找不到这两个地点之间的可用路线。',
      };
    }
    setPhase('nav');

    return {
      ok: true,
      action: 'navigation_updated',
      from: { id: parsed.from, name: NODE_BY_ID[parsed.from].name },
      to: { id: parsed.to, name: NODE_BY_ID[parsed.to].name },
      mode: parsed.mode,
      distanceMeters: nextRoute.summary.distanceMeters,
      durationSeconds: nextRoute.summary.durationSeconds,
      highlights: nextRoute.highlights.map((item) => ({
        id: item.id,
        name: item.name,
        distanceMeters: item.distanceMeters,
        description: item.description,
      })),
      message: en
        ? 'LubanNav has updated the route from the local routing graph. Tell the user briefly; if the destination is the 3F open-air deck or the weather calls for it, you may add a brief umbrella or sunscreen note.'
        : 'LubanNav 页面已使用本地寻路图更新路线，请简短告知用户；若目的地是 3 楼露天平台或天气需要，可顺带提醒带伞或防晒。',
    };
  }

  // Keep the shared voice session wired to the latest handlers even while the
  // in-menu VoiceAssistant panel is not mounted (e.g. on the landing screen);
  // re-registering when the menu closes prevents stale closures.
  const voiceHandlersRef = useRef({
    onUserTranscript: () => {},
    onAssistantTranscript: () => {},
    onNavigationCommand: () => {},
  });
  voiceHandlersRef.current = {
    onUserTranscript: handleVoiceUserTranscript,
    onAssistantTranscript: handleVoiceAssistantTranscript,
    onNavigationCommand: handleVoiceNavigationCommand,
  };
  useEffect(() => {
    voiceSession.setHandlers({
      onUserTranscript: (text) => voiceHandlersRef.current.onUserTranscript?.(text),
      onAssistantTranscript: (text) => voiceHandlersRef.current.onAssistantTranscript?.(text),
      onNavigationCommand: (...argumentsList) =>
        voiceHandlersRef.current.onNavigationCommand?.(...argumentsList),
    });
  }, [systemMenuOpen]);

  function selectDestination(id) {
    setTo(id);    const nextRoute = findRoute(from, id, mode);
    setMessages((items) => [
      ...items,
      {
        role: 'assistant',
        text: t('route.destSet', {
          name: localizedName(NODE_BY_ID[id], lang),
          distance: nextRoute.summary.distanceMeters,
        }),
      },
    ]);
  }

  function swapRoute() {
    setFrom(to);
    setTo(from);
  }

  async function copyShareLink() {
    await navigator.clipboard.writeText(window.location.href);
    setMessages((items) => [...items, { role: 'assistant', text: t('route.copied') }]);
  }

  return (
    <>
      {phase === 'landing' ? (
        <LandingPage
          onEnter={() => setPhase('nav')}
          onConfigureVoice={() => openSystemMenu('voice')}
        />
      ) : (
        <main class="app-shell">
      <header class="topbar">
        <a class="brand" href="./" aria-label={t('topbar.homeAria')}>
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
            <span class="version">V0.3.0</span>
          </div>
          <button
            type="button"
            class="pref-toggle"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={t('topbar.langToggle')}
            aria-label={t('topbar.langToggle')}
          >
            {t('topbar.langLabel')}
          </button>
          <button
            type="button"
            class="pref-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('topbar.themeToLight') : t('topbar.themeToDark')}
            aria-label={theme === 'dark' ? t('topbar.themeToLight') : t('topbar.themeToDark')}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
          <button
            ref={systemMenuButtonRef}
            type="button"
            class="system-menu-trigger"
            aria-label={t('topbar.menuAria')}
            aria-haspopup="dialog"
            aria-expanded={systemMenuOpen}
            onClick={() => openSystemMenu()}
          >
            <span class="system-menu-trigger-label">{t('topbar.menu')}</span>
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
                  <h1 id="route-title">{t('route.title')} <small>{t('route.titleSub')}</small></h1>
                </div>
              </div>
              <button class="icon-button" onClick={copyShareLink} title={t('route.copyLink')} aria-label={t('route.copyLink')}>↗</button>
            </div>

            <div class="mode-switch" aria-label={t('mode.aria')}>
              {Object.values(MODES).map((item) => (
                <button key={item.id} class={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)}>
                  <span>{item.id === 'pedestrian' ? '◉' : '◇'}</span>{t(`mode.${item.id}`)}
                </button>
              ))}
            </div>

            <div class="route-fields">
              <label>
                <span class="field-index">A</span>
                <span class="field-label">{t('route.from')}</span>
                <select value={from} onChange={(event) => setFrom(event.currentTarget.value)}>
                  {PUBLIC_LOCATIONS.map((location) => <option key={location.id} value={location.id}>{localizedName(location, lang)}</option>)}
                </select>
              </label>
              <button class="swap-button" onClick={swapRoute} aria-label={t('route.swap')}>⇅</button>
              <label>
                <span class="field-index destination">B</span>
                <span class="field-label">{t('route.to')}</span>
                <select value={to} onChange={(event) => setTo(event.currentTarget.value)}>
                  {PUBLIC_LOCATIONS.map((location) => <option key={location.id} value={location.id}>{localizedName(location, lang)}</option>)}
                </select>
              </label>
            </div>

            <div class="route-summary">
              <div>
                <span>{t('route.distance')}</span>
                <strong>{route.summary.distanceMeters}<small>{t('route.meterUnit')}</small></strong>
              </div>
              <div>
                <span>{t('route.duration')}</span>
                <strong>{formatDuration(route.summary.durationSeconds, lang)}</strong>
              </div>
              <div>
                <span>{route.summary.indoorDistanceMeters > 0 ? t('route.indoorLeg') : t('route.pathNodes')}</span>
                <strong>
                  {route.summary.indoorDistanceMeters > 0
                    ? route.summary.indoorDistanceMeters
                    : route.path.length}
                  <small>{route.summary.indoorDistanceMeters > 0 ? t('route.meterUnit') : t('route.nodeUnit')}</small>
                </strong>
              </div>
            </div>

            <button class="details-toggle" onClick={() => setShowDetails((value) => !value)}>
              {showDetails ? t('route.hideDetails') : t('route.showDetails')} <span>{showDetails ? '−' : '+'}</span>
            </button>

            {showDetails && (
              <ol class="route-steps">
                {route.instructions.map((instruction, index) => (
                  <li key={`${index}-${instruction}`}><span>{String(index + 1).padStart(2, '0')}</span>{instruction}</li>
                ))}
              </ol>
            )}

            <ChatAssistant messages={messages} onSend={handleQuery} />

            <CampusInsights
              route={route}
              activeEvent={activeEvent}
              onSelectDestination={selectDestination}
            />
          </section>

          <EventPanel
            events={events}
            activeEventId={activeEventId}
            onSelectEvent={setActiveEventId}
            onSaveEvent={saveEvent}
            onRestoreDefault={restoreDefault}
            onNavigate={handleEventNavigate}
          />
        </aside>

        <section class="map-stage" aria-label="地图与实时语音">
          <CampusMap
            route={route}
            destination={to}
            robotPosition={posState.robot}
            browserPosition={posState.browser}
            positionSource={posState.source}
            onSelectDestination={selectDestination}
          />
          <VoiceQuickControl onConfigure={() => openSystemMenu('voice')} />
        </section>
      </div>

        <footer class="footer">
          <p><strong>{t('footer.demo')}</strong>{t('footer.disclaimer')}</p>
          <div>
            <a href={DATASET.sourceUrl} target="_blank" rel="noreferrer">{t('footer.mapSource')}</a>
            <a href="./api/">{t('footer.apiDocs')}</a>
            <a href={staticApiUrl} target="_blank" rel="noreferrer">{t('footer.routeJson')}</a>
          </div>
        </footer>
        </main>
      )}

      <SystemMenu
        open={systemMenuOpen}
        onClose={closeSystemMenu}
        activePanel={systemMenuPanel}
        onSelectPanel={setSystemMenuPanel}
        route={route}
        event={activeEvent}
        onVoiceUserTranscript={handleVoiceUserTranscript}
        onVoiceAssistantTranscript={handleVoiceAssistantTranscript}
        onVoiceNavigationCommand={handleVoiceNavigationCommand}
        onRobotPosition={handleRobotPosition}
        robotPosition={posState.robot}
        browserPosition={posState.browser}
        routeStartedAt={routeStartedAt}
      />
    </>
  );
}
