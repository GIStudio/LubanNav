#!/usr/bin/env python3
"""car7_teleop.py — campusCar web_teleop 控制逻辑的独立移植。

逻辑等价移植自 campusCar `src/web_teleop.py` + `src/motion_profile.py`
（对方源码保持不动，本文件是我们自己的实现，部署在 ble_bridge/）：

  - TeleopState：set_stick(x, y, scale) → 目标速度（y*max_linear*scale /
    -x*max_angular*scale），slew 加减速，deadman 自动归零，snapshot。
  - shape_twist_for_base：底盘适配（TANK_TURN_MODE 等配置，读 robot.env）。
  - 参数对齐 web_teleop：20 Hz、accel_lin=1.2 decel_lin=2.0、
    accel_ang=2.0 decel_ang=3.0、deadman=0.45 s、max_linear=5.0（robot.env）。

与 web_teleop 的差异仅在于接入方式：本模块被 car7-wifi-bridge 复用
（方向键 continuous 指令 → set_stick），并保持同一套速度/平滑/安全语义。

纯标准库；无 rclpy 依赖（publish 由调用方注入）。
"""

from __future__ import annotations

import math
import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

_EPSILON = 1e-6


def _load_project_env() -> None:
    """Read config/robot.env into os.environ (same as campusCar motion_profile)."""
    env_file = Path(__file__).resolve().parents[1] / "config" / "robot.env"
    if not env_file.exists():
        return
    command = "set -a; source {}; env -0".format(shlex.quote(str(env_file)))
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
    value = os.getenv(name)
    return default if value is None or value == "" else value


_load_project_env()

TANK_TURN_MODE = _env_str("TANK_TURN_MODE", "angular").strip().lower()
TANK_TURN_SIDE_SPEED_SCALE = max(0.0, _env_float(
    "TANK_TURN_SIDE_SPEED_SCALE",
    _env_float("PIVOT_TURN_LINEAR_SCALE", 1.0),
))
TANK_TURN_MIN_SIDE_SPEED = max(0.0, _env_float(
    "TANK_TURN_MIN_SIDE_SPEED",
    _env_float("PIVOT_TURN_MIN_LINEAR", 0.10),
))
TANK_TURN_MAX_SIDE_SPEED = max(0.0, _env_float(
    "TANK_TURN_MAX_SIDE_SPEED",
    _env_float("PIVOT_TURN_MAX_LINEAR", 1.0),
))


def shape_twist_for_base(linear: float, angular: float) -> tuple[float, float]:
    """Shape pure-yaw commands without changing travelling-turn commands.

    Ported from campusCar src/motion_profile.py (unchanged semantics).
    """
    linear = float(linear)
    angular = float(angular)
    if abs(linear) > _EPSILON or abs(angular) <= _EPSILON:
        return linear, angular
    if TANK_TURN_MODE in ("angular", "pure_angular", "cmd_vel"):
        return 0.0, angular
    if TANK_TURN_SIDE_SPEED_SCALE <= 0.0 or TANK_TURN_MAX_SIDE_SPEED <= 0.0:
        return 0.0, angular

    side_speed = abs(angular) * TANK_TURN_SIDE_SPEED_SCALE
    if TANK_TURN_MIN_SIDE_SPEED > 0.0:
        side_speed = max(TANK_TURN_MIN_SIDE_SPEED, side_speed)
    side_speed = min(TANK_TURN_MAX_SIDE_SPEED, side_speed)

    if TANK_TURN_MODE in ("xz_opposite", "experimental_xz"):
        return -math.copysign(side_speed, angular), math.copysign(side_speed, angular)
    if TANK_TURN_MODE in ("xz_same", "experimental_xz_same"):
        return math.copysign(side_speed, angular), math.copysign(side_speed, angular)
    if TANK_TURN_MODE in ("yz_opposite", "experimental_yz"):
        return 0.0, math.copysign(side_speed, angular)
    return 0.0, angular


