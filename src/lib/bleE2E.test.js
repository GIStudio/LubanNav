/**
 * 端到端协议一致性测试（无 UI、无真机）：
 * 直接用前端的库（robotProtocol.js + WebBluetoothRobotClient）对接一个
 * 按 car7 固件规则（campusCar/src/ble_bridge/car7_protocol.py）实现的
 * Mock 后端，验证整条链路：
 *
 *   浏览器库 → 分包写入 → GATT → Mock 固件解包/校验/执行 → 遥测回传
 *
 * Mock 固件对每条消息做与真机相同的校验（类型、必填字段、waypointCount
 * 一致性、方向名、急停 commandId），并维护"后端联动日志"（backend log）
 * 与指令优先级仲裁（rc > ble > nav；direction 抢占导航、急停清除任务）。
 */

import { describe, expect, it } from 'vitest';
import { findRoute } from './pathfinding.js';
import {
  createDirectionCommand,
  createEmergencyStop,
  createNavigationTaskStream,
  encodeRobotMessage,
  normalizeRobotMessage,
  splitBleChunks,
} from './robotProtocol.js';
import { WebBluetoothRobotClient } from './webBluetoothRobot.js';

const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const COMMAND_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const TELEMETRY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ---------------------------------------------------------------------------
// Mock BLE 外设（等价于 fakeBluetoothStack + 固件状态机）
// ---------------------------------------------------------------------------

class MockFirmware {
  constructor({ onWrite } = {}) {
    this.log = [];
    this.task = null; // { taskId, waypointCount, receivedWaypoints }
    this.emergencyHalted = false;
    this.onWrite = onWrite;
    this.telemetryListeners = [];
  }

  /** 后端联动日志 */
  logEvent(event, detail = {}) {
    const entry = { at: new Date().toISOString(), event, ...detail };
    this.log.push(entry);
  }

  /** 固件入口：收到一个 GATT 写包 */
  receiveChunk(chunk) {
    if (this.onWrite) this.onWrite(chunk);
    this.logEvent('ble.write', { bytes: chunk.byteLength });
    const text = new TextDecoder().decode(chunk);
    // 与真机一致：按 LF 拼接/分割 JSONL（模拟跨包半行）
    this.buffer = (this.buffer ?? '') + text;
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (line) this.handleLine(line);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logEvent('firmware.error', { error: 'invalid-json', line: line.slice(0, 80) });
      return;
    }
    try {
      // 与真机 car7_protocol.py 相同的协议校验入口
      normalizeRobotMessage(message);
      this.dispatch(message);
    } catch (error) {
      this.logEvent('firmware.reject', { type: message.type, error: String(error) });
    }
  }

  dispatch(message) {
    this.logEvent('firmware.accept', { type: message.type, priority: message.priority ?? null });
    switch (message.type) {
      case 'navigation_start': {
        const count = message.route.waypointCount;
        if (!Number.isInteger(count) || count < 1) {
          throw new Error('invalidWaypointCount');
        }
        this.task = { taskId: message.taskId, waypointCount: count, receivedWaypoints: 0 };
        this.ack(message.taskId, `start:${count}`);
        break;
      }
      case 'waypoint': {
        if (!this.task || this.task.taskId !== message.taskId) {
          throw new Error('waypoint before navigation_start');
        }
        this.task.receivedWaypoints += 1;
        break;
      }
      case 'navigation_end': {
        if (!this.task || this.task.taskId !== message.taskId) {
          throw new Error('navigation_end without task');
        }
        if (this.task.receivedWaypoints !== message.waypointCount) {
          throw new Error(
            `waypointCount mismatch: received ${this.task.receivedWaypoints}, expected ${message.waypointCount}`,
          );
        }
        this.logEvent('navigation.task-complete', { taskId: message.taskId });
        this.task = null;
        this.ack(message.taskId, 'complete');
        break;
      }
      case 'navigation_task': {
        const waypoints = message.route.waypoints ?? [];
        if (!Array.isArray(waypoints) || waypoints.length < 1) {
          throw new Error('navigation_task requires route.waypoints');
        }
        this.logEvent('navigation.task-single-shot', { taskId: message.taskId, count: waypoints.length });
        this.ack(message.taskId, 'complete');
        break;
      }
      case 'direction': {
        // 优先级仲裁（ble > nav）：手动指令抢占导航任务
        if (this.task && message.direction !== 'stop') {
          this.logEvent('priority.preempt', { taskId: this.task.taskId, by: 'direction' });
          this.task = null;
        }
        if (message.direction === 'stop') this.emergencyHalted = false;
        this.ack(null, `direction:${message.direction}`);
        break;
      }
      case 'emergency_stop': {
        this.logEvent('safety.emergency-stop', { taskId: message.taskId ?? null });
        this.task = null;
        this.emergencyHalted = true;
        this.ack(message.taskId, 'stopped');
        break;
      }
      default:
        throw new Error(`unknown type ${message.type}`);
    }
  }

  ack(taskId, status) {
    this.notify({ type: 'ack', taskId: taskId ?? null, status });
  }

  /** 遥测回传：position 等 */
  notify(payload) {
    const message = { protocol: 'luban-nav-ble', protocolVersion: 1, ...payload };
    const encoded = encodeRobotMessage(message);
    for (const chunk of splitBleChunks(encoded, 20)) {
      this.telemetryListeners.forEach((listener) =>
        listener({ target: { value: chunk } }),
      );
    }
  }
}

