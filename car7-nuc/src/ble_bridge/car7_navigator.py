#!/usr/bin/env python3
"""
car7 无 IMU 轨迹导航器（stop-and-go，RTK 差分航向）

背景:
  - 车上没有 IMU / 编码器 / 激光，只有 RTK-GNSS。
  - 车停下后可能停在目标点的前/后/左/右任意位置, 预计算的转弯角会失效。
  - 因此采用「到点重算方向」: 每个关键点 (转弯点) 先减速, 用 RTK 位置差分得到
    “当前朝向”(伪航向), 再用「当前 RTK 位置 → 下一目标点」实时算目标方位角,
    差速纠偏转正, 再直行到点。全程不用 IMU, 计算量极低 (atan2 + 比例)。

用法:
  python3 car7_navigator.py --waypoints traj.json
  python3 car7_navigator.py --waypoints traj.json --speed 0.3 --radius 0.6
  python3 car7_navigator.py --waypoints traj.json --min-leg 1.2 --turn-thresh 25

控制:
  - FORWARD: 朝当前目标直行 (接近时减速), 转角过大时进入 ALIGN。
  - ALIGN  : 蠕动 (小 linear.x) + 差速纠偏到目标方位, 对正后回 FORWARD。
  - 朝向估计: 相邻有效 fix 位移方向 + 低通, 无 IMU 时的伪航向。

不动 campusCar 的 gps_navigator.py: 本文件独立, 复刻其 gps_to_enu/quat_to_yaw/angle_diff。
"""

import sys
import math
import json
import argparse
from pathlib import Path

# ---------------------------------------------------------------------------
# 纯逻辑 (不依赖 ROS, 便于本地单测)
# ---------------------------------------------------------------------------

def gps_to_enu(lat, lon, alt, lat0, lon0, alt0):
    """GPS 经纬度 → ENU 局部坐标 (米), 以 (lat0,lon0,alt0) 为原点。"""
    R = 6378137.0
    d_lat = math.radians(lat - lat0)
    d_lon = math.radians(lon - lon0)
    lat_r = math.radians(lat0)
    east = R * d_lon * math.cos(lat_r)
    north = R * d_lat
    up = alt - alt0
    return east, north, up


def angle_diff(a, b):
    """角度差 a-b, 归一化到 [-pi, pi]。"""
    d = a - b
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d


def bearing_enu(dx, dy):
    """目标方位角 (ENU, 东=0, 北=pi/2)。"""
    return math.atan2(dy, dx)


def haversine(lat1, lon1, lat2, lon2):
    """球面距离 (米)。"""
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def build_key_waypoints(points, min_leg=1.0, turn_thresh_deg=25.0):
    """把密集轨迹抽稀成稀疏“关键点”。

    - 保留与上个关键点距离 >= min_leg 的点。
    - 或转弯角 (相对上一段方向) 超过 turn_thresh_deg 的点也保留。
    输入 points: [{lat, lon, ...}], 输出同构列表。
    """
    if len(points) < 2:
        return list(points)
    out = [points[0]]
    prev = points[0]
    prev_bearing = None
    turn_thresh = math.radians(turn_thresh_deg)
    for p in points[1:]:
        d = haversine(prev["lat"], prev["lon"], p["lat"], p["lon"])
        bearing = bearing_enu(p["lon"] - prev["lon"], p["lat"] - prev["lat"])
        turn = angle_diff(bearing, prev_bearing) if prev_bearing is not None else 0.0
        if d >= min_leg or abs(turn) >= turn_thresh:
            out.append(p)
            # 更新方向: 用 (上一关键点 → 当前) 的方向, 抗抖
            prev_bearing = bearing
            prev = p
    return out