def slew(current: float, target: float, accel: float, decel: float, dt: float) -> float:
    if dt <= 0.0:
        return target
    delta = target - current
    speeding_up = abs(target) > abs(current) + 1e-9 and (
        current * target > 0 or abs(current) < 1e-9
    )
    rate = accel if speeding_up else decel
    step = rate * dt
    if abs(delta) <= step:
        return target
    return current + (step if delta > 0.0 else -step)


class TeleopState:
    """Target-speed state machine (ported from web_teleop.TeleopState)."""

    def __init__(self, max_linear=5.0, max_angular=5.0,
                 accel_lin=1.2, decel_lin=2.0, accel_ang=2.0, decel_ang=3.0,
                 deadman=0.45):
        self.lock = threading.Lock()
        self.max_linear = max_linear
        self.max_angular = max_angular
        self.accel_lin = accel_lin
        self.decel_lin = decel_lin
        self.accel_ang = accel_ang
        self.decel_ang = decel_ang
        self.deadman = deadman
        self.target_lin = 0.0
        self.target_ang = 0.0
        self.cmd_lin = 0.0
        self.cmd_ang = 0.0
        self.last_cmd_mono = 0.0
        self.has_cmd = False
        self.speed_scale = 0.55

    def set_stick(self, x, y, scale=None):
        x = max(-1.0, min(1.0, float(x)))
        y = max(-1.0, min(1.0, float(y)))
        with self.lock:
            if scale is not None:
                self.speed_scale = max(0.05, min(1.0, float(scale)))
            self.target_lin = y * self.max_linear * self.speed_scale
            self.target_ang = -x * self.max_angular * self.speed_scale
            self.last_cmd_mono = time.monotonic()
            self.has_cmd = True

    def set_direction(self, direction: str, speed_mps: float):
        """方向键语义：forward/backward = 满杆 Y；left/right = 满杆 X。
        speed_mps 换算为 scale（speed/max_linear）。"""
        x = {"left": -1.0, "right": 1.0}.get(direction, 0.0)
        y = {"forward": 1.0, "backward": -1.0}.get(direction, 0.0)
        scale = max(0.05, min(1.0, float(speed_mps) / max(self.max_linear, 0.05)))
        self.set_stick(x, y, scale)

    def stop(self, hard=False):
        with self.lock:
            self.target_lin = 0.0
            self.target_ang = 0.0
            self.last_cmd_mono = time.monotonic()
            self.has_cmd = True
            if hard:
                self.cmd_lin = 0.0
                self.cmd_ang = 0.0

    def tick(self, dt=None) -> tuple[float, float]:
        with self.lock:
            now = time.monotonic()
            if self.has_cmd and now - self.last_cmd_mono > self.deadman:
                self.target_lin = 0.0
                self.target_ang = 0.0
            if dt is None:
                dt = 0.05  # 20 Hz
            self.cmd_lin = slew(self.cmd_lin, self.target_lin,
                                self.accel_lin, self.decel_lin, dt)
            self.cmd_ang = slew(self.cmd_ang, self.target_ang,
                                self.accel_ang, self.decel_ang, dt)
            linear, angular = self.cmd_lin, self.cmd_ang
        return shape_twist_for_base(linear, angular)

    def moving(self) -> bool:
        with self.lock:
            return (abs(self.cmd_lin) > 0.01 or abs(self.cmd_ang) > 0.01
                    or abs(self.target_lin) > 0.01 or abs(self.target_ang) > 0.01)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "cmd_linear": round(self.cmd_lin, 3),
                "cmd_angular": round(self.cmd_ang, 3),
                "target_linear": round(self.target_lin, 3),
                "target_angular": round(self.target_ang, 3),
                "speed_scale": round(self.speed_scale, 3),
                "max_linear": self.max_linear,
                "max_angular": self.max_angular,
            }
