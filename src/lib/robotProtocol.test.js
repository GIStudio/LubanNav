import { describe, expect, it } from 'vitest';
import { findRoute } from './pathfinding.js';
import {
  DEFAULT_BLE_CONFIG,
  RobotMessageDecoder,
  bluetoothRequestOptions,
  createNavigationTask,
  encodeRobotMessage,
  getRobotProtocolDescriptor,
  splitBleChunks,
} from './robotProtocol.js';

describe('robot BLE protocol', () => {
  it('creates a robot-only navigation task containing every ordered route coordinate', () => {
    const route = findRoute('dorm-5', 'library', 'robot');
    const task = createNavigationTask(route, {
      taskId: 'task-test',
      createdAt: '2026-08-13T08:00:00.000Z',
    });
    expect(task).toMatchObject({
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: 'navigation_task',
      taskId: 'task-test',
      route: {
        from: 'dorm-5',
        to: 'library',
        mode: 'robot',
        coordinateSystem: 'WGS84 longitude/latitude',
      },
    });
    expect(task.route.waypoints).toHaveLength(route.path.length);
    expect(task.route.waypoints[0]).toMatchObject({
      sequence: 0,
      nodeId: route.path[0].id,
      longitude: route.path[0].longitude,
      latitude: route.path[0].latitude,
    });
    expect(task.route.waypoints.at(-1).nodeId).toBe('library');
    expect(() => createNavigationTask(findRoute('dorm-5', 'library', 'pedestrian'))).toThrow(
      'robot-mode',
    );
  });

  it('splits UTF-8 JSON Lines into legacy-safe BLE packets without losing bytes', () => {
    const message = {
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: 'status',
      status: '正在导航到图书馆',
    };
    const encoded = encodeRobotMessage(message);
    const chunks = splitBleChunks(encoded, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 20)).toBe(true);
    const rebuilt = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      rebuilt.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(rebuilt)).toBe(`${JSON.stringify(message)}\n`);
  });

  it('decodes partial and multiple telemetry messages and validates WGS84 positions', () => {
    const decoder = new RobotMessageDecoder();
    const data = encodeRobotMessage({
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: 'position',
      lon: 113.4776815,
      lat: 22.8883663,
      headingDegrees: 35,
    });
    expect(decoder.push(data.slice(0, 11))).toEqual([]);
    const messages = decoder.push(
      new Uint8Array([
        ...data.slice(11),
        ...encodeRobotMessage({
          protocol: 'luban-nav-ble',
          protocolVersion: 1,
          type: 'ack',
          taskId: 'task-test',
          status: 'accepted',
        }),
      ]),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'position',
      longitude: 113.4776815,
      latitude: 22.8883663,
      headingDegrees: 35,
    });
    expect(messages[1]).toMatchObject({ type: 'ack', status: 'accepted' });
  });

  it('provides open device selection by default and a firmware-readable descriptor', () => {
    expect(bluetoothRequestOptions(DEFAULT_BLE_CONFIG)).toEqual({
      acceptAllDevices: true,
      optionalServices: [DEFAULT_BLE_CONFIG.serviceUuid],
    });
    const filtered = bluetoothRequestOptions({ deviceNamePrefix: 'LubanBot' });
    expect(filtered.filters).toEqual([{ namePrefix: 'LubanBot' }]);
    const descriptor = getRobotProtocolDescriptor();
    expect(descriptor.transport.defaultGatt.chunkBytes).toBe(20);
    expect(descriptor.browserToRobot.navigationTask.type).toBe('navigation_task');
    expect(descriptor.robotToBrowser.position.example.type).toBe('position');
  });
});
