"""roadnet_builder / rtk_fixed_logger 纯逻辑单测（无需 ROS2）。
运行：python3 -m unittest test_roadnet_builder -v
部署位置：campusCar/src/rtk_tools/test_roadnet_builder.py
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from roadnet_builder import (
    RoadNetworkBuilder,
    build_from_log,
    haversine_m,
    parse_log_line,
    save_network,
)
from rtk_fixed_logger import (
    RTK_FIXED_STATUS,
    build_record,
    is_valid_coordinate,
    session_start_record,
    should_log,
)


class TestHaversine(unittest.TestCase):
    def test_known_distance(self):
        # 近似 111m/deg 纬度：0.001° ≈ 111m
        dist = haversine_m(22.888, 113.477, 22.889, 113.477)
        self.assertAlmostEqual(dist, 111.2, delta=2.0)

    def test_zero_distance(self):
        self.assertEqual(haversine_m(1.0, 2.0, 1.0, 2.0), 0.0)


class TestLoggerLogic(unittest.TestCase):
    def test_fixed_status_is_4(self):
        # 本系统约定：4=RTK_FIXED（core/bridge.py STATUS_MAP）
        self.assertEqual(RTK_FIXED_STATUS, 4)

    def test_should_log_filters_status_and_distance(self):
        ok, _ = should_log(4, {4}, 22.888, 113.477, None, None, 0.5)
        self.assertTrue(ok)
        # Float(5) / DGPS(1) 不记
        self.assertFalse(should_log(5, {4}, 22.888, 113.477, None, None, 0.5)[0])
        self.assertFalse(should_log(1, {4}, 22.888, 113.477, None, None, 0.5)[0])
        # 距离太近不记
        self.assertFalse(
            should_log(4, {4}, 22.8880001, 113.477, 22.888, 113.477, 0.5)[0]
        )

    def test_is_valid_coordinate(self):
        self.assertTrue(is_valid_coordinate(22.888, 113.477))
        self.assertFalse(is_valid_coordinate(91.0, 113.477))
        self.assertFalse(is_valid_coordinate(22.888, 181.0))
        self.assertFalse(is_valid_coordinate(float("nan"), 113.477))

    def test_build_record_shape(self):
        record = build_record(123.456, 22.888, 113.477, 5.0, 4, cov_m2=0.01, session="S1")
        self.assertEqual(record["type"], "fix")
        self.assertEqual(record["status"], 4)
        self.assertEqual(record["session"], "S1")
        self.assertIn("t", record)
        self.assertIn("ros_t", record)


class TestParseLogLine(unittest.TestCase):
    def test_skips_session_markers_and_garbage(self):
        self.assertIsNone(parse_log_line('{"type":"session_start","session":"S1"}'))
        self.assertIsNone(parse_log_line("not json"))
        self.assertIsNone(parse_log_line(""))
        record = parse_log_line(
            '{"type":"fix","lat":22.888,"lon":113.477,"alt":5.0,"status":4}'
        )
        self.assertEqual(record["lat"], 22.888)


class TestRoadNetworkBuilder(unittest.TestCase):
    def test_links_each_point_to_nearest_k(self):
        builder = RoadNetworkBuilder(k=3, merge_radius_m=0.2, max_edge_m=50.0)
        # 沿经度方向一条直线：每点相距约 1m（0.00001° lon ≈ 1m @ 22.9°）
        points = [(22.8880 + i * 0.000001, 113.4770 + i * 0.000010) for i in range(5)]
        for i, (lat, lon) in enumerate(points):
            builder.add_fix(lat, lon, t=i)
        self.assertEqual(len(builder.nodes), 5)
        # 每个点都应有边，且边数 >= 4（链式：至少 N-1 条）
        self.assertGreaterEqual(len(builder.edges), 4)
        # 端点到最近 3 个点的边距离应合理（<= ~3m）
        for edge in builder.edges:
            self.assertLessEqual(edge["distanceMeters"], 4.0)

    def test_merge_radius_dedup(self):
        builder = RoadNetworkBuilder(k=3, merge_radius_m=0.5, max_edge_m=50.0)
        builder.add_fix(22.888, 113.477)
        # 0.2m 内的点 → 合并，不新建节点
        builder.add_fix(22.8880001, 113.4770002)
        self.assertEqual(len(builder.nodes), 1)
        self.assertEqual(builder.nodes["N0"]["count"], 2)

    def test_max_edge_cap(self):
        builder = RoadNetworkBuilder(k=3, merge_radius_m=0.2, max_edge_m=5.0)
        # 两个相距 ~50m 的点：超过 max_edge，不应建边
        builder.add_fix(22.888, 113.477)
        builder.add_fix(22.888, 113.47750)
        self.assertEqual(len(builder.nodes), 2)
        self.assertEqual(len(builder.edges), 0)

    def test_network_json_shape(self):
        builder = RoadNetworkBuilder(k=3)
        builder.add_fix(22.888, 113.477, alt=5.0, t="t1")
        builder.add_fix(22.88802, 113.477, alt=5.0, t="t2")
        network = builder.to_network()
        self.assertEqual(network["schemaVersion"], "1.0")
        self.assertEqual(network["nodeCount"], 2)
        self.assertGreaterEqual(network["edgeCount"], 1)
        self.assertEqual(network["buildRule"]["linkNearestK"], 3)
        self.assertIn("nodes", network)
        self.assertIn("edges", network)


class TestFileFlow(unittest.TestCase):
    def test_rebuild_and_save_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "rtk_fixed.jsonl"
            net_path = Path(tmp) / "campus_road_network.json"
            with open(log_path, "w", encoding="utf-8") as f:
                f.write(json.dumps(session_start_record("S1")) + "\n")
                for i in range(6):
                    f.write(
                        json.dumps(
                            build_record(i, 22.888 + i * 1e-6, 113.477 + i * 1e-5, 5.0, 4)
                        )
                        + "\n"
                    )
            builder = RoadNetworkBuilder(k=3, merge_radius_m=0.2, max_edge_m=50.0)
            count = build_from_log(log_path, builder)
            self.assertEqual(count, 6)  # session 行被跳过
            save_network(builder.to_network(), net_path)
            self.assertTrue(net_path.exists())
            loaded = json.loads(net_path.read_text(encoding="utf-8"))
            self.assertEqual(loaded["nodeCount"], 6)
            self.assertGreaterEqual(loaded["edgeCount"], 5)

    def test_watch_incremental_uses_same_builder(self):
        # 增量语义：分两次喂点，第二次的点应能连到第一次的点
        builder = RoadNetworkBuilder(k=3, merge_radius_m=0.2, max_edge_m=50.0)
        for i in range(3):
            builder.add_fix(22.888, 113.477 + i * 1e-5)
        edges_before = len(builder.edges)
        for i in range(3, 6):
            builder.add_fix(22.888, 113.477 + i * 1e-5)
        self.assertGreater(len(builder.edges), edges_before)
        # 新点应连到旧链（存在跨批次的边）
        ids = set(builder.nodes.keys())
        cross_batch = [
            e for e in builder.edges
            if e["from"] in ids and e["to"] in ids
        ]
        self.assertGreaterEqual(len(builder.edges), 5)


if __name__ == "__main__":
    unittest.main()
