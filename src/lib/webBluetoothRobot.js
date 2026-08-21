import {
  RobotMessageDecoder,
  bluetoothRequestOptions,
  createDirectionCommand,
  createEmergencyStop,
  createGotoTarget,
  createNavigationTaskStream,
  encodeRobotMessage,
  normalizeBleConfig,
  splitBleChunks,
} from './robotProtocol.js';

function wait(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class RobotConnectionError extends Error {
  constructor(stage, cause, context = {}) {
    super(cause?.message ? `${stage}: ${cause.message}` : `Bluetooth failed at ${stage}`);
    this.name = 'RobotConnectionError';
    this.stage = stage;
    this.causeName = cause?.name ?? 'Error';
    this.context = context;
    this.cause = cause;
  }
}

export function webBluetoothSupport(environment = globalThis) {
  const secureContext = environment.isSecureContext === true;
  const apiAvailable = typeof environment.navigator?.bluetooth?.requestDevice === 'function';
  return {
    supported: secureContext && apiAvailable,
    secureContext,
    apiAvailable,
    reason: !secureContext
      ? 'Web Bluetooth 只能在 HTTPS 或 localhost 安全上下文运行。'
      : !apiAvailable
        ? '当前浏览器没有提供 Web Bluetooth，请使用支持该 API 的 Chromium 浏览器。'
        : null,
  };
}

export class WebBluetoothRobotClient {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, config = {}, sleep = wait, debug = true } = {}) {
    this.bluetooth = bluetooth;
    this.config = normalizeBleConfig(config);
    this.sleep = sleep;
    this.debug = debug !== false;
    this.decoder = new RobotMessageDecoder();
    this.listeners = new Set();
    this.state = 'idle';
    this.device = null;
    this.server = null;
    this.commandCharacteristic = null;
    this.telemetryCharacteristic = null;
    this.operationQueue = [];
    this.activeOperation = null;
    this.draining = false;
    this.lastTaskId = null;
    this.handleDisconnected = this.handleDisconnected.bind(this);
    this.handleTelemetry = this.handleTelemetry.bind(this);
  }

  /** 诊断日志：console.debug 输出，可用 new WebBluetoothRobotClient({ debug: false }) 关闭。 */
  trace(...args) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.debug('[ble]', ...args);
  }

  traceError(...args) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.error('[ble]', ...args);
  }

  /** 打印特征对象的可写属性与支持的写方法，用于排查"已连接但写不进去"。 */
  describeCharacteristic(tag, characteristic) {
    if (!characteristic) return null;
    const properties = {};
    try {
      for (const key of Object.keys(characteristic.properties ?? {})) {
        properties[key] = characteristic.properties[key] === true;
      }
    } catch {
      /* properties 为 null 时忽略 */
    }
    const summary = {
      uuid: characteristic.uuid,
      properties,
      writeWithoutResponseSupported:
        typeof characteristic.writeValueWithoutResponse === 'function',
      writeWithResponseSupported: typeof characteristic.writeValueWithResponse === 'function',
      legacyWriteSupported: typeof characteristic.writeValue === 'function',
    };
    this.trace(`${tag} uuid=${characteristic.uuid}`, summary);
    return summary;
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
    this.emit({ type: 'state', state, deviceName: this.device?.name ?? null, ...detail });
  }

  setConfig(config) {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error('Disconnect before changing Bluetooth configuration');
    }
    this.config = normalizeBleConfig(config);
  }

  async connect() {
    if (typeof this.bluetooth?.requestDevice !== 'function') {
      throw new Error('Web Bluetooth is not available in this browser');
    }
    if (this.state === 'connected') return this.device;
    this.setState('selecting');
    let stage = 'device-selection';
    let context = {};
    try {
      // Keep requestDevice directly inside the user-triggered call chain.
      this.trace('requestDevice', { filters: this.config });
      const device = await this.bluetooth.requestDevice(bluetoothRequestOptions(this.config));
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);
      this.trace('device selected', device.name, device.id);
      stage = 'gatt-connect';
      this.setState('connecting');
      this.server = await device.gatt.connect();
      this.trace('gatt connected');
      stage = 'primary-service';
      context = { uuid: this.config.serviceUuid };
      this.setState('discovering', { stage });
      const service = await this.server.getPrimaryService(this.config.serviceUuid);
      this.trace('primary service ok', this.config.serviceUuid);
      stage = 'command-characteristic';
      context = { uuid: this.config.commandCharacteristicUuid };
      this.setState('discovering', { stage });
      this.commandCharacteristic = await service.getCharacteristic(
        this.config.commandCharacteristicUuid,
      );
      const commandInfo = this.describeCharacteristic('command characteristic', this.commandCharacteristic);
      stage = 'telemetry-characteristic';
      context = { uuid: this.config.telemetryCharacteristicUuid };
      this.setState('discovering', { stage });
      this.telemetryCharacteristic = await service.getCharacteristic(
        this.config.telemetryCharacteristicUuid,
      );
      const telemetryInfo = this.describeCharacteristic('telemetry characteristic', this.telemetryCharacteristic);
      this.telemetryCharacteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleTelemetry,
      );
      stage = 'notifications';
      context = { uuid: this.config.telemetryCharacteristicUuid };
      this.setState('discovering', { stage });
      await this.telemetryCharacteristic.startNotifications();
      this.trace('notifications started');
      this.emit({ type: 'diagnostics', command: commandInfo, telemetry: telemetryInfo });
      this.setState('connected');
      return device;
    } catch (cause) {
      const cancelledSelection = stage === 'device-selection' && cause?.name === 'NotFoundError';
      const error = cancelledSelection
        ? cause
        : new RobotConnectionError(stage, cause, {
            ...context,
            deviceName: this.device?.name ?? null,
          });
      const deviceName = this.device?.name ?? null;
      this.traceError(`connect failed at ${stage}`, cause);
      if (this.device?.gatt?.connected) {
        this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
        this.device.gatt.disconnect();
      }
      this.releaseGattReferences();
      this.setState(cancelledSelection ? 'idle' : 'error', {
        error,
        stage,
        deviceName,
      });
      throw error;
    }
  }

  disconnect() {
    this.cancelTransfers('Bluetooth connection closed');
    if (this.device?.gatt?.connected) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device.gatt.disconnect();
    }
    this.releaseGattReferences();
    this.setState('disconnected');
  }

  handleDisconnected() {
    const deviceName = this.device?.name ?? null;
    this.cancelTransfers('Robot disconnected during transfer');
    this.releaseGattReferences();
    this.setState('disconnected', { deviceName });
  }

  releaseGattReferences() {
    if (this.telemetryCharacteristic) {
      this.telemetryCharacteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handleTelemetry,
      );
    }
    this.decoder.reset();
    this.server = null;
    this.commandCharacteristic = null;
    this.telemetryCharacteristic = null;
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected);
      this.device = null;
    }
  }

  handleTelemetry(event) {
    try {
      const messages = this.decoder.push(event.target.value);
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

  sendNavigationTask(route) {
    if (
      this.activeOperation?.message.type === 'navigation_task' ||
      this.operationQueue.some((operation) => operation.message.type === 'navigation_task')
    ) {
      return Promise.reject(new Error('A navigation task transfer is already in progress'));
    }
    // 导航任务（nav 级）下发 = 退出手动模式：清空未完成的方向指令
    this.cancelDirectionTransfers('Navigation task dispatched; manual direction commands cleared');
    // Streaming JSONL: navigation_start → N waypoint lines → navigation_end.
    // The robot acknowledges the header and parses waypoints as they arrive,
    // so it never waits for the whole (dense) document before acting.
    const lines = createNavigationTaskStream(route);
    this.lastTaskId = lines[0].taskId;
    return this.enqueueStream(lines, { priority: false });
  }

  sendEmergencyStop() {
    if (this.activeOperation?.message.type === 'navigation_task') {
      this.activeOperation.cancelled = true;
    }
    for (const operation of this.operationQueue) {
      if (operation.message.type === 'navigation_task') operation.cancelled = true;
    }
    return this.enqueueMessage(createEmergencyStop({ taskId: this.lastTaskId }), {
      priority: true,
      prefixDelimiter: true,
    });
  }

  /**
   * 指令优先级仲裁（ble > nav）：手动方向指令（含 stop）到达时，
   * 取消未完成/排队中的导航任务传输。固件侧收到 direction 后同样应
   * 暂停导航（协议 priority 字段 'ble' 高于 'nav'）。
   */
  cancelNavigationTransfers(reason) {
    const error = abortError(reason);
    let preempted = false;
    if (this.activeOperation?.message.type === 'navigation_task') {
      this.activeOperation.cancelled = true;
      preempted = true;
    }
    const remaining = [];
    for (const operation of this.operationQueue) {
      if (operation.message.type === 'navigation_task') {
        operation.reject(error);
        this.emit({ type: 'transfer-error', message: operation.message, error });
        preempted = true;
      } else {
        remaining.push(operation);
      }
    }
    this.operationQueue = remaining;
    if (preempted) {
      this.trace('nav preempted by manual direction', reason);
      this.emit({ type: 'nav-preempted', reason });
    }
  }

  sendDirection(direction, options = {}) {
    if (!['forward', 'backward', 'left', 'right', 'stop'].includes(direction)) {
      return Promise.reject(new Error(`Unknown direction: ${direction}`));
    }
    // 手动指令（ble 级）优先级高于导航：任何 direction 抢占当前导航任务
    this.cancelNavigationTransfers(`Manual direction "${direction}" preempts navigation task`);
    if (direction === 'stop') {
      // Stop everything and clear every queued/unstarted direction command.
      this.cancelDirectionTransfers('Manual stop cleared pending direction commands');
    }
    return this.enqueueMessage(createDirectionCommand(direction, options), {
      priority: direction === 'stop',
    });
  }

  /**
   * Send the car to one WGS84 waypoint. Navigation-level priority: preempts a
   * streaming route transfer. Requires bridge/firmware support for
   * `goto_target` (the WiFi bridge implements it; the classic BLE bridge
   * rejects unknown types).
   */
  sendGotoTarget(longitude, latitude, options = {}) {
    this.cancelNavigationTransfers('goto_target preempts the streaming route transfer');
    return this.enqueueMessage(createGotoTarget(longitude, latitude, options));
  }

  cancelDirectionTransfers(reason) {
    const error = abortError(reason);
    if (this.activeOperation?.message.type === 'direction') {
      this.activeOperation.cancelled = true;
    }
    const remaining = [];
    for (const operation of this.operationQueue) {
      if (operation.message.type === 'direction') {
        operation.reject(error);
        this.emit({ type: 'transfer-error', message: operation.message, error });
      } else {
        remaining.push(operation);
      }
    }
    this.operationQueue = remaining;
  }

  enqueueMessage(message, { priority = false, prefixDelimiter = false } = {}) {
    if (this.state !== 'connected' || !this.commandCharacteristic) {
      const reason = 'Robot is not connected';
      this.traceError('enqueue rejected', message.type, reason, { state: this.state });
      return Promise.reject(new Error(reason));
    }
    const encoded = encodeRobotMessage(message);
    const bytes = prefixDelimiter
      ? new Uint8Array([0x0a, ...encoded])
      : encoded;
    const chunks = splitBleChunks(bytes, this.config.chunkBytes);
    this.trace('enqueue', message.type, { taskId: message.taskId ?? null, chunks: chunks.length, chunkBytes: this.config.chunkBytes, priority });
    return new Promise((resolve, reject) => {
      const operation = { message, chunks, resolve, reject, cancelled: false };
      if (priority) this.operationQueue.unshift(operation);
      else this.operationQueue.push(operation);
      void this.drainQueue();
    });
  }

  /**
   * Send a navigation route as a JSONL stream (one JSON object per line).
   * All lines share one taskId and are written sequentially as a single
   * operation, so an interleaved emergency_stop cancels the whole stream and
   * the LF-prefix resync still drops only the partial line in flight.
   */
  enqueueStream(lines, { priority = false } = {}) {
    if (this.state !== 'connected' || !this.commandCharacteristic) {
      const reason = 'Robot is not connected';
      this.traceError('enqueue rejected', 'navigation_task', reason, { state: this.state });
      return Promise.reject(new Error(reason));
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return Promise.reject(new Error('Navigation stream is empty'));
    }
    const taskId = lines[0].taskId ?? null;
    const chunks = [];
    for (const line of lines) {
      chunks.push(...splitBleChunks(encodeRobotMessage(line), this.config.chunkBytes));
    }
    const message = {
      type: 'navigation_task',
      taskId,
      streaming: true,
      lineCount: lines.length,
    };
    this.trace('enqueue navigation_task', { taskId, lines: lines.length, chunks: chunks.length });
    return new Promise((resolve, reject) => {
      const operation = { message, chunks, resolve, reject, cancelled: false };
      if (priority) this.operationQueue.unshift(operation);
      else this.operationQueue.push(operation);
      void this.drainQueue();
    });
  }

  async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.operationQueue.length) {
        const operation = this.operationQueue.shift();
        this.activeOperation = operation;
        this.trace('drain start', operation.message.type, {
          taskId: operation.message.taskId ?? null,
          chunks: operation.chunks.length,
        });
        try {
          for (const [index, chunk] of operation.chunks.entries()) {
            if (operation.cancelled) throw abortError('Transfer cancelled by emergency stop');
            try {
              await this.writeChunk(chunk, index, operation);
            } catch (writeError) {
              this.traceError(
                `write failed chunk ${index + 1}/${operation.chunks.length}`,
                operation.message.type,
                writeError?.name,
                writeError?.message,
                { taskId: operation.message.taskId ?? null },
              );
              throw writeError;
            }
            this.emit({
              type: 'transfer-progress',
              messageType: operation.message.type,
              taskId: operation.message.taskId ?? null,
              sentChunks: index + 1,
              totalChunks: operation.chunks.length,
            });
            if (index < operation.chunks.length - 1) {
              await this.sleep(this.config.interChunkDelayMs);
            }
          }
          this.trace('sent', operation.message.type, { taskId: operation.message.taskId ?? null });
          this.emit({ type: 'sent', message: operation.message });
          operation.resolve(operation.message);
        } catch (error) {
          this.traceError('operation failed', operation.message.type, error?.name, error?.message);
          operation.reject(error);
          this.emit({ type: 'transfer-error', message: operation.message, error });
        } finally {
          this.activeOperation = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async writeChunk(chunk, index = 0, operation = null) {
    const characteristic = this.commandCharacteristic;
    if (!characteristic) throw new Error('Command characteristic is unavailable');
    // Prefer Write Without Response: no per-packet ACK round trip, so a dense
    // route transfers several times faster. The LF-framed JSONL protocol plus
    // the emergency-stop LF resync tolerates a lost tail chunk; BLE link-layer
    // retransmission still covers RF noise.
    const preview = Array.from(chunk.slice(0, 12))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ');
    if (characteristic.properties?.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
      if (index === 0) this.trace('write -> writeValueWithoutResponse', chunk.byteLength, 'bytes', preview);
      await characteristic.writeValueWithoutResponse(chunk);
      return;
    }
    if (characteristic.properties?.write && characteristic.writeValueWithResponse) {
      if (index === 0) this.trace('write -> writeValueWithResponse', chunk.byteLength, 'bytes', preview);
      await characteristic.writeValueWithResponse(chunk);
      return;
    }
    if (characteristic.writeValue) {
      if (index === 0) this.trace('write -> legacy writeValue', chunk.byteLength, 'bytes', preview);
      await characteristic.writeValue(chunk);
      return;
    }
    throw new Error('Command characteristic is not writable');
  }

  cancelTransfers(reason) {
    const error = abortError(reason);
    if (this.activeOperation) this.activeOperation.cancelled = true;
    for (const operation of this.operationQueue.splice(0)) operation.reject(error);
  }
}
