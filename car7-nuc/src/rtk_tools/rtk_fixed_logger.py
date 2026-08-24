#!/usr/bin/env python3
"""RTK Fixed 持久化日志节点 — 只记录 RTK 固定解，跨启动保留。

背景：原 path_recorder.py 是"会话式"记录——每次小车启动内存从空开始、每
会话存独立时间戳文件，看起来就像"每次清空 rtk 记录"。本节点改为**追加式
持久化日志**：只把 RTK Fixed（本系统 /fix status==4，见 core/bridge.py
STATUS_MAP：4=RTK_FIXED / 5=RTK_FLOAT / 1=DGPS）的历元追加写入
data/logs/rtk_fixed.jsonl，永不截断，随车 systemd 自启。

每个记录一行 JSON（JSONL），字段：t(ISO8601)/ros_t/lat/lon/alt/status/cov_m。
roadnet_builder.py 读取该日志自动构建路网。

部署位置：campusCar/src/rtk_tools/rtk_fixed_logger.py
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:  # ROS2 可选：让纯逻辑部分在无 ROS 环境下可导入做单测
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import NavSatFix
    from std_msgs.msg import String as StdString
except ImportError:  # pragma: no cover
    rclpy = None
    Node = None
    NavSatFix = None
    StdString = None

# 本系统 /fix 状态码约定（与 src/rtk_tools/core/bridge.py STATUS_MAP 一致）
RTK_FIXED_STATUS = 2  # nmea_navsat_driver 对 GGA quality 4/5(RTK) 发 sensor_msgs GBAS_FIX(2)；4 仅为 STATUS_MAP 兼容保留


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_008.8
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def is_valid_coordinate(lat, lon):
    return (
        isinstance(lat, (int, float)) and isinstance(lon, (int, float))
        and math.isfinite(lat) and math.isfinite(lon)
        and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0
    )


def covariance_hint(fix_msg):
    """返回位置协方差对角线的均值（米²），没有则为 None；用于质量审计。"""
    cov = getattr(fix_msg, "position_covariance", None)
    # rclpy 的 position_covariance 是 numpy 数组，不能直接做真值判断
    if cov is None or len(cov) == 0:
        return None
    values = [v for v in cov if isinstance(v, (int, float)) and v >= 0]
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def build_record(ros_time, lat, lon, alt, status, cov_m2=None, session=None):
    return {
        "type": "fix",
        "session": session,
        "t": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "ros_t": round(float(ros_time), 3),
        "lat": round(float(lat), 7),
        "lon": round(float(lon), 7),
        "alt": round(float(alt), 2) if alt is not None else None,
        "status": int(status),
        "cov_m": cov_m2,
    }


def session_start_record(session):
    return {
        "type": "session_start",
        "session": session,
        "t": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
    }


def should_log(status, fixed_statuses, lat, lon, last_lat, last_lon, min_dist_m):
    """纯判定逻辑（可单测）：是否应记录该历元。"""
    if status not in fixed_statuses:
        return False, None
    if not is_valid_coordinate(lat, lon):
        return False, None
    # 位置去重已移除: 每次 RTK 固定解都记录(含静止), 让时间轴记录持续到最新
    dist = haversine_m(lat, lon, last_lat, last_lon) if (last_lat is not None and last_lon is not None) else 0.0
    return True, dist


class RtkFixedLoggerNode(Node or object):
    """订阅 /fix，RTK Fixed 历元追加写入持久化 JSONL。

    无 ROS 环境下导入时退化为 object（便于单测纯逻辑），仅在 main() 里实例化。
    """

    def __init__(self, fix_topic, fixed_statuses, min_dist_m, log_path, backup_path=None):
        super().__init__("rtk_fixed_logger")
        self.fixed_statuses = set(fixed_statuses)
        self.min_dist_m = min_dist_m
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        # 双写备份：独立于 campusCar 目录（NUC 电源不稳反复重启时兜底）
        self.backup_path = Path(backup_path) if backup_path else None
        if self.backup_path is not None:
            self.backup_path.parent.mkdir(parents=True, exist_ok=True)

        self.session = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.total_records = 0
        self.session_records = 0
        self.last_lat = None
        self.last_lon = None

        # 启动写一个会话标记（便于 roadnet_builder 审计/切分）
        self._append(session_start_record(self.session))

        self.sub_fix = self.create_subscription(
            NavSatFix, fix_topic, self._on_fix, 10
        )
        self.pub_stats = self.create_publisher(
            StdString, "/rtk_fixed_log/status", 10,
        )
        self.create_timer(1.0, self._publish_stats)
        self.get_logger().info(
            "rtk_fixed_logger started: fix_topic={} fixed_statuses={} min_dist={}m log={} backup={}".format(
                fix_topic, sorted(self.fixed_statuses), min_dist_m, self.log_path, self.backup_path
            )
        )

    @staticmethod
    def _write_line(path, line):
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())  # 断电/重启不丢最后几条

    def _append(self, record):
        line = json.dumps(record, ensure_ascii=False) + "\n"
        self._write_line(self.log_path, line)
        if self.backup_path is not None:
            self._write_line(self.backup_path, line)

    def _on_fix(self, msg):
        status = int(msg.status.status)
        lat, lon, alt = float(msg.latitude), float(msg.longitude), float(msg.altitude)
        ok, _ = should_log(
            status, self.fixed_statuses, lat, lon,
            self.last_lat, self.last_lon, self.min_dist_m,
        )
        if not ok:
            return
        self.last_lat, self.last_lon = lat, lon
        record = build_record(
            msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9,
            lat, lon, alt, status,
            covariance_hint(msg), self.session,
        )
        self._append(record)
        self.total_records += 1
        self.session_records += 1

    def _publish_stats(self):
        text = json.dumps({
            "session": self.session,
            "session_records": self.session_records,
            "total_records": self.total_records,
            "last": {"lat": self.last_lat, "lon": self.last_lon},
            "log": str(self.log_path),
        }, ensure_ascii=False)
        self.pub_stats.publish(StdString(data=text))


# ---------------------------------------------------------------------------
# 单实例守卫：无论从哪里启动（systemd / host / 容器内 / docker exec），
# 都只保留最新一个实例。任何新的启动都会"顶替"旧的（杀掉旧进程）。
# ---------------------------------------------------------------------------
SINGLE_INSTANCE_PID_FILE = "data/rtk_fixed_logger.pid"
SINGLE_INSTANCE_OPTS = {
    "host": "data/rtk_fixed_logger.pid",
    "container": "/workspace/campusCar-new-chassis/data/rtk_fixed_logger.pid",
}


def _single_instance_path():
    """返回单实例 PID 文件路径（host 与容器内基于各自 cwd 自适应）。"""
    # 容器内 cwd=.../campusCar-new-chassis；host cwd=/home/pc/campusCar。
    # 两者 data/ 是同一挂载卷，PID 文件中存的 PID 均为宿主命名空间可见。
    return SINGLE_INSTANCE_PID_FILE if os.path.exists("data") else SINGLE_INSTANCE_PID_FILE


def _adopt_single_instance(pidfile=None):
    """单实例守卫：若已有存活实例则杀之，再写入自身 PID 并持锁。

    用 flock 互斥文件 + PID 文件实现原子「新顶旧」。任何来源启动本进程
    都会调用它，确保同一时刻全车只有一个 rtk_fixed_logger 在跑。

    返回一个保持打开的锁文件句柄；调用方需持有其引用，进程存活期间锁不被释放。
    """
    import fcntl
    import signal
    import struct

    pidfile = pidfile or _single_instance_path()
    lockfile = pidfile + ".lock"
    # data/ 目录存在（run.sh 已 mkdir -p）；确保锁目录可写
    Path(pidfile).parent.mkdir(parents=True, exist_ok=True)

    lock_f = open(lockfile, "w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # 有别的进程持锁 → 说明已有实例正在跑，杀掉它（新顶旧）
        try:
            old_pid = int(open(pidfile).read().strip())
        except Exception:
            old_pid = None
            # 无 PID 记录也拿不到锁：说明仍在握手/半死，直接尝试杀 rtk_fixed_logger 进程
        if old_pid is not None and old_pid != os.getpid():
            try:
                os.kill(old_pid, signal.SIGKILL)
                print("[rtk_fixed_logger] 单实例守卫: 杀掉旧实例 pid=%s" % old_pid, flush=True)
            except (ProcessLookupError, PermissionError):
                pass
        # 等旧进程释放锁（最多 3s 轮询）
        deadline = time.time() + 3.0
        while time.time() < deadline:
            try:
                fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                time.sleep(0.2)

    with open(pidfile, "w") as pf:
        pf.write(str(os.getpid()))
    print("[rtk_fixed_logger] 单实例守卫: 就绪 pid=%s pidfile=%s" % (os.getpid(), pidfile), flush=True)
    return lock_f


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="rtk_fixed_logger",
        description="RTK Fixed 持久化日志节点（只记录 status==4 固定解，追加写入，跨启动保留）。",
    )
    parser.add_argument("--fix-topic", default="/fix", help="NavSatFix 输入话题（默认 /fix）")
    parser.add_argument("--fixed-statuses", default="2,4",
                        help="视为 RTK Fixed 的状态码，逗号分隔（默认 4，见 core/bridge.py STATUS_MAP）")
    parser.add_argument("--min-dist", type=float, default=0.5,
                        help="相邻记录最小间距（米，默认 0.5，用于稀疏化）")
    parser.add_argument("--log-path", default="data/logs/rtk_fixed.jsonl",
                        help="持久化日志路径（默认 data/logs/rtk_fixed.jsonl，追加不截断）")
    parser.add_argument("--backup-path", default="/workspace/campusCar-new-chassis/rtk_backup/rtk_fixed.jsonl",
                        help="双写备份路径（默认容器挂载卷内独立目录；host 侧另有 systemd 定时快照到 /home/pc/rtk_logs/）")
    args = parser.parse_args(argv)
    statuses = []
    for part in args.fixed_statuses.split(","):
        part = part.strip()
        if part == "":
            continue
        try:
            statuses.append(int(part))
        except ValueError:
            parser.error("--fixed-statuses 必须是逗号分隔的整数（如 4）")
    if not statuses:
        parser.error("--fixed-statuses 不能为空")
    if args.min_dist < 0:
        parser.error("--min-dist 不能为负")
    return args, statuses


def main(argv=None):
    if rclpy is None:  # pragma: no cover
        print("rtk_fixed_logger: 需要 ROS2 (sensor_msgs/rclpy)，请在容器或已 source ROS 的环境运行",
              file=sys.stderr)
        return 1
    args, statuses = parse_args(argv)
    # 单实例守卫（new-replaces-old）：不管谁启动都只留最新一个
    lock_f = _adopt_single_instance()
    rclpy.init()
    node = RtkFixedLoggerNode(args.fix_topic, statuses, args.min_dist, args.log_path,
                              backup_path=args.backup_path)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, Exception):
        pass
    finally:
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass
        try:
            lock_f.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
