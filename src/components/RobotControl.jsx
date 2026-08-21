import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';
import { progressAlongRoute } from '../lib/positionStore.js';
import { DEFAULT_BLE_CONFIG, normalizeBleConfig } from '../lib/robotProtocol.js';
import { DEFAULT_WIFI_URL, WifiRobotLink } from '../lib/robotWifiLink.js';
import { WebBluetoothRobotClient, webBluetoothSupport } from '../lib/webBluetoothRobot.js';
import { RobotDirectionPad } from './RobotDirectionPad.jsx';

const CONFIG_STORAGE_KEY = 'luban-nav:ble-config:v2';
const TRANSPORT_STORAGE_KEY = 'luban-nav:robot-transport:v1';
const WIFI_URL_STORAGE_KEY = 'luban-nav:wifi-url:v1';

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '{}');
    return normalizeBleConfig(stored);
  } catch {
    return { ...DEFAULT_BLE_CONFIG };
  }
}

function loadWifiUrl() {
  try {
    return localStorage.getItem(WIFI_URL_STORAGE_KEY) || DEFAULT_WIFI_URL;
  } catch {
    return DEFAULT_WIFI_URL;
  }
}

const FIX_STATUS_LABEL_KEY = {
  rtk_fixed: 'robot.wifi.rtkFixed',
  rtk_float: 'robot.wifi.rtkFloat',
  dgps: 'robot.wifi.dgps',
  gps: 'robot.wifi.gps',
  no_fix: 'robot.wifi.noFix',
  replay: 'robot.wifi.replay',
};

