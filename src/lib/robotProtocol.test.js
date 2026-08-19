import { describe, expect, it } from 'vitest';
import { findRoute } from './pathfinding.js';
import {
  DEFAULT_BLE_CONFIG,
  NAVIGATION_END_TYPE,
  NAVIGATION_START_TYPE,
  ROS_MAX_LINEAR_SPEED_MPS,
  RobotMessageDecoder,
  WAYPOINT_TYPE,
  bluetoothRequestOptions,
  createDirectionCommand,
  createNavigationTask,
  createNavigationTaskStream,
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
    expect(task.route.waypoints).toHaveLength(route.navigationWaypoints.length);
    expect(task.route.waypoints.length).toBeGreaterThanOrEqual(route.path.length);
    expect(task.route.waypointSpacingMeters).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(task.route.waypoints[0]).toMatchObject({
      sequence: 0,
      nodeId: route.path[0].id,
      longitude: route.path[0].longitude,
      latitude: route.path[0].latitude,
      interpolated: false,
    });
    expect(task.route.waypoints.at(-1).nodeId).toBe('library');
    expect(task.route.waypoints.some((waypoint) => waypoint.interpolated === true)).toBe(true);
    expect(() => createNavigationTask(findRoute('dorm-5', 'library', 'pedestrian'))).toThrow(
      'robot-mode',
    );
  });

  it('builds a streaming JSONL route: navigation_start → waypoint lines → navigation_end', () => {
    const route = findRoute('dorm-5', 'library', 'robot');
    const lines = createNavigationTaskStream(route, {
      taskId: 'task-stream',
      createdAt: '2026-08-13T08:00:00.000Z',
    });

    expect(lines[0]).toMatchObject({
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: NAVIGATION_START_TYPE,
      taskId: 'task-stream',
      createdAt: '2026-08-13T08:00:00.000Z',
      route: {
        from: 'dorm-5',
        to: 'library',
        mode: 'robot',
        coordinateSystem: 'WGS84 longitude/latitude',
        waypointCount: route.navigationWaypoints.length,
        waypointSpacingMeters: route.summary.maxNavigationSpacingMeters,
      },
    });

    const waypointLines = lines.filter((line) => line.type === WAYPOINT_TYPE);
    expect(waypointLines).toHaveLength(route.navigationWaypoints.length);
    expect(waypointLines[0]).toMatchObject({
      type: WAYPOINT_TYPE,
      taskId: 'task-stream',
      sequence: 0,
      nodeId: route.path[0].id,
      longitude: route.path[0].longitude,
      latitude: route.path[0].latitude,
      interpolated: false,
    });
    expect(waypointLines.some((line) => line.interpolated === true)).toBe(true);
    for (const line of waypointLines) {
      expect(line.longitude).toBeGreaterThanOrEqual(-180);
      expect(line.longitude).toBeLessThanOrEqual(180);
      expect(line.latitude).toBeGreaterThanOrEqual(-90);
      expect(line.latitude).toBeLessThanOrEqual(90);
      // Every line is a small, independently parseable command (one line =
      // one command), so the robot never buffers the whole document.
      expect(new TextEncoder().encode(JSON.stringify(line)).byteLength).toBeLessThan(300);
    }

    expect(lines.at(-1)).toEqual({
      protocol: 'luban-nav-ble',
      protocolVersion: 1,
      type: NAVIGATION_END_TYPE,
      taskId: 'task-stream',
      waypointCount: route.navigationWaypoints.length,
    });
    expect(lines.every((line) => line.taskId === 'task-stream')).toBe(true);
    expect(() => createNavigationTaskStream(findRoute('dorm-5', 'library', 'pedestrian'))).toThrow(
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

  it('filters for car7 by default and provides a firmware-readable descriptor', () => {
    expect(bluetoothRequestOptions(DEFAULT_BLE_CONFIG)).toEqual({
      filters: [{ namePrefix: 'car7' }],
      optionalServices: [DEFAULT_BLE_CONFIG.serviceUuid],
    });
    const filtered = bluetoothRequestOptions({ deviceNamePrefix: 'LubanBot' });
    expect(filtered.filters).toEqual([{ namePrefix: 'LubanBot' }]);
    const descriptor = getRobotProtocolDescriptor();
    expect(descriptor.transport.defaultGatt.chunkBytes).toBe(185);
    expect(descriptor.transport.defaultGatt.interChunkDelayMs).toBe(5);
    expect(descriptor.transport.defaultGatt.deviceNamePrefix).toBe('car7');
    expect(descriptor.diagnostics.stages).toContain('primary-service');
    expect(descriptor.browserToRobot.navigationTask.type).toBe('navigation_task');
    expect(descriptor.browserToRobot.navigationStream.types).toEqual([
      NAVIGATION_START_TYPE,
      WAYPOINT_TYPE,
      NAVIGATION_END_TYPE,
    ]);
    expect(descriptor.robotToBrowser.position.example.type).toBe('position');
  });

  it('builds stepped direction commands and rejects unknown directions', () => {
    const forward = createDirectionCommand('forward');
    expect(forward).toMatchObject({
      type: 'direction',
      direction: 'forward',
      amountMeters: 0.15,
      amountDegrees: null,
      speedMetersPerSecond: null,
    });
    // Default speed is half of the ROS max (2.0 m/s out of 4.0).
    expect(DEFAULT_BLE_CONFIG.directionSpeedMetersPerSecond).toBe(2.0);
    expect(ROS_MAX_LINEAR_SPEED_MPS).toBe(4.0);
    const defaultSpeed = createDirectionCommand('forward', { speedMetersPerSecond: DEFAULT_BLE_CONFIG.directionSpeedMetersPerSecond });
    expect(defaultSpeed.speedMetersPerSecond).toBe(2.0);
    const fast = createDirectionCommand('forward', { speedMetersPerSecond: 0.2 });
    expect(fast.speedMetersPerSecond).toBe(0.2);
    const clamped = createDirectionCommand('backward', { speedMetersPerSecond: 9 });
    expect(clamped.speedMetersPerSecond).toBe(4.0);
    const turn = createDirectionCommand('right', { amountDegrees: 20 });
    expect(turn).toMatchObject({ direction: 'right', amountDegrees: 20, amountMeters: null });
    const stop = createDirectionCommand('stop');
    expect(stop).toMatchObject({
      direction: 'stop',
      amountMeters: null,
      amountDegrees: null,
      speedMetersPerSecond: null,
    });
    expect(() => createDirectionCommand('diagonal')).toThrow(/Unknown direction/);
  });
});