class HeadingEstimator:
    """无 IMU: 用 RTK 位置差分估计“当前朝向”(伪航向)。

    仅在车位移超过 min_move 时更新, 并用低通平滑。返回 None 表示尚无可靠航向。
    """

    def __init__(self, min_move=0.05, alpha=0.35):
        self.min_move = min_move
        self.alpha = alpha
        self.last = None       # (x, y)
        self.heading = None    # rad, ENU
        self.moved = False     # 是否已有过一次有效差分

    def update(self, x, y):
        if self.last is not None:
            dx = x - self.last[0]
            dy = y - self.last[1]
            dist = math.hypot(dx, dy)
            if dist > self.min_move:
                new_heading = math.atan2(dy, dx)
                if self.heading is None:
                    self.heading = new_heading
                else:
                    self.heading += self.alpha * angle_diff(new_heading, self.heading)
                self.moved = True
        self.last = (x, y)
        return self.heading

    def reset_at(self, x, y):
        self.last = (x, y)
        self.moved = False


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class StopAndGoNavigator:
    """stop-and-go 状态机。纯逻辑, control() 返回 (linear_x, angular_z)。"""

    STATE_FORWARD = "FORWARD"
    STATE_ALIGN = "ALIGN"
    STATE_DONE = "DONE"

    def __init__(self, waypoints, speed=0.3, radius=0.6, min_leg=1.2,
                 turn_thresh_deg=25.0, k_turn=1.6, align_speed=0.06,
                 align_tol_deg=8.0, k_align=2.0, max_ang=0.8, decel_dist=1.5,
                 start_speed=0.12, min_speed=0.08):
        self.waypoints = build_key_waypoints(waypoints, min_leg, turn_thresh_deg)
        self.speed = speed
        self.radius = radius
        self.k_turn = k_turn
        self.align_speed = align_speed
        self.align_tol = math.radians(align_tol_deg)
        self.k_align = k_align
        self.max_ang = max_ang
        self.decel_dist = decel_dist
        self.start_speed = start_speed
        self.min_speed = min_speed
        self.wp_index = 0
        self.state = self.STATE_FORWARD
        self.pos = None       # (x, y)
        self.origin = None    # (lat0, lon0, alt0)
        self.hdg = HeadingEstimator()

    # --- 位置输入 (由 ROS fix 回调调用) ---
    def on_position(self, lat, lon, alt):
        if self.origin is None:
            self.origin = (lat, lon, alt)
        x, y, _ = gps_to_enu(lat, lon, alt, *self.origin)
        self.pos = (x, y)
        self.hdg.update(x, y)
        return self.pos

    def reset_heading(self, lat, lon, alt):
        """转向或刚启动时, 以当前位置重置差分基准 (避免 stale 差分误导)。"""
        if self.origin is None:
            self.origin = (lat, lon, alt)
        x, y, _ = gps_to_enu(lat, lon, alt, *self.origin)
        self.pos = (x, y)
        self.hdg.reset_at(x, y)

    def heading(self):
        return self.hdg.heading

    # --- 目标信息 ---
    def target(self):
        if self.wp_index >= len(self.waypoints):
            return None
        wp = self.waypoints[self.wp_index]
        # 相对于当前 origin 的 ENU
        return self._wp_enu(wp)

    def _wp_enu(self, wp):
        if self.origin is None:
            return None
        x, y, _ = gps_to_enu(wp["lat"], wp["lon"], 0.0, *self.origin)
        return (x, y)

    # --- 控制主循环 ---
    def control(self):
        """返回 (linear_x, angular_z) 或 None (无位置/已完成)。"""
        if self.state == self.STATE_DONE:
            return (0.0, 0.0)
        if self.pos is None or self.origin is None:
            return None
        target = self.target()
        if target is None:
            self.state = self.STATE_DONE
            return (0.0, 0.0)

        tx, ty = target
        dx = tx - self.pos[0]
        dy = ty - self.pos[1]
        dist = math.hypot(dx, dy)

        # 到达当前点 → 切下一目标并进入 ALIGN (重算方向)
        if dist < self.radius:
            self.wp_index += 1
            if self.wp_index >= len(self.waypoints):
                self.state = self.STATE_DONE
                return (0.0, 0.0)
            self.state = self.STATE_ALIGN
            return self._align_cmd()

        target_bearing = math.atan2(dy, dx)  # ENU: 东=0, 北=pi/2
        if self.state == self.STATE_ALIGN:
            return self._align_cmd(target_bearing)

        # FORWARD
        # 若有伪航向, 且到目标的转角很大 → 停下转正 (重算方向)
        hdg = self.hdg.heading
        if hdg is not None:
            turn = angle_diff(target_bearing, hdg)
            if abs(turn) >= self.align_tol * 1.5:
                self.state = self.STATE_ALIGN
                return self._align_cmd(target_bearing)

        # 直行: 接近目标减速
        if dist < self.decel_dist:
            ratio = dist / self.decel_dist
            lin = max(self.min_speed, self.speed * ratio)
        else:
            lin = self.speed
        ang = 0.0
        if hdg is not None:
            # 前进中轻微纠偏 (小增益), 避免走偏
            ang = clamp(self.k_turn * 0.35 * angle_diff(target_bearing, hdg), -self.max_ang, self.max_ang)
        return (lin, ang)

    def _align_cmd(self, target_bearing=None):
        """蠕动转正: 保持小 linear.x 以便 RTK 差分航向, 用差速纠偏到 target_bearing。"""
        if target_bearing is None:
            return (self.align_speed, 0.0)
        hdg = self.hdg.heading
        if hdg is None:
            # 无航向: 缓慢前进以让差分建立航向, 不加角速度
            return (self.align_speed, 0.0)
        err = angle_diff(target_bearing, hdg)
        if abs(err) <= self.align_tol:
            self.state = self.STATE_FORWARD
            return (0.0, 0.0)
        ang = clamp(self.k_align * err, -self.max_ang, self.max_ang)
        return (self.align_speed, ang)

    def status(self) -> dict:
        return {
            "state": self.state,
            "wp_index": self.wp_index,
            "wp_total": len(self.waypoints),
            "heading_deg": round(math.degrees(self.hdg.heading), 1) if self.hdg.heading is not None else None,
            "pos": [round(v, 3) for v in self.pos] if self.pos else None,
        }


