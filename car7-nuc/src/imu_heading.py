#!/usr/bin/env python3
"""
IMU → heading bridge for campusCar outdoor navigation.

Hoverboard firmware IMU (when enabled) publishes accel + gyro only, no
orientation. This node:
  1) integrates gyro.z for yaw
  2) optionally soft-corrects yaw from GPS track when the car is moving
  3) publishes /imu (with orientation) and /heading (QuaternionStamped)

Usage:
  source /opt/ros/humble/setup.bash && source config/robot.env
  python3 src/imu_heading.py
  python3 src/imu_heading.py --imu-in /hoverboard/imu0/data
"""
from __future__ import annotations

import argparse
import math
import os
import shlex
import subprocess
from pathlib import Path

import rclpy
from geometry_msgs.msg import Quaternion, QuaternionStamped
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Imu, NavSatFix


def _load_project_env() -> None:
    env_file = Path(__file__).resolve().parents[1] / "config" / "robot.env"
    if not env_file.exists():
        return
    command = f"set -a; source {shlex.quote(str(env_file))}; env -0"
    try:
        result = subprocess.run(
            ["bash", "-lc", command],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=os.environ.copy(),
        )
    except Exception:
        return
    for entry in result.stdout.split(b"\0"):
        if not entry or b"=" not in entry:
            continue
        key, value = entry.split(b"=", 1)
        try:
            k = key.decode()
            v = value.decode()
        except UnicodeDecodeError:
            continue
        if k.replace("_", "").isalnum() and k and not k[0].isdigit():
            os.environ.setdefault(k, v)


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    return default if raw is None or raw == "" else raw


_load_project_env()

EARTH_RADIUS_M = 6378137.0


def yaw_to_quat(yaw: float) -> Quaternion:
    q = Quaternion()
    q.z = math.sin(yaw * 0.5)
    q.w = math.cos(yaw * 0.5)
    return q


def angle_diff(a: float, b: float) -> float:
    d = a - b
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d


