import {
  RobotMessageDecoder,
  createDirectionCommand,
  createEmergencyStop,
  createNavigationTaskStream,
  encodeRobotMessage,
} from './robotProtocol.js';

/**
 * WiFi transport for the LubanNav robot protocol.
 *
 * The browser talks to car7's WebSocket bridge (car7_wifi_bridge.py on the NUC,
 * e.g. ws://10.7.181.161:8900) with the exact same UTF-8 JSON Lines contract
 * as the BLE transport — one JSON object per line, LF-terminated. A WebSocket
 * frame carries one or more complete lines, so no BLE-style chunking or
 * LF-resync is needed; the robot's JSONLineFramer still tolerates any split.
 *
 * Mixed-content note: a page served over HTTPS cannot open ws:// to a LAN IP.
 * Use the local dev server (http://localhost:5173, a secure context) or serve
 * the built app over http:// while testing against the NUC; wss:// (TLS on the
 * car) is the production path.
 *
 * Event interface mirrors WebBluetoothRobotClient so RobotControl and
 * RobotDirectionPad can treat both transports identically:
 *   state / message / position / sent / transfer-error / telemetry-error
 */

export const DEFAULT_WIFI_URL = 'ws://10.7.181.161:8900';

function wait(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(cause, fallback) {
  return cause?.message ? `${fallback}: ${cause.message}` : fallback;
}

export class RobotWifiLinkError extends Error {
  constructor(stage, cause, context = {}) {
    super(cause?.message ? `${stage}: ${cause.message}` : `WiFi link failed at ${stage}`);
    this.name = 'RobotWifiLinkError';
    this.stage = stage;
    this.causeName = cause?.name ?? 'Error';
    this.context = context;
    this.cause = cause;
  }
}

export function normalizeWifiUrl(input) {
  const url = String(input ?? DEFAULT_WIFI_URL).trim();
  if (!/^wss?:\/\/.+/i.test(url)) {
    throw new Error('WiFi 地址必须是 ws:// 或 wss:// 开头的 WebSocket 地址');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`WiFi 地址无效: ${url}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('WiFi 地址必须是 ws:// 或 wss://');
  }
  return url;
}

export class WifiRobotLink {
  constructor({ url = DEFAULT_WIFI_URL, WebSocketImpl = globalThis.WebSocket, debug = true } = {}) {
    this.url = normalizeWifiUrl(url);
    this.WebSocketImpl = WebSocketImpl;
    this.debug = debug !== false;
    this.decoder = new RobotMessageDecoder();
    this.listeners = new Set();
    this.state = 'idle';
    this.socket = null;
    this.lastTaskId = null;
    this.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manualDisconnect = false;
    this.sendQueue = [];
    this.sending = false;
  }

  trace(...args) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.debug('[wifi]', ...args);
  }

  traceError(...args) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.error('[wifi]', ...args);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  setState(state, detail = {}) {
    this.state = state;
    this.emit({ type: 'state', state, deviceName: this.url, ...detail });
  }

  setConfig(config) {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error('Disconnect before changing the WiFi address');
    }
    this.url = normalizeWifiUrl(config?.url ?? this.url);
  }

  setAutoReconnect(enabled) {
    this.autoReconnect = enabled !== false;
    if (!this.autoReconnect && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async connect() {
    if (this.state === 'connected' || this.state === 'connecting') return;
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('WebSocket is not available in this browser');
    }
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this.setState('connecting');
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10_000);
      this._resolveOpen = () => {
        clearTimeout(timer);
        resolve();
      };
      this._rejectOpen = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => {
      // Some stacks fire only onerror (no onclose); fail the pending connect.
      if (this.state === 'connecting') {
        this._rejectOpen?.(new Error('WebSocket 连接失败'));
      }
    };
    socket.onclose = () => this.handleClose();
    try {
      await opened;
    } catch (cause) {
      this.traceError('connect failed', cause);
      this.setState('error', { error: new RobotWifiLinkError('connect', cause, { url: this.url }) });
      throw cause;
    }
  }

  handleOpen() {
    this.reconnectAttempts = 0;
    this.trace('connected', this.url);
    this.decoder.reset();
    this.setState('connected');
    const resolve = this._resolveOpen;
    this._resolveOpen = null;
    this._rejectOpen = null;
    resolve?.();
    this.drainQueue();
  }

  handleMessage(event) {
    try {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      const messages = this.decoder.push(new TextEncoder().encode(text));
      for (const message of messages) {
        this.trace('telemetry <-', message.type, message.taskId ?? '');
        this.emit({ type: 'message', message });
        if (message.type === 'position') this.emit({ type: 'position', position: message });
      }
    } catch (error) {
      this.traceError('telemetry decode error', error);
      this.emit({ type: 'telemetry-error', error });
    }
  }

  handleClose() {
    const wasConnected = this.state === 'connected';
    if (this.state === 'connecting') {
      this._rejectOpen?.(new Error('WebSocket 连接被关闭'));
    }
    this._resolveOpen = null;
    this._rejectOpen = null;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket = null;
    }
    this.rejectQueued('WiFi 连接已断开');
    if (this.manualDisconnect) {
      this.setState('disconnected');
      return;
    }
    this.setState(wasConnected ? 'disconnected' : 'error', {
      error: wasConnected ? null : new RobotWifiLinkError('connect', new Error('connection closed'), { url: this.url }),
    });
    if (this.autoReconnect) {
      const delay = Math.min(15_000, 1_000 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.trace(`reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.manualDisconnect && this.autoReconnect) {
          this.connect().catch(() => {});
        }
      }, delay);
    }
  }

  disconnect() {
    this.manualDisconnect = true;
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectQueued('WiFi 连接已断开');
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.setState('disconnected');
  }

  // ── send path ──────────────────────────────────────────────────────────

  /** Send one or more complete protocol messages (each becomes a JSONL line). */
  sendLines(lines, { priority = false, meta = null } = {}) {
    if (this.state !== 'connected' || !this.socket) {
      return Promise.reject(new Error('小车尚未连接（WiFi）'));
    }
    const items = Array.isArray(lines) ? lines : [lines];
    if (items.length === 0) return Promise.resolve();
    const encoded = items.map((message) => encodeRobotMessage(message));
    const operation = { encoded, resolve: null, reject: null, priority, meta };
    const promise = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    if (priority) this.sendQueue.unshift(operation);
    else this.sendQueue.push(operation);
    this.drainQueue();
    return promise;
  }

  drainQueue() {
    if (this.sending || this.state !== 'connected' || !this.socket) return;
    this.sending = true;
    try {
      while (this.sendQueue.length && this.state === 'connected' && this.socket) {
        const operation = this.sendQueue.shift();
        try {
          for (const bytes of operation.encoded) {
            this.socket.send(bytes);
          }
          this.trace('sent', operation.encoded.length, 'lines');
          this.emit({ type: 'sent', message: operation.meta });
          operation.resolve(operation.meta);
        } catch (error) {
          operation.reject(error);
          this.emit({ type: 'transfer-error', message: operation.meta, error });
        }
      }
    } finally {
      this.sending = false;
    }
  }

  rejectQueued(reason) {
    const error = new Error(reason);
    for (const operation of this.sendQueue.splice(0)) operation.reject(error);
  }

  // ── protocol commands (same names as WebBluetoothRobotClient) ──────────

  sendNavigationTask(route) {
    // Streaming JSONL: navigation_start → N waypoint lines → navigation_end.
    const lines = createNavigationTaskStream(route);
    this.lastTaskId = lines[0].taskId;
    return this.sendLines(lines, { meta: { type: 'navigation_task', taskId: this.lastTaskId, streaming: true, lineCount: lines.length } });
  }

  sendEmergencyStop() {
    return this.sendLines(createEmergencyStop({ taskId: this.lastTaskId }), {
      priority: true,
      meta: { type: 'emergency_stop' },
    });
  }

  sendDirection(direction, options = {}) {
    if (!['forward', 'backward', 'left', 'right', 'stop'].includes(direction)) {
      return Promise.reject(new Error(`Unknown direction: ${direction}`));
    }
    return this.sendLines(createDirectionCommand(direction, options), {
      priority: direction === 'stop',
      meta: { type: 'direction', direction },
    });
  }
}

