#!/usr/bin/env python3
"""car7 status server — live status dashboard for the LubanNav car NUC.

Runs INSIDE the campuscar container (rclpy available) and serves:

  http://<NUC-IP>:8901/            live dashboard (dark theme, SSE push)
  http://<NUC-IP>:8901/api/status  one-shot JSON snapshot
  http://<NUC-IP>:8901/api/stream  Server-Sent Events (1 Hz)

Data sources (merged every second):
  - ROS topics: /fix (RTK), /odom (speed), /nav_status, /rtk_fixed_log/status
  - files:      data/logs/rtk_fixed.jsonl, data/maps/campus_road_network.json
  - bridge:     car7-wifi-bridge HTTP status page on 127.0.0.1:8900

Without rclpy (unit tests / local dev) the ROS section is simply omitted and
the bridge status page is still polled when reachable.

Zero third-party dependencies (stdlib only).
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:  # rclpy exists only inside the container
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Imu, NavSatFix
    from nav_msgs.msg import Odometry
    from std_msgs.msg import String as StdString
except ImportError:  # pragma: no cover
    rclpy = None
    Node = None
    Imu = None
    NavSatFix = None
    Odometry = None
    StdString = None

SERVICE_NAME = "car7-status-server"
SERVICE_VERSION = "1.0"
DEFAULT_BRIDGE_URL = "http://127.0.0.1:8900/"

FIX_STATUS_MAP = {
    -1: "no_fix", 0: "gps", 1: "dgps", 2: "rtk_fixed", 4: "rtk_fixed", 5: "rtk_float",
}
FIX_LABEL_ZH = {
    "no_fix": "无信号",
    "gps": "GPS",
    "dgps": "DGPS",
    "rtk_fixed": "RTK 固定解",
    "rtk_float": "RTK 浮点解",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_jsonl_stats(path: str) -> dict:
    """Count session_start / fix records and return the last fix record."""
    sessions = 0
    fixes = 0
    last_fix = None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get("type") == "session_start":
                    sessions += 1
                elif record.get("type") == "fix":
                    fixes += 1
                    last_fix = record
    except OSError:
        pass
    return {"records": fixes, "sessions": sessions, "lastFix": last_fix}


def read_roadnet_stats(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        nodes = len(data.get("nodes", []))
        edges = len(data.get("edges", []))
        built_at = data.get("builtAt") or data.get("updatedAt")
        return {"nodes": nodes, "edges": edges, "builtAt": built_at}
    except (OSError, ValueError):
        return {"nodes": 0, "edges": 0, "builtAt": None}


def read_trajectory(path: str, max_points: int = 2000) -> list:
    """Read fix records from rtk_fixed.jsonl as [{lat, lon, t}] (time-ordered)."""
    points = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get("type") == "fix" and record.get("lat") is not None:
                    points.append({
                        "lat": record["lat"],
                        "lon": record["lon"],
                        "t": record.get("t"),
                    })
    except OSError:
        pass
    return points[-max_points:]


def campuscar_waypoint_payload(points: list) -> dict:
    """campusCar gps_navigator.py 可读的 {origin, waypoints[]} 格式。"""
    waypoints = [{"lat": p["lat"], "lon": p["lon"], "alt": 0} for p in points]
    if not waypoints:
        return {"origin": {"lat": 0.0, "lon": 0.0, "alt": 0}, "waypoints": []}
    return {"origin": dict(waypoints[0]), "waypoints": waypoints}


class NavigatorRunner:
    """Owns a trajectory-following subprocess for path navigation.

    默认用我们自有的 car7_navigator.py (无 IMU / stop-and-go / RTK 差分航向)。
    设环境变量 CAR7_NAVIGATOR=legacy 可回退到 campusCar 的 gps_navigator.py。
    """

    NAV_SCRIPT = "/workspace/campusCar-new-chassis/src/ble_bridge/car7_navigator.py"
    LEGACY_SCRIPT = "/workspace/campusCar-new-chassis/src/rtk_tools/gps_navigator.py"

    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)
        self.process = None
        self.points = 0
        self.lock = threading.Lock()

    def start(self, points: list, speed: float = 0.3, radius: float = 0.8,
              min_leg: float = 1.2, turn_thresh: float = 25.0) -> dict:
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return {"ok": False, "error": "navigation already running"}
            if len(points) < 3:
                return {"ok": False, "error": "轨迹点太少（至少 3 个）"}
            path = self.data_dir / "lubannav-trajectory.json"
            try:
                path.write_text(json.dumps(campuscar_waypoint_payload(points),
                                           ensure_ascii=False, indent=1), encoding="utf-8")
            except OSError as exc:
                return {"ok": False, "error": "轨迹文件写入失败: {}".format(exc)}
            legacy = os.environ.get("CAR7_NAVIGATOR", "").lower() == "legacy"
            script = self.LEGACY_SCRIPT if legacy else self.NAV_SCRIPT
            if legacy:
                cmd = ("source /opt/ros/humble/setup.bash && exec python3 "
                       "{} --waypoints {} --speed {} --radius {}".format(
                           script, path, speed, radius))
            else:
                cmd = ("source /opt/ros/humble/setup.bash && exec python3 "
                       "{} --waypoints {} --speed {} --radius {} "
                       "--min-leg {} --turn-thresh {}".format(
                           script, path, speed, radius, min_leg, turn_thresh))
            try:
                self.process = subprocess.Popen(
                    ["bash", "-lc", cmd],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                self.process = None
                return {"ok": False, "error": "{} 启动失败: {}".format(
                    "gps_navigator" if legacy else "car7_navigator", exc)}
            self.points = len(points)
            return {"ok": True, "points": len(points), "speed": speed,
                    "file": str(path), "navigator": "legacy" if legacy else "car7"}

    def stop(self) -> dict:
        with self.lock:
            if self.process is None:
                return {"ok": True, "stopped": False}
            self.process.terminate()
            try:
                self.process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
            return {"ok": True, "stopped": True}

    def status(self) -> dict:
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            return {
                "running": running,
                "points": self.points,
                "returncode": self.process.poll() if self.process is not None else None,
            }


def _duration(points: list) -> float | None:
    if len(points) < 2 or not points[0].get("t") or not points[-1].get("t"):
        return None
    try:
        from datetime import datetime
        t0 = datetime.fromisoformat(points[0]["t"].replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(points[-1]["t"].replace("Z", "+00:00"))
        return round((t1 - t0).total_seconds(), 1)
    except ValueError:
        return None


def last_known_fix(path: str) -> dict | None:
    """最后一条有效 fix（no_fix 时用作近似位置）。"""
    points = read_trajectory(path, max_points=1)
    return points[0] if points else None


def fetch_bridge_status(url: str, timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


class RosCollector:
    """Subscribes the ROS topics we care about in a background thread."""

    def __init__(self):
        self.fix = None
        self.speed = None
        self.heading = None
        self.nav_status = None
        self.logger_status = None
        self.node = None
        self.ready = threading.Event()

    def start(self) -> bool:
        if rclpy is None or Node is None:
            return False
        thread = threading.Thread(target=self._run, name="status-ros", daemon=True)
        thread.start()
        return True

    def _run(self):
        try:
            rclpy.init()
        except Exception as exc:  # pragma: no cover
            print("[STATUS] rclpy init failed: {}".format(exc), flush=True)
            return
        self.node = Node("car7_status_server")
        self.node.create_subscription(NavSatFix, "/fix", self._on_fix, 10)
        self.node.create_subscription(Odometry, "/odom", self._on_odom, 10)
        self.node.create_subscription(StdString, "/nav_status", self._on_nav_status, 10)
        self.node.create_subscription(StdString, "/rtk_fixed_log/status", self._on_logger_status, 10)
        self.ready.set()
        try:
            rclpy.spin(self.node)
        finally:
            self.node.destroy_node()
            rclpy.shutdown()

    def _on_fix(self, msg):
        status = int(msg.status.status)
        latitude = float(msg.latitude)
        longitude = float(msg.longitude)
        valid = status >= 0 and -90 <= latitude <= 90 and -180 <= longitude <= 180
        self.fix = {
            "status": status,
            "fixStatus": FIX_STATUS_MAP.get(status, "fix_{}".format(status)),
            "latitude": latitude if valid else None,
            "longitude": longitude if valid else None,
            "altitude": float(msg.altitude) if valid and msg.altitude == msg.altitude else None,
            "accuracyMeters": _covariance_accuracy(msg),
            "time": iso_now(),
        }

    def _on_odom(self, msg):
        self.speed = round(float(msg.twist.twist.linear.x), 3)
        self.heading = _odom_yaw_degrees(msg)

    def _on_nav_status(self, msg):
        self.nav_status = (msg.data or "").strip()

    def _on_logger_status(self, msg):
        try:
            self.logger_status = json.loads(msg.data)
        except ValueError:
            self.logger_status = {"raw": msg.data}


def _covariance_accuracy(msg) -> float | None:
    covariance = getattr(msg, "position_covariance", None)
    if not covariance:
        return None
    diagonal = [float(covariance[i]) for i in (0, 4, 8)
                if i < len(covariance) and isinstance(covariance[i], (int, float))
                and covariance[i] >= 0 and covariance[i] == covariance[i]]
    if not diagonal:
        return None
    return round(sum(diagonal) / len(diagonal) ** 0.5, 3)


def _odom_yaw_degrees(msg) -> float | None:
    try:
        orientation = msg.pose.pose.orientation
        siny_cosp = 2.0 * (orientation.w * orientation.z + orientation.x * orientation.y)
        cosy_cosp = 1.0 - 2.0 * (orientation.y * orientation.y + orientation.z * orientation.z)
        yaw_enu = math_atan2(siny_cosp, cosy_cosp)
        compass = (90.0 - math_degrees(yaw_enu)) % 360.0
        return round(compass, 1)
    except Exception:
        return None


def math_atan2(y, x):
    import math
    return math.atan2(y, x)


def math_degrees(radians):
    import math
    return math.degrees(radians)


class StatusCollector:
    def __init__(self, data_dir: str, bridge_url: str = DEFAULT_BRIDGE_URL):
        self.data_dir = Path(data_dir)
        self.bridge_url = bridge_url
        self.ros = RosCollector()
        self.bridge = None
        self.started_at = time.time()
        self.navigator = NavigatorRunner(data_dir)

    def trajectory(self) -> dict:
        points = read_trajectory(str(self.data_dir / "logs" / "rtk_fixed.jsonl"))
        meta = {
            "count": len(points),
            "firstT": points[0]["t"] if points else None,
            "lastT": points[-1]["t"] if points else None,
            "durationSeconds": _duration(points),
        }
        return {
            "points": points,
            "meta": meta,
            "navigator": self.navigator.status(),
            "saved": self.list_saved(),
        }

    def saved_dir(self):
        path = self.data_dir / "trajectories"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def list_saved(self) -> list:
        result = []
        for path in sorted(self.saved_dir().glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            result.append({
                "name": path.stem,
                "points": len(data.get("waypoints", [])),
                "firstT": data.get("meta", {}).get("firstT"),
                "lastT": data.get("meta", {}).get("lastT"),
                "file": path.name,
            })
        return result

    def save_trajectory(self, name: str, points: list) -> dict:
        import re
        clean = re.sub(r"[^0-9A-Za-z_-]", "_", name or "traj").strip("_") or "traj"
        waypoints = [{"lat": p["lat"], "lon": p["lon"], "alt": 0, "t": p.get("t")} for p in points]
        payload = {"origin": dict(waypoints[0]) if waypoints else {"lat": 0.0, "lon": 0.0, "alt": 0},
                   "waypoints": waypoints}
        payload["meta"] = {
            "firstT": points[0]["t"] if points else None,
            "lastT": points[-1]["t"] if points else None,
            "count": len(points),
            "savedAt": iso_now(),
        }
        path = self.saved_dir() / "{}.json".format(clean)
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError as exc:
            return {"ok": False, "error": "保存失败: {}".format(exc)}
        return {"ok": True, "name": clean, "points": len(points), "file": path.name}

    def start(self):
        if self.ros.start():
            self.ros.ready.wait(timeout=5.0)
            print("[STATUS] ROS collector ready", flush=True)
        else:
            print("[STATUS] rclpy unavailable — using bridge status page only", flush=True)

    def snapshot(self) -> dict:
        fix = self.ros.fix if self.ros else None
        if fix is None:
            bridge = fetch_bridge_status(self.bridge_url)
            if bridge:
                rtk = bridge.get("rtk", {})
                fix = {
                    "status": rtk.get("rawStatus"),
                    "fixStatus": rtk.get("fixStatus"),
                    "latitude": rtk.get("latitude"),
                    "longitude": rtk.get("longitude"),
                    "accuracyMeters": rtk.get("accuracyMeters"),
                    "time": iso_now(),
                }
        fix_label = FIX_LABEL_ZH.get(fix.get("fixStatus"), fix.get("fixStatus")) if fix else "无信号"
        jsonl_path = self.data_dir / "logs" / "rtk_fixed.jsonl"
        roadnet_path = self.data_dir / "maps" / "campus_road_network.json"
        # no_fix 时只给最后已知的 RTK 真实位置（不用校园中心等假位置）；
        # 无历史记录则坐标留空，由前端用浏览器定位（真实位置）兜底
        if fix is None:
            fix = {"fixStatus": "no_fix"}
        if fix.get("latitude") is None or fix.get("longitude") is None:
            fallback = last_known_fix(str(jsonl_path))
            if fallback is not None:
                fix["latitude"] = fallback["lat"]
                fix["longitude"] = fallback["lon"]
                fix["approximate"] = True
                fix_label = "{}（最后已知位置）".format(fix_label)
        return {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "time": iso_now(),
            "uptimeSeconds": round(time.time() - self.started_at),
            "rtk": fix,
            "fixLabel": fix_label,
            "speedMetersPerSecond": self.ros.speed if self.ros else None,
            "headingDegrees": self.ros.heading if self.ros else None,
            "navStatus": self.ros.nav_status if self.ros else None,
            "logger": self.ros.logger_status if self.ros else None,
            "jsonl": read_jsonl_stats(str(jsonl_path)),
            "roadnet": read_roadnet_stats(str(roadnet_path)),
            "bridge": self.bridge,
            "rosReady": bool(self.ros and self.ros.ready.is_set()),
        }


PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>car7 实时状态</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root { --bg:#0b1220; --panel:#131c2e; --line:#22304a; --text:#e8eef7; --muted:#8fa3bd;
          --ok:#3ecf8e; --warn:#ffb454; --bad:#e35d6a; --accent:#4aa3ff; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:"Segoe UI",system-ui,sans-serif; padding:18px; }
  h1 { font-size:1.15rem; margin:0 0 4px; letter-spacing:.04em; }
  .sub { color:var(--muted); font-size:.78rem; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .card h2 { margin:0 0 10px; font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
  .big { font-size:1.5rem; font-weight:700; font-family:var(--mono); }
  .row { display:flex; justify-content:space-between; gap:8px; padding:3px 0; font-size:.82rem; }
  .row span { color:var(--muted); }
  .row strong { font-family:var(--mono); font-weight:600; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.72rem; font-weight:700; }
  .badge.ok { background:rgba(62,207,142,.15); color:var(--ok); }
  .badge.warn { background:rgba(255,180,84,.15); color:var(--warn); }
  .badge.bad { background:rgba(227,93,106,.15); color:var(--bad); }
  #nav { margin-top:10px; font-size:.8rem; color:var(--muted); font-family:var(--mono); }
  .ctl { margin-top:12px; }
  .ctl-row { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .pad { display:grid; grid-template-columns:repeat(3,64px); gap:6px; justify-content:center; margin-top:10px; }
  .pad button { height:56px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--text);
                font-size:1.3rem; font-weight:700; cursor:pointer; touch-action:none; user-select:none; }
  .pad button:active { background:var(--accent); color:#fff; }
  .pad button.pad-stop { background:rgba(227,93,106,.18); color:var(--bad); border-color:var(--bad); }
  .pad button.pad-e { grid-column:1/4; height:40px; font-size:.95rem; color:var(--bad); border-color:var(--bad); }
  #traj-canvas { width:100%; height:220px; background:#0a111d; border:1px solid var(--line); border-radius:8px; display:none; }
  #traj-map { width:100%; height:300px; border:1px solid var(--line); border-radius:8px; background:#0a111d; z-index:1; }
  #traj-map .leaflet-control-zoom a { color:#cfd8e6; }
  .traj-btns { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  .traj-btns button { flex:1; min-width:90px; padding:7px 6px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:.78rem; font-weight:700; cursor:pointer; }
  .traj-btns button:hover { border-color:var(--accent); }
  #traj-nav { border-color:var(--ok); color:var(--ok); }
  #traj-stop { border-color:var(--bad); color:var(--bad); }
  #traj-info { margin-top:8px; font-size:.76rem; color:var(--muted); font-family:var(--mono); }
  .tl { margin-top:10px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:rgba(255,255,255,.02); }
  .tl-row { display:flex; align-items:center; gap:8px; font-size:.72rem; color:var(--muted); font-family:var(--mono); }
  .tl-row input[type=range] { flex:1; min-width:0; accent-color:var(--accent); }
  .tl-time { min-width:118px; white-space:nowrap; }
  .tl-count { margin-top:4px; font-size:.7rem; color:var(--muted); font-family:var(--mono); }
  .seg-btns { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  .seg-btns input[type=text] { flex:1; min-width:110px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:.75rem; font-family:var(--mono); }
  .seg-btns select { flex:1; min-width:110px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:.75rem; font-family:var(--mono); }
  .seg-btns button { flex:1; min-width:80px; padding:7px 6px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:.75rem; font-weight:700; cursor:pointer; }
  .seg-btns button:hover { border-color:var(--accent); }
  #ctl-log { margin-top:8px; font-size:.72rem; color:var(--muted); font-family:var(--mono); min-height:1.2em; }
  .speedlabel { font-size:.75rem; color:var(--muted); }
  footer { margin-top:16px; color:var(--muted); font-size:.7rem; }
</style>
</head>
<body>
  <h1>🚗 car7 实时状态</h1>
  <div class="sub">HKUST(GZ) LubanNav · 10.7.181.161 · <span id="conn" class="badge warn">连接中…</span></div>
  <div class="grid">
    <div class="card">
      <h2>RTK 定位</h2>
      <div id="fix" class="big">—</div>
      <div class="row"><span>坐标</span><strong id="pos">—</strong></div>
      <div class="row"><span>精度</span><strong id="acc">—</strong></div>
      <div class="row"><span>速度</span><strong id="speed">—</strong></div>
      <div class="row"><span>航向</span><strong id="heading">—</strong></div>
      <div class="row"><span>更新于</span><strong id="fixtime">—</strong></div>
    </div>
    <div class="card">
      <h2>RTK 固定记录</h2>
      <div id="records" class="big">—</div>
      <div class="row"><span>会话</span><strong id="sessions">—</strong></div>
      <div class="row"><span>最近记录</span><strong id="lastrec">—</strong></div>
    </div>
    <div class="card">
      <h2>路网</h2>
      <div class="row"><span>节点</span><strong id="nodes">—</strong></div>
      <div class="row"><span>边</span><strong id="edges">—</strong></div>
      <div class="row"><span>构建时间</span><strong id="built">—</strong></div>
    </div>
    <div class="card">
      <h2>系统</h2>
      <div class="row"><span>桥服务</span><strong id="bridge">—</strong></div>
      <div class="row"><span>ROS 采集</span><strong id="ros">—</strong></div>
      <div class="row"><span>运行时长</span><strong id="uptime">—</strong></div>
      <div class="row"><span>服务器时间</span><strong id="time">—</strong></div>
    </div>
  </div>
  <div id="nav">导航状态：—</div>
  <div class="card">
    <h2>🧭 RTK 轨迹</h2>
    <div id="traj-map"></div>
    <canvas id="traj-canvas" width="600" height="220"></canvas>
    <div class="traj-btns">
      <button id="traj-load">🔄 加载轨迹</button>
      <button id="traj-replay">▶ 回放</button>
      <button id="traj-view">🗺 地图 / 📈 平面</button>
      <button id="traj-nav">🚗 沿轨迹导航</button>
      <button id="traj-stop">⏹ 停止</button>
    </div>
    <div class="tl">
      <div class="tl-row">
        <span id="tl-start-t" class="tl-time">—</span>
        <input id="tl-start" type="range" min="0" max="0" value="0" disabled title="轨迹段起点"/>
        <input id="tl-end" type="range" min="0" max="0" value="0" disabled title="轨迹段终点"/>
        <span id="tl-end-t" class="tl-time">—</span>
      </div>
      <div class="tl-count" id="tl-count">时间轴 —</div>
    </div>
    <div class="seg-btns">
      <button id="traj-auto">✨ 自动选段</button>
      <button id="traj-select-all">⏺ 全选</button>
      <input id="traj-save-name" type="text" placeholder="保存名称（如 lab-loop-1）"/>
      <button id="traj-save">💾 保存选段</button>
    </div>
    <div class="seg-btns">
      <select id="traj-saved"><option value="">— 已保存轨迹 —</option></select>
      <button id="traj-load-saved">📂 加载</button>
      <button id="traj-del-saved">🗑 删除</button>
    </div>
    <div id="traj-info">—</div>
  </div>
  <div class="card ctl">
    <h2>🎮 网页操控台</h2>
    <div class="ctl-row">
      <span id="ctl-status" class="badge warn">未连接</span>
      <button id="ctl-connect" style="background:var(--accent);border:0;color:#fff;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer;">连接操控通道</button>
      <label class="speedlabel">速度 <input id="ctl-speed" type="range" min="0.05" max="5.0" step="0.05" value="1.0" style="width:120px;vertical-align:middle;"/></label>
      <strong id="ctl-speedval" style="font-family:var(--mono);font-size:.8rem;">1.00 m/s</strong>
    </div>
    <div class="pad">
      <button data-dir="forward" title="前进">↑</button>
      <button data-dir="left" title="左转">←</button>
      <button data-dir="stop" class="pad-stop" title="停止">■</button>
      <button data-dir="right" title="右转">→</button>
      <button data-dir="backward" title="后退">↓</button>
      <button id="ctl-estop" class="pad-e" title="紧急停止">🚨 紧急停止</button>
    </div>
    <div id="ctl-log">按住方向键移动，松开即停；紧急停止清空一切指令。</div>
  </div>
  <footer>car7-status-server · SSE 1Hz · 操控走 ws://本机:8900 连续驱动链路</footer>
<script>
const $ = (id) => document.getElementById(id);
function badge(state) {
  return state === 'rtk_fixed' ? '<span class="badge ok">RTK 固定解</span>'
       : state === 'no_fix' || !state ? '<span class="badge" style="background:rgba(143,163,189,.15);color:#8fa3bd;">无信号</span>'
       : '<span class="badge bad">' + state + '（非固定解）</span>';
}
function render(data) {
  const rtk = data.rtk || {};
  const f = rtk.fixStatus;
  $('fix').innerHTML = badge(f);
  $('pos').textContent = (rtk.latitude != null && rtk.longitude != null)
    ? (rtk.approximate ? '≈ ' : '') + rtk.latitude.toFixed(7) + ', ' + rtk.longitude.toFixed(7)
    : '—';
  $('acc').textContent = rtk.accuracyMeters != null ? rtk.accuracyMeters + ' m' : '—';
  $('speed').textContent = data.speedMetersPerSecond != null ? data.speedMetersPerSecond + ' m/s' : '—';
  $('heading').textContent = data.headingDegrees != null ? data.headingDegrees + '°' : '—';
  $('fixtime').textContent = rtk.time ? new Date(rtk.time).toLocaleTimeString('zh-CN', {hour12:false}) : '—';
  const j = data.jsonl || {};
  $('records').textContent = j.records != null ? j.records + ' 条' : '—';
  $('sessions').textContent = j.sessions != null ? j.sessions : '—';
  $('lastrec').textContent = j.lastFix ? (j.lastFix.t || '').slice(11,19) + ' · ' + j.lastFix.lat.toFixed(6) + ', ' + j.lastFix.lon.toFixed(6) : '—';
  const rn = data.roadnet || {};
  $('nodes').textContent = rn.nodes != null ? rn.nodes : '—';
  $('edges').textContent = rn.edges != null ? rn.edges : '—';
  $('built').textContent = rn.builtAt ? String(rn.builtAt).slice(0, 19).replace('T', ' ') : '—';
  $('bridge').textContent = data.bridge ? '在线' : '—';
  $('ros').textContent = data.rosReady ? '就绪' : '不可用';
  $('uptime').textContent = data.uptimeSeconds != null ? Math.floor(data.uptimeSeconds / 60) + ' 分' : '—';
  $('time').textContent = data.time ? data.time.slice(11,19) + ' UTC' : '—';
  $('nav').textContent = '导航状态：' + (data.navStatus || '—');
  lastLive = { lat: rtk.latitude, lon: rtk.longitude, speed: data.speedMetersPerSecond, fixLabel: f ? null : (data.fixLabel || '') };
  // 只展示小车位置：RTK 实时（固定解绿/非固定解红），无信号时用最后已知 RTK（灰）
  updateTrajLiveMarker(rtk.latitude, rtk.longitude, data.speedMetersPerSecond, f);
  if (rtk.latitude != null && rtk.longitude != null) {
    lastLive = { lat: rtk.latitude, lon: rtk.longitude, speed: data.speedMetersPerSecond, fixLabel: data.fixLabel };
    drawTrajectory();
  }
  $('conn').textContent = '实时连接';
  $('conn').className = 'badge ok';
}
if (window.EventSource) {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = () => { $('conn').textContent = '重连中…'; $('conn').className = 'badge warn'; };
} else {
  setInterval(async () => { try { render(await (await fetch('/api/status')).json()); } catch (_) {} }, 2000);
}
// ── RTK 轨迹：记录展示 / 回放动画 / 沿轨迹导航 ──────────────────────
let trajMap = null;
let trajPolyline = null;
let trajStartMarker = null;
let trajEndMarker = null;
let trajLiveMarker = null;
let trajPlayMarker = null;
let trajLiveMarkerValid = false;
let lastLive = { lat: null, lon: null, speed: null, fixLabel: null };

function initTrajMap() {
  if (trajMap || typeof L === 'undefined') return;
  trajMap = L.map('traj-map', { zoomControl: true, attributionControl: true });
  trajMap.setView([22.8902, 113.4791], 16);
  const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd', maxZoom: 20,
  });
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri', maxZoom: 19,
  });
  carto.addTo(trajMap);
  L.control.layers({ '矢量底图': carto, '卫星图': esri }).addTo(trajMap);
  trajLiveMarker = L.circleMarker([22.8902, 113.4791], {
    radius: 10, color: '#071c2c', weight: 2, fillColor: '#5a6a7d', fillOpacity: 0.7,
  }).addTo(trajMap).bindTooltip('实时定位：等待数据');
  trajPlayMarker = L.circleMarker([22.8902, 113.4791], {
    radius: 7, color: '#071c2c', weight: 2, fillColor: '#ffb454', fillOpacity: 1,
  }).addTo(trajMap).bindTooltip('回放');
  document.getElementById('traj-map').style.display = 'block';
  document.getElementById('traj-canvas').style.display = 'none';
}

function drawTrajectoryMap(points) {
  if (!trajMap || !points.length) return;
  const latlngs = points.map((p) => [p.lat, p.lon]);
  if (trajPolyline) trajPolyline.remove();
  trajPolyline = L.polyline(latlngs, { color: '#4aa3ff', weight: 3, opacity: 0.9 }).addTo(trajMap);
  if (trajStartMarker) trajStartMarker.remove();
  trajStartMarker = L.circleMarker(latlngs[0], {
    radius: 6, color: '#071c2c', weight: 2, fillColor: '#3ecf8e', fillOpacity: 1,
  }).addTo(trajMap).bindTooltip('起点');
  if (trajEndMarker) trajEndMarker.remove();
  trajEndMarker = L.circleMarker(latlngs[latlngs.length - 1], {
    radius: 6, color: '#071c2c', weight: 2, fillColor: '#e35d6a', fillOpacity: 1,
  }).addTo(trajMap).bindTooltip('终点');
  trajMap.fitBounds(L.latLngBounds(latlngs).pad(0.12));
}

// 位置来源只有小车：RTK 实时 / 后端最后已知 RTK（不用浏览器定位、不用校园中心）
function updateTrajLiveMarker(lat, lon, speed, fixStatus) {
  if (!trajMap || !trajLiveMarker) return;
  if (lat == null || lon == null) {
    trajLiveMarker.setStyle({ fillColor: '#5a6a7d', fillOpacity: 0.7 });
    trajLiveMarker.setTooltipContent('等待小车定位');
    trajLiveMarkerValid = false;
    return;
  }
  const fixed = fixStatus === 'rtk_fixed';
  const color = fixed ? '#3ecf8e' : '#e35d6a'; // 绿=固定解，红=非固定解
  trajLiveMarker.setLatLng([lat, lon]);
  trajLiveMarker.setStyle({ fillColor: color, fillOpacity: 1 });
  const speedText = speed != null ? ' · ' + speed.toFixed(2) + ' m/s' : '';
  trajLiveMarker.setTooltipContent((fixed ? 'RTK 固定解' : '非固定解 · ' + (fixStatus || 'gps')) + speedText);
  trajLiveMarker.openTooltip();
  trajLiveMarkerValid = true;
}

function trajReplayTick() {
  const seg = currentSegment();
  if (!seg.length) { stopTrajReplay(); return; }
  const p = seg[trajReplayIdx];
  if (trajMap && trajPlayMarker && p) trajPlayMarker.setLatLng([p.lat, p.lon]);
  drawTrajectory(trajReplayIdx, seg);
  trajReplayIdx = (trajReplayIdx + 1) % seg.length;
}

function trajUseMapView() {
  initTrajMap();
  if (trajMap) {
    document.getElementById('traj-map').style.display = 'block';
    document.getElementById('traj-canvas').style.display = 'none';
    if (trajPoints.length) drawTrajectoryMap(currentSegment());
  } else {
    document.getElementById('traj-canvas').style.display = 'block';
  }
}

const trajCanvas = document.getElementById('traj-canvas');
const trajCtx = trajCanvas.getContext('2d');
const trajInfo = document.getElementById('traj-info');
const tlStart = document.getElementById('tl-start');
const tlEnd = document.getElementById('tl-end');
const tlStartT = document.getElementById('tl-start-t');
const tlEndT = document.getElementById('tl-end-t');
const tlCount = document.getElementById('tl-count');
const trajSavedSel = document.getElementById('traj-saved');
const trajSaveName = document.getElementById('traj-save-name');
let trajPoints = [];
let trajSegStart = 0;
let trajSegEnd = 0;
let trajReplayTimer = null;
let trajReplayIdx = 0;

function fmtTime(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }); } catch (_) { return String(t); }
}

function fmtTz(t) {
  if (!t) return '—';
  try { return new Date(t).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return String(t); }
}

// 当前选中的轨迹段（时间轴范围）
function currentSegment() {
  const s = Math.max(0, Math.min(trajSegStart, trajPoints.length));
  const e = Math.max(s, Math.min(trajSegEnd, trajPoints.length));
  return trajPoints.slice(s, e);
}

function refreshTimeline() {
  const n = trajPoints.length;
  tlStart.disabled = tlEnd.disabled = n < 2;
  tlStart.max = tlEnd.max = Math.max(n - 1, 1);
  tlStart.value = trajSegStart;
  tlEnd.value = trajSegEnd;
  const a = trajPoints[trajSegStart], b = trajPoints[Math.max(trajSegEnd - 1, trajSegStart)];
  tlStartT.textContent = '起 ' + fmtTime(a && a.t);
  tlEndT.textContent = '止 ' + fmtTime(b && b.t);
  const seg = currentSegment();
  tlCount.textContent = '时间轴 ' + fmtTz(trajPoints[0] && trajPoints[0].t) + ' → ' + fmtTz(trajPoints[n - 1] && trajPoints[n - 1].t)
    + ' · 全轨 ' + n + ' 点 · 选段 ' + seg.length + ' 点';
}

function setSegment(start, end) {
  const n = trajPoints.length;
  trajSegStart = Math.max(0, Math.min(start, Math.max(n - 1, 0)));
  trajSegEnd = Math.max(trajSegStart, Math.min(end, n));
  stopTrajReplay();
  refreshTimeline();
  trajUseMapView();
  const seg = currentSegment();
  if (seg.length) drawTrajectoryMap(seg);
  else drawTrajectory(0);
}

// ✨ 自动选段：按时间间隔聚合，挑点数最多（最连续）的一段
function autoSelectSegment() {
  if (trajPoints.length < 2) { alert('没有轨迹可聚合'); return; }
  const gap = 120000; // 120s 以上视为断档
  let bestStart = 0, bestEnd = 0, curStart = 0;
  for (let i = 1; i < trajPoints.length; i++) {
    let broken = true;
    if (trajPoints[i].t && trajPoints[i - 1].t) {
      const dt = new Date(trajPoints[i].t) - new Date(trajPoints[i - 1].t);
      broken = !isFinite(dt) || dt > gap;
    }
    if (broken) {
      if (i - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = i; }
      curStart = i;
    }
  }
  if (trajPoints.length - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = trajPoints.length; }
  setSegment(bestStart, bestEnd);
  trajInfo.textContent = '✨ 自动选段：' + (bestEnd - bestStart) + ' 点（时间连续段，间隔 > 120s 自动断开）';
}

async function refreshSavedList(selectName) {
  try {
    const r = await fetch('/api/trajectories');
    const d = await r.json();
    const saved = d.saved || [];
    trajSavedSel.innerHTML = '<option value="">— 已保存轨迹 (' + saved.length + ') —</option>'
      + saved.map((s) => '<option value="' + s.file + '">' + s.name + ' · ' + s.points + '点</option>').join('');
    if (selectName) trajSavedSel.value = selectName;
  } catch (_) { /* 静默 */ }
}

async function saveSegment() {
  const seg = currentSegment();
  if (!seg.length) { alert('先选择要保存的轨迹段（时间轴）'); return; }
  const name = (trajSaveName.value || '').trim() || ('traj-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-'));
  try {
    const r = await fetch('/api/trajectory/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, startIdx: trajSegStart, endIdx: trajSegEnd }),
    });
    const d = await r.json();
    trajInfo.textContent = d.ok
      ? '💾 已保存「' + d.name + '」(' + d.points + ' 点)'
      : '❌ ' + (d.error || '保存失败');
    if (d.ok) { trajSaveName.value = ''; refreshSavedList(d.file); }
  } catch (_) { trajInfo.textContent = '保存请求失败'; }
}

async function loadSaved() {
  const file = trajSavedSel.value;
  if (!file) { alert('先在列表选择一条已保存轨迹'); return; }
  try {
    const r = await fetch('/api/trajectory/load?name=' + encodeURIComponent(file));
    const d = await r.json();
    if (!d.ok) { trajInfo.textContent = '❌ ' + (d.error || '加载失败'); return; }
    trajPoints = d.points || [];
    trajSegStart = 0; trajSegEnd = trajPoints.length;
    stopTrajReplay();
    refreshTimeline();
    trajUseMapView();
    if (trajPoints.length) drawTrajectoryMap(trajPoints);
    trajInfo.textContent = '📂 已加载「' + d.name + '」' + trajPoints.length + ' 点';
  } catch (_) { trajInfo.textContent = '加载请求失败'; }
}

async function deleteSaved() {
  const file = trajSavedSel.value;
  if (!file) { alert('先在列表选择要删除的轨迹'); return; }
  if (!confirm('确认删除已保存轨迹「' + file + '」？')) return;
  try {
    const r = await fetch('/api/trajectory/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file }),
    });
    const d = await r.json();
    trajInfo.textContent = d.ok ? '🗑 已删除' : '❌ ' + (d.error || '删除失败');
    refreshSavedList();
  } catch (_) { trajInfo.textContent = '删除请求失败'; }
}

function trajProject(p, origin) {
  const o = origin || (trajPoints.length ? trajPoints[0] : null);
  if (!o) return { x: 0, y: 0 };
  return {
    x: (p.lon - o.lon) * 111320 * Math.cos((o.lat * Math.PI) / 180),
    y: (p.lat - o.lat) * 110540,
  };
}

function drawTrajectory(highlightIdx, points) {
  const pts = points || trajPoints;
  const w = trajCanvas.width, h = trajCanvas.height;
  trajCtx.clearRect(0, 0, w, h);
  if (!pts.length) {
    trajCtx.fillStyle = '#8fa3bd';
    trajCtx.font = '12px sans-serif';
    trajCtx.fillText('暂无轨迹 — 先在室外跑一段收集 RTK 固定解，再点「加载轨迹」', 12, 24);
    return;
  }
  const proj = pts.map((p) => trajProject(p, pts[0]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  proj.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const pad = 24;
  const s = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1), (h - 2 * pad) / Math.max(maxY - minY, 1));
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const X = (p) => ox + (p.x - minX) * s;
  const Y = (p) => oy + (p.y - minY) * s;
  trajCtx.strokeStyle = '#4aa3ff';
  trajCtx.lineWidth = 2;
  trajCtx.beginPath();
  proj.forEach((p, i) => { i ? trajCtx.lineTo(X(p), Y(p)) : trajCtx.moveTo(X(p), Y(p)); });
  trajCtx.stroke();
  trajCtx.fillStyle = '#3ecf8e';
  trajCtx.beginPath(); trajCtx.arc(X(proj[0]), Y(proj[0]), 5, 0, 7); trajCtx.fill();
  trajCtx.fillStyle = '#e35d6a';
  trajCtx.beginPath(); trajCtx.arc(X(proj[proj.length - 1]), Y(proj[proj.length - 1]), 5, 0, 7); trajCtx.fill();
  // 实时定位点（canvas 视图，绿=固定解 红=非固定解）
  if (lastLive.lat != null && lastLive.lon != null) {
    const lp = trajProject(lastLive, pts[0]);
    const fixed = lastLive.fixLabel === 'RTK 固定解';
    const dotColor = fixed ? '#3ecf8e' : '#e35d6a';
    trajCtx.strokeStyle = fixed ? 'rgba(62,207,142,.35)' : 'rgba(227,93,106,.35)';
    trajCtx.lineWidth = 6;
    trajCtx.beginPath(); trajCtx.arc(X(lp), Y(lp), 10, 0, 7); trajCtx.stroke();
    trajCtx.fillStyle = dotColor;
    trajCtx.beginPath(); trajCtx.arc(X(lp), Y(lp), 6, 0, 7); trajCtx.fill();
  }
  if (highlightIdx != null && highlightIdx >= 0) {
    trajCtx.fillStyle = '#ffb454';
    trajCtx.beginPath(); trajCtx.arc(X(proj[highlightIdx]), Y(proj[highlightIdx]), 8, 0, 7); trajCtx.fill();
  }
}

function stopTrajReplay() {
  if (trajReplayTimer) { clearInterval(trajReplayTimer); trajReplayTimer = null; }
  trajReplayIdx = 0;
}

async function loadTrajectory() {
  try {
    const r = await fetch('/api/trajectory');
    const d = await r.json();
    trajPoints = d.points || [];
    trajSegStart = 0;
    trajSegEnd = trajPoints.length;
    stopTrajReplay();
    refreshTimeline();
    trajUseMapView();
    if (trajPoints.length) drawTrajectoryMap(trajPoints);
    const nav = d.navigator || {};
    trajInfo.textContent = '轨迹 ' + trajPoints.length + ' 点 · 导航: ' + (nav.running ? '运行中' : '停止');
    refreshSavedList();
  } catch (_) { trajInfo.textContent = '加载轨迹失败'; }
}

function startTrajReplay() {
  const seg = currentSegment();
  if (!seg.length) { alert('没有轨迹可回放，先加载'); return; }
  stopTrajReplay();
  trajReplayIdx = 0;
  trajReplayTimer = setInterval(trajReplayTick, 80);
}

async function navigateTrajectory() {
  const seg = currentSegment();
  if (!seg.length) { alert('没有轨迹可导航，先加载'); return; }
  if (!confirm('将沿选中的 ' + seg.length + ' 个轨迹点自主行驶（速度 0.3 m/s，需要 RTK 固定解）！确认开始？')) return;
  try {
    const r = await fetch('/api/trajectory/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: 0.3, points: seg, minLeg: 1.2, turnThresh: 25 }),
    });
    const d = await r.json();
    trajInfo.textContent = d.ok
      ? '🚗 导航已启动：' + d.trajectoryPoints + ' 点 @ ' + d.speed + ' m/s'
      : '❌ ' + (d.error || '启动失败');
  } catch (_) { trajInfo.textContent = '导航启动请求失败'; }
}

async function stopNavigation() {
  try {
    const r = await fetch('/api/trajectory/stop', { method: 'POST' });
    const d = await r.json();
    trajInfo.textContent = d.stopped ? '⏹ 导航已停止' : '导航未在运行';
  } catch (_) { trajInfo.textContent = '停止请求失败'; }
}

document.getElementById('traj-load').onclick = loadTrajectory;
document.getElementById('traj-replay').onclick = startTrajReplay;
document.getElementById('traj-auto').onclick = autoSelectSegment;
document.getElementById('traj-select-all').onclick = () => setSegment(0, trajPoints.length);
document.getElementById('traj-save').onclick = saveSegment;
document.getElementById('traj-load-saved').onclick = loadSaved;
document.getElementById('traj-del-saved').onclick = deleteSaved;
document.getElementById('traj-view').onclick = () => {
  initTrajMap();
  const mapEl = document.getElementById('traj-map');
  const canvasEl = document.getElementById('traj-canvas');
  const showMap = mapEl.style.display !== 'block';
  mapEl.style.display = showMap ? 'block' : 'none';
  canvasEl.style.display = showMap ? 'none' : 'block';
  if (showMap && trajMap) setTimeout(() => trajMap.invalidateSize(), 50);
};
document.getElementById('traj-nav').onclick = navigateTrajectory;
document.getElementById('traj-stop').onclick = stopNavigation;
// 时间轴滑块：拖动实时预览选段（两端可交叉，自动取 min/max）
function syncTimelineSliders() {
  const s = parseInt(tlStart.value, 10);
  const e = parseInt(tlEnd.value, 10);
  setSegment(Math.min(s, e), Math.max(s, e));
}
tlStart.addEventListener('input', syncTimelineSliders);
tlEnd.addEventListener('input', syncTimelineSliders);
refreshTimeline();
loadTrajectory();

// ── 操控台 ────────────────────────────────────────────────────────────
(function () {
  const statusEl = document.getElementById('ctl-status');
  const logEl = document.getElementById('ctl-log');
  const speedEl = document.getElementById('ctl-speed');
  const speedVal = document.getElementById('ctl-speedval');
  let ws = null, timer = null;
  speedEl.addEventListener('input', () => { speedVal.textContent = Number(speedEl.value).toFixed(2) + ' m/s'; });
  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'badge ' + (cls || 'warn'); }
  function logLine(text) { logEl.textContent = text; }
  function baseMsg(dir, speed) {
    return {
      protocol: 'luban-nav-ble', protocolVersion: 1, type: 'direction', priority: 'ble',
      commandId: 'dash-' + Date.now().toString(36), direction: dir,
      amountMeters: null, amountDegrees: null,
      speedMetersPerSecond: dir === 'stop' ? null : speed,
      continuous: true, createdAt: new Date().toISOString(),
    };
  }
  function send(dir) {
    if (!ws || ws.readyState !== 1) { setStatus('未连接'); return; }
    ws.send(JSON.stringify(baseMsg(dir, Number(speedEl.value))) + '\\n');
  }
  document.getElementById('ctl-connect').addEventListener('click', () => {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) { ws.close(); return; }
    const url = 'ws://' + location.hostname + ':8900';
    setStatus('连接中…');
    ws = new WebSocket(url);
    ws.onopen = () => { setStatus('已连接', 'ok'); logLine('已连接 ' + url + ' · 按住方向键移动'); };
    ws.onclose = () => { setStatus('未连接'); if (timer) { clearInterval(timer); timer = null; } };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'ack' || m.type === 'status') logLine('← ' + m.type + ' ' + (m.status || '') + (m.message ? ' · ' + m.message : ''));
      } catch (_) {}
    };
  });
  function hold(dir) {
    return (ev) => {
      ev.preventDefault();
      if (!ws || ws.readyState !== 1) return;
      send(dir);
      if (timer) clearInterval(timer);
      timer = setInterval(() => send(dir), 200);
    };
  }
  function release(ev) {
    ev?.preventDefault();
    if (timer) { clearInterval(timer); timer = null; }
    send('stop');
  }
  document.querySelectorAll('.pad button[data-dir]').forEach((btn) => {
    const dir = btn.dataset.dir;
    btn.addEventListener('pointerdown', hold(dir));
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  document.getElementById('ctl-estop').addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    send('stop');
    ws.send(JSON.stringify({ protocol: 'luban-nav-ble', protocolVersion: 1, type: 'emergency_stop',
      priority: 'safety', commandId: 'dash-estop-' + Date.now().toString(36), taskId: null,
      createdAt: new Date().toISOString(), reason: 'dashboard_estop' }) + '\\n');
    logLine('🚨 紧急停止已发送');
  });
})();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    collector = None  # set by serve()

    def log_message(self, *_args):
        pass

    def _send(self, code, body, content_type):
        payload = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path == "/index.html":
            self._send(200, PAGE_HTML, "text/html; charset=utf-8")
            return
        if path == "/api/status":
            self._send(200, json.dumps(self.collector.snapshot(), ensure_ascii=False), "application/json; charset=utf-8")
            return
        if path == "/api/trajectory":
            payload = self.collector.trajectory()
            self._send(200, json.dumps(payload, ensure_ascii=False), "application/json; charset=utf-8")
            return
        if path == "/api/trajectories":
            self._send(200, json.dumps({"saved": self.collector.list_saved()}, ensure_ascii=False),
                       "application/json; charset=utf-8")
            return
        if path == "/api/trajectory/load":
            from urllib.parse import urlparse, parse_qs
            name = parse_qs(urlparse(self.path).query).get("name", [""])[0]
            saved = self.collector.list_saved()
            hit = next((s for s in saved if s["file"] == name or s["name"] == name), None)
            if not hit:
                self._send(404, json.dumps({"ok": False, "error": "保存的轨迹不存在: {}".format(name)},
                                           ensure_ascii=False), "application/json; charset=utf-8")
                return
            try:
                data = json.loads((self.collector.saved_dir() / hit["file"]).read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                self._send(500, json.dumps({"ok": False, "error": "读取失败: {}".format(exc)},
                                           ensure_ascii=False), "application/json; charset=utf-8")
                return
            points = data.get("waypoints", [])
            self._send(200, json.dumps({
                "ok": True, "name": hit["name"], "points": points,
                "meta": data.get("meta", {}),
            }, ensure_ascii=False), "application/json; charset=utf-8")
            return
        if path == "/api/stream":
            self._stream()
            return
        self._send(404, json.dumps({"error": "not found"}), "application/json")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/trajectory/start":
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                data = {}
            points = None
            if data.get("points"):
                points = data["points"]
            elif data.get("name"):
                saved = self.collector.list_saved()
                hit = next((s for s in saved if s["file"] == data["name"] or s["name"] == data["name"]), None)
                if hit:
                    try:
                        payload = json.loads((self.collector.saved_dir() / hit["file"]).read_text(encoding="utf-8"))
                        points = payload.get("waypoints", [])
                    except (OSError, ValueError):
                        points = None
            if points is None:
                points = self.collector.trajectory()["points"]
            if not points:
                self._send(400, json.dumps({"ok": False, "error": "轨迹为空"}, ensure_ascii=False),
                           "application/json; charset=utf-8")
                return
            result = self.collector.navigator.start(
                points, speed=float(data.get("speed", 0.3)), radius=float(data.get("radius", 0.8)),
                min_leg=float(data.get("minLeg", 1.2)), turn_thresh=float(data.get("turnThresh", 25.0)))
            result.update({"trajectoryPoints": len(points)})
            self._send(200, json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
            return
        if path == "/api/trajectory/save":
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                data = {}
            traj = self.collector.trajectory()
            points = traj["points"]
            start_idx = max(0, int(data.get("startIdx", 0)))
            end_idx = min(len(points), int(data.get("endIdx", len(points) or 0)))
            if end_idx <= start_idx:
                end_idx = len(points)
            segment = points[start_idx:end_idx]
            if not segment:
                self._send(400, json.dumps({"ok": False, "error": "选段为空"}, ensure_ascii=False),
                           "application/json; charset=utf-8")
                return
            result = self.collector.save_trajectory(str(data.get("name", "")), segment)
            if not result.get("ok"):
                self._send(500, json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
                return
            self._send(200, json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
            return
        if path == "/api/trajectory/delete":
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                data = {}
            import re
            name = re.sub(r"[^0-9A-Za-z_.-]", "_", str(data.get("name", ""))).strip("_") or ""
            if name and not name.endswith(".json"):
                name = name + ".json"
            target = self.collector.saved_dir() / name
            if not name or not target.name.endswith(".json") or not target.exists():
                self._send(404, json.dumps({"ok": False, "error": "轨迹不存在: {}".format(name)},
                                           ensure_ascii=False), "application/json; charset=utf-8")
                return
            try:
                target.unlink()
            except OSError as exc:
                self._send(500, json.dumps({"ok": False, "error": "删除失败: {}".format(exc)},
                                           ensure_ascii=False), "application/json; charset=utf-8")
                return
            self._send(200, json.dumps({"ok": True, "name": name}, ensure_ascii=False),
                       "application/json; charset=utf-8")
            return
        if path == "/api/trajectory/stop":
            result = self.collector.navigator.stop()
            self._send(200, json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
            return
        self._send(404, json.dumps({"ok": False, "error": "not found"}), "application/json")

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                payload = json.dumps(self.collector.snapshot(), ensure_ascii=False)
                self.wfile.write("data: {}\n\n".format(payload).encode("utf-8"))
                self.wfile.flush()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def serve(collector, host: str, port: int):
    Handler.collector = collector
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print("[STATUS] {} v{} listening on http://{}:{}/".format(SERVICE_NAME, SERVICE_VERSION, host, port), flush=True)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(prog="car7-status-server", description="car7 live status dashboard")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8901)
    parser.add_argument("--data-dir", default="/workspace/campusCar-new-chassis/data",
                        help="campusCar data dir (logs/rtk_fixed.jsonl, maps/…)")
    parser.add_argument("--bridge-url", default=DEFAULT_BRIDGE_URL)
    options = parser.parse_args()
    collector = StatusCollector(data_dir=options.data_dir, bridge_url=options.bridge_url)
    collector.start()
    try:
        serve(collector, options.host, options.port)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