function fakeBluetoothStack(firmware) {
  const command = {
    uuid: COMMAND_UUID,
    properties: { write: true, writeWithoutResponse: false },
    writes: [],
    async writeValueWithResponse(value) {
      const bytes = new Uint8Array(value);
      command.writes.push(bytes);
      firmware.receiveChunk(bytes);
    },
  };
  const telemetry = {
    uuid: TELEMETRY_UUID,
    properties: { notify: true },
    listeners: new Set(),
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') this.listeners.add(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.delete(fn);
    },
    async startNotifications() {
      this.notifying = true;
    },
    // 直接转发固件通知到已注册的 characteristicvaluechanged 监听器
    notify(payload) {
      firmware.notify(payload);
    },
  };
  // 固件 → 特征监听器的固定转发通道（客户端 connect 时注册监听器）
  firmware.telemetryListeners.push((event) =>
    [...telemetry.listeners].forEach((fn) => fn(event)),
  );
  const service = {
    uuid: SERVICE_UUID,
    async getCharacteristic(uuid) {
      if (uuid === COMMAND_UUID) return command;
      if (uuid === TELEMETRY_UUID) return telemetry;
      throw new Error(`unknown characteristic ${uuid}`);
    },
  };
  const server = { async getPrimaryService() { return service; } };
  const device = {
    name: 'car7-e2e',
    gatt: { connected: true, connect: async () => server, disconnect() { this.connected = false; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const bluetooth = {
    async requestDevice() { return device; },
  };
  return { bluetooth, command, telemetry, device };
}

function decodeAllWrites(writes) {
  const bytes = new Uint8Array(writes.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of writes) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

describe('BLE 端到端：前端库 ↔ Mock 固件（car7_protocol 规则）', () => {
  it('完整路线下发：导航流被逐行接收校验、ack 与遥测回传', async () => {
    const firmware = new MockFirmware();
    const fake = fakeBluetoothStack(firmware);
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: async () => {},
      debug: false,
    });
    const received = [];
    client.subscribe((event) => {
      if (event.type === 'message') received.push(event.message);
    });

    await client.connect();

    const route = findRoute('dorm-5', 'library', 'robot');
    await client.sendNavigationTask(route);

    // 固件收到完整流并校验 waypointCount 一致
    const complete = firmware.log.find((entry) => entry.event === 'navigation.task-complete');
    expect(complete).toBeTruthy();
    expect(complete.taskId).toBeTruthy();

    // 固件收到的每行都是合法协议消息（normalizeRobotMessage 校验通过）
    const allLines = decodeAllWrites(fake.command.writes)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(allLines.length).toBeGreaterThan(100);
    for (const line of allLines) {
      const message = JSON.parse(line);
      expect(() => normalizeRobotMessage(message)).not.toThrow();
      expect(message.priority).toBe('nav');
    }

    // ack 回传
    const rejects = firmware.log.filter((e) => e.event === 'firmware.reject');
    if (!received.some((m) => m.type === 'ack' && m.status === 'complete')) {
      console.log('RECEIVED:', received.map((m) => m.type).slice(0, 10));
      console.log('FIRMWARE LOG:', firmware.log.slice(0, 12));
      console.log('REJECTS:', rejects);
    }
    expect(received.some((m) => m.type === 'ack' && m.status === 'complete')).toBe(true);

    // 遥测位置回传
    fake.telemetry.notify({
      type: 'position',
      taskId: 'e2e-task',
      longitude: 113.4815293,
      latitude: 22.888068,
      headingDegrees: 90,
    });
    expect(received.some((m) => m.type === 'position')).toBe(true);
  });

  it('指令优先级：direction 抢占进行中的导航，急停清除任务（ble > nav, safety 跨层）', async () => {
    const firmware = new MockFirmware();
    const fake = fakeBluetoothStack(firmware);
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: async () => {},
      debug: false,
    });
    await client.connect();

    // 固件侧先启动一个导航任务
    const route = findRoute('dorm-5', 'library', 'robot');
    const stream = createNavigationTaskStream(route);
    for (const line of stream) {
      firmware.receiveChunk(encodeRobotMessage(line));
    }
    expect(firmware.log.some((e) => e.event === 'navigation.task-complete')).toBe(true);

    // 手动指令抢占（固件侧仲裁）
    firmware.receiveChunk(encodeRobotMessage(createDirectionCommand('forward')));
    expect(firmware.log.some((e) => e.event === 'priority.preempt')).toBe(false); // 任务已完成,无抢占
    expect(firmware.log.at(-1).event).toBe('firmware.accept');

    // 传输中途方向指令抢占（浏览器侧）
    const navPromise = client.sendNavigationTask(route);
    const preempted = new Promise((resolve) => {
      client.subscribe((event) => {
        if (event.type === 'nav-preempted') resolve(true);
      });
    });
    await client.sendDirection('left');
    await preempted;
    await expect(navPromise).rejects.toMatchObject({ name: 'AbortError' });

    // 急停跨层清除（浏览器侧 + 固件侧）
    await client.sendEmergencyStop();
    expect(firmware.emergencyHalted).toBe(true);
    expect(firmware.log.some((e) => e.event === 'safety.emergency-stop')).toBe(true);
  });
});
