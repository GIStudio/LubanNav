#!/usr/bin/env bash
# 车机恢复后的 WiFi 链路完整验收（Mac 侧执行）：
#   1. 部署最终版桥到车机 + 重启 systemd 服务（deploy_car7_wifi.py）
#   2. 桥单元测试（本地）
#   3. 状态页健康检查
#   4. Mac 侧 WS 闭环验收（wifi_central_test.py，不含移动）
#   5. 浏览器端到端（本地桥 + 生产构建）
#
# 用法: bash tools/car7-wifi-tools/verify_real_car.sh [--commit "msg"]
set -euo pipefail
cd "$(dirname "$0")/../.."

COMMIT_MSG="${1:-feat(wifi_bridge): final WiFi transport (binary frames, nav_status, RTK telemetry)}"

echo "[1/5] 桥单元测试（本地）"
(cd artifacts/car7-wifi-bridge && python3 test_car7_wifi_bridge.py | tail -1)

echo "[2/5] 部署到车机并重启服务"
python3 artifacts/car7-wifi-bridge/deploy_car7_wifi.py --commit "$COMMIT_MSG"
sleep 2

echo "[3/5] 状态页健康检查"
curl -s -m 5 --noproxy '*' http://10.7.181.161:8900/ | python3 -c "import json,sys; d=json.load(sys.stdin); print('service:', d['service'], '| rtk:', d['rtk']['fixStatus'], '| clients:', d['clients'])"

echo "[4/5] Mac 侧 WS 闭环验收（真机）"
python3 tools/car7-wifi-tools/wifi_central_test.py --url ws://10.7.181.161:8900 --waypoints 8 | tail -3

echo "[5/5] 浏览器端到端（本地桥 + 生产构建）"
if ! curl -s -m 2 --noproxy '*' http://localhost:4173/ >/dev/null; then
  (npx vite preview --port 4173 >/tmp/lubannav-preview.log 2>&1 &)
  sleep 2
fi
(cd artifacts/car7-wifi-bridge && (python3 car7_wifi_bridge.py --host 127.0.0.1 --port 8901 --direction --replay-fallback > /tmp/wifi-local.log 2>&1 &) && sleep 1.5)
PAGE_URL='http://localhost:4173/?mode=robot' WIFI_URL=ws://127.0.0.1:8901 \
  NODE_PATH=/opt/homebrew/lib/node_modules node tools/e2e_wifi_loop.cjs | tail -3
pkill -f "car7_wifi_bridge.py --host 127.0.0.1" 2>/dev/null || true

echo "✅ 全部验收完成"
