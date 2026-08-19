import { describe, expect, it } from 'vitest';
import { findRoute } from './pathfinding.js';
import { DEFAULT_BLE_CONFIG, encodeRobotMessage } from './robotProtocol.js';
import { WebBluetoothRobotClient, webBluetoothSupport } from './webBluetoothRobot.js';

class FakeCharacteristic extends EventTarget {
  constructor(properties = {}) {
    super();
    this.properties = properties;
    this.writes = [];
    this.notificationsStarted = false;
    this.value = null;
  }

  async writeValueWithResponse(value) {
    this.writes.push(new Uint8Array(value));
  }

  async startNotifications() {
    this.notificationsStarted = true;
    return this;
  }

  notify(bytes) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function fakeBluetoothStack() {
  const command = new FakeCharacteristic({ write: true });
  const telemetry = new FakeCharacteristic({ notify: true });
  const service = {
    getCharacteristic: async (uuid) =>
      uuid === DEFAULT_BLE_CONFIG.commandCharacteristicUuid ? command : telemetry,
  };
  const server = { getPrimaryService: async () => service };
  const device = new EventTarget();
  device.name = 'LubanBot Test';
  device.gatt = {
    connected: false,
    connect: async () => {
      device.gatt.connected = true;
      return server;
    },
    disconnect: () => {
      device.gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  const bluetooth = {
    options: null,
    requestDevice: async (options) => {
      bluetooth.options = options;
      return device;
    },
  };
  return { bluetooth, command, telemetry, device, service };
}

describe('WebBluetoothRobotClient', () => {
  it('connects sequentially, sends the complete task, and receives a position notification', async () => {
    const fake = fakeBluetoothStack();
    const events = [];
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: async () => {},
    });
    client.subscribe((event) => events.push(event));

    await client.connect();
    expect(client.state).toBe('connected');
    expect(fake.telemetry.notificationsStarted).toBe(true);
    expect(fake.bluetooth.options).toMatchObject({ filters: [{ namePrefix: 'car7' }] });

    const route = findRoute('dorm-5', 'library', 'robot');
    const sent = await client.sendNavigationTask(route);
    const bytes = new Uint8Array(
      fake.command.writes.reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of fake.command.writes) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
      expect(chunk.byteLength).toBeLessThanOrEqual(20);
    }
    // The dispatch is a JSONL stream: one command per line.
    const lines = new TextDecoder()
      .decode(bytes)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      type: 'navigation_start',
      taskId: sent.taskId,
    });
    expect(lines[0].route.waypointCount).toBe(route.navigationWaypoints.length);
    const waypointLines = lines.filter((line) => line.type === 'waypoint');
    // The dispatched task carries the dense ≤ 2.5 m waypoint list, one per line.
    expect(waypointLines).toHaveLength(route.navigationWaypoints.length);
    expect(waypointLines.length).toBeGreaterThan(route.path.length);
    expect(lines.at(-1)).toEqual({
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: 'navigation_end',
      taskId: sent.taskId,
      waypointCount: route.navigationWaypoints.length,
    });

    fake.telemetry.notify(
      encodeRobotMessage({
        protocol: 'luban-nav-ble',
        protocolVersion: 1,
        type: 'position',
        longitude: 113.4815293,
        latitude: 22.888068,
        headingDegrees: 90,
      }),
    );
    expect(events.find((event) => event.type === 'position')?.position).toMatchObject({
      longitude: 113.4815293,
      latitude: 22.888068,
      headingDegrees: 90,
    });

    fake.command.writes.length = 0;
    await client.sendEmergencyStop();
    const stopBytes = new Uint8Array(
      fake.command.writes.reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    offset = 0;
    for (const chunk of fake.command.writes) {
      stopBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(stopBytes[0]).toBe(0x0a);
    expect(JSON.parse(new TextDecoder().decode(stopBytes).trim()).type).toBe('emergency_stop');
  });

  it('sends stepped direction commands and prioritizes direction stop', async () => {
    const fake = fakeBluetoothStack();
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: async () => {},
    });
    await client.connect();
    const decodeWrites = () => {
      const size = fake.command.writes.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of fake.command.writes) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes).trim());
    };

    await client.sendDirection('forward', { amountMeters: 0.1 });
    expect(decodeWrites()).toMatchObject({
      type: 'direction',
      direction: 'forward',
      amountMeters: 0.1,
      amountDegrees: null,
    });

    fake.command.writes.length = 0;
    await client.sendDirection('right');
    expect(decodeWrites()).toMatchObject({ direction: 'right', amountDegrees: 15 });

    fake.command.writes.length = 0;
    await client.sendDirection('stop');
    expect(decodeWrites()).toMatchObject({ type: 'direction', direction: 'stop' });
    await expect(client.sendDirection('diagonal')).rejects.toThrow(/Unknown direction/);
  });

  it('stop clears every queued direction command and halts the active one', async () => {
    const fake = fakeBluetoothStack();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: () => gate, // freeze the queue between chunks so commands pile up
    });
    await client.connect();

    const first = client.sendDirection('forward', { speedMetersPerSecond: 0.1 });
    const second = client.sendDirection('left');
    const third = client.sendDirection('right');
    const stop = client.sendDirection('stop');

    await expect(second).rejects.toThrow(/cleared pending direction/);
    await expect(third).rejects.toThrow(/cleared pending direction/);
    release();
    await expect(first).rejects.toThrow(); // active step cancelled
    await expect(stop).resolves.toMatchObject({ type: 'direction', direction: 'stop' });

    // Only the aborted forward step (partially written) plus the final stop
    // were written, and the stop line comes after the aborted fragments.
    const text = fake.command.writes
      .map((chunk) => new TextDecoder().decode(chunk))
      .join('');
    expect(text.startsWith('{"protocol":"luban')).toBe(true);
    const stopStart = text.indexOf('{"protocol"', 1);
    expect(stopStart).toBeGreaterThan(0);
    expect(JSON.parse(text.slice(stopStart).trim()).direction).toBe('stop');
  });

  it('prefers Write Without Response when the firmware advertises it', async () => {
    const fake = fakeBluetoothStack();
    // Override the command characteristic to advertise both write flavours.
    const dual = new FakeCharacteristic({ write: true, writeWithoutResponse: true });
    const withResponse = [];
    const withoutResponse = [];
    dual.writeValueWithResponse = async (value) => {
      withResponse.push(new Uint8Array(value));
    };
    dual.writeValueWithoutResponse = async (value) => {
      withoutResponse.push(new Uint8Array(value));
    };
    fake.service.getCharacteristic = async (uuid) =>
      uuid === DEFAULT_BLE_CONFIG.commandCharacteristicUuid ? dual : fake.telemetry;
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 185, interChunkDelayMs: 0 },
      sleep: async () => {},
    });
    await client.connect();

    await client.sendDirection('forward', { amountMeters: 0.1 });
    expect(withoutResponse.length).toBeGreaterThan(0);
    expect(withResponse.length).toBe(0);
    const decoded = JSON.parse(
      new TextDecoder().decode(
        withoutResponse.reduce(
          (total, chunk) => new Uint8Array([...total, ...chunk]),
          new Uint8Array(),
        ),
      ),
    );
    expect(decoded).toMatchObject({ type: 'direction', direction: 'forward' });
  });

  it('reports secure-context and API support separately', () => {
    expect(
      webBluetoothSupport({
        isSecureContext: true,
        navigator: { bluetooth: { requestDevice() {} } },
      }).supported,
    ).toBe(true);
    expect(webBluetoothSupport({ isSecureContext: false, navigator: {} })).toMatchObject({
      supported: false,
      secureContext: false,
    });
  });

  it('reports a missing service as a primary-service diagnostic instead of chooser cancellation', async () => {
    const fake = fakeBluetoothStack();
    const notFound = new Error('No Services matching UUID found in Device');
    notFound.name = 'NotFoundError';
    fake.device.gatt.connect = async () => {
      fake.device.gatt.connected = true;
      return {
        getPrimaryService: async () => {
          throw notFound;
        },
      };
    };
    const events = [];
    const client = new WebBluetoothRobotClient({ bluetooth: fake.bluetooth });
    client.subscribe((event) => events.push(event));

    await expect(client.connect()).rejects.toMatchObject({
      name: 'RobotConnectionError',
      stage: 'primary-service',
      causeName: 'NotFoundError',
      context: {
        deviceName: 'LubanBot Test',
        uuid: DEFAULT_BLE_CONFIG.serviceUuid,
      },
    });
    expect(client.state).toBe('error');
    expect(fake.device.gatt.connected).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      state: 'error',
      stage: 'primary-service',
      deviceName: 'LubanBot Test',
    });
  });

  it('keeps an actual device chooser cancellation in the idle state', async () => {
    const cancelled = new Error('User cancelled the requestDevice chooser');
    cancelled.name = 'NotFoundError';
    const client = new WebBluetoothRobotClient({
      bluetooth: { requestDevice: async () => { throw cancelled; } },
    });
    await expect(client.connect()).rejects.toBe(cancelled);
    expect(client.state).toBe('idle');
  });

  it('cancels a partial route and resynchronizes framing before the priority stop command', async () => {
    const fake = fakeBluetoothStack();
    let releaseFirstWrite;
    let markFirstWriteStarted;
    const firstWriteStarted = new Promise((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteBlocked = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });
    fake.command.writeValueWithResponse = async (value) => {
      fake.command.writes.push(new Uint8Array(value));
      if (fake.command.writes.length === 1) {
        markFirstWriteStarted();
        await firstWriteBlocked;
      }
    };
    const client = new WebBluetoothRobotClient({
      bluetooth: fake.bluetooth,
      config: { chunkBytes: 20, interChunkDelayMs: 0 },
      sleep: async () => {},
    });
    await client.connect();

    const taskPromise = client.sendNavigationTask(findRoute('dorm-5', 'library', 'robot'));
    const taskRejected = expect(taskPromise).rejects.toMatchObject({ name: 'AbortError' });
    await firstWriteStarted;
    const stopPromise = client.sendEmergencyStop();
    releaseFirstWrite();
    await taskRejected;
    await stopPromise;

    expect(fake.command.writes.length).toBeGreaterThan(1);
    expect(fake.command.writes.every((chunk) => chunk.byteLength <= 20)).toBe(true);
    expect(fake.command.writes[1][0]).toBe(0x0a);
    const stopBytes = new Uint8Array(
      fake.command.writes
        .slice(1)
        .reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of fake.command.writes.slice(1)) {
      stopBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(JSON.parse(new TextDecoder().decode(stopBytes).trim()).type).toBe('emergency_stop');
  });
});
