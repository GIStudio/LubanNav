#!/usr/bin/env python3
"""car7 WiFi bridge — LubanNav robot protocol over WebSocket (RFC 6455).

Runs INSIDE the campuscar docker container (host /home/pc/campusCar is mounted
at /workspace/campusCar-new-chassis), so it can talk to everything with plain
loopback / ROS2:

  - Browser (or any WS client)  <──WebSocket──>  car7_wifi_bridge.py
        │  JSON Lines (identical contract to the BLE bridge, car7_protocol.py)
        ├── direction ──▶ move_executor (127.0.0.1:9099, odom closed loop)
        ├── navigation_task / navigation_start..end stream
        │       └── (--drive) launch gps_navigator.py (RTK Stanley closed loop)
        └── telemetry: /fix + /imu + /odom → position JSONL @ 2 Hz
                        (replay fallback when RTK has no fix and --replay-fallback)

Why WiFi instead of BLE: the NUC's Intel combo card (WiFi+BT shared antenna)
starves BLE broadcasts while WiFi is in use (see docs/car7-ble-troubleshooting.md),
and the page must reach the car over the campus LAN at 10.7.181.161.

Zero third-party dependencies: WebSocket server is a minimal stdlib RFC 6455
implementation (text frames, ping/pong, close; no extensions).

Safety flags (mirror the BLE bridge stance):
  --direction        execute manual direction commands on the real chassis
  --drive            run gps_navigator.py on an accepted route (autonomous
                     motion). Default OFF: routes are exported + telemetry only.
  --replay-fallback  when RTK has no fix, replay route waypoints as positions
                     so the web loop stays demonstrable (default ON).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import queue
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import List, Optional

try:  # rclpy exists only inside the container; unit tests run without it
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    from sensor_msgs.msg import Imu, NavSatFix
    from nav_msgs.msg import Odometry
    from std_msgs.msg import String as StdString
except ImportError:  # pragma: no cover
    rclpy = None
    Node = None
    Twist = None
    Imu = None
    NavSatFix = None
    Odometry = None
    StdString = None

from car7_teleop import TeleopState

from car7_protocol import (
    Car7CommandError,
    DirectionCommand,
    EmergencyStop,
    FramingError,
    GotoTarget,
    JSONLineFramer,
    NavigationEnd,
    NavigationRoute,
    NavigationStart,
    NavigationTask,
    NavigationWaypoint,
    WaypointLine,
    acknowledgement,
    bearing_degrees,
    campuscar_waypoint_file,
    encode_line,
    encode_pretty,
    iso8601_now,
    parse_command,
    position_message,
    status_message,
)

PROTOCOL_NAME = "luban-nav-ble"  # transport-agnostic protocol name (kept for parity)
SERVICE_NAME = "car7-wifi-bridge"
SERVICE_VERSION = "1.0"
MOVE_EXECUTOR_PORT = 9099
MOVE_REPLY_TIMEOUT_S = 30.0

# /fix status convention: nmea_navsat_driver emits sensor_msgs status codes
# (2 = GBAS_FIX, which is the RTK fixed solution); 4/5 kept for STATUS_MAP compat
FIX_STATUS_MAP = {
    -1: "no_fix",
    0: "gps_fix",
    1: "dgps",
    2: "rtk_fixed",
    4: "rtk_fixed",
    5: "rtk_float",
}
DEFAULT_ACCURACY_METERS = {
    "rtk_fixed": 0.03,
    "rtk_float": 0.30,
    "dgps": 1.0,
    "gps_fix": 2.5,
    "no_fix": None,
}

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME_BYTES = 1_048_576


# ---------------------------------------------------------------------------
# Minimal RFC 6455 WebSocket server (stdlib only)
# ---------------------------------------------------------------------------

class WebSocketError(Exception):
    pass


def websocket_accept_key(key: str) -> str:
    digest = hashlib.sha1((key + WS_GUID).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def parse_http_request(data: bytes):
    """Split an HTTP request into (request_line, headers_dict, rest_bytes)."""
    head, sep, rest = data.partition(b"\r\n\r\n")
    if not sep:
        raise WebSocketError("incomplete HTTP headers")
    lines = head.decode("utf-8", errors="replace").split("\r\n")
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return request_line, headers, rest


class WebSocketConnection:
    """One RFC 6455 client connection (text/binary frames, server side)."""

    def __init__(self, sock: socket.socket, address, bridge: "Car7WifiBridge"):
        self.sock = sock
        self.address = address
        self.bridge = bridge
        self.send_queue = queue.Queue()
        self.closed = threading.Event()
        self.recv_buffer = b""
        self.send_lock = threading.Lock()
        self.connected_at = time.time()
        self.remote_ip = address[0] if isinstance(address, tuple) else str(address)

    # ── outbound ──────────────────────────────────────────────────────────

    def _enqueue_raw(self, data: bytes) -> bool:
        if self.closed.is_set():
            return False
        try:
            self.send_queue.put_nowait(data)
            return True
        except queue.Full:
            return False

    def enqueue_text(self, text: str) -> bool:
        """Queue one complete WebSocket text frame carrying `text`."""
        return self._enqueue_raw(self._frame(0x1, text.encode("utf-8")))

    @staticmethod
    def _frame(opcode: int, payload: bytes) -> bytes:
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header += struct.pack(">H", length)
        else:
            header.append(127)
            header += struct.pack(">Q", length)
        return bytes(header) + payload

    def _send_raw(self, data: bytes):
        with self.send_lock:
            self.sock.sendall(data)

    def sender_loop(self):
        while not self.closed.is_set():
            try:
                data = self.send_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._send_raw(data)
            except OSError:
                self.close()
                return

    # ── inbound ───────────────────────────────────────────────────────────

    def read_frames(self):
        """Consume frames until the peer closes or an error occurs."""
        while not self.closed.is_set():
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if chunk == b"":
                break
            self.recv_buffer += chunk
            try:
                for payload, opcode in self._next_frames():
                    if opcode == 0x8:  # close
                        self._send_raw(self._frame(0x8, b""))
                        self.close()
                        return
                    if opcode == 0x9:  # ping → pong
                        self._send_raw(self._frame(0xA, payload))
                        continue
                    if opcode in (0x1, 0x2):  # text / binary → JSONL bytes
                        self.bridge.on_text(self, payload)
            except WebSocketError as exc:
                self.bridge.log("DROP", "websocket error from {}: {}".format(self.remote_ip, exc))
                self.close()
                return
        self.close()

    def _next_frames(self):
        while True:
            if len(self.recv_buffer) < 2:
                return
            first, second = self.recv_buffer[0], self.recv_buffer[1]
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            offset = 2
            if length == 126:
                if len(self.recv_buffer) < offset + 2:
                    return
                length = struct.unpack(">H", self.recv_buffer[offset:offset + 2])[0]
                offset += 2
            elif length == 127:
                if len(self.recv_buffer) < offset + 8:
                    return
                length = struct.unpack(">Q", self.recv_buffer[offset:offset + 8])[0]
                offset += 8
            if length > MAX_FRAME_BYTES:
                raise WebSocketError("frame too large: {} bytes".format(length))
            if not masked:
                raise WebSocketError("client frames must be masked")
            if len(self.recv_buffer) < offset + 4 + length:
                return
            mask = self.recv_buffer[offset:offset + 4]
            offset += 4
            payload = bytearray(self.recv_buffer[offset:offset + length])
            for index in range(length):
                payload[index] ^= mask[index % 4]
            self.recv_buffer = self.recv_buffer[offset + length:]
            yield bytes(payload), opcode
            if not fin:
                raise WebSocketError("fragmented frames not supported")

    def close(self):
        if not self.closed.is_set():
            self.closed.set()
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Move executor client (127.0.0.1:9099) — same contract as the BLE bridge
# ---------------------------------------------------------------------------

class MoveClient(threading.Thread):
    """Background client for the in-container move executor.

    Commands are queued; replies are delivered via on_reply(kind, detail).
    """

    def __init__(self, host: str, port: int, on_reply):
        super().__init__(name="wifi-move-client", daemon=True)
        self.host = host
        self.port = port
        self.on_reply = on_reply
        self.queue = queue.Queue()
        self.stop_all = threading.Event()
        self.stop_now_flag = threading.Event()
        self.discard_until_stop = threading.Event()
        self.conn = None

    def submit(self, command, argument=None, speed=None):
        self.queue.put((command, argument, speed))

    def stop_now(self):
        self.stop_now_flag.set()
        self.discard_until_stop.set()
        self.queue.put(("STOP", None, None))

    def close(self):
        self.stop_all.set()
        self.submit("__EXIT__", None)

    def _ensure_conn(self):
        if self.conn is not None:
            return True
        try:
            sock = socket.create_connection((self.host, self.port), timeout=3.0)
            sock.settimeout(0.2)
            self.conn = sock
            return True
        except OSError as exc:
            self.on_reply("ERR", "executor unreachable: {}".format(exc))
            return False

    def _send(self, text):
        try:
            self.conn.sendall(text.encode("utf-8") + b"\n")
            return True
        except OSError:
            self.conn = None
            return False

    def run(self):
        while not self.stop_all.is_set():
            command, argument, speed = self.queue.get()
            if command == "__EXIT__":
                break
            if self.discard_until_stop.is_set() and command != "STOP":
                continue
            if command == "STOP":
                self.discard_until_stop.clear()
                self.stop_now_flag.clear()
                if self._ensure_conn():
                    self._send("STOP")
                    self._await_reply(command)
                continue
            if not self._ensure_conn():
                continue
            parts = [command, argument] if argument is not None else [command]
            if speed is not None:
                parts.append(speed)
            self._send(" ".join(str(part) for part in parts))
            self._await_reply(command)

    def _await_reply(self, command):
        deadline = time.monotonic() + MOVE_REPLY_TIMEOUT_S
        buffer = b""
        while time.monotonic() < deadline and not self.stop_all.is_set():
            if self.stop_now_flag.is_set():
                self.stop_now_flag.clear()
                self._send("STOP")
            try:
                chunk = self.conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                self.conn = None
                self.on_reply("ERR", "executor connection lost")
                return
            if chunk == b"":
                self.conn = None
                self.on_reply("ERR", "executor closed connection")
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                kind, detail = self._parse_line(line)
                if command in ("FORWARD", "BACKWARD", "LEFT", "RIGHT"):
                    if kind in ("DONE", "STOPPED", "TIMEOUT", "ERR"):
                        self.on_reply(kind, detail)
                        return
                    continue
                self.on_reply(kind, detail)
                return
        else:
            self.on_reply("ERR", "executor reply timeout")
            self.conn = None

    @staticmethod
    def _parse_line(line):
        parts = line.decode("utf-8", errors="replace").strip().split()
        if not parts:
            return "OK", None
        kind = parts[0].upper()
        detail = None
        if len(parts) > 1:
            try:
                detail = float(parts[1])
            except ValueError:
                detail = parts[1]
        return kind, detail


# ---------------------------------------------------------------------------
# ROS telemetry (runs only inside the container)
# ---------------------------------------------------------------------------

class RosTelemetry:
    """Subscribes /fix + /imu + /odom + /nav_status in a background rclpy thread."""

    def __init__(self, on_fix, on_imu, on_odom, on_nav_status):
        self.on_fix = on_fix
        self.on_imu = on_imu
        self.on_odom = on_odom
        self.on_nav_status = on_nav_status
        self.node = None
        self.cmd_pub = None
        self.thread = None
        self.ready = threading.Event()

    def start(self):
        if rclpy is None or Node is None:
            return False
        self.thread = threading.Thread(target=self._run, name="wifi-ros", daemon=True)
        self.thread.start()
        return True

    def _run(self):
        try:
            rclpy.init()
        except Exception as exc:  # pragma: no cover
            print("[RTK] rclpy init failed: {}".format(exc), flush=True)
            return
        self.node = Node("car7_wifi_bridge")
        self.node.create_subscription(NavSatFix, "/fix", self._on_fix, 10)
        self.node.create_subscription(Imu, "/imu", self._on_imu, 10)
        self.node.create_subscription(Odometry, "/odom", self._on_odom, 10)
        if StdString is not None:
            self.node.create_subscription(StdString, "/nav_status", self._on_nav_status, 10)
        if Twist is not None:
            self.cmd_pub = self.node.create_publisher(Twist, "/cmd_vel", 10)
        self.ready.set()
        try:
            rclpy.spin(self.node)
        finally:
            self.node.destroy_node()
            rclpy.shutdown()

    def _on_fix(self, msg):
        self.on_fix(msg)

    def _on_imu(self, msg):
        self.on_imu(msg)

    def _on_odom(self, msg):
        self.on_odom(msg)

    def _on_nav_status(self, msg):
        self.on_nav_status(msg.data)


def quat_to_yaw_enu(x, y, z, w) -> Optional[float]:
    """Quaternion → yaw in radians (ENU: east=0, ccw positive)."""
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def enu_yaw_to_compass(radians: float) -> float:
    """ENU yaw (east=0, ccw) → compass heading (north=0, clockwise, 0-360)."""
    degrees = math.degrees(radians)
    compass = (90.0 - degrees) % 360.0
    return compass


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    radius = 6_371_008.8
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Bridge state
# ---------------------------------------------------------------------------

class NavigationRunner:
    """Owns a gps_navigator.py subprocess (autonomous RTK closed-loop)."""

    def __init__(self, bridge, python: str, script: str, speed: float, radius: float):
        self.bridge = bridge
        self.python = python
        self.script = script
        self.speed = speed
        self.radius = radius
        self.process: Optional[subprocess.Popen] = None
        self.task_id: Optional[str] = None
        self.waypoints_file: Optional[str] = None
        self._monitor = None

    def start(self, task: NavigationTask, waypoints_file: str,
              speed: Optional[float] = None, radius: Optional[float] = None):
        self.stop()
        self.task_id = task.task_id
        self.waypoints_file = waypoints_file
        speed = speed if speed is not None else self.speed
        radius = radius if radius is not None else self.radius
        self.bridge.log(
            "NAV",
            "launching gps_navigator for {} (speed={} m/s, radius={} m): {}".format(
                task.task_id, speed, radius, waypoints_file
            ),
        )
        try:
            self.process = subprocess.Popen(
                [
                    self.python,
                    self.script,
                    "--waypoints",
                    waypoints_file,
                    "--speed",
                    str(speed),
                    "--radius",
                    str(radius),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self.bridge.send_all(status_message(task.task_id, "fault", message="gps_navigator failed to start: {}".format(exc)))
            self.process = None
            self.task_id = None
            return
        self._monitor = threading.Thread(target=self._wait, name="wifi-nav-monitor", daemon=True)
        self._monitor.start()

    def _wait(self):
        process = self.process
        task_id = self.task_id
        if process is None:
            return
        try:
            for raw_line in process.stdout:
                line = raw_line.rstrip()
                if line:
                    self.bridge.log("NAV", line)
        except Exception:
            pass
        returncode = process.wait()
        if self.process is not process:
            return  # replaced by a newer run
        self.process = None
        if returncode == 0 and self.task_id == task_id:
            self.bridge.send_all(status_message(task_id, "arrived", message="gps_navigator finished"))
            self.bridge.log("NAV", "arrived {}".format(task_id))
        elif self.task_id == task_id:
            self.bridge.send_all(status_message(task_id, "fault", message="gps_navigator exited {}".format(returncode)))
            self.bridge.log("ERROR", "gps_navigator exited {}".format(returncode))
        self.task_id = None

    def stop(self, reason: Optional[str] = None):
        process = self.process
        if process is not None and process.poll() is None:
            self.bridge.log("NAV", "terminating gps_navigator ({})".format(reason or "stop"))
            process.terminate()
            try:
                process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                process.kill()
        self.process = None
        self.task_id = None


class Car7WifiBridge:
    def __init__(self, options):
        self.options = options
        self.connections: List[WebSocketConnection] = []
        self.connections_lock = threading.Lock()
        self.framer = JSONLineFramer()
        self.started_at = time.time()

        self.active_task: Optional[NavigationTask] = None
        self.streaming: Optional[dict] = None
        self.next_waypoint_index = 0
        self.replay_source_id = None
        self.task_lock = threading.Lock()

        self.move_client = MoveClient("127.0.0.1", options.executor_port, self.on_move_reply)
        self.navigator = NavigationRunner(
            self, options.python, options.navigator, options.speed, options.radius
        )

        # telemetry state
        self.fix = None            # latest NavSatFix
        self.imu_yaw = None        # compass degrees
        self.odom_speed = None     # m/s
        self.fix_lock = threading.Lock()
        self.telemetry_thread = None

        self.ros = None
        self.teleop = None
        self.teleop_thread = None

    # ── logging / broadcast ───────────────────────────────────────────────

    @staticmethod
    def log(category, message):
        print("[{}] {}".format(category, message), flush=True)

    def send_all(self, message: dict):
        data = encode_line(message)
        with self.connections_lock:
            targets = list(self.connections)
        for connection in targets:
            connection.enqueue_text(data.decode("utf-8"))

    # ── lifecycle ─────────────────────────────────────────────────────────

    def start(self):
        scheme = "wss" if (self.options.tls_cert and self.options.tls_key) else "ws"
        if self.options.drive:
            self.log("BOOT", "DRIVE mode: accepted routes launch gps_navigator (autonomous motion)")
        elif self.options.direction:
            self.log("BOOT", "telemetry + DIRECTION mode; executes web joystick steps on the real chassis")
        else:
            self.log("BOOT", "telemetry-only mode; no motor or ROS2 output")
        if self.options.replay_fallback:
            self.log("BOOT", "replay fallback enabled (positions replay route when RTK has no fix)")
        if scheme == "wss":
            self.log("BOOT", "TLS enabled: serving wss:// (cert={})".format(self.options.tls_cert))
        self.move_client.start()
        self.ros = RosTelemetry(self._on_fix, self._on_imu, self._on_odom, self._on_nav_status)
        if self.ros.start():
            self.log("RTK", "ROS telemetry thread started (fix/imu/odom)")
            self.ros.ready.wait(timeout=5.0)  # node 在后台线程创建，等它就绪
        else:
            self.log("RTK", "rclpy unavailable — telemetry will use replay fallback only")
        self.telemetry_thread = threading.Thread(target=self._telemetry_loop, name="wifi-telemetry", daemon=True)
        self.telemetry_thread.start()
        if self.ros.node is not None and self.ros.cmd_pub is not None:
            # campusCar web_teleop 移植逻辑（car7_teleop.TeleopState）
            self.teleop = TeleopState(
                max_linear=self.options.max_linear,
                max_angular=self.options.max_angular,
                deadman=self.options.teleop_deadman,
            )
            self.teleop_thread = threading.Thread(target=self._teleop_loop, name="wifi-teleop", daemon=True)
            self.teleop_thread.start()
            self.log("BOOT", "teleop continuous drive ready (max_linear={} m/s, max_angular={} rad/s, rate={}Hz)".format(
                self.options.max_linear, self.options.max_angular, self.options.teleop_rate))
        else:
            self.log("BOOT", "teleop continuous drive unavailable (no ROS publisher)")
        self.log("READY", "{} v{} listening on {}://{}:{}/".format(SERVICE_NAME, SERVICE_VERSION, scheme, self.options.host, self.options.port))

    def shutdown(self):
        self.navigator.stop(reason="bridge shutdown")
        self.stop_teleop(reason="bridge shutdown", hard=True)
        self.move_client.close()
        with self.connections_lock:
            for connection in self.connections:
                connection.close()

    # ── ROS callbacks ─────────────────────────────────────────────────────

    def _on_fix(self, msg):
        with self.fix_lock:
            self.fix = msg

    def _on_imu(self, msg):
        try:
            yaw = quat_to_yaw_enu(msg.orientation.x, msg.orientation.y, msg.orientation.z, msg.orientation.w)
            with self.fix_lock:
                self.imu_yaw = enu_yaw_to_compass(yaw) if yaw is not None else None
        except Exception:
            pass

    def _on_odom(self, msg):
        try:
            with self.fix_lock:
                self.odom_speed = msg.twist.twist.linear.x
        except Exception:
            pass

    def _on_nav_status(self, text):
        """Forward gps_navigator /nav_status (e.g. 'WP 3/100 | dist=1.2m | ...')
        to the web panel as a status message with live waypoint progress."""
        text = (text or "").strip()
        if not text:
            return
        with self.task_lock:
            task = self.active_task
        if task is None:
            return
        self.send_all(status_message(task.task_id, "navigating", message=text))
        self.log("NAV", text)

    def _latest_rtk_position(self):
        """(lat, lon, fix_status, accuracy) from the latest /fix, or None.

        Robust against malformed fixes (e.g. the NMEA driver emitting 1-element
        numpy arrays when the RTK module disappears from USB): any conversion
        or finite-check failure returns None so telemetry falls back to replay.
        """
        with self.fix_lock:
            fix = self.fix
        if fix is None:
            return None
        try:
            status = int(fix.status.status)
            latitude = float(fix.latitude)
            longitude = float(fix.longitude)
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(latitude) and math.isfinite(longitude)
                and -90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
            return None
        name = FIX_STATUS_MAP.get(status, "fix_{}".format(status))
        accuracy = DEFAULT_ACCURACY_METERS.get(name)
        covariance = getattr(fix, "position_covariance", None)
        # rclpy exposes position_covariance as a numpy array: never test it
        # for truthiness directly (ambiguous for multi-element arrays).
        if covariance is not None and len(covariance) >= 3:
            # NavSatFix stores the 3x3 covariance row-major; use the diagonal
            # (indices 0,4,8) like rtk_fixed_logger's covariance_hint.
            diagonal = [float(covariance[index]) for index in (0, 4, 8)
                        if index < len(covariance)
                        and isinstance(covariance[index], (int, float))
                        and covariance[index] >= 0]
            if diagonal and all(math.isfinite(value) for value in diagonal):
                accuracy = math.sqrt(sum(diagonal) / len(diagonal))
        return latitude, longitude, name, accuracy

    # ── teleop continuous drive ────────────────────────────────────────────

    def _publish_twist(self, linear, angular):
        node = self.ros.node if self.ros is not None else None
        if node is None or self.ros.cmd_pub is None:
            self.log("ERROR", "cmd_vel publish skipped (node={} pub={})".format(
                node is not None, self.ros.cmd_pub is not None if self.ros else None))
            return
        msg = Twist()
        msg.linear.x = float(linear)
        msg.angular.z = float(angular)
        try:
            self.ros.cmd_pub.publish(msg)
        except Exception as exc:  # pragma: no cover
            self.log("ERROR", "cmd_vel publish: {}".format(exc))

    def _teleop_loop(self):
        tick_count = 0
        while True:
            time.sleep(self.options.teleop_interval)
            try:
                if self.teleop is not None:
                    linear, angular = self.teleop.tick()
                    self._publish_twist(linear, angular)
                    tick_count += 1
                    if tick_count % 20 == 0:
                        snap = self.teleop.snapshot()
                        self.log("TELEOP", "lin={} ang={} target=({},{}) scale={}".format(
                            snap["cmd_linear"], snap["cmd_angular"],
                            snap["target_linear"], snap["target_angular"], snap["speed_scale"]))
            except Exception as exc:  # pragma: no cover
                self.log("ERROR", "teleop tick: {}".format(exc))

    def stop_teleop(self, reason: str, hard: bool = True):
        if self.teleop is not None and self.teleop.moving():
            self.log("SAFE", "teleop stopped: {}".format(reason))
        if self.teleop is not None:
            self.teleop.stop(hard=hard)

    # ── telemetry loop (2 Hz) ─────────────────────────────────────────────

    def _telemetry_loop(self):
        while True:
            time.sleep(0.5)
            try:
                self._telemetry_tick()
            except Exception as exc:  # pragma: no cover
                self.log("ERROR", "telemetry tick: {}".format(exc))

    def _telemetry_tick(self):
        rtk = self._latest_rtk_position()
        with self.task_lock:
            task = self.active_task
        if rtk is not None:
            latitude, longitude, fix_name, accuracy = rtk
            self._publish_rtk_position(task, latitude, longitude, fix_name, accuracy)
            return
        # No valid RTK fix: replay the active route when allowed.
        if self.options.replay_fallback and task is not None and task.route.waypoints:
            self._send_next_replay_waypoint(task)
            return
        if task is not None and not getattr(self, "_fix_lost_sent", False):
            self._fix_lost_sent = True
            self.send_all(status_message(task.task_id, "rtk_unavailable", message="no valid RTK fix; waiting for /fix"))

    def _publish_rtk_position(self, task, latitude, longitude, fix_name, accuracy):
        with self.fix_lock:
            heading = self.imu_yaw
            speed = self.odom_speed
        message = position_message(
            task.task_id if task is not None else None,
            longitude,
            latitude,
            heading,
            accuracy if accuracy is not None else 0.5,
            iso8601_now(),
        )
        message["fixStatus"] = fix_name
        if speed is not None:
            message["speedMetersPerSecond"] = round(float(speed), 3)
        self.send_all(message)
        self.log(
            "POS",
            "rtk {} lat={} lon={} hdg={} acc={}".format(
                fix_name, latitude, longitude,
                round(heading, 1) if heading is not None else None,
                accuracy,
            ),
        )

    def _send_next_replay_waypoint(self, task):
        waypoints = task.route.waypoints
        if not waypoints:
            return
        index = self.next_waypoint_index
        if index >= len(waypoints):
            # Replay finished (no RTK fix, no --drive): declare arrival like the
            # BLE bridge's non-loop playback, then clear the task.
            self.send_all(status_message(task.task_id, "arrived", message="replay complete (no RTK fix)"))
            self.log("TASK", "arrived {} (replay complete)".format(task.task_id))
            self.stop_task(reason="replay complete")
            return
        waypoint = waypoints[index]
        if len(waypoints) < 2:
            heading = None
        elif index + 1 < len(waypoints):
            heading = bearing_degrees(waypoint.latitude, waypoint.longitude,
                                      waypoints[index + 1].latitude, waypoints[index + 1].longitude)
        else:
            heading = bearing_degrees(waypoints[index - 1].latitude, waypoints[index - 1].longitude,
                                      waypoint.latitude, waypoint.longitude)
        message = position_message(
            task.task_id, waypoint.longitude, waypoint.latitude, heading,
            DEFAULT_ACCURACY_METERS.get("rtk_fixed", 0.03) if self.options.replay_accuracy_meters is None
            else self.options.replay_accuracy_meters,
            iso8601_now(),
        )
        message["fixStatus"] = "replay"
        message["speedMetersPerSecond"] = 0.0
        self.send_all(message)
        self.next_waypoint_index += 1
        self.log("POS", "replay {}/{} lat={} lon={}".format(index + 1, len(waypoints), waypoint.latitude, waypoint.longitude))

    # ── WebSocket plumbing ────────────────────────────────────────────────

    def on_text(self, connection: WebSocketConnection, payload: bytes):
        try:
            frames = self.framer.append(payload)
        except FramingError as exc:
            self.log("DROP", str(exc))
            return
        for frame in frames:
            try:
                self.handle(parse_command(frame))
            except (Car7CommandError, ValueError) as exc:
                detail = exc.description() if isinstance(exc, Car7CommandError) else str(exc)
                self.log("DROP", "ignored invalid JSON line: {}".format(detail))

    # ── command handling (mirrors car7_ble_bridge.handle) ─────────────────

    def handle(self, command):
        if isinstance(command, NavigationStart):
            self.begin_streaming(command)
        elif isinstance(command, WaypointLine):
            self.append_waypoint(command)
        elif isinstance(command, NavigationEnd):
            self.finish_streaming(command)
        elif isinstance(command, NavigationTask):
            self.start_task(command)
        elif isinstance(command, EmergencyStop):
            self.handle_emergency_stop(command)
        elif isinstance(command, DirectionCommand):
            self.handle_direction(command)
        elif isinstance(command, GotoTarget):
            self.handle_goto(command)

    # ── goto_target: send the car to one WGS84 point (next-step nav) ──────

    def handle_goto(self, command: GotoTarget):
        """A `goto_target` replaces the current task: stop any navigation or
        queued direction, export a single-waypoint file and (with --drive)
        launch gps_navigator for RTK closed-loop tracking of that point."""
        self.stop_task(reason="goto_target {}".format(command.command_id))
        task = NavigationTask(
            task_id=command.command_id,
            created_at=command.created_at,
            dataset=None,
            route=NavigationRoute(
                origin="goto",
                destination="goto",
                mode="robot",
                coordinate_system="WGS84 longitude/latitude",
                distance_meters=None,
                duration_seconds=None,
                waypoints=[NavigationWaypoint(
                    sequence=0,
                    node_id=None,
                    longitude=command.longitude,
                    latitude=command.latitude,
                    kind="goto",
                )],
            ),
        )
        with self.task_lock:
            self.active_task = task
            self.streaming = {"expected_count": 1, "completed": True}
        self.next_waypoint_index = 0
        self._fix_lost_sent = False
        waypoints_file = self.export_goto_target(command)
        self.send_all(acknowledgement(
            command.command_id, "accepted",
            message="goto target lat={} lon={}".format(command.latitude, command.longitude),
        ))
        self.log("TASK", "goto {}: lat={} lon={} speed={} radius={}".format(
            command.command_id, command.latitude, command.longitude,
            command.speed_meters_per_second, command.arrival_radius_meters))
        if self.options.drive and waypoints_file:
            self.send_all(status_message(command.command_id, "navigating",
                                         message="goto target (drive)"))
            self.navigator.start(
                task, waypoints_file,
                speed=command.speed_meters_per_second or self.options.speed,
                radius=command.arrival_radius_meters or self.options.radius,
            )
        else:
            self.send_all(status_message(command.command_id, "navigating",
                                         message="goto target (no --drive: telemetry only)"))

    def handle_emergency_stop(self, command: EmergencyStop):
        stopped_task_id = command.task_id
        with self.task_lock:
            if stopped_task_id is None and self.active_task is not None:
                stopped_task_id = self.active_task.task_id
        self.stop_task(reason="emergency_stop {}".format(command.command_id))
        self.move_client.stop_now()
        self.stop_teleop(reason="emergency_stop", hard=True)
        self.send_all(acknowledgement(stopped_task_id, "stopped"))
        self.send_all(status_message(stopped_task_id, "stopped", message=command.reason))
        self.log("TASK", "emergency stop {}".format(command.command_id))

    def handle_direction(self, command: DirectionCommand):
        if not self.options.direction:
            self.log("TASK", "direction ignored: bridge started without --direction")
            self.send_all(acknowledgement(None, "rejected", message="direction control disabled"))
            return
        if command.continuous:
            self.handle_continuous_direction(command)
            return
        if command.direction == "stop":
            self.move_client.stop_now()
            self.send_all(acknowledgement(None, "accepted", message="stop sent"))
            self.log("TASK", "direction stop {}".format(command.command_id))
            return
        mapping = {
            "forward": ("FORWARD", command.amount_meters),
            "backward": ("BACKWARD", command.amount_meters),
            "left": ("LEFT", command.amount_degrees),
            "right": ("RIGHT", command.amount_degrees),
        }
        executor_command, amount = mapping[command.direction]
        self.log(
            "TASK",
            "direction {}: {} {} speed={} m/s".format(
                command.command_id, executor_command, amount,
                command.speed_meters_per_second if command.speed_meters_per_second is not None else "default",
            ),
        )
        # Manual (ble) priority > nav: a direction preempts the running navigator.
        if self.options.drive:
            with self.task_lock:
                task = self.active_task
            if task is not None:
                self.stop_task(reason="direction {} preempted navigation".format(command.direction))
        self.move_client.submit(executor_command, amount, command.speed_meters_per_second)
        self.send_all(acknowledgement(None, "accepted", message=command.direction))

    def handle_continuous_direction(self, command: DirectionCommand):
        """Continuous drive: set the /cmd_vel target; the TeleopDriver keeps
        publishing with slew smoothing until stop / deadman / disconnect."""
        if command.direction == "stop":
            self.log("TASK", "teleop stop {}".format(command.command_id))
            self.move_client.stop_now()
            self.stop_teleop(reason="teleop stop {}".format(command.command_id), hard=True)
            self.send_all(acknowledgement(None, "accepted", message="teleop stop"))
            return
        speed = (command.speed_meters_per_second
                 if command.speed_meters_per_second is not None
                 else self.options.teleop_speed)
        self.log("TASK", "teleop {}: {} m/s".format(command.direction, speed))
        self.move_client.stop_now()  # 连续模式与步进互斥
        if self.teleop is not None:
            self.teleop.set_direction(command.direction, speed)
        self.send_all(acknowledgement(None, "accepted", message="teleop {}".format(command.direction)))

    # ── navigation tasks ──────────────────────────────────────────────────

    def start_task(self, task: NavigationTask):
        """Legacy single-document navigation_task."""
        self.stop_task(reason=None)
        with self.task_lock:
            self.active_task = task
            self.streaming = {"expected_count": len(task.route.waypoints), "completed": True}
        self.next_waypoint_index = 0
        self._fix_lost_sent = False
        self.log("TASK", "accepted {}: {} -> {}, {} waypoints".format(
            task.task_id, task.route.origin, task.route.destination, len(task.route.waypoints)))
        self._on_route_complete(task)

    def begin_streaming(self, start: NavigationStart):
        self.stop_task(reason=None)
        task = NavigationTask(
            task_id=start.task_id,
            created_at=start.created_at,
            dataset=start.dataset,
            route=NavigationRoute(
                origin=start.origin,
                destination=start.destination,
                mode=start.mode,
                coordinate_system=start.coordinate_system,
                distance_meters=start.distance_meters,
                duration_seconds=start.duration_seconds,
                waypoints=[],
            ),
        )
        with self.task_lock:
            self.active_task = task
            self.streaming = {"expected_count": start.waypoint_count, "completed": False}
        self.next_waypoint_index = 0
        self._fix_lost_sent = False
        self.log("TASK", "streaming {}: {} -> {}, expecting {} waypoints".format(
            task.task_id, start.origin, start.destination, start.waypoint_count))
        self.send_all(acknowledgement(task.task_id, "accepted",
                                      message="streaming {} waypoints".format(start.waypoint_count)))

    def append_waypoint(self, line: WaypointLine):
        with self.task_lock:
            task = self.active_task
            streaming = self.streaming
            if task is None or streaming is None:
                self.log("DROP", "waypoint without navigation_start")
                return
            if line.task_id != task.task_id:
                self.log("DROP", "waypoint taskId mismatch: got {} expected {}".format(line.task_id, task.task_id))
                return
            if streaming["completed"]:
                self.log("DROP", "waypoint after navigation_end: sequence {}".format(line.waypoint.sequence))
                return
            waypoints = task.route.waypoints
            if line.waypoint.sequence != len(waypoints):
                self.log("DROP", "waypoint sequence gap: expected {} got {}".format(len(waypoints), line.waypoint.sequence))
                return
            waypoints.append(line.waypoint)
            received = len(waypoints)
            expected = streaming["expected_count"]
        if received == 1:
            self.send_all(status_message(task.task_id, "navigating"))
        if received >= expected:
            self.complete_streaming()

    def finish_streaming(self, end: NavigationEnd):
        with self.task_lock:
            task = self.active_task
            streaming = self.streaming
            if task is None or streaming is None:
                self.log("DROP", "navigation_end without navigation_start")
                return
            if end.task_id != task.task_id:
                self.log("DROP", "navigation_end taskId mismatch")
                return
            received = len(task.route.waypoints)
            expected = streaming["expected_count"]
        if received != expected:
            self.log("ERROR", "route incomplete {}: received {} / expected {}".format(task.task_id, received, expected))
            self.send_all(status_message(task.task_id, "fault", message="incomplete route"))
            self.stop_task(reason="incomplete route")
            return
        self.complete_streaming()

    def complete_streaming(self):
        with self.task_lock:
            task = self.active_task
            streaming = self.streaming
            if task is None or streaming is None or streaming["completed"]:
                return
            if len(task.route.waypoints) < streaming["expected_count"]:
                return
            streaming["completed"] = True
        self.log("TASK", "route complete {}: {} waypoints".format(task.task_id, len(task.route.waypoints)))
        self._on_route_complete(task)

    def _on_route_complete(self, task: NavigationTask):
        """Route is fully in hand: export for campusCar and act according to flags."""
        waypoints_file = self.export_campuscar_route(task)
        self.send_all(acknowledgement(task.task_id, "accepted"))
        self.send_all(status_message(task.task_id, "navigating"))
        if self.options.drive and waypoints_file:
            self.navigator.start(task, waypoints_file)
            return
        # telemetry-only / replay: keep the task active so telemetry has a route
        self.log("TASK", "{} (no --drive: telemetry only)".format(
            "route ready" if waypoints_file else "route accepted without export"))

    def stop_task(self, reason: Optional[str]):
        with self.task_lock:
            self.active_task = None
            self.streaming = None
        self.next_waypoint_index = 0
        self._fix_lost_sent = False
        self.navigator.stop(reason=reason)
        self.log("TASK", "task cleared: {}".format(reason or "replaced"))

    # ── campusCar export (atomic, same as BLE bridge) ─────────────────────

    def export_campuscar_route(self, task: NavigationTask) -> Optional[str]:
        raw_path = self.options.campuscar_export
        if not raw_path:
            return None
        path = os.path.abspath(os.path.expanduser(raw_path))
        directory = os.path.dirname(path)
        try:
            os.makedirs(directory, exist_ok=True)
            payload = encode_pretty(campuscar_waypoint_file(task))
            fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".lubannav-", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(payload)
                os.replace(tmp_path, path)
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            self.log("EXPORT", "campusCar waypoint file: {}".format(path))
            return path
        except OSError as exc:
            self.log("ERROR", "campusCar export failed: {}".format(exc))
            return None

    def export_goto_target(self, command: GotoTarget) -> Optional[str]:
        """Single-waypoint campusCar file for a goto_target (gps_navigator
        accepts one target as a one-waypoint route)."""
        raw_path = self.options.goto_export
        if not raw_path:
            return None
        path = os.path.abspath(os.path.expanduser(raw_path))
        directory = os.path.dirname(path)
        point = {"lat": command.latitude, "lon": command.longitude, "alt": 0}
        payload = encode_pretty({"origin": dict(point), "waypoints": [point]})
        try:
            os.makedirs(directory, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".lubannav-", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(payload)
                os.replace(tmp_path, path)
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            self.log("EXPORT", "goto target file: {}".format(path))
            return path
        except OSError as exc:
            self.log("ERROR", "goto export failed: {}".format(exc))
            return None

    # ── move executor replies ─────────────────────────────────────────────

    def on_move_reply(self, kind, detail):
        with self.task_lock:
            task = self.active_task
        if task is None:
            if kind not in ("OK",):
                self.log("TASK", "direction step done: {} {}".format(kind, detail or ""))
            return
        if kind in ("DONE", "STOPPED", "OK"):
            self.log("TASK", "move step done: {} {}".format(kind, detail or 0.0))
        elif kind in ("TIMEOUT", "ERR"):
            self.log("ERROR", "move executor {} {}".format(kind, detail or ""))
            self.move_client.submit("STOP", None)

    # ── HTTP status page ──────────────────────────────────────────────────

    @staticmethod
    def _http_json(code: int, payload: dict) -> bytes:
        body = json.dumps(payload, ensure_ascii=False)
        return (
            "HTTP/1.1 {} {}\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type\r\n"
            "Cache-Control: no-store\r\n"
            "Content-Length: {}\r\n"
            "Connection: close\r\n\r\n{}".format(
                code, "OK" if code == 200 else ("Not Found" if code == 404 else "Bad Request"),
                len(body.encode("utf-8")), body
            )
        ).encode("utf-8")

    def handle_http_command(self, raw_line: str) -> dict:
        """Execute one protocol JSON line (HTTP POST path). Returns a summary
        for the caller; the real ack/status messages still broadcast to WS
        clients as usual."""
        try:
            command = parse_command(raw_line.encode("utf-8"))
        except (Car7CommandError, ValueError) as exc:
            detail = exc.description() if isinstance(exc, Car7CommandError) else str(exc)
            return {"ok": False, "error": detail}
        self.handle(command)
        if isinstance(command, EmergencyStop):
            return {"ok": True, "status": "stopped"}
        if isinstance(command, DirectionCommand):
            if not self.options.direction:
                return {"ok": True, "status": "rejected", "message": "direction control disabled"}
            return {"ok": True, "status": "accepted",
                    "message": "teleop {}".format(command.direction)}
        return {"ok": True, "status": "accepted"}

    def http_command_response(self, body: bytes) -> bytes:
        """POST /api/cmd: JSON or JSONL body -> execute each line -> summary."""
        results = []
        for line in body.decode("utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            results.append(self.handle_http_command(line))
        if not results:
            return self._http_json(400, {"ok": False, "error": "empty command body"})
        return self._http_json(200, {"ok": all(r["ok"] for r in results), "results": results})

    def http_status(self) -> bytes:
        with self.fix_lock:
            fix = self.fix
        rtk = self._latest_rtk_position()
        with self.task_lock:
            task_id = self.active_task.task_id if self.active_task else None
        payload = {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "protocol": PROTOCOL_NAME,
            "uptimeSeconds": round(time.time() - self.started_at, 1),
            "clients": len(self.connections),
            "flags": {
                "direction": self.options.direction,
                "drive": self.options.drive,
                "replayFallback": self.options.replay_fallback,
                "tls": bool(self.options.tls_cert and self.options.tls_key),
            },
            "rtk": {
                "fixStatus": rtk[2] if rtk else FIX_STATUS_MAP.get(int(fix.status.status), "no_fix") if fix is not None else "no_fix",
                "latitude": rtk[0] if rtk else None,
                "longitude": rtk[1] if rtk else None,
                "accuracyMeters": rtk[3] if rtk else None,
                "rawStatus": int(fix.status.status) if fix is not None else None,
            },
            "activeTask": task_id,
            "executorPort": self.options.executor_port,
        }
        body = json.dumps(payload, indent=2, sort_keys=True)
        return (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Cache-Control: no-store\r\n"
            "Content-Length: {}\r\n"
            "Connection: close\r\n\r\n{}".format(len(body.encode("utf-8")), body)
        ).encode("utf-8")


# ---------------------------------------------------------------------------
# Server accept loop
# ---------------------------------------------------------------------------

def make_ssl_context(certfile: str, keyfile: str):
    """Server-side TLS context for wss:// (stdlib only).

    The certificate must cover the IP/hostname the browser connects to and be
    signed by a CA the browser trusts — for an intranet car, generate one with
    tools/car7-wifi-tools/make_car7_cert.sh (local CA) and install that CA on
    the operator's devices once.
    """
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile, keyfile)
    return context


def serve(bridge: Car7WifiBridge, host: str, port: int):
    ssl_context = None
    if bridge.options.tls_cert and bridge.options.tls_key:
        ssl_context = make_ssl_context(bridge.options.tls_cert, bridge.options.tls_key)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(16)
    server.settimeout(1.0)
    while True:
        try:
            sock, address = server.accept()
        except socket.timeout:
            continue
        except OSError:
            return
        if ssl_context is not None:
            try:
                sock = ssl_context.wrap_socket(sock, server_side=True)
            except (ssl.SSLError, OSError) as exc:
                bridge.log("DROP", "TLS handshake failed from {}: {}".format(address, exc))
                try:
                    sock.close()
                except OSError:
                    pass
                continue
        sock.settimeout(1.0)
        threading.Thread(
            target=handle_connection, args=(bridge, sock, address),
            daemon=True, name="wifi-ws-conn",
        ).start()


def handle_connection(bridge: Car7WifiBridge, sock: socket.socket, address):
    try:
        data = sock.recv(65536)
    except OSError:
        sock.close()
        return
    if not data:
        sock.close()
        return
    try:
        request_line, headers, _ = parse_http_request(data)
    except WebSocketError as exc:
        bridge.log("DROP", "bad request from {}: {}".format(address, exc))
        sock.close()
        return
    method, target, _version = (request_line + " ").split(" ", 2)
    upgrade = headers.get("upgrade", "").lower()
    if upgrade != "websocket":
        if method == "GET":
            # Plain HTTP GET: status page (used for quick health checks).
            sock.sendall(bridge.http_status())
        elif method == "POST" and target.startswith("/api/cmd"):
            body = data.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in data else b""
            content_length = int(headers.get("content-length", "0") or "0")
            while len(body) < content_length:
                try:
                    chunk = sock.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                body += chunk
            sock.sendall(bridge.http_command_response(body))
        elif method == "OPTIONS":
            sock.sendall(bridge._http_json(200, {"ok": True}))
        else:
            sock.sendall(bridge._http_json(404, {"ok": False, "error": "not found"}))
        sock.close()
        return
    key = headers.get("sec-websocket-key")
    if not key:
        bridge.log("DROP", "websocket handshake missing key from {}".format(address))
        sock.close()
        return
    accept = websocket_accept_key(key)
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: {}\r\n\r\n".format(accept)
    )
    try:
        sock.sendall(response.encode("ascii"))
    except OSError:
        sock.close()
        return
    connection = WebSocketConnection(sock, address, bridge)
    with bridge.connections_lock:
        bridge.connections.append(connection)
    bridge.log("LINK", "client connected: {}".format(address))
    threading.Thread(target=connection.sender_loop, daemon=True, name="wifi-ws-send").start()
    try:
        connection.read_frames()
    finally:
        with bridge.connections_lock:
            if connection in bridge.connections:
                bridge.connections.remove(connection)
            remaining = len(bridge.connections)
        bridge.log("LINK", "client disconnected: {}".format(address))
        if remaining == 0:
            bridge.stop_teleop(reason="all clients disconnected", hard=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_options(argv):
    parser = argparse.ArgumentParser(
        prog="car7-wifi-bridge",
        description="LubanNav robot protocol over WebSocket on the car7 NUC (WiFi transport).",
    )
    parser.add_argument("--host", default="0.0.0.0", help="listen address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8900, help="WebSocket port (default 8900)")
    parser.add_argument(
        "--executor-port",
        type=int,
        default=MOVE_EXECUTOR_PORT,
        help="move executor TCP port (default: 9099)",
    )
    parser.add_argument(
        "--direction",
        action="store_true",
        help=(
            "DANGER: execute manual direction commands (forward/backward/left/right/stop) "
            "from the web joystick pad on the real chassis via the move executor."
        ),
    )
    parser.add_argument(
        "--drive",
        action="store_true",
        help=(
            "DANGER: on every accepted navigation task, launch gps_navigator.py which "
            "drives the real chassis with RTK closed-loop control. Default off (telemetry only)."
        ),
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=0.2,
        help="gps_navigator max speed in m/s (default 0.2)",
    )
    parser.add_argument(
        "--radius",
        type=float,
        default=0.6,
        help="gps_navigator arrival radius in meters (default 0.6)",
    )
    parser.add_argument(
        "--replay-fallback",
        action="store_true",
        default=True,
        help=(
            "when RTK has no valid fix, replay the active route waypoints as position "
            "telemetry so the web loop stays demonstrable (default on)"
        ),
    )
    parser.add_argument(
        "--no-replay-fallback",
        action="store_false",
        dest="replay_fallback",
        help="disable replay fallback (positions only from real RTK fixes)",
    )
    parser.add_argument(
        "--replay-accuracy-meters",
        type=float,
        default=None,
        help="accuracyMeters reported by replay fallback (default 0.03)",
    )
    parser.add_argument(
        "--campuscar-export",
        default=None,
        help="write campusCar gps_navigator waypoint JSON on every accepted route",
    )
    parser.add_argument(
        "--goto-export",
        default=None,
        help="write the single-waypoint campusCar file for goto_target commands",
    )
    parser.add_argument(
        "--max-linear",
        type=float,
        default=5.0,
        help="teleop continuous-drive linear speed cap in m/s (default 5.0, robot.env MAX_LINEAR_SPEED)",
    )
    parser.add_argument(
        "--max-angular",
        type=float,
        default=5.0,
        help="teleop continuous-drive angular speed cap in rad/s (default 5.0)",
    )
    parser.add_argument(
        "--teleop-speed",
        type=float,
        default=1.0,
        help="teleop default speed in m/s when the command omits speedMetersPerSecond",
    )
    parser.add_argument(
        "--teleop-rate",
        type=float,
        default=20.0,
        help="teleop /cmd_vel publish rate in Hz (default 20, web_teleop parity)",
    )
    parser.add_argument(
        "--teleop-deadman",
        type=float,
        default=0.45,
        help="teleop deadman in seconds: auto-stop when no new command arrives (default 0.45, web_teleop parity)",
    )
    parser.add_argument(
        "--tls-cert",
        default=None,
        help="TLS certificate file (PEM). When set together with --tls-key the "
             "bridge serves wss:// instead of ws://. Generate for the car with "
             "tools/car7-wifi-tools/make_car7_cert.sh (local CA).",
    )
    parser.add_argument(
        "--tls-key",
        default=None,
        help="TLS private key file (PEM, unencrypted)",
    )
    parser.add_argument(
        "--navigator",
        default="/workspace/campusCar-new-chassis/src/rtk_tools/gps_navigator.py",
        help="path to gps_navigator.py (default: container path)",
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="python executable used to launch gps_navigator (default: sys.executable)",
    )
    options = parser.parse_args(argv)
    options.teleop_interval = 1.0 / options.teleop_rate
    return options


def main(argv=None):
    options = parse_options(sys.argv[1:] if argv is None else argv)
    bridge = Car7WifiBridge(options)
    bridge.start()
    try:
        serve(bridge, options.host, options.port)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.shutdown()


if __name__ == "__main__":
    main()
