export const ROBOT_PROTOCOL_NAME = 'luban-nav-ble';
export const ROBOT_PROTOCOL_VERSION = 1;

// Streaming JSONL route delivery: one JSON object per line. `navigation_start`
// carries the task header so the robot can acknowledge immediately; every
// `waypoint` line is parsed as it arrives (动态解包, no waiting for the whole
// file); `navigation_end` closes the task. `navigation_task` (one document
// with all waypoints) stays supported as the legacy single-shot form.
export const NAVIGATION_START_TYPE = 'navigation_start';
export const WAYPOINT_TYPE = 'waypoint';
export const NAVIGATION_END_TYPE = 'navigation_end';

/**
 * 指令优先级（三级模型，固件按此仲裁）：
 *   rc（遥控器，物理通道，最高）> ble（BLE 手动指令）> nav（自主导航任务）
 * 跨层：safety（急停/停止）在任何时刻优先于一切。
 * 所有 BLE 下行指令携带 `priority` 字段；遥控器不在 BLE 通道内，
 * 固件应通过硬件信号检测遥控器接管并忽略 BLE 运动指令与导航。
 */
export const COMMAND_PRIORITY = Object.freeze({
  remoteControl: 'rc',
  manual: 'ble',
  navigation: 'nav',
  safety: 'safety',
});

// Nordic UART Service-compatible defaults. They are editable in the UI because
// the robot firmware remains the source of truth for its GATT UUIDs.
//
// Transport defaults are tuned for real BLE MTUs (Android + BlueZ negotiate
// ≥ 185-byte ATT payloads): 185-byte writes with no meaningful gap transfer a
// ~90 KB dense route in seconds instead of a minute. The chunk size is still
// capped at 512 and stays editable for legacy stacks with a 23-byte MTU.
export const DEFAULT_BLE_CONFIG = Object.freeze({
  deviceNamePrefix: 'car7',
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  commandCharacteristicUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  telemetryCharacteristicUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  chunkBytes: 185,
  interChunkDelayMs: 5,
  directionStepMeters: 0.75,
  directionStepDegrees: 75,
  directionSpeedMetersPerSecond: 2.0,
});

/**
 * ROS-side linear speed envelope, derived from the campusCar chassis data
 * (car_web_gui.py MAX_LINEAR_SPEED / hoverboard profile), not an arbitrary
 * cap. The web joystick default is HALF of the ROS max; the ceiling IS the
 * ROS max. The chassis has since been tuned higher, and the operator chose a
 * 2.0 m/s default, so the envelope is 4.0 m/s max. Adjust these two numbers
 * together whenever ROS publishes its real max_velocity.
 */
export const ROS_MAX_LINEAR_SPEED_MPS = 4.0;
export const DEFAULT_DIRECTION_SPEED_MPS = ROS_MAX_LINEAR_SPEED_MPS / 2; // 2.0
export const MIN_DIRECTION_SPEED_MPS = 0.02;

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
  config.directionStepMeters = Math.min(
    1,
    Math.max(0.05, finiteNumber(config.directionStepMeters ?? 0.75, 'directionStepMeters')),
  );
  config.directionStepDegrees = Math.min(
    90,
    Math.max(5, finiteNumber(config.directionStepDegrees ?? 75, 'directionStepDegrees')),
  );
  config.directionSpeedMetersPerSecond = Math.min(
    ROS_MAX_LINEAR_SPEED_MPS,
    Math.max(
      MIN_DIRECTION_SPEED_MPS,
      finiteNumber(
        config.directionSpeedMetersPerSecond ?? DEFAULT_DIRECTION_SPEED_MPS,
        'directionSpeedMetersPerSecond',
      ),
    ),
  );
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

function routeWaypoints(route) {
  // Prefer the dense 2–3 m waypoint list; fall back to the sparse graph path
  // for older route payloads.
  return route.navigationWaypoints ?? route.path ?? [];
}

function waypointObject(point, sequence) {
  return {
    sequence,
    nodeId: point.id ?? point.nodeId ?? null,
    longitude: roundedCoordinate(point.longitude),
    latitude: roundedCoordinate(point.latitude),
    kind: point.kind ?? 'interpolated',
    indoor: point.indoor === true,
    level: point.level ?? null,
    interpolated: point.interpolated === true,
  };
}

function routeHeaderFields(route, waypoints) {
  return {
    from: route.request.from,
    to: route.request.to,
    mode: route.request.mode,
    coordinateSystem: 'WGS84 longitude/latitude',
    distanceMeters: route.summary.distanceMeters,
    durationSeconds: route.summary.durationSeconds,
    waypointSpacingMeters: route.summary.maxNavigationSpacingMeters ?? null,
  };
}

