#!/usr/bin/env bash
# car7_selfheal.sh — 运行环境自愈守卫（自动求解服务崩溃 / 残留进程 / 代码漂移 / RTK 失联）
#
# 自动检测并修复四类冲突, 避免靠人工排查:
#   1) 服务自愈   : 核心系统服务 inactive/failed -> 自动 restart
#   2) 代码漂移   : 服务进程启动时间 < 关键文件 mtime (代码已更新但服务仍跑旧版) -> 自动 restart
#   3) 进程去重   : 容器内残留/多余实例(旧 gps_navigator、重复 status/wifi/move) -> 自动清理
#   4) RTK 健康   : /fix 持续无固定解(status>=2) -> 自动重启 nmea-driver
#
# 以 User=root 常驻运行(免 sudo 重启 systemd 单元, 可 docker exec)。每 ROUND_SECS 一轮。
set -uo pipefail

CONTAINER="campuscar-stm32-hoverboard"
RUN_DIR="/home/pc/campusCar/src/ble_bridge"
RTK_DIR="/home/pc/campusCar/src/rtk_tools"
LOG="/home/pc/campusCar/data/logs/car7-selfheal.log"
STATE="/tmp/car7-selfheal.state"
ROUND_SECS="${CAR7_SELFHEAL_SECS:-30}"
RTK_MISS_MAX="${CAR7_RTK_MISS:-2}"      # 连续多少轮 /fix 无固定解才重启 nmea

SERVICES=(car7-wifi-bridge car7-status-server car7-web-teleop car7-nmea-driver move-executor)

# 用于漂移检测: "服务:文件1:文件2..." (文件在 RUN_DIR 或 RTK_DIR)
SVC_FILES=(
  "car7-wifi-bridge:car7_wifi_bridge.py:car7_protocol.py:car7_teleop.py"
  "car7-status-server:car7_status_server.py:car7_navigator.py:car7_protocol.py"
  "car7-web-teleop:web_teleop.py"
  "car7-nmea-driver:rtk_serial_probe.py"
)

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
restart_svc() { systemctl restart "$1" 2>/dev/null || true; log "ACTION restart $1 ($2)"; }

# 探测 /fix 是否有固定解 (status>=2)
fix_ok_check() {
  docker exec "$CONTAINER" bash -lc \
    'source /opt/ros/humble/setup.bash && timeout 3 ros2 topic echo /fix --field status 2>&1 | grep -Eq "status: [2-9]"' \
    2>/dev/null && echo 1 || echo 0
}

while true; do
  # ---------- 1) 服务自愈 ----------
  for svc in "${SERVICES[@]}"; do
    if ! systemctl is-active --quiet "$svc"; then
      restart_svc "$svc" "was inactive/failed"
    fi
  done

  # ---------- 2) 代码漂移重启 ----------
  for spec in "${SVC_FILES[@]}"; do
    svc="${spec%%:*}"
    files="${spec#*:}"
    start_ts=$(systemctl show -p ActiveEnterTimestamp "$svc" 2>/dev/null | cut -d= -f2-)
    [ -n "$start_ts" ] || continue
    start_epoch=$(date -d "$start_ts" +%s 2>/dev/null) || continue
    newest=0
    IFS=':' read -ra flist <<< "$files"
    for f in "${flist[@]}"; do
      path="$RUN_DIR/$f"; [ -f "$path" ] || path="$RTK_DIR/$f"
      [ -f "$path" ] || continue
      m=$(date +%s -r "$path" 2>/dev/null) || continue
      (( m > newest )) && newest=$m
    done
    if [ "$newest" -gt "$start_epoch" ]; then
      restart_svc "$svc" "code drift (file newer than service start)"
    fi
  done

  # ---------- 4) RTK 健康 ----------
  fix_ok=$(fix_ok_check)
  miss=0
  [ -f "$STATE" ] && miss=$(cat "$STATE" 2>/dev/null || echo 0)
  if [ "$fix_ok" = "1" ]; then
    miss=0
  else
    miss=$((miss + 1))
  fi
  echo "$miss" > "$STATE"
  if [ "$fix_ok" != "1" ] && [ "$miss" -ge "$RTK_MISS_MAX" ] && systemctl is-active --quiet car7-nmea-driver; then
    restart_svc car7-nmea-driver "rtk /fix lost (miss=${miss})"
    echo 0 > "$STATE"
  fi

  # ---------- 3) 进程去重 (容器内) ----------
  dedup_specs=(gps_navigator:0 car7_status_server:1 car7_wifi_bridge:1 move_executor:1)
  for spec in "${dedup_specs[@]}"; do
    pname="${spec%%:*}"
    expect="${spec#*:}"
    pat="[${pname:0:1}]${pname:1}"
    pids=$(docker exec "$CONTAINER" bash -lc "ps -eo pid=,cmd= | grep \"$pat\" | awk '{print \$1}'" 2>/dev/null \
           | tr ' ' '\n' | grep -v '^$' | tr '\n' ' ')
    n=$(echo -n "$pids" | tr ' ' '\n' | grep -c . || true)
    [ "$n" -gt "$expect" ] || continue
    keep=0
    for pid in $pids; do
      keep=$((keep + 1))
      [ "$keep" -gt "$expect" ] && { docker exec "$CONTAINER" bash -lc "kill -9 $pid 2>/dev/null || true" 2>/dev/null; log "ACTION kill-dedup $pname pid=$pid (n=$n expect=$expect)"; }
    done
  done

  log "round done (rtk_miss=${miss})"
  sleep "$ROUND_SECS"
done
