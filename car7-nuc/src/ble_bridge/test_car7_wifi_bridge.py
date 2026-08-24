#!/usr/bin/env python3
"""Unit tests for car7_wifi_bridge.py (pure logic; no ROS, no network).

Run from this directory:
  python3 test_car7_wifi_bridge.py
"""

import argparse
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import car7_wifi_bridge as wifi

PASSED = 0
FAILED = []


def check(name, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print("PASS  {}".format(name))
    else:
        FAILED.append(name)
        print("FAIL  {}  {}".format(name, detail))


def make_options(**overrides):
    values = dict(
        host="0.0.0.0",
        port=8900,
        executor_port=9099,
        direction=False,
        drive=False,
        speed=0.2,
        radius=0.6,
        replay_fallback=True,
        replay_accuracy_meters=None,
        campuscar_export=None,
        navigator="/tmp/nonexistent/gps_navigator.py",
        python=sys.executable,
        tls_cert=None,
        tls_key=None,
        goto_export=None,
        max_linear=5.0,
        max_angular=5.0,
        teleop_speed=1.0,
        teleop_rate=20.0,
        teleop_deadman=0.45,
        teleop_interval=0.05,
    )
    values.update(overrides)
    return argparse.Namespace(**values)


class RecordingBridge(wifi.Car7WifiBridge):
    """Captures broadcast messages instead of sending them over sockets."""

    def __init__(self, options):
        super().__init__(options)
        self.outbox = []
        self.sent_lines = []

    def send_all(self, message):
        self.outbox.append(message)
        self.sent_lines.append(wifi.encode_line(message).decode("utf-8").strip())

    @property
    def last(self):
        return self.outbox[-1] if self.outbox else None


def stream_lines(bridge, task_id="task-t", count=5):
    """Feed a complete streaming route: navigation_start + waypoints + end."""
    route = {
        "from": "main-entrance",
        "to": "library",
        "mode": "robot",
        "coordinateSystem": "WGS84 longitude/latitude",
        "distanceMeters": 10,
        "durationSeconds": 30,
        "waypointSpacingMeters": 2.5,
        "waypointCount": count,
    }
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1,
        "type": "navigation_start", "taskId": task_id, "createdAt": wifi.iso8601_now(),
        "route": route,
    })))
    for sequence in range(count):
        bridge.handle(wifi.parse_command(wifi.encode_line({
            "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1,
            "type": "waypoint", "taskId": task_id, "sequence": sequence,
            "nodeId": "n{}".format(sequence) if sequence % 2 == 0 else None,
            "longitude": 113.47768 + sequence * 0.00001,
            "latitude": 22.88836 + sequence * 0.00001,
            "kind": "entrance" if sequence == 0 else "interpolated",
            "indoor": False, "level": None, "interpolated": sequence > 0,
        })))
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1,
        "type": "navigation_end", "taskId": task_id, "waypointCount": count,
    })))


# ---------------------------------------------------------------------------
# WebSocket primitives
# ---------------------------------------------------------------------------

def test_handshake():
    accept = wifi.websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ==")
    check("handshake accept key (RFC 6455 sample)",
          accept == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", accept)


def test_frame_roundtrip():
    conn = wifi.WebSocketConnection.__new__(wifi.WebSocketConnection)
    payload = b'{"type":"position"}\n'
    frame = conn._frame(0x1, payload)
    # server frame: FIN|TEXT, unmasked, length byte
    check("server frame header", frame[0] == 0x81 and frame[1] == len(payload),
          frame.hex())
    check("server frame payload", frame[2:] == payload)


def test_parse_http_request():
    request = (
        b"GET / HTTP/1.1\r\n"
        b"Host: 10.7.181.161:8900\r\n"
        b"Upgrade: websocket\r\n"
        b"Connection: Upgrade\r\n"
        b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        b"\r\n"
    )
    line, headers, rest = wifi.parse_http_request(request)
    check("http request line", line == "GET / HTTP/1.1", line)
    check("http header parse", headers["upgrade"] == "websocket" and
          headers["sec-websocket-key"] == "dGhlIHNhbXBsZSBub25jZQ==")


# ---------------------------------------------------------------------------
# Command handling
# ---------------------------------------------------------------------------

def test_direction_rejected_without_flag():
    bridge = RecordingBridge(make_options())
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1, "type": "direction",
        "commandId": "dir-1", "direction": "forward", "amountMeters": 0.15,
        "amountDegrees": None, "speedMetersPerSecond": None, "createdAt": wifi.iso8601_now(),
    })))
    check("direction rejected without --direction",
          bridge.last is not None and bridge.last["type"] == "ack" and
          bridge.last["status"] == "rejected", bridge.last)