/**
 * Streaming JSONL route delivery: one JSON object per line. The first line is
 * `navigation_start` (task header + waypointCount), followed by one `waypoint`
 * line per dense waypoint, and a final `navigation_end` line. A robot can
 * acknowledge the header and start acting on the first waypoints without
 * buffering the whole document, and `emergency_stop` can interleave at any
 * point.
 */
export function createNavigationTaskStream(route, options = {}) {
  if (route?.status !== 'ok') throw new Error('Only a successful route can be sent to a robot');
  if (route.request?.mode !== 'robot') throw new Error('Robot tasks require a robot-mode route');
  const createdAt = options.createdAt ?? new Date().toISOString();
  const taskId = options.taskId ?? createTaskId();
  const waypoints = routeWaypoints(route);
  if (waypoints.length === 0) throw new Error('A navigation route contains no waypoints');

  const lines = [
    {
      protocol: ROBOT_PROTOCOL_NAME,
      protocolVersion: ROBOT_PROTOCOL_VERSION,
      type: NAVIGATION_START_TYPE,
      priority: COMMAND_PRIORITY.navigation,
      taskId,
      createdAt,
      dataset: route.dataset,
      route: {
        ...routeHeaderFields(route, waypoints),
        waypointCount: waypoints.length,
      },
    },
    ...waypoints.map((point, sequence) => ({
      protocol: ROBOT_PROTOCOL_NAME,
      protocolVersion: ROBOT_PROTOCOL_VERSION,
      type: WAYPOINT_TYPE,
      priority: COMMAND_PRIORITY.navigation,
      taskId,
      ...waypointObject(point, sequence),
    })),
    {
      protocol: ROBOT_PROTOCOL_NAME,
      protocolVersion: ROBOT_PROTOCOL_VERSION,
      type: NAVIGATION_END_TYPE,
      priority: COMMAND_PRIORITY.navigation,
      taskId,
      waypointCount: waypoints.length,
    },
  ];
  return lines;
}

export function createNavigationTask(route, options = {}) {
  if (route?.status !== 'ok') throw new Error('Only a successful route can be sent to a robot');
  if (route.request?.mode !== 'robot') throw new Error('Robot tasks require a robot-mode route');
  const createdAt = options.createdAt ?? new Date().toISOString();
  const taskId = options.taskId ?? createTaskId();
  const waypoints = routeWaypoints(route);
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: 'navigation_task',
    priority: COMMAND_PRIORITY.navigation,
    taskId,
    createdAt,
    dataset: route.dataset,
    route: {
      ...routeHeaderFields(route, waypoints),
      waypoints: waypoints.map((point, sequence) => waypointObject(point, sequence)),
    },
  };
}

export function createEmergencyStop(options = {}) {
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: 'emergency_stop',
    priority: COMMAND_PRIORITY.safety,
    commandId: options.commandId ?? `stop-${Date.now().toString(36)}`,
    taskId: options.taskId ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason ?? 'operator_request',
  };
}

export const DIRECTION_NAMES = Object.freeze(['forward', 'backward', 'left', 'right', 'stop']);

export const GOTO_TARGET_TYPE = 'goto_target';

/**
 * Send the car to ONE WGS84 waypoint — the "next step" navigation command.
 * The WiFi bridge writes a single-waypoint campusCar file and (with --drive)
 * launches gps_navigator for RTK closed-loop tracking of that target. Manual
 * direction commands and emergency_stop still preempt it.
 */