export function RobotControl({ route, onRobotPosition, browserPosition }) {
  const { t, lang } = useI18n();

  function friendlyError(error) {
    if (error?.name === 'RobotConnectionError') {
      const uuid = error.context?.uuid;
      const deviceName = error.context?.deviceName ?? t('robot.logs.defaultDevice');
      if (error.stage === 'gatt-connect') {
        return t('robot.errors.gattConnect', { device: deviceName });
      }
      if (error.stage === 'primary-service') {
        return t('robot.errors.primaryService', { device: deviceName, uuid });
      }
      if (error.stage === 'command-characteristic') {
        return t('robot.errors.commandCharacteristic', { uuid });
      }
      if (error.stage === 'telemetry-characteristic') {
        return t('robot.errors.telemetryCharacteristic', { uuid });
      }
      if (error.stage === 'notifications') {
        return t('robot.errors.notifications', { uuid });
      }
    }
    if (error?.name === 'NotFoundError') return t('robot.errors.notFound');
    if (error?.name === 'SecurityError') return t('robot.errors.security');
    if (error?.name === 'NetworkError') return t('robot.errors.network');
    if (error?.name === 'AbortError') return t('robot.errors.abort');
    return error?.message ?? t('robot.errors.unknown');
  }

  function logLabel(event) {
    if (event.type === 'sent') {
      return event.message?.type === 'navigation_task'
        ? t('robot.logs.taskSent', { taskId: event.message.taskId })
        : t('robot.logs.stopSent');
    }
    if (event.type === 'message') {
      if (event.message.type === 'ack') {
        return t('robot.logs.ack', { status: event.message.status ?? 'received' });
      }
      if (event.message.type === 'status') {
        return t('robot.logs.status', { status: event.message.status ?? 'unknown' });
      }
    }
    return null;
  }

  const support = useMemo(() => webBluetoothSupport(window), []);
  const [transport, setTransport] = useState(() => {
    try {
      return localStorage.getItem(TRANSPORT_STORAGE_KEY) === 'ble' ? 'ble' : 'wifi';
    } catch {
      return 'wifi';
    }
  });
  const [config, setConfig] = useState(loadConfig);
  const [wifiUrl, setWifiUrl] = useState(loadWifiUrl);
  const [connection, setConnection] = useState({
    state: 'idle',
    deviceName: null,
    stage: null,
    error: null,
  });
  const [wifiConnection, setWifiConnection] = useState({ state: 'idle', error: null });
  const [position, setPosition] = useState(null);
  const [progress, setProgress] = useState(null);
  const [logs, setLogs] = useState([]);

  const bleClientRef = useRef(null);
  if (!bleClientRef.current) {
    bleClientRef.current = new WebBluetoothRobotClient({
      bluetooth: window.navigator?.bluetooth,
      config,
    });
  }
  const wifiClientRef = useRef(null);
  if (!wifiClientRef.current) {
    wifiClientRef.current = new WifiRobotLink({ url: wifiUrl });
  }

  const client = transport === 'ble' ? bleClientRef.current : wifiClientRef.current;
  const activeConnection = transport === 'ble' ? connection : wifiConnection;
  const connected = activeConnection.state === 'connected';
  const connectionBusy = ['selecting', 'connecting', 'discovering'].includes(activeConnection.state);
  const configLocked = connected || connectionBusy;
  const transferring = progress && progress.sentChunks < progress.totalChunks;
  const robotRoute = route?.request.mode === 'robot';
  const mixedContentRisk = transport === 'wifi'
    && typeof window !== 'undefined'
    && window.location?.protocol === 'https:'
    && wifiUrl.startsWith('ws://');

  function addLog(text, level = 'info') {
    if (!text) return;
    setLogs((items) => [
      {
        text,
        level,
        timestamp: new Date().toLocaleTimeString(lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false }),
      },
      ...items,
    ].slice(0, 5));
  }

  useEffect(() => {
    const active = transport === 'ble' ? bleClientRef.current : wifiClientRef.current;
    const unsubscribe = active.subscribe((event) => {
      if (event.type === 'state') {
        if (transport === 'ble') {
          setConnection({
            state: event.state,
            deviceName: event.deviceName,
            stage: event.stage ?? null,
            error: event.error ?? null,
          });
          if (event.state === 'connected') {
            addLog(t('robot.logs.connected', { device: event.deviceName ?? t('robot.logs.defaultBle') }), 'success');
          }
          if (event.state === 'disconnected') addLog(t('robot.logs.disconnected'), 'warning');
          if (event.state === 'error' && event.error) addLog(friendlyError(event.error), 'error');
        } else {
          setWifiConnection({ state: event.state, error: event.error ?? null });
          if (event.state === 'connected') {
            addLog(t('robot.wifi.connected', { url: event.deviceName ?? wifiUrl }), 'success');
          }
          if (event.state === 'disconnected') addLog(t('robot.wifi.disconnected'), 'warning');
          if (event.state === 'error' && event.error) addLog(friendlyError(event.error), 'error');
        }
      }
      if (event.type === 'transfer-progress') setProgress(event);
      if (event.type === 'sent') {
        setProgress(null);
        addLog(logLabel(event), 'success');
      }
      if (event.type === 'transfer-error') {
        setProgress(null);
        addLog(friendlyError(event.error), event.error?.name === 'AbortError' ? 'warning' : 'error');
      }
      if (event.type === 'nav-preempted') {
        addLog(t('robot.logs.navPreempted'), 'warning');
      }
      if (event.type === 'message') addLog(logLabel(event));
      if (event.type === 'telemetry-error') {
        addLog(t('robot.logs.telemetryError', { error: friendlyError(event.error) }), 'error');
      }
      if (event.type === 'diagnostics' && event.command) {
        const command = event.command;
        const writable = command.properties?.writeWithoutResponse || command.properties?.write || command.legacyWriteSupported;
        addLog(
          t('robot.logs.commandCharacteristic', {
            writable: writable ? '可写' : '不可写',
            detail: JSON.stringify(command.properties ?? {}),
          }),
          writable ? 'success' : 'error',
        );
      }
      if (event.type === 'position') {
        setPosition(event.position);
        onRobotPosition?.(event.position);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [transport]);

  useEffect(() => {
    if (transport !== 'ble' || configLocked) return;
    try {
      bleClientRef.current.setConfig(config);
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }, [config, configLocked, transport]);

  useEffect(() => {
    try {
      localStorage.setItem(TRANSPORT_STORAGE_KEY, transport);
    } catch {
      /* ignore */
    }
  }, [transport]);

  useEffect(() => {
    try {
      localStorage.setItem(WIFI_URL_STORAGE_KEY, wifiUrl);
    } catch {
      /* ignore */
    }
  }, [wifiUrl]);

  function selectTransport(next) {
    if (next === transport) return;
    if (connected) client.disconnect();
    setProgress(null);
    setTransport(next);
  }

  async function connect() {
    try {
      if (transport === 'wifi') {
        wifiClientRef.current.setConfig({ url: wifiUrl });
      }
      // Do not add asynchronous work before connect(): requestDevice must retain
      // the browser's user activation from this click (BLE path).
      await client.connect();
    } catch (error) {
      if (error?.name === 'NotFoundError') addLog(friendlyError(error), 'warning');
    }
  }

  async function sendRoute() {
    try {
      await client.sendNavigationTask(route);
    } catch (error) {
      if (error?.name !== 'AbortError') addLog(friendlyError(error), 'error');
    }
  }

  async function emergencyStop() {
    try {
      addLog(t('robot.logs.stopping'), 'warning');
      await client.sendEmergencyStop();
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }

  async function sendNextWaypoint() {
    if (!nextWaypoint) return;
    try {
      await client.sendGotoTarget(nextWaypoint.longitude, nextWaypoint.latitude, {
        speedMetersPerSecond: 0.3,
        taskId: client.lastTaskId ?? null,
      });
      addLog(t('robot.logs.gotoSent', {
        index: nextWaypoint.index + 1,
        latitude: nextWaypoint.latitude.toFixed(7),
        longitude: nextWaypoint.longitude.toFixed(7),
      }), 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') addLog(friendlyError(error), 'error');
    }
  }

  function updateConfig(field, value) {
    setConfig((current) => ({
      ...current,
      [field]: [
        'chunkBytes',
        'interChunkDelayMs',
        'directionStepMeters',
        'directionStepDegrees',
        'directionSpeedMetersPerSecond',
      ].includes(field)
        ? Number(value)
        : value,
    }));
  }

  const stateLabel = {
    idle: t('robot.state.idle'),
    selecting: t('robot.state.selecting'),
    connecting: t('robot.state.connecting'),
    discovering: t('robot.state.discovering'),
    connected: t('robot.state.connected'),
    disconnected: t('robot.state.disconnected'),
    error: t('robot.state.error'),
  }[activeConnection.state] ?? activeConnection.state;

  const routeProgress = useMemo(
    () => (position ? progressAlongRoute(route, position) : null),
    [position, route],
  );

  // 下一个要前进的经纬度：按小车当前位置沿路线取第一个未到达航点。
  const nextWaypoint = useMemo(() => {
    if (!position || !route?.path?.length) return null;
    const progress = progressAlongRoute(route, position);
    if (!progress) return null;
    const points = route.navigationWaypoints ?? route.path;
    const point = points[progress.nextIndex];
    if (!point) return null;
    return { index: progress.nextIndex, longitude: point.longitude, latitude: point.latitude };
  }, [position, route]);

  const fixStatusLabel = position?.fixStatus ? t(FIX_STATUS_LABEL_KEY[position.fixStatus] ?? 'robot.wifi.noFix') : null;
  const positionSourceLabel = position?.fixStatus === 'replay'
    ? `${t('robot.positionSources.robot')} · ${fixStatusLabel}`
    : fixStatusLabel
      ? `${t('robot.positionSources.robot')} · ${fixStatusLabel}`
      : t('robot.positionSources.none');

  return (
    <section class="robot-control" aria-labelledby="robot-control-title">
      <div class="robot-heading">
        <div>
          <p class="eyebrow">ROBOT LINK / BLE + WIFI</p>
          <h2 id="robot-control-title">{t('robot.title')}</h2>
        </div>
        <span class={`robot-state ${connected ? 'connected' : ''}`}>
          <i />{stateLabel}
        </span>
      </div>

      <div class="robot-transport-tabs" role="tablist" aria-label={t('system.tabsAria')}>
        <button
          type="button"
          role="tab"
          class={transport === 'wifi' ? 'active' : ''}
          aria-selected={transport === 'wifi'}
          onClick={() => selectTransport('wifi')}
        >
          <strong>WiFi</strong>
          <small>{t('robot.transport.wifiDesc')}</small>
        </button>
        <button
          type="button"
          role="tab"
          class={transport === 'ble' ? 'active' : ''}
          aria-selected={transport === 'ble'}
          onClick={() => selectTransport('ble')}
        >
          <strong>BLE</strong>
          <small>{t('robot.transport.bleDesc')}</small>
        </button>
      </div>

      {transport === 'wifi' ? (
        <>
          <div class="robot-capability ready" role="status">
            <strong>{t('robot.wifi.title')}</strong>
            <p>{t('robot.wifi.hint')}</p>
          </div>

          <div class="robot-connection-row">
            <label class="robot-wifi-url">
              <span>{t('robot.wifi.url')}</span>
              <input
                value={wifiUrl}
                onInput={(event) => setWifiUrl(event.currentTarget.value.trim())}
                disabled={connected || connectionBusy}
                placeholder={t('robot.wifi.urlPlaceholder')}
                spellcheck={false}
              />
            </label>
            {connected ? (
              <button class="robot-secondary-button" onClick={() => client.disconnect()}>{t('robot.disconnect')}</button>
            ) : (
              <button
                class="robot-connect-button"
                onClick={connect}
                disabled={connectionBusy}
              >
                {connectionBusy ? t('robot.wifi.connecting') : t('robot.wifi.connect')}
              </button>
            )}
          </div>

          <small class={`robot-hint ${mixedContentRisk ? 'robot-hint-warn' : ''}`}>
            {t(mixedContentRisk ? 'robot.wifi.mixedContent' : 'robot.wifi.hint')}
          </small>

          {activeConnection.error && (
            <div class="robot-diagnostic" role="alert">
              <strong>{t('robot.diagnostic', { stage: activeConnection.stage ?? '' })}</strong>
              <p>{friendlyError(activeConnection.error)}</p>
            </div>
          )}
        </>
      ) : !support.supported ? (
        <div class="robot-capability blocked" role="status">
          <strong>{t('robot.blockedTitle')}</strong>
          <p>{support.reason}</p>
          <ul>
            <li>{t('robot.blockedDesktop')}</li>
            <li>{t('robot.blockedAndroid')}</li>
            <li>{t('robot.blockedIos')}</li>
          </ul>
        </div>
      ) : (
        <>
          <div class="robot-capability ready" role="status">
            <strong>{t('robot.readyTitle')}</strong>
            <p>{t('robot.readyHint', { prefix: config.deviceNamePrefix || t('robot.anyName') })}</p>
          </div>

          <div class="robot-connection-row">
            <div>
              <span>{t('robot.device')}</span>
              <strong>{connection.deviceName ?? t('robot.noDevice')}</strong>
            </div>
            {connected ? (
              <button class="robot-secondary-button" onClick={() => client.disconnect()}>{t('robot.disconnect')}</button>
            ) : (
              <button
                class="robot-connect-button"
                onClick={connect}
                disabled={connectionBusy}
              >
                {connectionBusy ? t('robot.connecting') : t('robot.connect')}
              </button>
            )}
          </div>

          <small class="robot-hint">
            {t('robot.selectorHint')}
            {config.deviceNamePrefix ? t('robot.selectorHintPrefix') : ''}
          </small>
        </>
      )}

      <RobotDirectionPad
        connected={connected}
        configLocked={configLocked}
        client={client}
        config={config}
        onUpdateConfig={updateConfig}
      />

      <div class="robot-actions">
        <button
          class="robot-send-button"
          onClick={sendRoute}
          disabled={!connected || !robotRoute || transferring}
        >
          <span>{t('robot.sendRoute')}</span>
          <small>{robotRoute
            ? t(route.navigationWaypoints ? 'robot.waypointsDense' : 'robot.waypoints', {
              count: route.navigationWaypoints?.length ?? route.path.length,
            })
            : t('robot.needRobotMode')}</small>
        </button>
        <button
          class="robot-stop-button"
          onClick={emergencyStop}
          disabled={!connected}
        >
          STOP
        </button>
      </div>

      <div class="robot-goto-row">
        <button
          class="robot-goto-button"
          onClick={sendNextWaypoint}
          disabled={!connected || !robotRoute || !nextWaypoint}
        >
          <span>{t('robot.sendNextWaypoint')}</span>
          <small>{nextWaypoint
            ? t('robot.nextWaypoint', {
              index: nextWaypoint.index + 1,
              latitude: nextWaypoint.latitude.toFixed(7),
              longitude: nextWaypoint.longitude.toFixed(7),
            })
            : t('robot.needCarPosition')}</small>
        </button>
      </div>

      {progress && (
        <div class="robot-progress" role="status">
          <span style={{ width: `${(progress.sentChunks / progress.totalChunks) * 100}%` }} />
          <small>{t(progress.messageType === 'navigation_task' ? 'robot.progressRoute' : 'robot.progressCommand')} {progress.sentChunks}/{progress.totalChunks}</small>
        </div>
      )}

      <div class="robot-position" aria-live="polite">
        <span>{t('robot.position')}</span>
        {position ? (
          <strong>
            {position.latitude.toFixed(7)}, {position.longitude.toFixed(7)}
            <small>
              {position.headingDegrees == null ? t('robot.headingUnknown') : t('robot.heading', { degrees: Math.round(position.headingDegrees) })}
              {position.speedMetersPerSecond != null ? ` · ${t('robot.progress.speed', { speed: position.speedMetersPerSecond.toFixed(2) })}` : ''}
            </small>
            <small class="robot-position-source">{positionSourceLabel}</small>
          </strong>
        ) : (
          <strong>{t('robot.waitingPosition')}<small>JSON Lines / WGS84</small></strong>
        )}
        {browserPosition && (
          <div class="robot-browser-position">
            <span>{t('robot.positionSources.browser')}</span>
            <strong>{browserPosition.latitude.toFixed(7)}, {browserPosition.longitude.toFixed(7)}</strong>
          </div>
        )}
      </div>

      {routeProgress && position && (
        <div class="robot-live-progress" role="status">
          <div class="robot-live-progress-bar">
            <span style={{ width: `${Math.round(routeProgress.percent * 100)}%` }} />
          </div>
          <div class="robot-live-progress-row">
            <strong>{t('robot.progress.percent', { percent: Math.round(routeProgress.percent * 100) })}</strong>
            <span>{t('robot.progress.remaining', { meters: Math.round(routeProgress.remainingMeters) })}</span>
            <span>{t('robot.progress.next', { meters: Math.round(routeProgress.distanceToNextMeters) })}</span>
          </div>
          {routeProgress.arrived && <small class="robot-live-arrived">{t('robot.progress.arrived')}</small>}
        </div>
      )}

      {transport === 'ble' && (
        <details class="robot-settings">
          <summary>{t('robot.settings')}</summary>
          <div class="robot-settings-grid">
            <label>
              <span>{t('robot.fields.deviceNamePrefix')}</span>
              <input
                value={config.deviceNamePrefix}
                onInput={(event) => updateConfig('deviceNamePrefix', event.currentTarget.value)}
                disabled={configLocked}
                placeholder={t('robot.fields.deviceNamePrefixPlaceholder')}
              />
            </label>
            <label>
              <span>{t('robot.fields.serviceUuid')}</span>
              <input
                value={config.serviceUuid}
                onInput={(event) => updateConfig('serviceUuid', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.commandUuid')}</span>
              <input
                value={config.commandCharacteristicUuid}
                onInput={(event) => updateConfig('commandCharacteristicUuid', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.telemetryUuid')}</span>
              <input
                value={config.telemetryCharacteristicUuid}
                onInput={(event) => updateConfig('telemetryCharacteristicUuid', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.chunkBytes')}</span>
              <input
                type="number"
                min="1"
                max="512"
                value={config.chunkBytes}
                onInput={(event) => updateConfig('chunkBytes', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.stepMeters')}</span>
              <input
                type="number"
                min="0.05"
                max="1"
                step="0.05"
                value={config.directionStepMeters}
                onInput={(event) => updateConfig('directionStepMeters', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.stepDegrees')}</span>
              <input
                type="number"
                min="5"
                max="90"
                step="5"
                value={config.directionStepDegrees}
                onInput={(event) => updateConfig('directionStepDegrees', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
            <label>
              <span>{t('robot.fields.interChunkDelay')}</span>
              <input
                type="number"
                min="0"
                max="1000"
                value={config.interChunkDelayMs}
                onInput={(event) => updateConfig('interChunkDelayMs', event.currentTarget.value)}
                disabled={configLocked}
              />
            </label>
          </div>
        </details>
      )}

      <div class="robot-log" aria-label={t('robot.logAria')}>
        {logs.length ? logs.map((item, index) => (
          <p class={item.level} key={`${item.timestamp}-${index}-${item.text}`}>
            <time>{item.timestamp}</time>{item.text}
          </p>
        )) : <p><time>--:--:--</time>{t('robot.logs.idle')}</p>}
      </div>

      <p class="robot-safety">
        {t('robot.safety')}
      </p>
    </section>
  );
}
