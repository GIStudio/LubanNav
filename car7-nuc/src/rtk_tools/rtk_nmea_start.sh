#!/usr/bin/env bash
# rtk_nmea_start.sh — 自动匹配 RTK GNSS 串口并启动 nmea 驱动（容器内运行）
#
# 流程：rtk_serial_probe.py 扫描 AirM2M 所有 ACM 接口，按 NMEA 有效性打分
# 选出 GNSS 数据口（USB 重连后接口映射变化也能自动匹配）→ 清掉旧驱动 →
# 以选中的口启动 nmea_serial_driver。无可靠口时回退默认 by-id if06。
#
# 用法（容器内，ROS 已 source）：
#   bash /workspace/campusCar-new-chassis/src/rtk_tools/rtk_nmea_start.sh
set -euo pipefail

cd /workspace/campusCar-new-chassis/src/rtk_tools

BAUD="${NMEA_BAUD:-115200}"
SAMPLE="${NMEA_PROBE_SAMPLE:-2.5}"

PORT="$(python3 rtk_serial_probe.py --baud "${BAUD}" --sample "${SAMPLE}" 2>/dev/null | tail -1)"
RC=$?
echo "[nmea] probe rc=${RC} port=${PORT}"
if [ -z "${PORT}" ]; then
  PORT="/dev/serial/by-id/usb-AirM2M_AirM2M_Compo_000000000001-if06"
  echo "[nmea] probe 未找到可靠口，回退默认口 ${PORT}"
fi

pkill -9 -f nmea_serial_driver 2>/dev/null || true
sleep 1

echo "[nmea] starting nmea_serial_driver on ${PORT} @ ${BAUD}"
exec ros2 run nmea_navsat_driver nmea_serial_driver \
    --ros-args -p "port:=${PORT}" -p "baud:=${BAUD}"