def test_direction_accepted_with_flag():
    bridge = RecordingBridge(make_options(direction=True))
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1, "type": "direction",
        "commandId": "dir-2", "direction": "forward", "amountMeters": 0.15,
        "amountDegrees": None, "speedMetersPerSecond": 0.2, "createdAt": wifi.iso8601_now(),
    })))
    check("direction accepted with --direction",
          bridge.last is not None and bridge.last["type"] == "ack" and
          bridge.last["status"] == "accepted", bridge.last)


def test_streaming_route_complete():
    bridge = RecordingBridge(make_options())
    stream_lines(bridge, count=3)
    acks = [m for m in bridge.outbox if m["type"] == "ack"]
    statuses = [m for m in bridge.outbox if m["type"] == "status"]
    check("streaming ack accepted", acks and acks[0]["status"] == "accepted", acks)
    check("streaming navigating status", any(s["status"] == "navigating" for s in statuses),
          statuses)
    check("task held", bridge.active_task is not None and
          len(bridge.active_task.route.waypoints) == 3)


def test_incomplete_stream_fault():
    bridge = RecordingBridge(make_options())
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1,
        "type": "navigation_start", "taskId": "task-x", "createdAt": wifi.iso8601_now(),
        "route": {"from": "a", "to": "b", "mode": "robot", "waypointCount": 5},
    })))
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1,
        "type": "navigation_end", "taskId": "task-x", "waypointCount": 5,
    })))
    check("incomplete stream -> fault",
          any(m["type"] == "status" and m["status"] == "fault" for m in bridge.outbox))


def test_emergency_stop_clears_task():
    bridge = RecordingBridge(make_options())
    stream_lines(bridge, count=2)
    bridge.handle(wifi.parse_command(wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1, "type": "emergency_stop",
        "commandId": "stop-1", "taskId": "task-t", "createdAt": wifi.iso8601_now(),
        "reason": "operator_request",
    })))
    check("emergency stop ack",
          any(m["type"] == "ack" and m["status"] == "stopped" for m in bridge.outbox),
          bridge.outbox)
    check("task cleared", bridge.active_task is None)


def test_campuscar_export():
    with tempfile.TemporaryDirectory() as tmp:
        export_path = os.path.join(tmp, "route.json")
        bridge = RecordingBridge(make_options(campuscar_export=export_path))
        stream_lines(bridge, count=2)
        check("export file written", os.path.exists(export_path))
        import json
        payload = json.load(open(export_path))
        check("export origin", payload["origin"]["lat"] == 22.88836, payload["origin"])
        check("export waypoints", len(payload["waypoints"]) == 2)


def test_replay_fallback_publishes_positions():
    bridge = RecordingBridge(make_options(replay_fallback=True))
    stream_lines(bridge, count=3)
    bridge._telemetry_tick()  # no RTK fix → replay first waypoint
    positions = [m for m in bridge.outbox if m["type"] == "position"]
    check("replay position published", positions and positions[-1]["fixStatus"] == "replay",
          positions[-1] if positions else None)


def test_rtk_position_publish():
    bridge = RecordingBridge(make_options(replay_fallback=True))
    stream_lines(bridge, count=3)
    fix = type("Fix", (), {"status": type("S", (), {"status": 4})(),
                           "latitude": 22.888, "longitude": 113.477,
                           "position_covariance": [0.0004, 0.0, 0.0, 0.0, 0.0004, 0.0, 0.0, 0.0, 0.0004]})()
    bridge._on_fix(fix)
    bridge._on_imu(type("Imu", (), {"orientation": type("Q", (), {
        "x": 0.0, "y": 0.0, "z": 0.7071, "w": 0.7071})()})())
    bridge._telemetry_tick()
    positions = [m for m in bridge.outbox if m["type"] == "position"]
    last = positions[-1] if positions else None
    check("rtk position published", last is not None and last["fixStatus"] == "rtk_fixed", last)
    check("rtk heading from imu", last is not None and abs(last["headingDegrees"] - 0.0) < 1.0, last)
    check("rtk accuracy from covariance", last is not None and abs(last["accuracyMeters"] - 0.02) < 0.005,
          last)


def test_binary_frame_accepted():
    """Browser sends Uint8Array lines as BINARY frames (opcode 0x2); the
    bridge must treat them like text frames (JSONL bytes)."""
    bridge = RecordingBridge(make_options())
    payload = b'{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction","commandId":"bin-1","direction":"stop","amountMeters":null,"amountDegrees":null,"speedMetersPerSecond":null,"createdAt":"t"}\n'
    # client frames are masked; build one manually (opcode 0x2 = binary,
    # 16-bit length because the line is longer than 125 bytes)
    import os as _os
    import struct as _struct
    frame = bytearray([0x82, 0x80 | 126]) + _struct.pack(">H", len(payload)) + _os.urandom(4)
    mask = frame[4:8]
    frame += bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    frame = bytes(frame)
    conn = wifi.WebSocketConnection.__new__(wifi.WebSocketConnection)
    conn.bridge = bridge
    conn.recv_buffer = frame
    frames = list(conn._next_frames())
    check("binary frame parsed", frames and frames[0][1] == 0x2, frames)
    bridge.on_text(conn, frames[0][0])
    check("binary frame handled as JSONL",
          any(m["type"] == "ack" for m in bridge.outbox), bridge.outbox)


