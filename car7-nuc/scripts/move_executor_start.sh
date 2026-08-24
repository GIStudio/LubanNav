#!/usr/bin/env bash
# Start the in-container move executor (odom-closed-loop, 127.0.0.1:9099).
set -e
docker exec -d campuscar-stm32-hoverboard bash -c   "source /opt/ros/humble/setup.bash && cd /workspace/campusCar-new-chassis/src/ble_bridge && python3 move_executor.py > /workspace/campusCar-new-chassis/data/logs/move_executor.log 2>&1"
sleep 3
tail -2 /home/pc/campusCar/data/logs/move_executor.log
