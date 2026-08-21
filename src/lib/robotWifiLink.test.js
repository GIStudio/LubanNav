import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WIFI_URL,
  RobotWifiLinkError,
  WifiRobotLink,
  normalizeWifiUrl,
} from './robotWifiLink.js';
import { ROBOT_PROTOCOL_NAME, ROBOT_PROTOCOL_VERSION } from './robotProtocol.js';

/** Minimal in-memory WebSocket pair used to test the link logic. */
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
    // Simulate the browser opening the connection on the next tick.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  send(data) {
    this.sent.push(data);
    this.peer?.receive?.(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Server side: deliver a message to the link. */
  receiveFromServer(text) {
    this.onmessage?.({ data: text });
  }
  /** Attach the server half that receives client sends. */
  setPeer(peer) {
    this.peer = peer;
  }
}

class FakeServerHalf {
  constructor(clientSocket) {
    this.received = [];
    this.clientSocket = clientSocket;
    clientSocket.setPeer(this);
  }
  receive(data) {
    this.received.push(data);
  }
  sendToClient(text) {
    this.clientSocket.receiveFromServer(text);
  }
}

function latestSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** Connect the link and return its socket plus a server half. */
async function connectPair(url = DEFAULT_WIFI_URL) {
  FakeWebSocket.instances = [];
  const link = new WifiRobotLink({ url, WebSocketImpl: FakeWebSocket });
  await link.connect();
  expect(link.state).toBe('connected');
  const socket = latestSocket();
  const server = new FakeServerHalf(socket);
  return { link, socket, server };
}

describe('normalizeWifiUrl', () => {
  it('accepts ws:// and wss:// URLs', () => {
    expect(normalizeWifiUrl('ws://10.7.181.161:8900')).toBe('ws://10.7.181.161:8900');
    expect(normalizeWifiUrl('  wss://car7.local/  ')).toBe('wss://car7.local/');
  });

  it('rejects non-WebSocket URLs', () => {
    expect(() => normalizeWifiUrl('http://10.7.181.161:8900')).toThrow();
    expect(() => normalizeWifiUrl('10.7.181.161:8900')).toThrow();
    expect(() => normalizeWifiUrl('')).toThrow();
  });
});

describe('WifiRobotLink connect/disconnect', () => {
  it('connects and reports the state event', async () => {
    FakeWebSocket.instances = [];
    const link = new WifiRobotLink({ url: DEFAULT_WIFI_URL, WebSocketImpl: FakeWebSocket });
    const listener = vi.fn();
    link.subscribe(listener);
    await link.connect();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'state', state: 'connected' }));
    link.disconnect();
    expect(link.state).toBe('disconnected');
  });

  it('reports an error when the socket fails', async () => {
    class RefusedSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        setTimeout(() => this.onerror?.({ error: new Error('connection refused') }), 0);
      }
      send() {}
      close() {}
    }
    const link = new WifiRobotLink({ url: 'ws://10.0.0.1:8900', WebSocketImpl: RefusedSocket });
    link.setAutoReconnect(false);
    await expect(link.connect()).rejects.toThrow();
    expect(link.state).toBe('error');
  });

  it('rejects sends while disconnected', async () => {
    const link = new WifiRobotLink({ url: DEFAULT_WIFI_URL, WebSocketImpl: FakeWebSocket });
    await expect(link.sendNavigationTask(routeFixture())).rejects.toThrow();
  });
});

