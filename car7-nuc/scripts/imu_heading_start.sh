#!/usr/bin/env bash
# Start IMU→heading bridge for outdoor RTK waypoint nav.
# Requires chassis started with HOVERBOARD_IMU_ENABLED=true and firmware IMU frames.
#
# Usage (inside Docker ROS shell, after chassis is up):
#   ./scripts/imu_heading_start.sh
#   ./scripts/imu_heading_start.sh --initial-yaw-deg 90   # face north at start
#
# Check:
#   ros2 topic hz /hoverboard/imu0/data
#   ros2 topic echo /heading --once

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

IMU_IN="${HOVERBOARD_IMU_TOPIC:-/hoverboard/imu0/data}"
echo "IMU heading bridge"
echo "  in:  ${IMU_IN}"
echo "  out: ${IMU_TOPIC:-/imu}  and  ${HEADING_TOPIC:-/heading}"
echo "  tip: if /hoverboard/imu0/data has no hz, chassis firmware is not sending IMU frames"

exec python3 "${PROJECT_ROOT}/src/imu_heading.py" \
    --imu-in "${IMU_IN}" \
    --imu-out "${IMU_TOPIC:-/imu}" \
    --heading-out "${HEADING_TOPIC:-/heading}" \
    "${PASSTHROUGH_ARGS[@]}"
