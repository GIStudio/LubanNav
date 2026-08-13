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
  return { bluetooth, command, telemetry, device };
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
    const decoded = JSON.parse(new TextDecoder().decode(bytes).trim());
    expect(decoded.taskId).toBe(sent.taskId);
    expect(decoded.route.waypoints).toHaveLength(route.path.length);

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
