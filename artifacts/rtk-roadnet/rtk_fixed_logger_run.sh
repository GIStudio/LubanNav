#!/usr/bin/env bash
# RTK Fixed 日志节点启动包装（systemd ExecStart 用；exec 保持进程树单一）
set -e
cd /home/pc/campusCar
mkdir -p data/logs data/maps
# ── 自愈单实例：启动即清掉已存在的 rtk_fixed_logger 实例（host + 容器）──
# 与 rtk_fixed_logger.py 内的 flock 守卫一致：无论从哪里启动(systemd/host/手动)
# 都收敛为「最新顶替旧实例」的单一实例，避免多实例叠加重复订阅 /fix。
# host 侧进程（容器 exec 也可见于宿主命名空间）：
pkill -9 -f 'rtk_fixed_logger.py' 2>/dev/null || true
# 容器内进程（若 host 侧 pkill 未覆盖，此处再兜底）：
CONTAINER="${RTK_ROADNET_CONTAINER:-campuscar-stm32-hoverboard}"
if [ -n "$CONTAINER" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    docker exec "$CONTAINER" bash -c 'pkill -9 -f rtk_fixed_logger.py 2>/dev/null || true' 2>/dev/null || true
    sleep 0.5
fi
# 仅当 host 真能 import rclpy 才在 host 跑；否则一律用容器（容器有 ROS /fix）
if command -v ros2 >/dev/null 2>&1 && python3 -c 'import rclpy' 2>/dev/null; then
    exec python3 src/rtk_tools/rtk_fixed_logger.py
fi
if [ -n "$CONTAINER" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    exec docker exec "$CONTAINER" bash -lc \
        'source /opt/ros/humble/setup.bash && exec python3 /workspace/campusCar-new-chassis/src/rtk_tools/rtk_fixed_logger.py'
fi
echo "rtk_fixed_logger: 找不到 ROS2 环境（host 无 ros2，容器不可用）" >&2
exit 1
