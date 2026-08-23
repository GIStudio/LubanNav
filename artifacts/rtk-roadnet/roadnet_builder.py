#!/usr/bin/env python3
"""自动构建路网后端服务 — 从 RTK Fixed 持久化日志增量构建校园路网。

数据流：
  rtk_fixed_logger.py  --追加--> data/logs/rtk_fixed.jsonl
  roadnet_builder.py   --读取--> 自动把每个新点关联到最近 k(默认3) 个点，
                                 输出 data/maps/campus_road_network.json

两种模式：
  --watch（默认）：tail 日志文件，新点到达即增量构图并原子落盘，随车常驻。
  --rebuild：从头重放整个日志重建路网（适合手工触发或升级后一次性重建）。

纯 Python 标准库，无 ROS 依赖（可在宿主或容器运行，便于单测）。
部署位置：campusCar/src/rtk_tools/roadnet_builder.py
"""

import argparse
import json
import math
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def haversine_m(lat1, lon1, lat2, lon2):
    """WGS84 大圆距离（米）。"""
    R = 6_371_008.8
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _cell_key(lat, lon, size_m):
    """把经纬度映射到边长为 size_m 的网格单元（局部等距近似）。"""
    lat_rad = math.radians(lat)
    m_per_deg_lat = 110_574.0
    m_per_deg_lon = 110_574.0 * math.cos(lat_rad)
    cx = int(math.floor(lon * m_per_deg_lon / size_m))
    cy = int(math.floor(lat * m_per_deg_lat / size_m))
    return (cx, cy)


class RoadNetworkBuilder:
    """增量路网：每个新点关联到最近的 k 个已有点（默认最近 3 个点）。

    设计：
    - 去重：新点与已有节点距离 < merge_radius_m 时视为同一点（更新计数，不新建）。
    - 关联：以 max_edge_m 为网格边长做空间索引，只对半径内候选算距离，
      取最近 k 个建无向边（一对点只保留一条边）。
    - 全增量：只处理新点，历史点不需要重算（新点入图后再补它到旧点的边）。
    """

    def __init__(self, k=3, merge_radius_m=0.5, max_edge_m=25.0):
        if k < 1:
            raise ValueError("k must be >= 1")
        if merge_radius_m < 0 or max_edge_m < 0:
            raise ValueError("radii must be >= 0")
        self.k = k
        self.merge_radius_m = merge_radius_m
        self.max_edge_m = max_edge_m
        self.nodes = {}       # id -> node dict
        self.edges = []       # edge dicts（保持加入顺序，便于审计）
        self._edge_keys = set()
        self._grid = {}       # (cx, cy) -> [node_id]
        self._next_node_id = 0
        self._next_edge_id = 0

    # ── 查询 ──────────────────────────────────────────────────────────

    def _cell_size(self):
        return self.max_edge_m if self.max_edge_m > 0 else 50.0

    def _candidates_within(self, lat, lon, radius_m):
        """返回距 (lat,lon) <= radius_m 的节点 id（用网格粗筛 + 精确距离）。"""
        size = self._cell_size()
        if radius_m <= 0 or self.max_edge_m <= 0:
            # 无上限：退化为全量扫描（点少时可用）
            return list(self.nodes.keys())
        cx, cy = _cell_key(lat, lon, size)
        span = int(math.ceil(radius_m / size))
        ids = []
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for nid in self._grid.get((cx + dx, cy + dy), ()):
                    node = self.nodes[nid]
                    if haversine_m(lat, lon, node["lat"], node["lon"]) <= radius_m:
                        ids.append(nid)
        return ids

    # ── 构图 ──────────────────────────────────────────────────────────

    def add_fix(self, lat, lon, alt=None, t=None) -> bool:
        """加入一个 RTK Fixed 点；返回是否真正新建了节点。"""
        # 去重：半径内已有点 → 只更新计数
        merged = self._candidates_within(lat, lon, self.merge_radius_m)
        if merged:
            nid = merged[0]
            self.nodes[nid]["count"] += 1
            self.nodes[nid]["last_t"] = t
            return False

        nid = "N{}".format(self._next_node_id)
        self._next_node_id += 1
        node = {
            "id": nid,
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "alt": round(alt, 2) if alt is not None else None,
            "first_t": t,
            "last_t": t,
            "count": 1,
        }
        self.nodes[nid] = node
        size = self._cell_size()
        if self.max_edge_m > 0:
            self._grid.setdefault(_cell_key(lat, lon, size), []).append(nid)

        # 关联最近 k 个点（含上限截断）
        candidates = self._candidates_within(lat, lon, self.max_edge_m) if self.max_edge_m > 0 else list(self.nodes.keys())
        distances = []
        for other_id in candidates:
            if other_id == nid:
                continue
            other = self.nodes[other_id]
            distances.append(
                (haversine_m(lat, lon, other["lat"], other["lon"]), other_id)
            )
        distances.sort(key=lambda item: item[0])
        for dist_m, other_id in distances[: self.k]:
            self._add_edge(nid, other_id, dist_m)
        return True

    def _add_edge(self, a_id, b_id, dist_m):
        key = "{}-{}".format(min(a_id, b_id), max(a_id, b_id))
        if key in self._edge_keys:
            return
        self._edge_keys.add(key)
        edge = {
            "id": "E{}".format(self._next_edge_id),
            "from": a_id,
            "to": b_id,
            "distanceMeters": round(dist_m, 2),
        }
        self._next_edge_id += 1
        self.edges.append(edge)

    # ── 输出 ──────────────────────────────────────────────────────────

    def to_network(self, generated_at=None):
        return {
            "schemaVersion": "1.0",
            "generatedAt": generated_at or datetime.now(timezone.utc).isoformat(),
            "coordinateSystem": "wgs84",
            "nodeCount": len(self.nodes),
            "edgeCount": len(self.edges),
            "buildRule": {
                "fixedOnly": True,
                "linkNearestK": self.k,
                "mergeRadiusMeters": self.merge_radius_m,
                "maxEdgeMeters": self.max_edge_m,
            },
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges),
        }


