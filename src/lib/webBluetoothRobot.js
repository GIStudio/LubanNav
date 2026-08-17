import {
  RobotMessageDecoder,
  bluetoothRequestOptions,
  createDirectionCommand,
  createEmergencyStop,
  createNavigationTask,
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
  constructor({ bluetooth = globalThis.navigator?.bluetooth, config = {}, sleep = wait } = {}) {
    this.bluetooth = bluetooth;
    this.config = normalizeBleConfig(config);
    this.sleep = sleep;
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
      const device = await this.bluetooth.requestDevice(bluetoothRequestOptions(this.config));
      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnected);
      stage = 'gatt-connect';
      this.setState('connecting');
      this.server = await device.gatt.connect();
      stage = 'primary-service';
      context = { uuid: this.config.serviceUuid };
      this.setState('discovering', { stage });
      const service = await this.server.getPrimaryService(this.config.serviceUuid);
      stage = 'command-characteristic';
      context = { uuid: this.config.commandCharacteristicUuid };
      this.setState('discovering', { stage });
      this.commandCharacteristic = await service.getCharacteristic(
        this.config.commandCharacteristicUuid,
      );
      stage = 'telemetry-characteristic';
      context = { uuid: this.config.telemetryCharacteristicUuid };
      this.setState('discovering', { stage });
      this.telemetryCharacteristic = await service.getCharacteristic(
        this.config.telemetryCharacteristicUuid,
      );
      this.telemetryCharacteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleTelemetry,
      );
      stage = 'notifications';
      context = { uuid: this.config.telemetryCharacteristicUuid };
      this.setState('discovering', { stage });
      await this.telemetryCharacteristic.startNotifications();
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
        this.emit({ type: 'message', message });
        if (message.type === 'position') this.emit({ type: 'position', position: message });
      }
    } catch (error) {
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
    const task = createNavigationTask(route);
    this.lastTaskId = task.taskId;
    return this.enqueueMessage(task, { priority: false });
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

  sendDirection(direction, options = {}) {
    if (!['forward', 'backward', 'left', 'right', 'stop'].includes(direction)) {
      return Promise.reject(new Error(`Unknown direction: ${direction}`));
    }
    return this.enqueueMessage(createDirectionCommand(direction, options), {
      priority: direction === 'stop',
    });
  }

  enqueueMessage(message, { priority = false, prefixDelimiter = false } = {}) {
    if (this.state !== 'connected' || !this.commandCharacteristic) {
      return Promise.reject(new Error('Robot is not connected'));
    }
    const encoded = encodeRobotMessage(message);
    const bytes = prefixDelimiter
      ? new Uint8Array([0x0a, ...encoded])
      : encoded;
    const chunks = splitBleChunks(bytes, this.config.chunkBytes);
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
        try {
          for (const [index, chunk] of operation.chunks.entries()) {
            if (operation.cancelled) throw abortError('Transfer cancelled by emergency stop');
            await this.writeChunk(chunk);
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
          this.emit({ type: 'sent', message: operation.message });
          operation.resolve(operation.message);
        } catch (error) {
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

  async writeChunk(chunk) {
    const characteristic = this.commandCharacteristic;
    if (!characteristic) throw new Error('Command characteristic is unavailable');
    if (characteristic.properties?.write && characteristic.writeValueWithResponse) {
      await characteristic.writeValueWithResponse(chunk);
      return;
    }
    if (characteristic.properties?.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
      return;
    }
    if (characteristic.writeValue) {
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
