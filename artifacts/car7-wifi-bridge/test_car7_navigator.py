#!/usr/bin/env python3
"""car7_navigator.py 纯逻辑单测 (无 ROS)。"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import car7_navigator as nav

PASSED = 0
FAILED = []


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print("PASS  {}".format(name))
    else:
        FAILED.append(name)
        print("FAIL  {}  {}".format(name, detail))


def test_build_key_waypoints():
    # 沿直线每 ~0.5m 一个点, min_leg=1.0 → 应抽稀到约一半
    pts = [{"lat": 22.88, "lon": 113.47 + i * 5e-6} for i in range(20)]
    key = nav.build_key_waypoints(pts, min_leg=1.0, turn_thresh_deg=25)
    check("build_key_waypoints 直线抽稀", 0 < len(key) < len(pts), (len(key), len(pts)))
    # 拐弯处应保留: 先东后北, L 形
    base_lat, base_lon = 22.88, 113.47
    pts2 = []
    for i in range(6):
        pts2.append({"lat": base_lat, "lon": base_lon + i * 2e-4})   # 向东
    for i in range(1, 7):
        pts2.append({"lat": base_lat + i * 2e-4, "lon": base_lon + 6 * 2e-4})  # 向北
    key2 = nav.build_key_waypoints(pts2, min_leg=1.0, turn_thresh_deg=20)
    check("build_key_waypoints 拐弯保留", len(key2) >= 3, len(key2))
    check("build_key_waypoints 首点保留", key2[0] == pts2[0], key2[0])


def test_angle_diff():
    check("angle_diff 0", abs(nav.angle_diff(0.0, 0.0)) < 1e-9)
    check("angle_diff wrap", abs(nav.angle_diff(math.radians(350), math.radians(10)) - math.radians(-20)) < 1e-6)
    check("angle_diff same", abs(nav.angle_diff(math.pi, -math.pi)) < 1e-6)


def test_heading_estimator():
    he = nav.HeadingEstimator()
    check("heading init none", he.heading is None)
    he2 = nav.HeadingEstimator()
    he2.update(0.0, 0.0)
    he2.update(0.1, 0.0)  # 向东
    check("heading east", he2.heading is not None and abs(he2.heading) < 0.05, he2.heading)
    he3 = nav.HeadingEstimator()
    he3.update(0.0, 0.0)
    he3.update(0.0, 0.1)  # 向北 (dy>0)
    check("heading north", he3.heading is not None and abs(he3.heading - math.pi / 2) < 0.05, he3.heading)


def test_right_turn_when_target_is_east_but_heading_north():
    """车在起点朝北 (heading≈pi/2), 目标在正东 → 到点后应右转 (angular<0)。"""
    wps = [{"lat": 0.0, "lon": 0.0}, {"lat": 0.0, "lon": 2e-4}]  # 目标在东
    nav2 = nav.StopAndGoNavigator(wps, speed=0.3, radius=0.3, min_leg=0.0, turn_thresh_deg=5)
    # 建航向: 向北移动 (lon 不变, lat 增加)
    nav2.on_position(0.0, 0.0, 0.0)
    nav2.on_position(3e-6, 0.0, 0.0)   # 向北
    check("north heading established", nav2.heading() is not None and nav2.heading() > 0.5, nav2.heading())
    # 车仍在起点附近 → wp0 在半径内, control 会推进到 wp1 并进入 ALIGN
    lin, ang = nav2.control()
    check("right turn angular<0", ang < 0, (lin, ang))


def test_forward_when_aligned_east():
    """车朝东且目标也正东且远 → FORWARD 直行 (linear>0, 不进入 ALIGN)。"""
    wps = [{"lat": 0.0, "lon": 2e-4}]  # 单一目标远正东
    nav2 = nav.StopAndGoNavigator(wps, speed=0.3, radius=0.3, min_leg=0.0, turn_thresh_deg=5)
    nav2.on_position(0.0, 0.0, 0.0)
    nav2.on_position(0.0, 3e-6, 0.0)  # 向东移动 → hdg≈0
    nav2.state = nav2.STATE_FORWARD
    lin, ang = nav2.control()
    check("forward stays forward", nav2.state == nav2.STATE_FORWARD, nav2.state)
    check("forward positive speed", lin > 0, lin)


def test_arrival_advances_waypoint():
    wps = [{"lat": 0.0, "lon": 0.0}, {"lat": 0.0, "lon": 1e-4}]
    nav2 = nav.StopAndGoNavigator(wps, radius=8.0, min_leg=0.0)  # 半径大到直接到达 wp0
    nav2.on_position(0.0, 0.0, 0.0)
    lin, ang = nav2.control()
    check("arrival advances wp_index", nav2.wp_index == 1, nav2.wp_index)
    check("arrival enters ALIGN", nav2.state in (nav2.STATE_ALIGN, nav2.STATE_FORWARD), nav2.state)


def test_odom_yaw_calibration():
    """odom 原始朝北(pi/2), 但 RTK 差分向东(0) → 标定 offset=-pi/2, 对齐后 heading=0(东)。"""
    nav2 = nav.StopAndGoNavigator([{"lat": 0.0, "lon": 0.0}, {"lat": 0.0, "lon": 2e-4}], radius=0.3, min_leg=0.0)
    nav2.set_odom_yaw(math.pi / 2)
    nav2.on_position(0.0, 0.0, 0.0)
    nav2.on_position(0.0, 0.1, 0.0)  # 经度+ → 向东
    check("odom 已标定", nav2.yaw_offset is not None, nav2.yaw_offset)
    check("标定后 heading 向东", abs(nav2.heading()) < 0.2, nav2.heading())


def test_align_timeout_forces_forward():
    """转向超过 max_align_secs 仍未对齐 → 强制回 FORWARD, 杜绝 360/720 无限转。"""
    wps = [{"lat": 0.0, "lon": 0.0}, {"lat": 0.0, "lon": 2e-4}]
    nav2 = nav.StopAndGoNavigator(wps, radius=0.3, min_leg=0.0, max_align_secs=0.0)
    nav2.on_position(0.0, 0.0, 0.0)
    nav2.on_position(3e-6, 0.0, 0.0)  # 建航向(东)
    nav2._begin_align()
    lin, ang = nav2._align_cmd(math.atan2(0, 1))  # 目标正东
    check("align timeout -> FORWARD", nav2.state == nav2.STATE_FORWARD, nav2.state)


def test_align_speed_high_enough_for_diff():
    """转正时保持足够前进 (>=0.15) 以便 RTK 差分航向更新, 避免原地蹭无位移死循环。"""
    nav2 = nav.StopAndGoNavigator([], min_leg=0.0)
    check("align_speed supports RTK diff", nav2.align_speed >= 0.15, nav2.align_speed)
    check("tolerant heading min_move", nav.HeadingEstimator().min_move <= 0.03, nav.HeadingEstimator().min_move)


if __name__ == "__main__":
    test_build_key_waypoints()
    test_angle_diff()
    test_heading_estimator()
    test_right_turn_when_target_is_east_but_heading_north()
    test_forward_when_aligned_east()
    test_arrival_advances_waypoint()
    test_odom_yaw_calibration()
    test_align_timeout_forces_forward()
    test_align_speed_high_enough_for_diff()
    print("\n{} passed, {} failed".format(PASSED, len(FAILED)))
    sys.exit(1 if FAILED else 0)