def parse_log_line(line: str):
    """解析 rtk_fixed.jsonl 的一行；非航点记录（session_start 等）返回 None。"""
    text = line.strip()
    if not text:
        return None
    try:
        record = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(record, dict) or "lat" not in record or "lon" not in record:
        return None
    return record


def build_from_log(log_path: Path, builder: RoadNetworkBuilder) -> int:
    """重放整个日志（或从指定行号开始）加入 builder；返回处理的行数。"""
    if not log_path.exists():
        return 0
    count = 0
    with open(log_path, "r", encoding="utf-8") as handle:
        for line in handle:
            record = parse_log_line(line)
            if record is None:
                continue
            builder.add_fix(record["lat"], record["lon"], record.get("alt"), record.get("t"))
            count += 1
    return count


def save_network(network: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = path.with_suffix(path.suffix + ".tmp"), path
    with open(fd, "w", encoding="utf-8") as f:
        json.dump(network, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(fd, tmp)  # 原子替换，避免读半边文件


def _log(message: str) -> None:
    print("[roadnet] {}".format(message), flush=True)


def run_watch(args) -> None:
    log_path = Path(args.log_path)
    network_path = Path(args.network_path)
    builder = RoadNetworkBuilder(k=args.k, merge_radius_m=args.merge_radius, max_edge_m=args.max_edge)

    # 启动时先重放已有日志（含上次没来得及处理的尾部）
    processed = 0
    start = time.time()
    processed = build_from_log(log_path, builder)
    save_network(builder.to_network(), network_path)
    _log(
        "watch started: replayed {} records -> {} nodes / {} edges ({}s), network -> {}".format(
            processed, builder._next_node_id, len(builder.edges),
            round(time.time() - start, 1), network_path,
        )
    )

    offset = 0
    # "a+"：日志不存在时创建（logger 可能还没起来），然后从末尾开始读新增行
    with open(log_path, "a+", encoding="utf-8") as handle:
        handle.seek(0, os.SEEK_END)
        offset = handle.tell()

        stop = [False]

        def _on_signal(signum, frame):
            stop[0] = True

        signal.signal(signal.SIGTERM, _on_signal)
        signal.signal(signal.SIGINT, _on_signal)

        new_count = 0
        while not stop[0]:
            line = handle.readline()
            if line == "":
                time.sleep(args.poll_s)
                continue
            record = parse_log_line(line)
            if record is None:
                continue
            builder.add_fix(record["lat"], record["lon"], record.get("alt"), record.get("t"))
            new_count += 1
            if new_count >= args.save_every:
                save_network(builder.to_network(), network_path)
                _log(
                    "+{} points -> {} nodes / {} edges".format(
                        new_count, builder._next_node_id, len(builder.edges)
                    )
                )
                new_count = 0
        # 退出前落盘
        save_network(builder.to_network(), network_path)
        _log("stopped, final network -> {}".format(network_path))


def run_rebuild(args) -> None:
    log_path = Path(args.log_path)
    network_path = Path(args.network_path)
    builder = RoadNetworkBuilder(k=args.k, merge_radius_m=args.merge_radius, max_edge_m=args.max_edge)
    start = time.time()
    count = build_from_log(log_path, builder)
    save_network(builder.to_network(), network_path)
    _log(
        "rebuild done: {} records -> {} nodes / {} edges ({}s), network -> {}".format(
            count, builder._next_node_id, len(builder.edges),
            round(time.time() - start, 1), network_path,
        )
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="roadnet_builder",
        description="从 RTK Fixed 持久化日志自动构建路网（每个点关联最近 k 个点）。",
    )
    parser.add_argument("--log-path", default="data/logs/rtk_fixed.jsonl",
                        help="RTK Fixed 持久化日志（默认 data/logs/rtk_fixed.jsonl）")
    parser.add_argument("--network-path", default="data/maps/campus_road_network.json",
                        help="路网输出（默认 data/maps/campus_road_network.json）")
    parser.add_argument("--k", type=int, default=3, help="每个点关联的最近点数（默认 3）")
    parser.add_argument("--merge-radius", type=float, default=0.5,
                        help="同点合并半径（米，默认 0.5）")
    parser.add_argument("--max-edge", type=float, default=25.0,
                        help="最大边长（米，默认 25；0=不限，全量扫描）")
    parser.add_argument("--rebuild", action="store_true", help="一次性重放全量日志重建路网")
    parser.add_argument("--watch", action="store_true", help="常驻增量构建（默认）")
    parser.add_argument("--poll-s", type=float, default=2.0, help="watch 轮询间隔（秒，默认 2）")
    parser.add_argument("--save-every", type=int, default=20,
                        help="每新增 N 个点落盘一次（默认 20）")
    args = parser.parse_args(argv)
    if not args.watch and not args.rebuild:
        args.watch = True
    return args


def main(argv=None):
    args = parse_args(argv)
    if args.rebuild:
        run_rebuild(args)
    else:
        run_watch(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
