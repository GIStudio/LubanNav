#!/usr/bin/env python3
"""
Web teleop for campusCar — phone/desktop browser joystick → /cmd_vel.

  source /opt/ros/humble/setup.bash && source config/robot.env
  python3 src/web_teleop.py --port 8090

Same Wi-Fi / LAN:
  http://<NUC-IP>:8090/
Project default NUC IP: 192.168.100.1
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node

from motion_profile import shape_twist_for_base


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


_load_project_env()

CMD_VEL_TOPIC = os.getenv("CMD_VEL_TOPIC", "/cmd_vel")
MJPEG_PORT = int(os.getenv("MJPEG_PORT", "8080") or "8080")
MAX_LINEAR = _env_float("MAX_LINEAR_SPEED", 1.0)
MAX_ANGULAR = _env_float("MAX_ANGULAR_SPEED", 1.0)


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


class TeleopNode(Node):
    def __init__(self, topic: str):
        super().__init__("web_teleop_node")
        self.pub = self.create_publisher(Twist, topic, 10)
        self.get_logger().info(f"Web teleop publishing {topic}")

    def publish(self, linear: float, angular: float):
        linear, angular = shape_twist_for_base(linear, angular)
        msg = Twist()
        msg.linear.x = float(linear)
        msg.angular.z = float(angular)
        self.pub.publish(msg)


class TeleopState:
    def __init__(
        self,
        max_linear: float,
        max_angular: float,
        accel_lin: float,
        decel_lin: float,
        accel_ang: float,
        decel_ang: float,
        deadman: float,
    ):
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
        self.speed_scale = 0.55

    def set_stick(self, x: float, y: float, scale: float | None = None):
        x = max(-1.0, min(1.0, float(x)))
        y = max(-1.0, min(1.0, float(y)))
        with self.lock:
            if scale is not None:
                self.speed_scale = max(0.05, min(1.0, float(scale)))
            self.target_lin = y * self.max_linear * self.speed_scale
            self.target_ang = -x * self.max_angular * self.speed_scale
            self.last_cmd_mono = time.monotonic()

    def stop(self, hard: bool = False):
        with self.lock:
            self.target_lin = 0.0
            self.target_ang = 0.0
            self.last_cmd_mono = time.monotonic()
            if hard:
                self.cmd_lin = 0.0
                self.cmd_ang = 0.0

    def tick(self, dt: float) -> tuple[float, float]:
        with self.lock:
            now = time.monotonic()
            if self.last_cmd_mono > 0.0 and now - self.last_cmd_mono > self.deadman:
                self.target_lin = 0.0
                self.target_ang = 0.0
            self.cmd_lin = slew(
                self.cmd_lin, self.target_lin, self.accel_lin, self.decel_lin, dt
            )
            self.cmd_ang = slew(
                self.cmd_ang, self.target_ang, self.accel_ang, self.decel_ang, dt
            )
            return self.cmd_lin, self.cmd_ang

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


def build_html(mjpeg_port: int) -> bytes:
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<title>campusCar 遥控</title>
<style>
  :root {{
    --bg: #0f1419; --panel: #1a222c; --text: #e7eef6; --muted: #8b9aab;
    --accent: #3d8bfd; --danger: #e35d6a; --ok: #3ecf8e;
  }}
  * {{ box-sizing: border-box; -webkit-tap-highlight-color: transparent; }}
  html, body {{
    margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font-family: "Segoe UI", system-ui, sans-serif; overflow: hidden;
  }}
  .wrap {{
    height: 100%; display: grid; grid-template-rows: auto minmax(0,1fr) auto;
    gap: 10px; padding: 12px;
  }}
  header {{ display: flex; align-items: center; justify-content: space-between; gap: 8px; }}
  h1 {{ font-size: 1.05rem; margin: 0; font-weight: 600; }}
  .status {{ font-size: 0.8rem; color: var(--muted); }}
  .status.on {{ color: var(--ok); }}
  .cam {{
    background: #000; border-radius: 12px; overflow: hidden; min-height: 140px;
    display: flex; align-items: center; justify-content: center;
  }}
  .cam img {{ width: 100%; height: 100%; object-fit: contain; display: block; }}
  .controls {{
    display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end;
  }}
  .pad-wrap {{
    position: relative; width: min(56vw, 280px); aspect-ratio: 1;
    touch-action: none; user-select: none;
  }}
  .pad {{
    width: 100%; height: 100%; border-radius: 50%;
    background: var(--panel); border: 1px solid #2a3542; position: relative;
  }}
  .knob {{
    position: absolute; width: 34%; height: 34%; border-radius: 50%;
    background: var(--accent); left: 33%; top: 33%;
  }}
  .side {{ display: flex; flex-direction: column; gap: 10px; min-width: 120px; }}
  button.stop {{
    background: var(--danger); color: #fff; border: 0; border-radius: 12px;
    padding: 18px 14px; font-size: 1rem; font-weight: 700;
  }}
  label {{ font-size: 0.75rem; color: var(--muted); }}
  input[type=range] {{ width: 100%; }}
  .readout {{
    font-variant-numeric: tabular-nums; font-size: 0.8rem; color: var(--muted);
    white-space: pre-line;
  }}
  .hint {{ font-size: 0.72rem; color: var(--muted); line-height: 1.35; }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>campusCar 遥控</h1>
    <div id="link" class="status">连接中…</div>
  </header>
  <div class="cam"><img id="cam" alt="camera"/></div>
  <div>
    <div class="controls">
      <div class="pad-wrap" id="padWrap">
        <div class="pad" id="pad"><div class="knob" id="knob"></div></div>
      </div>
      <div class="side">
        <button class="stop" id="stop">停车</button>
        <label for="speed">速度比例</label>
        <input id="speed" type="range" min="5" max="100" value="55"/>
        <div class="readout" id="out">cmd 0 / 0</div>
      </div>
    </div>
    <p class="hint">按住摇杆移动；松手自动减速。电脑可用 WASD / 方向键。空格或红色按钮立刻停车。仅限同网段。</p>
  </div>
</div>
<script>
const MJPEG_PORT = {mjpeg_port};
const pad = document.getElementById('pad');
const knob = document.getElementById('knob');
const speedEl = document.getElementById('speed');
const out = document.getElementById('out');
const link = document.getElementById('link');
const cam = document.getElementById('cam');
cam.src = 'http://' + location.hostname + ':' + MJPEG_PORT + '/stream';
cam.onerror = () => {{ cam.style.display = 'none'; }};

let active = false;
let keys = {{w:false,a:false,s:false,d:false}};
let lastSent = 0;

function clamp(v, lo, hi) {{ return Math.max(lo, Math.min(hi, v)); }}

function setKnob(nx, ny) {{
  const r = pad.clientWidth / 2;
  knob.style.left = (r + nx * (r * 0.62) - knob.offsetWidth / 2) + 'px';
  knob.style.top = (r - ny * (r * 0.62) - knob.offsetHeight / 2) + 'px';
}}

function stickFromEvent(e) {{
  const rect = pad.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const t = e.touches ? e.touches[0] : e;
  let nx = (t.clientX - cx) / (rect.width / 2);
  let ny = -(t.clientY - cy) / (rect.height / 2);
  const mag = Math.hypot(nx, ny);
  if (mag > 1) {{ nx /= mag; ny /= mag; }}
  return [clamp(nx, -1, 1), clamp(ny, -1, 1)];
}}

async function sendCmd(x, y, hardStop=false) {{
  const scale = Number(speedEl.value) / 100;
  const body = hardStop ? {{stop: true, hard: true}} : {{x, y, scale}};
  try {{
    const res = await fetch('/api/cmd', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify(body),
    }});
    if (!res.ok) throw new Error('bad');
    link.textContent = '已连接';
    link.className = 'status on';
    lastSent = Date.now();
  }} catch (err) {{
    link.textContent = '断开';
    link.className = 'status';
  }}
}}

function onMove(e) {{
  if (!active) return;
  e.preventDefault();
  const [nx, ny] = stickFromEvent(e);
  setKnob(nx, ny);
  sendCmd(nx, ny);
}}
function onEnd() {{
  active = false;
  setKnob(0, 0);
  sendCmd(0, 0);
}}

pad.addEventListener('pointerdown', (e) => {{
  active = true;
  pad.setPointerCapture(e.pointerId);
  onMove(e);
}});
pad.addEventListener('pointermove', onMove);
pad.addEventListener('pointerup', onEnd);
pad.addEventListener('pointercancel', onEnd);
document.getElementById('stop').onclick = () => {{
  active = false; setKnob(0, 0); sendCmd(0, 0, true);
}};

function keyStick() {{
  let x = 0, y = 0;
  if (keys.a) x -= 1; if (keys.d) x += 1;
  if (keys.w) y += 1; if (keys.s) y -= 1;
  const mag = Math.hypot(x, y);
  if (mag > 1) {{ x /= mag; y /= mag; }}
  return [x, y];
}}
window.addEventListener('keydown', (e) => {{
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.w = true;
  if (k === 's' || k === 'arrowdown') keys.s = true;
  if (k === 'a' || k === 'arrowleft') keys.a = true;
  if (k === 'd' || k === 'arrowright') keys.d = true;
  if (k === ' ' || k === 'x') {{ sendCmd(0, 0, true); return; }}
  const [x, y] = keyStick(); setKnob(x, y); sendCmd(x, y);
}});
window.addEventListener('keyup', (e) => {{
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.w = false;
  if (k === 's' || k === 'arrowdown') keys.s = false;
  if (k === 'a' || k === 'arrowleft') keys.a = false;
  if (k === 'd' || k === 'arrowright') keys.d = false;
  const [x, y] = keyStick(); setKnob(x, y); sendCmd(x, y);
}});

setInterval(async () => {{
  try {{
    const j = await (await fetch('/api/status')).json();
    out.textContent = 'cmd ' + j.cmd_linear.toFixed(2) + ' m/s  '
      + j.cmd_angular.toFixed(2) + ' rad/s\\nscale '
      + (j.speed_scale * 100).toFixed(0) + '%';
    if (Date.now() - lastSent < 2000) {{
      link.textContent = '已连接'; link.className = 'status on';
    }}
  }} catch (_) {{}}
}}, 200);
setKnob(0, 0);
</script>
</body>
</html>
""".encode("utf-8")


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def make_handler(state: TeleopState, page: bytes):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self._cors()
                self.end_headers()
                self.wfile.write(page)
                return
            if path == "/api/status":
                body = json.dumps(state.snapshot()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._cors()
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            if urlparse(self.path).path != "/api/cmd":
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            if data.get("stop"):
                state.stop(hard=bool(data.get("hard")))
            else:
                state.set_stick(data.get("x", 0.0), data.get("y", 0.0), data.get("scale"))
            body = json.dumps({"ok": True, **state.snapshot()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Web teleop for campusCar")
    parser.add_argument("--port", type=int, default=int(os.getenv("WEB_TELEOP_PORT", "8090")))
    parser.add_argument("--topic", default=CMD_VEL_TOPIC)
    parser.add_argument("--max-linear", type=float, default=MAX_LINEAR)
    parser.add_argument("--max-angular", type=float, default=MAX_ANGULAR)
    parser.add_argument("--accel-linear", type=float, default=1.2)
    parser.add_argument("--decel-linear", type=float, default=2.0)
    parser.add_argument("--accel-angular", type=float, default=2.0)
    parser.add_argument("--decel-angular", type=float, default=3.0)
    parser.add_argument("--deadman", type=float, default=0.45)
    parser.add_argument("--rate", type=float, default=20.0)
    args = parser.parse_args()

    state = TeleopState(
        max_linear=max(0.05, args.max_linear),
        max_angular=max(0.05, args.max_angular),
        accel_lin=max(0.0, args.accel_linear),
        decel_lin=max(0.0, args.decel_linear),
        accel_ang=max(0.0, args.accel_angular),
        decel_ang=max(0.0, args.decel_angular),
        deadman=max(0.1, args.deadman),
    )
    page = build_html(MJPEG_PORT)

    rclpy.init()
    node = TeleopNode(args.topic)

    def spin():
        try:
            rclpy.spin(node)
        except Exception:
            pass

    threading.Thread(target=spin, daemon=True).start()

    stop_flag = threading.Event()

    def publish_loop():
        period = 1.0 / max(args.rate, 1.0)
        last = time.monotonic()
        while not stop_flag.is_set():
            now = time.monotonic()
            dt = max(1e-3, now - last)
            last = now
            lin, ang = state.tick(dt)
            node.publish(lin, ang)
            time.sleep(period)

    threading.Thread(target=publish_loop, daemon=True).start()

    server = ThreadedHTTPServer(("0.0.0.0", args.port), make_handler(state, page))
    print(f"Web teleop: http://0.0.0.0:{args.port}/")
    try:
        import subprocess as _sp

        out = _sp.check_output(
            ["bash", "-lc", "ip -4 -o addr show scope global"],
            text=True,
        )
        print("Phone/PC use one of these (same Wi-Fi as NUC):")
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            iface = parts[1]
            ip = parts[3].split("/")[0]
            if ip.startswith("127."):
                continue
            print(f"  http://{ip}:{args.port}/  ({iface})")
    except Exception:
        print(f"Phone/PC: http://<NUC-LAN-IP>:{args.port}/")
    print("  (127.0.0.1 only works on the NUC itself, not on a phone)")
    print(f"Topic:      {args.topic}  max_linear={args.max_linear}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_flag.set()
        state.stop(hard=True)
        for _ in range(5):
            node.publish(0.0, 0.0)
            time.sleep(0.03)
        server.shutdown()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
