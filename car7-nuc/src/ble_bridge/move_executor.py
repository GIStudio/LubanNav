#!/usr/bin/env python3
"""Move executor for the campusCar chassis: odom-closed-loop short moves.

Runs INSIDE the campuscar docker container (ROS2 /cmd_vel publisher,
/odom feedback). Listens on 127.0.0.1:9099 (container runs with --net=host,
so the host BLE bridge reaches it on localhost) for line-based commands:

  FORWARD <meters>   -> DONE <traveled> | TIMEOUT <traveled> | ERR <msg>
  BACKWARD <meters>  -> DONE <traveled> | TIMEOUT <traveled> | ERR <msg>
  STOP               -> STOPPED <traveled>   (stops immediately, cancels move)
  STATUS             -> STATE <idle|moving>

Safety: low default speed (0.06 m/s), hard timeout, stop on TCP disconnect,
stop on STOP. Never moves unless a move is explicitly requested.
"""

from __future__ import annotations

import argparse
import math
import socket
import threading
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry


class MoveExecutor(Node):
    def __init__(self, speed: float, timeout: float, angular_speed: float = 0.3):
        super().__init__("move_executor")
        self.speed = speed
        self.timeout = timeout
        self.angular_speed = angular_speed

        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)
        self.sub = self.create_subscription(Odometry, "/odom", self._on_odom, 10)

        self.lock = threading.Lock()
        self.mode = "IDLE"          # IDLE | FWD | BACK | LEFT | RIGHT
        self.target_amount = 0.0
        self.move_start = 0.0
        self.start_x = 0.0
        self.start_y = 0.0
        self.start_yaw = 0.0
        self.latest_x = 0.0
        self.latest_y = 0.0
        self.latest_yaw = 0.0
        self.stop_requested = False
        self.done_payload = ("IDLE", 0.0)
        self.done_event = threading.Event()
        self.move_speed = None  # per-move override (m/s), None = defaults

        self.timer = self.create_timer(0.05, self._tick)
        self.get_logger().info(
            "move executor listening on 127.0.0.1:9099 "
            "(speed={:.3f} m/s, angular={:.3f} rad/s, timeout={:.1f}s)".format(
                speed, angular_speed, timeout
            )
        )

    @staticmethod
    def _quaternion_to_yaw(orientation) -> float:
        siny_cosp = 2.0 * (orientation.w * orientation.z + orientation.x * orientation.y)
        cosy_cosp = 1.0 - 2.0 * (orientation.y * orientation.y + orientation.z * orientation.z)
        return math.atan2(siny_cosp, cosy_cosp)

    @staticmethod
    def _wrap_angle(delta: float) -> float:
        return math.atan2(math.sin(delta), math.cos(delta))

    def _on_odom(self, msg: Odometry):
        with self.lock:
            self.latest_x = msg.pose.pose.position.x
            self.latest_y = msg.pose.pose.position.y
            self.latest_yaw = self._quaternion_to_yaw(msg.pose.pose.orientation)

    def _publish(self, linear: float, angular: float = 0.0):
        twist = Twist()
        twist.linear.x = linear
        twist.angular.z = angular
        self.pub.publish(twist)

    def start_move(self, direction: str, amount: float, speed=None) -> str:
        with self.lock:
            if self.mode != "IDLE":
                return "ERR busy"
            if direction in ("FORWARD", "BACKWARD"):
                if amount <= 0.0 or amount > 2.0:
                    return "ERR distance must be in (0, 2] meters"
            else:  # LEFT / RIGHT
                if amount <= 0.0 or amount > 180.0:
                    return "ERR angle must be in (0, 180] degrees"
            if speed is not None:
                try:
                    speed = float(speed)
                except (TypeError, ValueError):
                    return "ERR bad speed"
                speed = min(0.5, max(0.02, speed))
            self.mode = direction
            self.target_amount = amount
            self.move_speed = speed
            self.move_start = time.monotonic()
            self.start_x = self.latest_x
            self.start_y = self.latest_y
            self.start_yaw = self.latest_yaw
            self.stop_requested = False
            self.done_event.clear()
        self.done_payload = ("IDLE", 0.0)
        return "OK"

    def request_stop(self):
        with self.lock:
            self.stop_requested = True

    def current_state(self) -> str:
        with self.lock:
            return self.mode

    def _traveled(self) -> float:
        with self.lock:
            return math.hypot(self.latest_x - self.start_x, self.latest_y - self.start_y)

    def _turned(self) -> float:
        with self.lock:
            return abs(self._wrap_angle(self.latest_yaw - self.start_yaw))

    def _finish(self, payload, amount: float):
        with self.lock:
            self.mode = "IDLE"
            self.stop_requested = False
        self.done_payload = (payload, amount)
        self.done_event.set()
        self.get_logger().info("move finished: {} amount={:.4f}".format(payload, amount))

    def _tick(self):
        with self.lock:
            mode = self.mode
            move_speed = self.move_speed
        if mode == "IDLE":
            return
        if self.stop_requested:
            amount = self._turned() if mode in ("LEFT", "RIGHT") else self._traveled()
            self._publish(0.0, 0.0)
            self._finish("STOPPED", amount)
            return
        elapsed = time.monotonic() - self.move_start
        linear_speed = move_speed if move_speed is not None else self.speed
        angular_speed = min(1.5, linear_speed * 5.0)
        if mode in ("LEFT", "RIGHT"):
            turned = self._turned()
            if turned >= math.radians(self.target_amount):
                self._publish(0.0, 0.0)
                self._finish("DONE", math.degrees(turned))
                return
            if elapsed > self.timeout:
                self._publish(0.0, 0.0)
                self._finish("TIMEOUT", math.degrees(turned))
                return
            remaining = math.radians(self.target_amount) - turned
            # Proportional slowdown near the target to limit overshoot.
            effective = min(angular_speed, max(0.15, remaining * 3.0))
            sign = 1.0 if mode == "LEFT" else -1.0
            self._publish(0.0, sign * effective)
            return
        traveled = self._traveled()
        if traveled >= self.target_amount:
            self._publish(0.0, 0.0)
            self._finish("DONE", traveled)
            return
        if elapsed > self.timeout:
            self._publish(0.0, 0.0)
            self._finish("TIMEOUT", traveled)
            return
        remaining = self.target_amount - traveled
        effective = min(linear_speed, max(0.02, remaining * 2.0))
        sign = 1.0 if mode == "FWD" else -1.0
        self._publish(sign * effective, 0.0)


