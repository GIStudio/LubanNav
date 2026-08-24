#!/usr/bin/env bash
# Stop the LubanNav BLE bridge.
pkill -f "[c]ar7_ble_bridge.py" 2>/dev/null && echo "stopped" || echo "was not running"
