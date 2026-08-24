#!/usr/bin/env bash
# 不通过 UE，直接向 /U2RTopic_Command 回放老师联调时的真实指令。
# 用法（在 Docker / 已 source ROS 的终端）：
#   ./scripts/ue_cmd_selftest.sh front|back|left|right|stop|nav
#   ./scripts/ue_cmd_selftest.sh file data/ue_fixtures/xxx.json

set -eo pipefail
# 不启用 nounset：source ROS setup 时可能碰到未绑定变量

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$ROOT/data/ue_fixtures"

if [[ -f "$ROOT/config/robot.env" ]]; then
  # shellcheck disable=SC1091
  set +u
  source "$ROOT/config/robot.env"
  set -u
fi
if [[ -n "${ROS_SETUP:-}" && -f "$ROS_SETUP" ]]; then
  # shellcheck disable=SC1090
  set +u
  source "$ROS_SETUP"
  set -u
elif [[ -f /opt/ros/humble/setup.bash ]]; then
  set +u
  # shellcheck disable=SC1091
  source /opt/ros/humble/setup.bash
  set -u
fi
set +u

usage() {
  cat <<EOF
用法: $0 <front|back|left|right|stop|nav|file <path.json>>

示例:
  $0 front
  $0 left
  $0 nav
  $0 file $FIXTURE_DIR/navigate_sample.json
EOF
}

pick_fixture() {
  case "$1" in
    front) echo "$FIXTURE_DIR/direction_front.json" ;;
    back)  echo "$FIXTURE_DIR/direction_back.json" ;;
    left)  echo "$FIXTURE_DIR/direction_left.json" ;;
    right) echo "$FIXTURE_DIR/direction_right.json" ;;
    stop)  echo "$FIXTURE_DIR/direction_stop.json" ;;
    nav)   echo "$FIXTURE_DIR/navigate_sample.json" ;;
    *) return 1 ;;
  esac
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "$1" == "file" ]]; then
  [[ $# -ge 2 ]] || { usage; exit 1; }
  FIXTURE="$2"
else
  FIXTURE="$(pick_fixture "$1")" || { usage; exit 1; }
fi

if [[ ! -f "$FIXTURE" ]]; then
  echo "找不到样例文件: $FIXTURE" >&2
  exit 1
fi

# 读入 JSON，再塞进 std_msgs/String.data（单行）
PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), ensure_ascii=False, separators=(",",":")))' "$FIXTURE")"

echo "发布到 /U2RTopic_Command:"
echo "$PAYLOAD"

ros2 topic pub --once /U2RTopic_Command std_msgs/msg/String \
  "$(python3 -c 'import json,sys; print(json.dumps({"data": sys.argv[1]}))' "$PAYLOAD")"

echo "完成。可另开终端看: ros2 topic echo /cmd_vel   或   ros2 topic echo /R2UTopic_Text"
