import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';
import { DEFAULT_BLE_CONFIG, normalizeBleConfig } from '../lib/robotProtocol.js';
import { WebBluetoothRobotClient, webBluetoothSupport } from '../lib/webBluetoothRobot.js';
import { RobotDirectionPad } from './RobotDirectionPad.jsx';

const CONFIG_STORAGE_KEY = 'luban-nav:ble-config:v2';

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '{}');
    return normalizeBleConfig(stored);
  } catch {
    return { ...DEFAULT_BLE_CONFIG };
  }
}

export function RobotControl({ route, onRobotPosition }) {
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
      return event.message.type === 'navigation_task'
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
  const [config, setConfig] = useState(loadConfig);
  const [connection, setConnection] = useState({
    state: 'idle',
    deviceName: null,
    stage: null,
    error: null,
  });
  const [position, setPosition] = useState(null);
  const [progress, setProgress] = useState(null);
  const [logs, setLogs] = useState([]);
  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new WebBluetoothRobotClient({
      bluetooth: window.navigator?.bluetooth,
      config,
    });
  }
  const client = clientRef.current;
  const connected = connection.state === 'connected';
  const connectionBusy = ['selecting', 'connecting', 'discovering'].includes(connection.state);
  const configLocked = connected || connectionBusy;
  const transferring = progress && progress.sentChunks < progress.totalChunks;
  const robotRoute = route?.request.mode === 'robot';

  function addLog(text, level = 'info') {
    if (!text) return;
    setLogs((items) => [
      { text, level, timestamp: new Date().toLocaleTimeString(lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) },
      ...items,
    ].slice(0, 5));
  }

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'state') {
        setConnection({
          state: event.state,
          deviceName: event.deviceName,
          stage: event.stage ?? null,
          error: event.error ?? null,
        });
        if (event.state === 'connected') addLog(t('robot.logs.connected', { device: event.deviceName ?? t('robot.logs.defaultBle') }), 'success');
        if (event.state === 'disconnected') addLog(t('robot.logs.disconnected'), 'warning');
        if (event.state === 'error' && event.error) addLog(friendlyError(event.error), 'error');
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
      if (event.type === 'message') addLog(logLabel(event));
      if (event.type === 'telemetry-error') addLog(t('robot.logs.telemetryError', { error: friendlyError(event.error) }), 'error');
      if (event.type === 'position') {
        setPosition(event.position);
        onRobotPosition?.(event.position);
      }
    });
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, []);

  useEffect(() => {
    if (configLocked) return;
    try {
      client.setConfig(config);
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }, [config, configLocked]);

  async function connect() {
    try {
      // Do not add asynchronous work before connect(): requestDevice must retain
      // the browser's user activation from this click.
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
  }[connection.state] ?? connection.state;

  return (
    <section class="robot-control" aria-labelledby="robot-control-title">
      <div class="robot-heading">
        <div>
          <p class="eyebrow">WEB BLUETOOTH / BLE GATT</p>
          <h2 id="robot-control-title">{t('robot.title')}</h2>
        </div>
        <span class={`robot-state ${connected ? 'connected' : ''}`}>
          <i />{stateLabel}
        </span>
      </div>

      {!support.supported ? (
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

          <RobotDirectionPad
            connected={connected}
            configLocked={configLocked}
            client={client}
            config={config}
            onUpdateConfig={updateConfig}
          />

          {connection.error && (
            <div class="robot-diagnostic" role="alert">
              <strong>{t('robot.diagnostic', { stage: connection.stage ?? '' })}</strong>
              <p>{friendlyError(connection.error)}</p>
              <small>{t('robot.diagnosticHint')}</small>
            </div>
          )}

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
                <small>{position.headingDegrees == null ? t('robot.headingUnknown') : t('robot.heading', { degrees: Math.round(position.headingDegrees) })}</small>
              </strong>
            ) : (
              <strong>{t('robot.waitingPosition')}<small>JSON Lines / WGS84</small></strong>
            )}
          </div>

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
        </>
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
