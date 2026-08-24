#!/usr/bin/env python3
"""Unit tests for car7_status_server.py (pure logic; no ROS, no network)."""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import car7_status_server as status

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


def test_jsonl_stats():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "rtk_fixed.jsonl")
        with open(path, "w") as handle:
            handle.write(json.dumps({"type": "session_start", "session": "s1"}) + "\n")
            handle.write(json.dumps({"type": "fix", "lat": 22.888, "lon": 113.477, "status": 2}) + "\n")
            handle.write(json.dumps({"type": "fix", "lat": 22.889, "lon": 113.478, "status": 2}) + "\n")
        stats = status.read_jsonl_stats(path)
        check("jsonl counts", stats["records"] == 2 and stats["sessions"] == 1, stats)
        check("jsonl last fix", stats["lastFix"]["lat"] == 22.889, stats["lastFix"])
    missing = status.read_jsonl_stats("/nonexistent.jsonl")
    check("jsonl missing file", missing["records"] == 0, missing)


def test_roadnet_stats():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "campus_road_network.json")
        with open(path, "w") as handle:
            json.dump({"nodes": [{"id": 1}, {"id": 2}], "edges": [{"from": 1, "to": 2}], "builtAt": "2026-08-23T08:00:00Z"}, handle)
        stats = status.read_roadnet_stats(path)
        check("roadnet counts", stats["nodes"] == 2 and stats["edges"] == 1, stats)
    empty = status.read_roadnet_stats("/nonexistent.json")
    check("roadnet missing", empty["nodes"] == 0 and empty["edges"] == 0, empty)


def test_snapshot_structure_without_ros():
    with tempfile.TemporaryDirectory() as tmp:
        collector = status.StatusCollector(data_dir=tmp, bridge_url="http://127.0.0.1:1/")
        snapshot = collector.snapshot()
        check("snapshot keys", all(key in snapshot for key in
              ["rtk", "fixLabel", "jsonl", "roadnet", "rosReady", "time"]), snapshot.keys())
        check("snapshot ros ready false", snapshot["rosReady"] is False)
        check("snapshot no fix label", snapshot["fixLabel"] == "无信号", snapshot["fixLabel"])
        check("snapshot no fake position without history",
              snapshot["rtk"].get("approximate") is not True and
              snapshot["rtk"].get("latitude") is None, snapshot["rtk"])


def test_page_contains_ui():
    check("page has fix badge", "RTK 定位" in status.PAGE_HTML)
    check("page has EventSource", "EventSource" in status.PAGE_HTML)
    check("page has stream endpoint", "/api/stream" in status.PAGE_HTML)
    check("page has timeline", "tl-start" in status.PAGE_HTML)
    check("page has save segment", "traj-save" in status.PAGE_HTML)
    check("page has auto select", "traj-auto" in status.PAGE_HTML)


def test_save_and_load_trajectory():
    import time
    with tempfile.TemporaryDirectory() as tmp:
        # 造 5 个 fix 记录
        log = os.path.join(tmp, "logs", "rtk_fixed.jsonl")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        base = time.time() * 1000
        with open(log, "w") as handle:
            for i in range(5):
                handle.write(json.dumps({"type": "fix", "lat": 22.88 + i * 1e-4, "lon": 113.47,
                                         "t": "2026-08-23T{:02d}:00:00Z".format(10 + i)}) + "\n")
        collector = status.StatusCollector(data_dir=tmp, bridge_url="http://127.0.0.1:1/")
        traj = collector.trajectory()
        check("trajectory meta count", traj["meta"]["count"] == 5, traj["meta"])
        check("trajectory meta duration", traj["meta"]["durationSeconds"] == 14400.0, traj["meta"])
        # 保存中段（索引 1..4）
        result = collector.save_trajectory("lab_loop", traj["points"][1:4])
        check("save ok", result.get("ok") is True, result)
        saved = collector.list_saved()
        check("list saved", len(saved) == 1 and saved[0]["points"] == 3, saved)
        # 读回内容含 t
        payload = json.loads((collector.saved_dir() / saved[0]["file"]).read_text(encoding="utf-8"))
        check("saved keeps t", payload["waypoints"][0].get("t") is not None, payload["waypoints"][0])
        check("saved meta", payload["meta"]["count"] == 3, payload["meta"])


def test_annotate_speeds():
    # 沿直线, 相邻 ~5m, 每秒一点 → 每边速度 ~5 m/s
    lat0, lon0 = 22.88, 113.47
    pts = [{"lat": lat0 + i * 5e-5, "lon": lon0, "t": "2026-08-23T00:00:0{}Z".format(i)} for i in range(6)]
    out = status.annotate_speeds(list(pts))
    check("annotate speedAvg windowed", out[2]["speedAvg"] and 3 < out[2]["speedAvg"] < 8, out[2])
    check("annotate speedInstant", out[2]["speedInstant"] is not None, out[2])
    # 断段: 第2点后跳到 >10m
    pts2 = [dict(p) for p in pts[:3]]
    pts2.append({"lat": 22.90, "lon": 113.47, "t": "2026-08-23T00:00:03Z"})
    out2 = status.annotate_speeds(list(pts2))
    check("annotate 断段不跨段(无speedAvg)", out2[3].get("speedAvg") is None, out2[3])


def test_smooth_trajectory():
    lat0, lon0 = 22.88, 113.47
    # 每隔一点加 1e-5 抖动 → 原始相邻跳变较大, 平滑后应明显减小
    pts = [{"lat": lat0 + i * 5e-5 + (1e-5 if i % 2 else 0), "lon": lon0,
            "t": "2026-08-23T00:00:0{}Z".format(i)} for i in range(20)]
    raw_jumps = max(abs(pts[i + 1]["lat"] - pts[i]["lat"]) for i in range(len(pts) - 1))
    out = status.smooth_trajectory(list(pts), window=10)
    check("smooth keeps count", len(out) == len(pts), len(out))
    check("smooth keeps t", out[5].get("t") == pts[5].get("t"), out[5])
    sm_jumps = max(abs(out[i + 1]["lat"] - out[i]["lat"]) for i in range(len(out) - 1))
    check("smooth reduces jumps", sm_jumps < raw_jumps, (raw_jumps, sm_jumps))
    # 断段: 第2点后跳到很远(>10m) → 平滑窗口不跨段, 断段点不受前段影响
    pts2 = [dict(p) for p in pts[:3]]
    pts2.append({"lat": 22.90, "lon": 113.47, "t": "2026-08-23T00:00:03Z"})
    out2 = status.smooth_trajectory(list(pts2), window=10)
    check("smooth 断段不跨段(最后点不回归前段)", abs(out2[3]["lat"] - 22.90) < 1e-6, out2[3]["lat"])


if __name__ == "__main__":
    test_jsonl_stats()
    test_roadnet_stats()
    test_snapshot_structure_without_ros()
    test_page_contains_ui()
    test_save_and_load_trajectory()
    test_annotate_speeds()
    test_smooth_trajectory()
    print("\n{} passed, {} failed".format(PASSED, len(FAILED)))
    sys.exit(1 if FAILED else 0)
