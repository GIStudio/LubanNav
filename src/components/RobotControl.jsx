import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_BLE_CONFIG, normalizeBleConfig } from '../lib/robotProtocol.js';
import { WebBluetoothRobotClient, webBluetoothSupport } from '../lib/webBluetoothRobot.js';

const CONFIG_STORAGE_KEY = 'luban-nav:ble-config:v1';

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '{}');
    return normalizeBleConfig(stored);
  } catch {
    return { ...DEFAULT_BLE_CONFIG };
  }
}

function friendlyError(error) {
  if (error?.name === 'NotFoundError') return '已取消设备选择。';
  if (error?.name === 'SecurityError') return '浏览器拒绝了蓝牙权限，请确认使用 HTTPS 并由按钮触发连接。';
  if (error?.name === 'NetworkError') return 'GATT 连接失败，请确认小车未被其他设备占用。';
  if (error?.name === 'AbortError') return '路线传输已中止。';
  return error?.message ?? '未知蓝牙错误';
}

function logLabel(event) {
  if (event.type === 'sent') {
    return event.message.type === 'navigation_task'
      ? `任务 ${event.message.taskId} 已完整写入`
      : '紧急停止指令已写入';
  }
  if (event.type === 'message') {
    if (event.message.type === 'ack') {
      return `小车确认：${event.message.status ?? 'received'}`;
    }
    if (event.message.type === 'status') {
      return `小车状态：${event.message.status ?? 'unknown'}`;
    }
  }
  return null;
}

export function RobotControl({ route, onRobotPosition }) {
  const support = useMemo(() => webBluetoothSupport(window), []);
  const [config, setConfig] = useState(loadConfig);
  const [connection, setConnection] = useState({ state: 'idle', deviceName: null });
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
  const transferring = progress && progress.sentChunks < progress.totalChunks;
  const robotRoute = route?.request.mode === 'robot';

  function addLog(text, level = 'info') {
    if (!text) return;
    setLogs((items) => [
      { text, level, timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }) },
      ...items,
    ].slice(0, 5));
  }

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'state') {
        setConnection({ state: event.state, deviceName: event.deviceName });
        if (event.state === 'connected') addLog(`已连接 ${event.deviceName ?? 'BLE 小车'}`, 'success');
        if (event.state === 'disconnected') addLog('蓝牙连接已断开', 'warning');
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
      if (event.type === 'telemetry-error') addLog(`遥测解析失败：${friendlyError(event.error)}`, 'error');
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
    if (connected || connection.state === 'connecting') return;
    try {
      client.setConfig(config);
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }, [config, connected, connection.state]);

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
      addLog('正在中止路线传输并发送停止指令…', 'warning');
      await client.sendEmergencyStop();
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }

  function updateConfig(field, value) {
    setConfig((current) => ({
      ...current,
      [field]: field === 'chunkBytes' || field === 'interChunkDelayMs' ? Number(value) : value,
    }));
  }

  const stateLabel = {
    idle: '等待连接',
    selecting: '选择设备…',
    connecting: '连接 GATT…',
    connected: '已连接',
    disconnected: '已断开',
    error: '连接错误',
  }[connection.state] ?? connection.state;

  return (
    <section class="robot-control" aria-labelledby="robot-control-title">
      <div class="robot-heading">
        <div>
          <p class="eyebrow">WEB BLUETOOTH / BLE GATT</p>
          <h2 id="robot-control-title">机器人联络</h2>
        </div>
        <span class={`robot-state ${connected ? 'connected' : ''}`}>
          <i />{stateLabel}
        </span>
      </div>

      {!support.supported ? (
        <div class="robot-unsupported" role="status">
          <strong>此浏览器暂时无法连接 BLE</strong>
          <p>{support.reason}</p>
          <small>建议在 Android Chrome，或支持 Web Bluetooth 的电脑 Chromium 浏览器中打开本站。</small>
        </div>
      ) : (
        <>
          <div class="robot-connection-row">
            <div>
              <span>设备</span>
              <strong>{connection.deviceName ?? '尚未选择'}</strong>
            </div>
            {connected ? (
              <button class="robot-secondary-button" onClick={() => client.disconnect()}>断开</button>
            ) : (
              <button
                class="robot-connect-button"
                onClick={connect}
                disabled={connection.state === 'selecting' || connection.state === 'connecting'}
              >
                选择并连接小车
              </button>
            )}
          </div>

          <div class="robot-actions">
            <button
              class="robot-send-button"
              onClick={sendRoute}
              disabled={!connected || !robotRoute || transferring}
            >
              <span>下发当前路线</span>
              <small>{robotRoute ? `${route.path.length} 个路径点` : '请先切换机器人模式'}</small>
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
              <small>{progress.messageType === 'navigation_task' ? '路线' : '指令'} {progress.sentChunks}/{progress.totalChunks}</small>
            </div>
          )}

          <div class="robot-position" aria-live="polite">
            <span>最新位置</span>
            {position ? (
              <strong>
                {position.latitude.toFixed(7)}, {position.longitude.toFixed(7)}
                <small>{position.headingDegrees == null ? '航向未知' : `航向 ${Math.round(position.headingDegrees)}°`}</small>
              </strong>
            ) : (
              <strong>等待小车通知<small>JSON Lines / WGS84</small></strong>
            )}
          </div>

          <details class="robot-settings">
            <summary>GATT 与分包设置</summary>
            <div class="robot-settings-grid">
              <label>
                <span>设备名前缀（可空）</span>
                <input
                  value={config.deviceNamePrefix}
                  onInput={(event) => updateConfig('deviceNamePrefix', event.currentTarget.value)}
                  disabled={connected}
                  placeholder="例如 LubanBot"
                />
              </label>
              <label>
                <span>Service UUID</span>
                <input
                  value={config.serviceUuid}
                  onInput={(event) => updateConfig('serviceUuid', event.currentTarget.value)}
                  disabled={connected}
                />
              </label>
              <label>
                <span>Command / RX UUID</span>
                <input
                  value={config.commandCharacteristicUuid}
                  onInput={(event) => updateConfig('commandCharacteristicUuid', event.currentTarget.value)}
                  disabled={connected}
                />
              </label>
              <label>
                <span>Telemetry / TX UUID</span>
                <input
                  value={config.telemetryCharacteristicUuid}
                  onInput={(event) => updateConfig('telemetryCharacteristicUuid', event.currentTarget.value)}
                  disabled={connected}
                />
              </label>
              <label>
                <span>每包字节</span>
                <input
                  type="number"
                  min="1"
                  max="512"
                  value={config.chunkBytes}
                  onInput={(event) => updateConfig('chunkBytes', event.currentTarget.value)}
                  disabled={connected}
                />
              </label>
              <label>
                <span>包间隔 ms</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  value={config.interChunkDelayMs}
                  onInput={(event) => updateConfig('interChunkDelayMs', event.currentTarget.value)}
                  disabled={connected}
                />
              </label>
            </div>
          </details>
        </>
      )}

      <div class="robot-log" aria-label="机器人通信记录">
        {logs.length ? logs.map((item, index) => (
          <p class={item.level} key={`${item.timestamp}-${index}-${item.text}`}>
            <time>{item.timestamp}</time>{item.text}
          </p>
        )) : <p><time>--:--:--</time>所有任务均需人工点击下发，不会随路线变化自动控制小车。</p>}
      </div>

      <p class="robot-safety">
        浏览器链路不是安全控制器；真实运行仍需小车端看门狗、定位、避障、制动与实体急停。
      </p>
    </section>
  );
}
