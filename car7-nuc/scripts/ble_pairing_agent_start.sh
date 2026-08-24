#!/usr/bin/env bash
# Start the BlueZ pairing agent (Just Works auto-accept; fixed PIN 123456
# for legacy PIN/passkey flows) and enable pairable mode on the adapter.
# Web Bluetooth GATT never needs pairing; this only unblocks OS-level pairing.
set -e
cd /home/pc/campusCar
mkdir -p data/logs
pkill -f "[b]le_pairing_agent.py" 2>/dev/null || true
sleep 1
nohup setsid python3 src/ble_bridge/ble_pairing_agent.py --pin 123456   > data/logs/ble_pairing_agent.log 2>&1 &
echo $! > data/logs/ble_pairing_agent.pid
sleep 2
cat data/logs/ble_pairing_agent.log