def goto_line(command_id="goto-1", lon=113.4777, lat=22.8884, **extra):
    line = {
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1, "type": "goto_target",
        "commandId": command_id, "longitude": lon, "latitude": lat,
        "taskId": None, "speedMetersPerSecond": None,
        "arrivalRadiusMeters": None, "createdAt": wifi.iso8601_now(),
    }
    line.update(extra)
    return wifi.encode_line(line)


def test_goto_parses_and_acks_without_drive():
    bridge = RecordingBridge(make_options())
    bridge.handle(wifi.parse_command(goto_line()))
    check("goto ack accepted", any(m["type"] == "ack" and m["status"] == "accepted"
          for m in bridge.outbox), bridge.outbox)
    check("goto task held", bridge.active_task is not None and
          len(bridge.active_task.route.waypoints) == 1, bridge.active_task)


def test_goto_rejects_bad_coordinates():
    bridge = RecordingBridge(make_options())
    try:
        wifi.parse_command(goto_line(lon=200.0))
        rejected = False
    except wifi.Car7CommandError:
        rejected = True
    check("goto bad lon rejected at parse", rejected)
    check("goto bad lon leaves no task", bridge.active_task is None)


def test_goto_export_single_waypoint():
    import json as _json
    with tempfile.TemporaryDirectory() as tmp:
        export_path = os.path.join(tmp, "goto.json")
        bridge = RecordingBridge(make_options(goto_export=export_path))
        bridge.handle(wifi.parse_command(goto_line(lat=22.8884, lon=113.4777)))
        check("goto file written", os.path.exists(export_path))
        payload = _json.load(open(export_path))
        check("goto origin", payload["origin"]["lat"] == 22.8884)
        check("goto single waypoint", len(payload["waypoints"]) == 1)


def test_goto_drive_launches_navigator():
    import tempfile as _tf
    with _tf.TemporaryDirectory() as tmp:
        script = os.path.join(tmp, "fake_navigator.py")
        with open(script, "w") as handle:
            handle.write("import sys\nprint('fake nav done')\nsys.exit(0)\n")
        bridge = RecordingBridge(make_options(
            drive=True, python=sys.executable, navigator=script,
            goto_export=os.path.join(tmp, "goto.json"),
        ))
        bridge.handle(wifi.parse_command(goto_line()))
        check("goto drive launches navigator",
              bridge.navigator.process is not None and bridge.navigator.process.poll() is None,
              "process={}".format(bridge.navigator.process))
        bridge.navigator.stop(reason="test cleanup")


def teleop_line(direction="forward", speed=1.0, command_id="tp-1", continuous=True):
    return wifi.encode_line({
        "protocol": wifi.PROTOCOL_NAME, "protocolVersion": 1, "type": "direction",
        "commandId": command_id, "direction": direction,
        "amountMeters": None, "amountDegrees": None,
        "speedMetersPerSecond": speed, "createdAt": wifi.iso8601_now(),
        "continuous": continuous,
    })


def test_continuous_direction_parse():
    command = wifi.parse_command(teleop_line("forward", 1.5))
    check("continuous parsed", isinstance(command, wifi.DirectionCommand) and
          command.continuous and command.amount_meters is None, command)
    stop = wifi.parse_command(teleop_line("stop", None))
    check("continuous stop parsed", stop.direction == "stop" and stop.continuous, stop)


def test_teleop_state_slew_and_deadman():
    published = []
    state = wifi.TeleopState(max_linear=5.0, max_angular=5.0,
                             accel_lin=1.2, decel_lin=2.0, accel_ang=2.0, decel_ang=3.0,
                             deadman=0.45)
    state.set_stick(0.0, 1.0, 0.2)  # full forward at 20% scale -> 1.0 m/s
    check("stick target lin", abs(state.target_lin - 1.0) < 1e-6, state.target_lin)
    for _ in range(20):  # accel 1.2 @20Hz -> 0.06/step -> 17 steps to 1.0
        published.append(state.tick(dt=0.05))
    check("teleop ramps toward target", published[-1][0] >= 0.95, published[-1])
    state.stop(hard=True)
    published.append(state.tick(dt=0.05))
    check("teleop hard stop publishes zero", published[-1][0] == 0.0, published[-1])
    # deadman: set stick, advance time without new commands, tick -> decelerate
    state.set_stick(0.0, 1.0, 0.2)
    state.last_cmd_mono -= 1.0  # simulate 1s silence
    state.cmd_lin = 1.0
    published = [state.tick(dt=0.05)]
    check("teleop deadman zeroes target", state.target_lin == 0.0, state.target_lin)
    check("teleop deadman decelerates", published[-1][0] < 1.0, published[-1])