def serve(executor: MoveExecutor, host: str, port: int):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(8)
    server.settimeout(1.0)
    executor.get_logger().info("move executor TCP ready on {}:{}".format(host, port))

    while rclpy.ok():
        try:
            conn, _addr = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        executor.get_logger().info("accepted connection from {}".format(_addr))
        thread = threading.Thread(
            target=handle_connection, args=(executor, conn), daemon=True, name="move-exec-conn"
        )
        thread.start()


def handle_connection(executor: MoveExecutor, conn: socket.socket):
    conn.settimeout(0.2)
    buffer = b""
    pending_result = False
    try:
        while rclpy.ok():
            try:
                chunk = conn.recv(4096)
                if chunk == b"":
                    executor.get_logger().info("connection closed by peer")
                    break  # peer closed
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    text = line.decode("utf-8", errors="replace").strip()
                    if not text:
                        continue
                    executor.get_logger().info("cmd: {}".format(text))
                    reply, expect_result = executor_line(executor, text)
                    if reply is not None:
                        conn.sendall(reply.encode("utf-8") + b"\n")
                        executor.get_logger().info("reply: {}".format(reply))
                    if expect_result:
                        pending_result = True
            except socket.timeout:
                pass
            if pending_result and executor.done_event.is_set():
                payload, traveled = executor.done_payload
                line = "{} {:.4f}".format(payload, traveled)
                conn.sendall(line.encode("utf-8") + b"\n")
                executor.get_logger().info("result: {}".format(line))
                executor.done_event.clear()
                pending_result = False
    finally:
        conn.close()
        if executor.current_state() != "IDLE":
            executor.request_stop()


def executor_line(executor: MoveExecutor, line: str):
    """Returns (immediate_reply_or_None, expect_result_line).

    Protocol contract: exactly one reply line per command. FORWARD/BACKWARD/
    LEFT/RIGHT reply "OK" when accepted and then one result line
    (DONE/STOPPED/TIMEOUT) when the move finishes. STOP replies "OK" when
    idle, or defers to the result line (STOPPED) when a move is in progress.
    """
    if not line:
        return None, False
    parts = line.split()
    command = parts[0].upper()
    if command in ("FORWARD", "BACKWARD", "LEFT", "RIGHT"):
        if len(parts) not in (2, 3):
            return "ERR usage: {} <amount> [speed_mps]".format(command), False
        try:
            amount = float(parts[1])
        except ValueError:
            return "ERR bad amount", False
        speed = None
        if len(parts) == 3:
            try:
                speed = float(parts[2])
            except ValueError:
                return "ERR bad speed", False
        reply = executor.start_move(command, amount, speed)
        return reply, reply == "OK"
    if command == "STOP":
        if executor.current_state() != "IDLE":
            executor.request_stop()
            return None, True  # result line comes when the move stops
        return "OK", False
    if command == "STATUS":
        return "STATE {}".format(executor.current_state().lower()), False
    return "ERR unknown command", False


def main():
    parser = argparse.ArgumentParser(description="Odom-closed-loop short move executor")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9099)
    parser.add_argument("--speed", type=float, default=0.06, help="linear speed in m/s (default 0.06)")
    parser.add_argument("--timeout", type=float, default=15.0, help="hard timeout seconds (default 15)")
    args = parser.parse_args()

    rclpy.init()
    executor = MoveExecutor(speed=args.speed, timeout=args.timeout)
    server_thread = threading.Thread(
        target=serve, args=(executor, args.host, args.port), daemon=True, name="move-executor-tcp"
    )
    server_thread.start()
    try:
        rclpy.spin(executor)
    finally:
        executor.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