export function createGotoTarget(longitude, latitude, options = {}) {
  const lon = finiteNumber(longitude, 'longitude');
  const lat = finiteNumber(latitude, 'latitude');
  if (lon < -180 || lon > 180) throw new Error('longitude is outside WGS84 bounds');
  if (lat < -90 || lat > 90) throw new Error('latitude is outside WGS84 bounds');
  let speed = null;
  if (options.speedMetersPerSecond != null) {
    speed = Math.min(
      ROS_MAX_LINEAR_SPEED_MPS,
      Math.max(MIN_DIRECTION_SPEED_MPS, finiteNumber(options.speedMetersPerSecond, 'speedMetersPerSecond')),
    );
  }
  let radius = null;
  if (options.arrivalRadiusMeters != null) {
    radius = Math.min(10, Math.max(0.1, finiteNumber(options.arrivalRadiusMeters, 'arrivalRadiusMeters')));
  }
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: GOTO_TARGET_TYPE,
    priority: COMMAND_PRIORITY.navigation,
    commandId: options.commandId ?? `goto-${Date.now().toString(36)}`,
    taskId: options.taskId ?? null,
    longitude: roundedCoordinate(lon),
    latitude: roundedCoordinate(lat),
    speedMetersPerSecond: speed,
    arrivalRadiusMeters: radius,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Manual joystick command. Each command moves one fixed step (amountMeters /
 * amountDegrees) so a stray packet can never run the chassis continuously;
 * the web UI repeats it while the operator holds the pad button.
 */
export function createDirectionCommand(direction, options = {}) {
  if (!DIRECTION_NAMES.includes(direction)) {
    throw new Error(`Unknown direction: ${direction}`);
  }
  const moving = direction !== 'stop';
  const speed =
    moving && options.speedMetersPerSecond != null
      ? Math.min(
          ROS_MAX_LINEAR_SPEED_MPS,
          Math.max(
            MIN_DIRECTION_SPEED_MPS,
            finiteNumber(options.speedMetersPerSecond, 'speedMetersPerSecond'),
          ),
        )
      : null;
  return {
    protocol: ROBOT_PROTOCOL_NAME,
    protocolVersion: ROBOT_PROTOCOL_VERSION,
    type: 'direction',
    priority: COMMAND_PRIORITY.manual,
    commandId: options.commandId ?? `dir-${Date.now().toString(36)}`,
    direction,
    amountMeters:
      direction === 'forward' || direction === 'backward'
        ? finiteNumber(options.amountMeters ?? 0.75, 'amountMeters')
        : null,
    amountDegrees:
      direction === 'left' || direction === 'right'
        ? finiteNumber(options.amountDegrees ?? 15, 'amountDegrees')
        : null,
    speedMetersPerSecond: speed,
    createdAt: options.createdAt ?? new Date().toISOString(),
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
    priority: {
      model: 'rc > ble > nav；safety（急停）任何时候跨层优先',
      levels: [
        {
          priority: COMMAND_PRIORITY.remoteControl,
          source: '物理遥控器（不在 BLE 通道内）',
          rule:
            '固件通过硬件信号检测遥控器接管后，忽略所有 BLE 运动指令并暂停导航任务，直到遥控器释放接管。',
        },
        {
          priority: COMMAND_PRIORITY.manual,
          source: 'BLE direction 手动指令',
          rule:
            '收到 direction（含 stop）即抢占：固件暂停/取消当前导航任务并切换手动步进模式；恢复自主导航只能靠新的 navigation_task。',
        },
        {
          priority: COMMAND_PRIORITY.navigation,
          source: 'BLE navigation_task / navigation_start..end 流',
          rule:
            '最低优先级：新任务取消旧任务；任何时刻可被 direction、emergency_stop 或遥控器打断。',
        },
        {
          priority: COMMAND_PRIORITY.safety,
          source: 'BLE emergency_stop（跨层）',
          rule: '任何时刻优先于一切指令：立即停止运动、清除任务，直到显式恢复。',
        },
      ],
      note:
        '所有下行指令携带 priority 字段，固件可按字段仲裁；遥控器接管不在 BLE 通道内表达，由固件硬件层处理。',
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
      navigationStream: {
        types: [NAVIGATION_START_TYPE, WAYPOINT_TYPE, NAVIGATION_END_TYPE],
        lineOrder:
          'One JSON object per line. navigation_start (task header with route.waypointCount) → N waypoint lines (one per dense waypoint, ordered by sequence) → navigation_end (validates waypointCount). The robot should acknowledge navigation_start immediately and parse each waypoint line as it arrives, without waiting for the whole document; emergency_stop may interleave at any line boundary.',
        waypoints:
          'Each waypoint line is WGS84 longitude/latitude with sequence, nodeId (null when interpolated=true), kind, indoor, level.',
      },
      emergencyStop: {
        type: 'emergency_stop',
        behavior:
          'The browser prefixes LF to resynchronize after a cancelled partial transfer. Ignore an invalid partial line, then stop motion immediately, clear the active task, and notify an ack/status message.',
      },
      direction: {
        type: 'direction',
        direction: DIRECTION_NAMES,
        behavior:
          'Manual joystick step. Each command moves one fixed step (forward/backward: amountMeters, default 0.15 m; left/right: amountDegrees, default 15 deg; stop: halt immediately and clear queued commands). Optional speedMetersPerSecond (default 2.0, range 0.02-4.0, ROS max 4.0 m/s) overrides the default step speed; angular speed follows proportionally. The robot must stop at the end of every step by itself; the browser repeats the command while the pad button is held.',
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
