import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_BLE_CONFIG, normalizeBleConfig } from '../lib/robotProtocol.js';
import { WebBluetoothRobotClient, webBluetoothSupport } from '../lib/webBluetoothRobot.js';

const CONFIG_STORAGE_KEY = 'luban-nav:ble-config:v2';

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '{}');
    return normalizeBleConfig(stored);
  } catch {
    return { ...DEFAULT_BLE_CONFIG };
  }
}

function friendlyError(error) {
  if (error?.name === 'RobotConnectionError') {
    const uuid = error.context?.uuid;
    const deviceName = error.context?.deviceName ?? 'car7';
    if (error.stage === 'gatt-connect') {
      return `已选择 ${deviceName}，但无法建立 BLE GATT 链路。请确认它是 BLE/GATT 设备而不是传统蓝牙 SPP，并关闭其他正在连接小车的 App。`;
    }
    if (error.stage === 'primary-service') {
      return `已连接 ${deviceName}，但找不到 Service ${uuid}。这说明 car7 很可能不使用当前默认的 Nordic UART Service；请从固件或 nRF Connect 读取实际 Service UUID。`;
    }
    if (error.stage === 'command-characteristic') {
      return `已找到 GATT Service，但没有可用的 Command/RX Characteristic ${uuid}。请填写 car7 实际的写入 UUID。`;
    }
    if (error.stage === 'telemetry-characteristic') {
      return `已找到命令通道，但没有 Telemetry/TX Characteristic ${uuid}。请填写 car7 实际的 Notify UUID。`;
    }
    if (error.stage === 'notifications') {
      return `已找到 TX Characteristic ${uuid}，但无法启用 Notify。请确认固件为该 Characteristic 开启 Notify 属性。`;
    }
  }
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
      { text, level, timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }) },
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
      addLog('正在中止路线传输并发送停止指令…', 'warning');
      await client.sendEmergencyStop();
    } catch (error) {
      addLog(friendlyError(error), 'error');
    }
  }

  // ── manual direction pad ────────────────────────────────────────────────

  const padTimer = useRef(null);
  const padActiveRef = useRef(false);

  function stopPadRepeat() {
    if (padTimer.current) {
      clearInterval(padTimer.current);
      padTimer.current = null;
    }
  }

  useEffect(() => () => stopPadRepeat(), []);

  function startPadHold(direction, options) {
    return (event) => {
      if (!connected) return;
      event.preventDefault();
      if (padActiveRef.current) return; // another button already holds
      padActiveRef.current = true;
      const command = {
        ...options,
        speedMetersPerSecond: config.directionSpeedMetersPerSecond ?? 0.06,
      };
      const send = () => client.sendDirection(direction, command).catch(() => {});
      send();
      padTimer.current = setInterval(send, 450);
    };
  }

  function endPadHold(event) {
    event?.preventDefault();
    padActiveRef.current = false;
    stopPadRepeat();
  }

  function stopNow() {
    stopPadRepeat();
    padActiveRef.current = false;
    client.sendDirection('stop').catch(() => {});
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
    idle: '等待连接',
    selecting: '选择设备…',
    connecting: '连接 GATT…',
    discovering: '检查服务…',
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
        <div class="robot-capability blocked" role="status">
          <strong>此浏览器无法直连 BLE</strong>
          <p>{support.reason}</p>
          <ul>
            <li>电脑：请改用 <b>Chrome / Edge</b>（桌面 Safari 不支持 Web Bluetooth）。</li>
            <li>Android 平板 / 手机：系统自带 <b>Chrome / Edge</b> 均支持，推荐用于现场演示。</li>
            <li>iPhone / iPad：Safari 无 Web Bluetooth，可安装 <b>Bluefy</b> 浏览器后直连 car7。</li>
          </ul>
        </div>
      ) : (
        <>
          <div class="robot-capability ready" role="status">
            <strong>BLE 直连就绪</strong>
            <p>点击下方按钮，在系统设备选择器中选择 <b>car7</b>（名称以“{config.deviceNamePrefix || '任意名称'}”开头）。</p>
          </div>

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
                disabled={connectionBusy}
              >
                {connectionBusy ? '连接中…' : '选择并连接小车'}
              </button>
            )}
          </div>

          <small class="robot-hint">
            系统选择器只显示正在广播的 BLE 设备：请确认小车已开机、蓝牙在广播，且与平板/电脑在同一空间。
            {config.deviceNamePrefix ? ' 若看不到设备，可清空“设备名前缀”显示全部附近设备。' : ''}
          </small>

          <div class="robot-pad" aria-label="手动方向控制">
            <div class="robot-pad-head">
              <span>手动方向控制</span>
              <small>每步 {config.directionStepMeters ?? 0.15} m / {config.directionStepDegrees ?? 15}° · 按住连续</small>
            </div>
            <label class="robot-speed-slider">
              <span>速度</span>
              <input
                type="range"
                min="0.02"
                max="0.30"
                step="0.01"
                value={config.directionSpeedMetersPerSecond ?? 0.06}
                onInput={(event) => updateConfig('directionSpeedMetersPerSecond', event.currentTarget.value)}
                disabled={configLocked}
                aria-label="方向控制速度"
              />
              <strong>{(config.directionSpeedMetersPerSecond ?? 0.06).toFixed(2)} m/s</strong>
            </label>
            <div class="robot-pad-grid">
              <button
                class="robot-pad-btn pad-up"
                type="button"
                aria-label="向前"
                disabled={!connected}
                onPointerDown={startPadHold('forward', { amountMeters: config.directionStepMeters })}
                onPointerUp={endPadHold}
                onPointerLeave={endPadHold}
                onPointerCancel={endPadHold}
                onContextMenu={(event) => event.preventDefault()}
              >↑<small>前</small></button>
              <button
                class="robot-pad-btn pad-left"
                type="button"
                aria-label="左转"
                disabled={!connected}
                onPointerDown={startPadHold('left', { amountDegrees: config.directionStepDegrees })}
                onPointerUp={endPadHold}
                onPointerLeave={endPadHold}
                onPointerCancel={endPadHold}
                onContextMenu={(event) => event.preventDefault()}
              >←<small>左</small></button>
              <button
                class="robot-pad-btn pad-stop"
                type="button"
                aria-label="停止"
                disabled={!connected}
                onPointerDown={(event) => event.preventDefault()}
                onClick={stopNow}
              >■<small>停止</small></button>
              <button
                class="robot-pad-btn pad-right"
                type="button"
                aria-label="右转"
                disabled={!connected}
                onPointerDown={startPadHold('right', { amountDegrees: config.directionStepDegrees })}
                onPointerUp={endPadHold}
                onPointerLeave={endPadHold}
                onPointerCancel={endPadHold}
                onContextMenu={(event) => event.preventDefault()}
              >→<small>右</small></button>
              <button
                class="robot-pad-btn pad-down"
                type="button"
                aria-label="向后"
                disabled={!connected}
                onPointerDown={startPadHold('backward', { amountMeters: config.directionStepMeters })}
                onPointerUp={endPadHold}
                onPointerLeave={endPadHold}
                onPointerCancel={endPadHold}
                onContextMenu={(event) => event.preventDefault()}
              >↓<small>后</small></button>
            </div>
            <small class="robot-hint">方向键只走固定步长；小车端自带超时与断连保护。红色停止键停止所有动作并清空未执行的指令，任务级急停用下方 STOP。</small>
          </div>

          {connection.error && (
            <div class="robot-diagnostic" role="alert">
              <strong>连接诊断 · {connection.stage}</strong>
              <p>{friendlyError(connection.error)}</p>
              <small>修改下方 GATT UUID 后重新连接；网页无法自动枚举未授权的自定义 Service。</small>
            </div>
          )}

          <div class="robot-actions">
            <button
              class="robot-send-button"
              onClick={sendRoute}
              disabled={!connected || !robotRoute || transferring}
            >
              <span>下发当前路线</span>
              <small>{robotRoute ? `${route.navigationWaypoints?.length ?? route.path.length} 个路径点${route.navigationWaypoints ? '（2.5 m 加密）' : ''}` : '请先切换机器人模式'}</small>
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
                  disabled={configLocked}
                  placeholder="例如 LubanBot"
                />
              </label>
              <label>
                <span>Service UUID</span>
                <input
                  value={config.serviceUuid}
                  onInput={(event) => updateConfig('serviceUuid', event.currentTarget.value)}
                  disabled={configLocked}
                />
              </label>
              <label>
                <span>Command / RX UUID</span>
                <input
                  value={config.commandCharacteristicUuid}
                  onInput={(event) => updateConfig('commandCharacteristicUuid', event.currentTarget.value)}
                  disabled={configLocked}
                />
              </label>
              <label>
                <span>Telemetry / TX UUID</span>
                <input
                  value={config.telemetryCharacteristicUuid}
                  onInput={(event) => updateConfig('telemetryCharacteristicUuid', event.currentTarget.value)}
                  disabled={configLocked}
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
                  disabled={configLocked}
                />
              </label>
              <label>
                <span>单步距离 m（前/后）</span>
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
                <span>单步转角 °（左/右）</span>
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
                <span>包间隔 ms</span>
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
