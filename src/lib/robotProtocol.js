export const ROBOT_PROTOCOL_NAME = 'luban-nav-ble';
export const ROBOT_PROTOCOL_VERSION = 1;

// Nordic UART Service-compatible defaults. They are editable in the UI because
// the robot firmware remains the source of truth for its GATT UUIDs.
export const DEFAULT_BLE_CONFIG = Object.freeze({
  deviceNamePrefix: 'car7',
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  commandCharacteristicUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  telemetryCharacteristicUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  chunkBytes: 20,
  interChunkDelayMs: 12,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number`);
  return number;
}

function roundedCoordinate(value) {
  return Number(Number(value).toFixed(7));
}

export function normalizeBleConfig(input = {}) {
  const config = { ...DEFAULT_BLE_CONFIG, ...input };
  const uuidFields = [
    'serviceUuid',
    'commandCharacteristicUuid',
    'telemetryCharacteristicUuid',
  ];
  for (const field of uuidFields) {
    config[field] = String(config[field]).trim().toLowerCase();
    if (!UUID_PATTERN.test(config[field])) throw new Error(`${field} is not a full Bluetooth UUID`);
  }
  config.deviceNamePrefix = String(config.deviceNamePrefix ?? '').trim();
  config.chunkBytes = Math.round(finiteNumber(config.chunkBytes, 'chunkBytes'));
  config.interChunkDelayMs = Math.round(
    finiteNumber(config.interChunkDelayMs, 'interChunkDelayMs'),
  );
  if (config.chunkBytes < 1 || config.chunkBytes > 512) {
    throw new Error('chunkBytes must be between 1 and 512');
  }
  if (config.interChunkDelayMs < 0 || config.interChunkDelayMs > 1_000) {
    throw new Error('interChunkDelayMs must be between 0 and 1000');
  }
  return config;
}

export function bluetoothRequestOptions(configInput = {}) {
  const config = normalizeBleConfig(configInput);
  if (config.deviceNamePrefix) {
    return {
      filters: [{ namePrefix: config.deviceNamePrefix }],
      optionalServices: [config.serviceUuid],
    };
  }
  return {
    acceptAllDevices: true,
    optionalServices: [config.serviceUuid],
  };
}

export function encodeRobotMessage(message) {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

export function splitBleChunks(bytesInput, chunkBytes = DEFAULT_BLE_CONFIG.chunkBytes) {
  const bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
  const size = Math.round(finiteNumber(chunkBytes, 'chunkBytes'));
  if (size < 1 || size > 512) throw new Error('chunkBytes must be between 1 and 512');
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

export function createTaskId(now = Date.now(), random = Math.random()) {
  return `task-${now.toString(36)}-${Math.floor(random * 0xffffff)
    .toString(36)
    .padStart(5, '0')}`;
}

export function createNavigationTask(route, options = {}) {
  if (route?.status !== 'ok') throw new Error('Only a successful route can be sent to a robot');
  if (route.request?.mode !== 'robot') throw new Error('Robot tasks require a robot-mode route');
  const createdAt = options.createdAt ?? new Date().toISOString();
  const taskId = options.taskId ?? createTaskId();
  // Prefer the dense 2–3 m waypoint list; fall back to the sparse graph path
  // for older route payloads.
  const waypoints = route.navigationWaypoints ?? route.path ?? [];
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: 'navigation_task',
    taskId,
    createdAt,
    dataset: route.dataset,
    route: {
      from: route.request.from,
      to: route.request.to,
      mode: route.request.mode,
      coordinateSystem: 'WGS84 longitude/latitude',
      distanceMeters: route.summary.distanceMeters,
      durationSeconds: route.summary.durationSeconds,
      waypointSpacingMeters: route.summary.maxNavigationSpacingMeters ?? null,
      waypoints: waypoints.map((point, sequence) => ({
        sequence,
        nodeId: point.id ?? point.nodeId ?? null,
        longitude: roundedCoordinate(point.longitude),
        latitude: roundedCoordinate(point.latitude),
        kind: point.kind,
        indoor: point.indoor === true,
        level: point.level ?? null,
        interpolated: point.interpolated === true,
      })),
    },
  };
}

export function createEmergencyStop(options = {}) {
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: 'emergency_stop',
    commandId: options.commandId ?? `stop-${Date.now().toString(36)}`,
    taskId: options.taskId ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason ?? 'operator_request',
  };
}

export function normalizeRobotMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Robot message must be a JSON object');
  }
  if (message.protocol !== ROBOT_PROTOCOL_NAME) {
    throw new Error(`Unsupported robot protocol: ${message.protocol ?? 'missing'}`);
  }
  if (message.protocolVersion !== ROBOT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported robot protocol version: ${message.protocolVersion ?? 'missing'}`);
  }
  if (typeof message.type !== 'string' || !message.type) {
    throw new Error('Robot message type is required');
  }
  if (message.type === 'position') {
    const longitude = finiteNumber(message.longitude ?? message.lon, 'longitude');
    const latitude = finiteNumber(message.latitude ?? message.lat, 'latitude');
    if (longitude < -180 || longitude > 180) throw new Error('longitude is outside WGS84 bounds');
    if (latitude < -90 || latitude > 90) throw new Error('latitude is outside WGS84 bounds');
    return {
      ...message,
      longitude,
      latitude,
      headingDegrees:
        message.headingDegrees == null
          ? null
          : finiteNumber(message.headingDegrees, 'headingDegrees'),
      accuracyMeters:
        message.accuracyMeters == null
          ? null
          : finiteNumber(message.accuracyMeters, 'accuracyMeters'),
      receivedAt: new Date().toISOString(),
    };
  }
  return message;
}

