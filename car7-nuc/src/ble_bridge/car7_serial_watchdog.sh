#!/usr/bin/env bash
# car7_serial_watchdog.sh — 底盘串口热加载看门狗（host 层，systemd 守护）
#
# 目标：不阻塞调试。底盘串口缺失时容器以 skip 模式运行（RTK/相机/桥/状态台
# 全可用）；串口齐全（front+rear）时自动切回 local_command 并重启容器加载底盘。
#
# 只改 config/profiles/stm32_hoverboard_4wd.local.env 的 CHASSIS_START_MODE
# （launch_all.sh 的 preflight 在 skip 模式下直接跳过串口检查，这是项目自带
# 的配置覆盖机制，不动对方脚本/镜像）。
set -uo pipefail

LOCAL_ENV="/home/pc/campusCar/config/profiles/stm32_hoverboard_4wd.local.env"
FRONT="${HOVERBOARD_FRONT_DEVICE:-/dev/ttyUSB0}"
REAR="${HOVERBOARD_REAR_DEVICE:-/dev/ttyUSB1}"
CONTAINER="campuscar-stm32-hoverboard"
STATE_FILE="/tmp/car7-serial-state"
CHECK_MS="${CAR7_WATCHDOG_MS:-5000}"

log() { echo "[watchdog] $*"; }

set_mode() {
    local mode="$1"
    if grep -q '^CHASSIS_START_MODE=' "$LOCAL_ENV" 2>/dev/null; then
        sed -i "s|^CHASSIS_START_MODE=.*|CHASSIS_START_MODE=${mode}|" "$LOCAL_ENV"
    else
        printf '\n# 底盘串口热加载：由 car7-serial-watchdog 管理\nCHASSIS_START_MODE=%s\n' "$mode" >> "$LOCAL_ENV"
    fi
}

container_running() {
    docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true
}

while true; do
    if [ -e "$FRONT" ] && [ -e "$REAR" ]; then
        MODE="local_command"
    else
        MODE="skip"
    fi

    PREV="$(cat "$STATE_FILE" 2>/dev/null || echo none)"
    RESTARTED=0
    if [ "$MODE" != "$PREV" ]; then
        echo "$MODE" > "$STATE_FILE"
        set_mode "$MODE"
        log "底盘串口状态变化 -> ${MODE}（front=${FRONT} rear=${REAR}），重启容器加载"
        docker restart "$CONTAINER" >/dev/null 2>&1 || true
        RESTARTED=1
    elif ! container_running; then
        log "容器不在运行，尝试启动（mode=${MODE}）"
        set_mode "$MODE"
        docker start "$CONTAINER" >/dev/null 2>&1 || true
        RESTARTED=1
    fi
    if [ "$RESTARTED" = "1" ]; then
        # 容器重启后 launch 脚本会拉起自己的 nmea 驱动；等容器+ROS 就绪后
        # 重启我们的自动匹配驱动（ExecStartPre 会清掉 launch 实例，避免双驱动抢串口）
        sleep 10
        systemctl restart car7-nmea-driver >/dev/null 2>&1 || true
        log "已重启 car7-nmea-driver（自动匹配串口，独占驱动）"
    fi

    sleep "$((CHECK_MS / 1000))"
done
