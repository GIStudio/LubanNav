#!/usr/bin/env bash
# 一键启停 RTK Fixed 日志 + 自动路网构建（systemd 已装时走 systemctl，否则 nohup 兜底）。
set -e
cd /home/pc/campusCar
SVC_A=rtk-fixed-logger.service
SVC_B=rtk-roadnet-builder.service
mkdir -p data/logs data/maps

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    case "${1:-start}" in
        start)
            echo "1" | sudo -S -p "" systemctl restart "$SVC_A" "$SVC_B" 2>/dev/null \
                || sudo systemctl restart "$SVC_A" "$SVC_B"
            systemctl --no-pager status "$SVC_A" "$SVC_B" | head -12
            ;;
        stop)
            sudo systemctl stop "$SVC_A" "$SVC_B"
            ;;
        status)
            systemctl --no-pager status "$SVC_A" "$SVC_B" | head -20
            ;;
        *)
            echo "用法: $0 [start|stop|status]" >&2
            exit 2
            ;;
    esac
    exit 0
fi

# 无 systemd 兜底（调试用）
case "${1:-start}" in
    start)
        pkill -f "[r]tk_fixed_logger.py" 2>/dev/null || true
        pkill -f "[r]oadnet_builder.py" 2>/dev/null || true
        sleep 1
        nohup bash src/rtk_tools/rtk_fixed_logger_run.sh >> data/logs/rtk_fixed_logger.log 2>&1 &
        echo $! > data/logs/rtk_fixed_logger.pid
        nohup python3 src/rtk_tools/roadnet_builder.py --watch \
            >> data/logs/roadnet_builder.log 2>&1 &
        echo $! > data/logs/roadnet_builder.pid
        echo "started logger $(cat data/logs/rtk_fixed_logger.pid) builder $(cat data/logs/roadnet_builder.pid)"
        ;;
    stop)
        pkill -f "[r]tk_fixed_logger.py" 2>/dev/null || true
        pkill -f "[r]oadnet_builder.py" 2>/dev/null || true
        echo "stopped"
        ;;
    status)
        ps aux | grep -E "[r]tk_fixed_logger|[r]oadnet_builder" || echo "not running"
        ;;
    *)
        echo "用法: $0 [start|stop|status]" >&2
        exit 2
        ;;
esac