function bytesFromNotification(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Unsupported Bluetooth notification value');
}

export class RobotMessageDecoder {
  constructor({ maximumBufferBytes = 65_536 } = {}) {
    this.maximumBufferBytes = maximumBufferBytes;
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  push(value) {
    this.buffer += this.decoder.decode(bytesFromNotification(value), { stream: true });
    if (new TextEncoder().encode(this.buffer).byteLength > this.maximumBufferBytes) {
      this.reset();
      throw new Error('Robot notification buffer exceeded its safety limit');
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeRobotMessage(JSON.parse(line)));
  }

  reset() {
    this.decoder = new TextDecoder();
    this.buffer = '';
  }
}

export function getRobotProtocolDescriptor() {
  return {
    schemaVersion: '1.0',
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    transport: {
      role: 'Browser is BLE Central; robot is GATT Peripheral/Server.',
      encoding: 'UTF-8 JSON Lines. Concatenate characteristic writes and split on LF (0x0A).',
      defaultGatt: DEFAULT_BLE_CONFIG,
      writeOrdering: 'Sequential; never process GATT writes in parallel.',
    },
    diagnostics: {
      stages: [
        'device-selection',
        'gatt-connect',
        'primary-service',
        'command-characteristic',
        'telemetry-characteristic',
        'notifications',
      ],
      note:
        'A visible device name does not prove that the configured GATT service and characteristics exist.',
    },
    browserToRobot: {
      navigationTask: {
        type: 'navigation_task',
        required: ['protocol', 'protocolVersion', 'type', 'taskId', 'route'],
        waypointOrder:
          'route.waypoints is ordered, WGS84 longitude/latitude, and dense: consecutive waypoints are at most 2.5 m apart (route.waypointSpacingMeters). interpolated=true marks points inserted by linear interpolation between graph nodes; nodeId is null for them.',
      },
      emergencyStop: {
        type: 'emergency_stop',
        behavior:
          'The browser prefixes LF to resynchronize after a cancelled partial transfer. Ignore an invalid partial line, then stop motion immediately, clear the active task, and notify an ack/status message.',
      },
    },
    robotToBrowser: {
      position: {
        example: {
          protocol: ROBOT_PROTOCOL_NAME,
          protocolVersion: ROBOT_PROTOCOL_VERSION,
          type: 'position',
          taskId: 'task-example',
          longitude: 113.4776815,
          latitude: 22.8883663,
          headingDegrees: 35,
          accuracyMeters: 1.5,
          timestamp: '2026-08-13T08:00:00.000Z',
        },
      },
      acknowledgement: {
        example: {
          protocol: ROBOT_PROTOCOL_NAME,
          protocolVersion: ROBOT_PROTOCOL_VERSION,
          type: 'ack',
          taskId: 'task-example',
          status: 'accepted',
        },
      },
    },
    safety:
      'This transport does not replace localization, obstacle avoidance, access control, braking, watchdogs, or a physical emergency stop.',
  };
}
