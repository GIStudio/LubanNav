#!/usr/bin/env bash
# Phone/desktop web teleop → /cmd_vel
# Usage (inside Docker ROS shell):
#   ./scripts/web_teleop.sh
# Then open: http://192.168.100.1:8090/

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASSTHROUGH_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --profile)
            [ $# -ge 2 ] || { echo "--profile requires a value" >&2; exit 2; }
            export ROBOT_PROFILE="$2"
            shift 2
            ;;
        *)
            PASSTHROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

# shellcheck disable=SC1091
source "${PROJECT_ROOT}/config/robot.env"

if [ ! -f "$ROS_SETUP" ]; then
    echo "ROS setup not found: $ROS_SETUP" >&2
    exit 1
fi

set +u
# shellcheck disable=SC1090
source "$ROS_SETUP"
set -u

PORT="${WEB_TELEOP_PORT:-8090}"
echo "Web teleop starting…"
echo "  Open on phone/PC (same Wi-Fi as this NUC):"
# Prefer real LAN addresses; 192.168.100.1 is only valid on the robot switch network.
ip -4 -o addr show scope global 2>/dev/null | awk -v p="$PORT" '
  {
    split($4, a, "/");
    iface=$2; ip=a[1];
    if (ip ~ /^127\./) next;
    printf "    http://%s:%s/  (%s)\n", ip, p, iface;
  }'
echo "  Do NOT use http://127.0.0.1:${PORT}/ on the phone — that only works on the NUC itself."

exec python3 "${PROJECT_ROOT}/src/web_teleop.py" \
    --port "${PORT}" \
    --topic "${CMD_VEL_TOPIC}" \
    --max-linear "${MAX_LINEAR_SPEED}" \
    --max-angular "${MAX_ANGULAR_SPEED}" \
    "${PASSTHROUGH_ARGS[@]}"
