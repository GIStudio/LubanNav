#!/usr/bin/env bash
# Start the LubanNav BLE bridge in the background.
#   ble_bridge_start.sh              telemetry-only (no motor output)
#   ble_bridge_start.sh --move-test  real chassis acceptance: fwd 10cm -> stop -> back 10cm
set -e
cd /home/pc/campusCar
mkdir -p data/logs
pkill -f "[c]ar7_ble_bridge.py" 2>/dev/null || true
sleep 1
EXTRA=""
case "${1:-}" in
  "") ;;
  --move-test|--direction) EXTRA="$1" ;;
  *) echo "unknown mode: $1"; exit 1 ;;
esac
nohup setsid python3 src/ble_bridge/car7_ble_bridge.py $EXTRA   --campuscar-export /home/pc/campusCar/data/lubannav-campuscar-route.json   > data/logs/ble_bridge.log 2>&1 &
echo $! > data/logs/ble_bridge.pid
sleep 2
echo "started pid $(cat data/logs/ble_bridge.pid) mode=${EXTRA:-telemetry-only}"
cat data/logs/ble_bridge.log