def test_continuous_direction_sets_teleop_target():
    bridge = RecordingBridge(make_options(direction=True))
    bridge.teleop = wifi.TeleopState(max_linear=5.0, max_angular=5.0)
    bridge.handle(wifi.parse_command(teleop_line("forward", 1.0)))
    check("teleop forward target (1 m/s -> scale 0.2 -> lin 1.0)",
          abs(bridge.teleop.target_lin - 1.0) < 1e-6 and bridge.teleop.target_ang == 0.0,
          (bridge.teleop.target_lin, bridge.teleop.target_ang))
    bridge.handle(wifi.parse_command(teleop_line("left", 1.0)))
    check("teleop left target (angular > 0)", bridge.teleop.target_ang > 0.0,
          bridge.teleop.target_ang)
    bridge.handle(wifi.parse_command(teleop_line("stop")))
    check("teleop stop clears target",
          bridge.teleop.target_lin == 0.0 and bridge.teleop.target_ang == 0.0,
          (bridge.teleop.target_lin, bridge.teleop.target_ang))


def test_http_post_command():
    bridge = RecordingBridge(make_options(direction=True))
    # direction stop via POST
    result = bridge.handle_http_command(
        '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction","priority":"ble",'
        '"commandId":"post-1","direction":"stop","amountMeters":null,"amountDegrees":null,'
        '"speedMetersPerSecond":null,"createdAt":"t","continuous":true}')
    check("POST direction ok", result.get("ok") is True and result.get("status") == "accepted", result)
    # goto_target via POST
    result = bridge.handle_http_command(
        '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"goto_target","priority":"nav",'
        '"commandId":"post-2","longitude":113.4777,"latitude":22.8884,"createdAt":"t"}')
    check("POST goto ok", result.get("ok") is True, result)
    # invalid JSON via POST
    result = bridge.handle_http_command('{"protocol":"wrong"}')
    check("POST invalid rejected", result.get("ok") is False, result)
    # multi-line body
    response = bridge.http_command_response(
        b'{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction","priority":"ble",'
        b'"commandId":"post-3","direction":"stop","amountMeters":null,"amountDegrees":null,'
        b'"speedMetersPerSecond":null,"createdAt":"t","continuous":true}\n'
        b'{"protocol":"luban-nav-ble","protocolVersion":1,"type":"emergency_stop","priority":"safety",'
        b'"commandId":"post-4","createdAt":"t","reason":"test"}')
    import json as _json
    payload = _json.loads(response.decode("utf-8").split("\r\n\r\n", 1)[1])
    check("POST multiline results", len(payload["results"]) == 2 and payload["ok"] is True, payload)


def test_nav_status_forwarded():
    """gps_navigator /nav_status lines are forwarded as status messages."""
    bridge = RecordingBridge(make_options())
    stream_lines(bridge, count=2)
    bridge._on_nav_status("WP 2/10 | dist=1.23m | v=0.20m/s | ω=0.10rad/s")
    statuses = [m for m in bridge.outbox if m["type"] == "status"]
    check("nav_status forwarded", any(
        s["status"] == "navigating" and s.get("message", "").startswith("WP 2/10")
        for s in statuses), statuses)


def test_http_status_page():
    bridge = RecordingBridge(make_options())
    body = bridge.http_status()
    check("http status page", body.startswith(b"HTTP/1.1 200") and b"car7-wifi-bridge" in body)
    check("http CORS header", b"Access-Control-Allow-Origin: *" in body)


if __name__ == "__main__":
    test_handshake()
    test_frame_roundtrip()
    test_parse_http_request()
    test_direction_rejected_without_flag()
    test_direction_accepted_with_flag()
    test_streaming_route_complete()
    test_incomplete_stream_fault()
    test_emergency_stop_clears_task()
    test_campuscar_export()
    test_replay_fallback_publishes_positions()
    test_rtk_position_publish()
    test_binary_frame_accepted()
    test_goto_parses_and_acks_without_drive()
    test_goto_rejects_bad_coordinates()
    test_goto_export_single_waypoint()
    test_goto_drive_launches_navigator()
    test_continuous_direction_parse()
    test_teleop_state_slew_and_deadman()
    test_continuous_direction_sets_teleop_target()
    test_http_post_command()
    test_nav_status_forwarded()
    test_http_status_page()
    print("\n{} passed, {} failed".format(PASSED, len(FAILED)))
    if FAILED:
        sys.exit(1)