describe('WifiRobotLink protocol exchange', () => {
  it('sends the streaming navigation task as LF-terminated JSONL frames', async () => {
    const { link, server } = await connectPair();
    const listener = vi.fn();
    link.subscribe(listener);
    await link.sendNavigationTask(routeFixture());
    expect(server.received.length).toBe(5); // start + 3 waypoints + end
    for (const bytes of server.received) {
      expect(bytes.byteLength).toBeGreaterThan(0);
      const text = new TextDecoder().decode(bytes);
      expect(text.endsWith('\n')).toBe(true);
      const obj = JSON.parse(text);
      expect(obj.protocol).toBe(ROBOT_PROTOCOL_NAME);
      expect(obj.protocolVersion).toBe(ROBOT_PROTOCOL_VERSION);
    }
    const first = JSON.parse(new TextDecoder().decode(server.received[0]));
    expect(first.type).toBe('navigation_start');
    const last = JSON.parse(new TextDecoder().decode(server.received[4]));
    expect(last.type).toBe('navigation_end');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'sent' }));
  });

  it('decodes position / ack / status messages from the server', async () => {
    const { link, server } = await connectPair();
    const listener = vi.fn();
    link.subscribe(listener);
    server.sendToClient(
      `${JSON.stringify({
        protocol: ROBOT_PROTOCOL_NAME,
        protocolVersion: ROBOT_PROTOCOL_VERSION,
        type: 'ack',
        taskId: 'task-1',
        status: 'accepted',
      })}\n`,
    );
    server.sendToClient(
      `${JSON.stringify({
        protocol: ROBOT_PROTOCOL_NAME,
        protocolVersion: ROBOT_PROTOCOL_VERSION,
        type: 'position',
        taskId: 'task-1',
        longitude: 113.4777,
        latitude: 22.8884,
        headingDegrees: 47.9,
        accuracyMeters: 0.03,
        fixStatus: 'rtk_fixed',
        timestamp: '2026-08-21T00:00:00.000Z',
      })}\n`,
    );
    const events = listener.mock.calls.map(([event]) => event);
    expect(events.some((event) => event.type === 'message' && event.message.type === 'ack')).toBe(true);
    const positionEvent = events.find((event) => event.type === 'position');
    expect(positionEvent.position.latitude).toBe(22.8884);
    expect(positionEvent.position.fixStatus).toBe('rtk_fixed');
  });

  it('handles multiple JSON lines inside a single frame', async () => {
    const { link, server } = await connectPair();
    const listener = vi.fn();
    link.subscribe(listener);
    server.sendToClient(
      `${JSON.stringify({ protocol: ROBOT_PROTOCOL_NAME, protocolVersion: 1, type: 'ack', status: 'accepted', taskId: 't' })}\n${JSON.stringify({ protocol: ROBOT_PROTOCOL_NAME, protocolVersion: 1, type: 'status', status: 'navigating', taskId: 't' })}\n`,
    );
    const messages = listener.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'message')
      .map((event) => event.message);
    expect(messages.map((m) => m.type)).toEqual(['ack', 'status']);
  });

  it('sends a single-waypoint goto_target command', async () => {
    const { link, server } = await connectPair();
    await link.sendGotoTarget(113.4777, 22.8884, { speedMetersPerSecond: 0.3 });
    const text = new TextDecoder().decode(server.received[0]);
    const obj = JSON.parse(text);
    expect(obj.type).toBe('goto_target');
    expect(obj.longitude).toBe(113.4777);
    expect(obj.latitude).toBe(22.8884);
    expect(obj.speedMetersPerSecond).toBe(0.3);
  });

  it('sends direction and emergency stop with priority ordering', async () => {
    const { link, server } = await connectPair();
    await link.sendDirection('forward', { amountMeters: 0.15 });
    await link.sendEmergencyStop();
    const texts = server.received.map((bytes) => new TextDecoder().decode(bytes));
    expect(JSON.parse(texts[0]).type).toBe('direction');
    expect(JSON.parse(texts[1]).type).toBe('emergency_stop');
  });
});

function routeFixture() {
  return {
    status: 'ok',
    dataset: 'hkustgz-layered-routing-v4',
    request: { from: 'main-entrance', to: 'library', mode: 'robot' },
    summary: { distanceMeters: 10, durationSeconds: 20, maxNavigationSpacingMeters: 2.5 },
    navigationWaypoints: [
      { sequence: 0, longitude: 113.47768, latitude: 22.88836, kind: 'entrance' },
      { sequence: 1, longitude: 113.47770, latitude: 22.88840, kind: 'interpolated' },
      { sequence: 2, longitude: 113.47772, latitude: 22.88844, kind: 'interpolated' },
    ],
  };
}