def bearing_enu(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """ENU: east=0, north=pi/2."""
    mid_lat = math.radians((lat1 + lat2) * 0.5)
    east = math.radians(lon2 - lon1) * EARTH_RADIUS_M * math.cos(mid_lat)
    north = math.radians(lat2 - lat1) * EARTH_RADIUS_M
    return math.atan2(north, east)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class ImuHeadingNode(Node):
    def __init__(
        self,
        imu_in: str,
        imu_out: str,
        heading_out: str,
        fix_in: str,
        gyro_axis: str,
        gyro_sign: float,
        gps_assist: bool,
        gps_min_speed: float,
        gps_gain: float,
        initial_yaw_deg: float | None,
    ):
        super().__init__("imu_heading_node")
        self.imu_in = imu_in
        self.gyro_axis = gyro_axis
        self.gyro_sign = gyro_sign
        self.gps_assist = gps_assist
        self.gps_min_speed = gps_min_speed
        self.gps_gain = gps_gain

        self.yaw = 0.0 if initial_yaw_deg is None else math.radians(initial_yaw_deg)
        self.gyro_bias = 0.0
        self.bias_samples = 0
        self.last_imu_time = None
        self.last_fix = None  # (lat, lon, stamp_sec)
        self.got_imu = False
        self.yaw_source = "gyro"

        self.pub_imu = self.create_publisher(Imu, imu_out, 10)
        self.pub_heading = self.create_publisher(QuaternionStamped, heading_out, 10)
        self.create_subscription(Imu, imu_in, self._on_imu, qos_profile_sensor_data)
        if gps_assist:
            self.create_subscription(NavSatFix, fix_in, self._on_fix, 10)

        self.get_logger().info(
            f"IMU heading: {imu_in} → {imu_out} + {heading_out} "
            f"(gyro_axis={gyro_axis}, sign={gyro_sign}, gps_assist={gps_assist})"
        )
        if initial_yaw_deg is not None:
            self.get_logger().info(f"Initial yaw set to {initial_yaw_deg:.1f} deg (ENU)")

    def _pick_gyro(self, msg: Imu) -> float:
        if self.gyro_axis == "x":
            raw = msg.angular_velocity.x
        elif self.gyro_axis == "y":
            raw = msg.angular_velocity.y
        else:
            raw = msg.angular_velocity.z
        return self.gyro_sign * raw

    def _on_imu(self, msg: Imu):
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        if stamp <= 0.0:
            stamp = self.get_clock().now().nanoseconds * 1e-9

        omega = self._pick_gyro(msg)
        if self.last_imu_time is None:
            self.last_imu_time = stamp
            # Collect a short bias estimate while nearly still.
            if abs(omega) < 0.05:
                self.gyro_bias = omega
                self.bias_samples = 1
            self.got_imu = True
            self._publish(msg, stamp)
            return

        dt = stamp - self.last_imu_time
        self.last_imu_time = stamp
        if dt <= 0.0 or dt > 0.5:
            self._publish(msg, stamp)
            return

        # Online bias when nearly stationary (low gyro + low accel xy).
        accel_xy = math.hypot(msg.linear_acceleration.x, msg.linear_acceleration.y)
        if abs(omega) < 0.04 and accel_xy < 1.5:
            self.bias_samples = min(self.bias_samples + 1, 200)
            alpha = 1.0 / max(1, self.bias_samples)
            self.gyro_bias = (1.0 - alpha) * self.gyro_bias + alpha * omega

        self.yaw = math.atan2(
            math.sin(self.yaw + (omega - self.gyro_bias) * dt),
            math.cos(self.yaw + (omega - self.gyro_bias) * dt),
        )
        self.yaw_source = "gyro"
        self.got_imu = True
        self._publish(msg, stamp)

    def _on_fix(self, msg: NavSatFix):
        if not self.gps_assist or not self.got_imu:
            return
        if msg.status.status < 0:
            return
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        if stamp <= 0.0:
            stamp = self.get_clock().now().nanoseconds * 1e-9
        if self.last_fix is None:
            self.last_fix = (msg.latitude, msg.longitude, stamp)
            return

        lat0, lon0, t0 = self.last_fix
        dt = stamp - t0
        dist = haversine_m(lat0, lon0, msg.latitude, msg.longitude)
        self.last_fix = (msg.latitude, msg.longitude, stamp)
        if dt <= 0.05 or dt > 2.0 or dist < 0.15:
            return
        speed = dist / dt
        if speed < self.gps_min_speed:
            return

        track = bearing_enu(lat0, lon0, msg.latitude, msg.longitude)
        err = angle_diff(track, self.yaw)
        # Soft pull toward GPS track while moving — reduces gyro drift outdoors.
        self.yaw = math.atan2(
            math.sin(self.yaw + self.gps_gain * err),
            math.cos(self.yaw + self.gps_gain * err),
        )
        self.yaw_source = "gyro+gps"

    def _publish(self, src: Imu, stamp: float):
        q = yaw_to_quat(self.yaw)

        out = Imu()
        out.header.stamp = src.header.stamp
        out.header.frame_id = src.header.frame_id or "imu_link"
        out.orientation = q
        out.orientation_covariance = [
            0.05, 0.0, 0.0,
            0.0, 0.05, 0.0,
            0.0, 0.0, 0.15,
        ]
        out.angular_velocity = src.angular_velocity
        out.angular_velocity_covariance = src.angular_velocity_covariance
        out.linear_acceleration = src.linear_acceleration
        out.linear_acceleration_covariance = src.linear_acceleration_covariance
        self.pub_imu.publish(out)

        heading = QuaternionStamped()
        heading.header.stamp = src.header.stamp
        heading.header.frame_id = "base_link"
        heading.quaternion = q
        self.pub_heading.publish(heading)


def main():
    parser = argparse.ArgumentParser(description="IMU gyro → /heading for campusCar")
    parser.add_argument(
        "--imu-in",
        default=_env_str("HOVERBOARD_IMU_TOPIC", "/hoverboard/imu0/data"),
    )
    parser.add_argument("--imu-out", default=_env_str("IMU_TOPIC", "/imu"))
    parser.add_argument("--heading-out", default=_env_str("HEADING_TOPIC", "/heading"))
    parser.add_argument("--fix-in", default=_env_str("FIX_TOPIC", "/fix"))
    parser.add_argument("--gyro-axis", choices=("x", "y", "z"), default="z")
    parser.add_argument(
        "--gyro-sign",
        type=float,
        default=_env_float("IMU_GYRO_YAW_SIGN", 1.0),
        help="Flip to -1 if left/right turn sign is inverted",
    )
    parser.add_argument("--no-gps-assist", action="store_true")
    parser.add_argument("--gps-min-speed", type=float, default=0.4)
    parser.add_argument("--gps-gain", type=float, default=0.08)
    parser.add_argument(
        "--initial-yaw-deg",
        type=float,
        default=None,
        help="Optional absolute ENU yaw at start (0=east, 90=north)",
    )
    args = parser.parse_args()

    rclpy.init()
    node = ImuHeadingNode(
        imu_in=args.imu_in,
        imu_out=args.imu_out,
        heading_out=args.heading_out,
        fix_in=args.fix_in,
        gyro_axis=args.gyro_axis,
        gyro_sign=args.gyro_sign,
        gps_assist=not args.no_gps_assist,
        gps_min_speed=args.gps_min_speed,
        gps_gain=args.gps_gain,
        initial_yaw_deg=args.initial_yaw_deg,
    )
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
