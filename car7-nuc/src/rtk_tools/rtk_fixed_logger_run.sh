#!/usr/bin/env bash
# RTK Fixed 日志节点启动包装（systemd ExecStart 用；exec 保持进程树单一，便于守护）
# ROS2 环境定位顺序：
#   1. 先 source config/robot.env 拿到 HOVERBOARD_SETUP / ROS_SETUP / ROSBRIDGE_SETUP
#   2. 依次 source 存在的 setup.bash（workspace 优先，内含 distro underlay）
#   3. 都没有则退出 1（systemd 3s 自动重试；等 ROS 栈起来后即可连上 /fix）
set -e
cd /home/pc/campusCar
mkdir -p data/logs data/maps

# shellcheck disable=SC1091
source config/robot.env

for setup_file in "${HOVERBOARD_SETUP:-}" "${ROSBRIDGE_SETUP:-}" "${ROS_SETUP:-}"; do
    if [ -n "$setup_file" ] && [ -f "$setup_file" ]; then
        # shellcheck disable=SC1090
        source "$setup_file"
    fi
done

if command -v ros2 >/dev/null 2>&1 || [ -n "${ROS_DISTRO:-}" ]; then
    exec python3 src/rtk_tools/rtk_fixed_logger.py
fi

if [ -n "${RTK_ROADNET_CONTAINER:-}" ]; then
    exec docker exec "${RTK_ROADNET_CONTAINER}" python3 \
        /home/pc/campusCar/src/rtk_tools/rtk_fixed_logger.py
fi

echo "rtk_fixed_logger: 找不到 ROS2 环境（robot.env 的 setup.bash 均不存在）" >&2
exit 1
