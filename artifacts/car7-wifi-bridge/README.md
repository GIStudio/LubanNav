# car7 WiFi Bridge（WebSocket 机器人链路）

把 LubanNav 机器人协议（与 BLE 桥 `car7_protocol.py` 完全相同的 JSON Lines）
搬到 WiFi：浏览器直连 `ws://10.7.181.161:8900/`，实时下发方向/导航指令并接收
RTK 定位遥测。**动机**：车机 Intel 组合卡 WiFi/BT 共存压制 BLE 广播，WiFi 必
须占用时优先走 WiFi 传输（见 `docs/car7-ble-troubleshooting.md` 与
`docs/robot-wifi-link.md`）。

## 运行形态

- 跑在容器 `campuscar-stm32-hoverboard` 内（host `/home/pc/campusCar` 挂载为
  容器 `/workspace/campusCar-new-chassis`），由 host systemd
  `car7-wifi-bridge.service` 经 `docker exec` 启动，`rclpy` 直接订阅
  `/fix` `/imu` `/odom`。
- 纯 Python 标准库：WebSocket 服务为最小 RFC 6455 实现（text 帧、ping/pong、
  close；无扩展），不依赖 `websockets` 等第三方包。
- 遥测：RTK 固定解/浮点解时 2 Hz 回传真实位置（含航向、速度、精度）；无固定
  解且 `--replay-fallback` 时按路线航点回放，网页闭环仍可演示。

## 文件

| 文件 | 说明 |
| --- | --- |
| `car7_wifi_bridge.py` | 主程序：WS 服务、协议处理、move_executor 客户端、gps_navigator 启动器、RTK 遥测 |
| `car7_protocol.py` | 协议层（与 BLE 桥同源，不修改） |
| `test_car7_wifi_bridge.py` | 单元测试（22 项，无 ROS/无网络） |
| `car7-wifi-bridge.service` | systemd 单元（已安装启用） |
| `deploy_car7_wifi.py` | 部署脚本：上传 → 安装单元 → 重启服务 → fe-ble-bridge worktree 提交 |

## 运行

```bash
cd /home/pc/campusCar/src/ble_bridge   # host 路径（= 容器 /workspace/campusCar-new-chassis/src/ble_bridge）
python3 test_car7_wifi_bridge.py

# 容器内手动运行（systemd 已接管，仅调试用）
docker exec campuscar-stm32-hoverboard bash -c \
  'source /opt/ros/humble/setup.bash && cd /workspace/campusCar-new-chassis/src/ble_bridge && \
   exec python3 car7_wifi_bridge.py --host 0.0.0.0 --port 8900 --direction --replay-fallback'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--host` / `--port` | `0.0.0.0` / `8900` | 监听地址（host 网络，局域网可直达） |
| `--direction` | 关 | 网页方向指令驱动真实底盘（move_executor 127.0.0.1:9099） |
| `--drive` | 关 | 收到完整导航任务自动启动 gps_navigator.py（自主运动；需人工确认开启） |
| `--speed` / `--radius` | `0.2` / `0.6` | gps_navigator 最大速度 m/s 与到达半径 m |
| `--replay-fallback` | 开 | RTK 无固定解时回放航点位置 |
| `--campuscar-export` | 无 | 每个任务原子写出 gps_navigator 可读航点 JSON |

## 启用 wss（可选，HTTPS 页面直连用）

桥原生支持 TLS（stdlib `ssl`，无新依赖）：`--tls-cert server.crt --tls-key server.key`
后监听 `wss://`。内网无域名时用 `tools/car7-wifi-tools/make_car7_cert.sh` 生成
本地 CA + IP 证书，并把 CA 根证书装到使用设备；系统级说明见
`docs/robot-wifi-link.md` 的“启用 wss”一节。

```bash
# 本地验证（cert 已含 SAN: IP:127.0.0.1 / 10.7.181.161, car7.local, localhost）
python3 car7_wifi_bridge.py --port 8443 --tls-cert tls/server.crt --tls-key tls/server.key
python3 ../../tools/car7-wifi-tools/wifi_central_test.py --url wss://127.0.0.1:8443 --ca tls/ca.crt
```

## 验收

Mac 侧（无需第三方库）：

```bash
python3 tools/car7-wifi-tools/wifi_central_test.py --url ws://10.7.181.161:8900
curl http://10.7.181.161:8900/    # 状态页（CORS 开放，仅信息用途）
```

网页侧：本地开发页 `http://localhost:5173/?mode=robot` → 机器人联络 →
WiFi 局域网 → 连接 → 下发路线。HTTPS 页面访问 `ws://` 局域网地址会被混合内容
拦截，正式 HTTPS 部署需 `wss://`。

## 协作约定

与 BLE 桥一致：主工作区 `/home/pc/campusCar` 属对方开发者，HEAD 不动；部署 +
提交走 `deploy_car7_wifi.py`（worktree `/home/pc/campusCar-fe`，分支
`fe-ble-bridge`，身份 `wsqstar`）。