# ---------------------------------------------------------------------------
# ROS 节点 (仅在 __main__ 引入 rclpy)
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="car7 无 IMU 轨迹导航 (stop-and-go + RTK 差分航向)")
    parser.add_argument("--waypoints", required=True)
    parser.add_argument("--speed", type=float, default=0.3)
    parser.add_argument("--radius", type=float, default=0.6)
    parser.add_argument("--min-leg", type=float, default=1.2)
    parser.add_argument("--turn-thresh", type=float, default=25.0)
    parser.add_argument("--k-turn", type=float, default=1.6)
    parser.add_argument("--k-align", type=float, default=2.0)
    parser.add_argument("--max-ang", type=float, default=0.8)
    parser.add_argument("--hz", type=float, default=10.0)
    parser.add_argument("--fix-topic", default="/fix")
    parser.add_argument("--cmd-topic", default="/cmd_vel")
    parser.add_argument("--no-validate", action="store_true",
                        help="无需 RTK 固定解也能移动 (默认需要 fix 才动, 安全)")
    args = parser.parse_args()

    sys.path.insert(0, "/opt/ros/humble/lib/python3.10/site-packages"
                     if "/opt/ros" in str(Path(__file__)) else str(Path(__file__).parent))

    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import NavSatFix
    from geometry_msgs.msg import Twist

    # 加载航点
    with open(args.waypoints, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    wps = [{"lat": w["lat"], "lon": w["lon"], "alt": w.get("alt", 0.0)} for w in data.get("waypoints", [])]
    if not wps:
        print("[car7-nav] 航点为空, 退出")
        return

    nav = StopAndGoNavigator(wps, speed=args.speed, radius=args.radius,
                             min_leg=args.min_leg, turn_thresh_deg=args.turn_thresh,
                             k_turn=args.k_turn, k_align=args.k_align, max_ang=args.max_ang)

    class NavNode(Node):
        def __init__(self):
            super().__init__("car7_navigator")
            self.pub = self.create_publisher(Twist, args.cmd_topic, 10)
            self.sub = self.create_subscription(NavSatFix, args.fix_topic, self._on_fix, 10)
            self.gps_ok = False
            self.create_timer(1.0 / args.hz, self._control)
            self.get_logger().info(
                "car7-nav 启动: {} 个关键点 (原{}点) speed={} radius={} turn_thresh={}".format(
                    len(nav.waypoints), len(wps), args.speed, args.radius, args.turn_thresh))

        def _on_fix(self, msg):
            if msg.status.status < 0:
                self.gps_ok = False
                return
            if not args.no_validate:
                # 需要 RTK 固定解才动 (安全)
                self.gps_ok = (msg.status.status >= 2)
            else:
                self.gps_ok = True
            if msg.latitude == 0.0 and msg.longitude == 0.0:
                return
            nav.on_position(msg.latitude, msg.longitude, msg.altitude)

        def _control(self):
            if not self.gps_ok:
                # 无有效 fix → 停车, 等待信号
                stop = Twist()
                self.pub.publish(stop)
                return
            cmd = nav.control()
            if cmd is None:
                stop = Twist()
                self.pub.publish(stop)
                return
            twist = Twist()
            twist.linear.x = float(cmd[0])
            twist.angular.z = float(cmd[1])
            self.pub.publish(twist)

    rclpy.init()
    node = NavNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        stop = Twist()
        node.pub.publish(stop)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
