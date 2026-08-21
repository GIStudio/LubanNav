#!/usr/bin/env bash
# 为车机生成 wss:// 用的本地 CA 与服务器证书（无需公网、无需付费）。
#
# 原理：wss 强制 TLS，TLS 必须有证书；内网小车没有域名，所以自己当 CA，
# 给车机 IP 签发一张证书。使用设备（Mac / Android 平板）需要一次性信任
# 这个本地 CA 根证书，之后 wss://10.7.181.161:8443 就能像 https 一样直连。
#
# 产物（默认 ~/lubannav-car7-tls/）：
#   ca.crt        本地 CA 根证书 —— 装到所有使用设备（一次性）
#   server.crt    车机服务器证书（SAN: IP 10.7.181.161 / 127.0.0.1, car7.local）
#   server.key    车机私钥（只放车机）
#
# 用法：
#   bash tools/car7-wifi-tools/make_car7_cert.sh [--ip 10.7.181.161] [--dir ~/lubannav-car7-tls]
#   bash tools/car7-wifi-tools/make_car7_cert.sh --install-macos     # 本机信任 CA（可选）
#   bash tools/car7-wifi-tools/make_car7_cert.sh --deploy-car        # 上传证书到车机（需车机在线）
#
# 车机启用 wss（systemd 覆盖）：
#   sudo systemctl edit car7-wifi-bridge
#   [Service]
#   ExecStart=/usr/bin/docker exec campuscar-stm32-hoverboard bash -c \
#     'source /opt/ros/humble/setup.bash && cd /workspace/campusCar-new-chassis/src/ble_bridge && \
#      exec python3 car7_wifi_bridge.py --host 0.0.0.0 --port 8443 --direction --replay-fallback \
#      --tls-cert /workspace/campusCar-new-chassis/src/ble_bridge/tls/server.crt \
#      --tls-key /workspace/campusCar-new-chassis/src/ble_bridge/tls/server.key'
#   sudo systemctl restart car7-wifi-bridge
# 然后网页端地址填 wss://10.7.181.161:8443（HTTPS 页面也能直连）。
set -euo pipefail

CAR_IP="${CAR_IP:-10.7.181.161}"
OUT_DIR="${CAR_TLS_DIR:-$HOME/lubannav-car7-tls}"
HOST="pc@${CAR_IP}"
REMOTE_TLS_DIR="/home/pc/campusCar/src/ble_bridge/tls"

for arg in "$@"; do
  case "$arg" in
    --install-macos) INSTALL_MACOS=1 ;;
    --deploy-car) DEPLOY_CAR=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# 1. 本地 CA（只生成一次；重复运行保留现有 CA，避免重新信任）
if [ ! -f ca.key ]; then
  echo "[1/4] 生成本地 CA（根证书 ca.crt）"
  openssl genrsa -out ca.key 3072 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 3650 \
    -subj "/CN=LubanNav Car7 Local CA/O=LubanNav" -out ca.crt
else
  echo "[1/4] 复用现有本地 CA ca.crt"
fi

# 2. 服务器私钥 + CSR（SAN 含车机 IP / 本机回环 / 局域网主机名）
if [ ! -f server.key ]; then
  echo "[2/4] 生成车机服务器证书（IP: ${CAR_IP}）"
  openssl genrsa -out server.key 2048 2>/dev/null
  openssl req -new -key server.key -subj "/CN=car7" -out server.csr
  cat > san.ext <<EOF
subjectAltName = DNS:car7.local, DNS:localhost, IP:${CAR_IP}, IP:127.0.0.1
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
EOF
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days 825 -sha256 -extfile san.ext -out server.crt 2>/dev/null
  rm -f server.csr
else
  echo "[2/4] 复用现有车机证书 server.crt"
fi

echo "[3/4] 产物: $OUT_DIR/{ca.crt, server.crt, server.key}"

# 3. （可选）本机（Mac）信任 CA —— 之后本机浏览器/工具可直接用 wss
if [ "${INSTALL_MACOS:-}" = "1" ]; then
  echo "[3b] 安装 CA 到 macOS 登录钥匙串（Safari/其他工具可用）"
  security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" ca.crt
  echo "      ★ Chrome/Chromium 只信任系统钥匙串，需再执行一次（需要密码）："
  echo "        sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${OUT_DIR}/ca.crt"
  echo "      移除: sudo security delete-certificate -c 'LubanNav Car7 Local CA'"
fi

# 4. （可选）上传到车机（需车机在线）
if [ "${DEPLOY_CAR:-}" = "1" ]; then
  echo "[4/4] 上传证书到车机 $HOST:$REMOTE_TLS_DIR"
  ssh "$HOST" "mkdir -p '$REMOTE_TLS_DIR'"
  scp server.crt server.key "$HOST:$REMOTE_TLS_DIR/"
  echo "      已上传。按上方 systemctl edit 启用 wss 后重启服务。"
fi

echo
echo "下一步："
echo "  1) 把 ca.crt 装到所有使用设备（Mac: 本脚本 --install-macos；"
echo "     Android: adb push ca.crt /sdcard/ 后到 设置→安全→安装CA证书→CA证书）"
echo "  2) 车机 systemctl edit car7-wifi-bridge 加 --tls-cert/--tls-key 并重启"
echo "  3) 网页端地址填 wss://${CAR_IP}:8443"
