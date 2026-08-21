# 机器人 WiFi 链路（car7-wifi-bridge，WebSocket）

> **2026-08-21 部署**：car7 NUC（`10.7.181.161`）已启用 `car7-wifi-bridge.service`，
> 浏览器通过 `ws://10.7.181.161:8900/` 直连小车，走与 BLE 完全相同的
> LubanNav JSON Lines 机器人协议。**WiFi 与蓝牙共用 Intel 组合卡天线，存在
> 共存压制（见 [car7-ble-troubleshooting.md](car7-ble-troubleshooting.md)），
> 因此导航链路优先迁移到 WiFi。**

## 为什么用 WiFi 而不是蓝牙

| 对比项 | BLE（car7_ble_bridge.py） | WiFi（car7_wifi_bridge.py） |
| --- | --- | --- |
| 传输 | BlueZ GATT 外设，20–185 B/包分包 | WebSocket 帧，一次一行 JSONL |
| 距离/穿透 | 近距离（10 m 内） | 同一局域网即可（数十米） |
| WiFi 占用时的稳定性 | 广播被共存逻辑饿死（实测 0 条/60 s） | 不受影响（视频流 8080 同网照跑） |
| 带宽 | 89 KB 加密路线约 4 s（185 B MTU） | 瞬时完成（< 0.5 s） |
| 浏览器要求 | Chromium + Web Bluetooth（HTTPS 安全上下文） | 任意现代浏览器（WebSocket） |
| 定位回传 | 由桥回放或（真机扩展）RTK | 真机 /fix + /imu + /odom 订阅，2 Hz 实时回传 |

## 链路图

```
浏览器网页（LubanNav 机器人面板，WiFi 传输）
    │  WebSocket ws://10.7.181.161:8900/
    ▼
car7_wifi_bridge.py（容器内运行，复用 car7_protocol.py 协议层）
    │  方向指令 ──▶ move_executor（127.0.0.1:9099，odom 闭环）──▶ /cmd_vel ──▶ 底盘
    │  导航任务 ──▶（--drive 时）gps_navigator.py（RTK Stanley 闭环）
    │  遥测回传 ◀── /fix（RTK）+ /imu（航向）+ /odom（速度），2 Hz
    └─ RTK 无固定解且启用回放时：按路线航点回放位置（网页闭环仍可演示）
```

车机侧部署形态与 BLE 桥相同：`/home/pc/campusCar`（host）≡
`/workspace/campusCar-new-chassis`（容器），systemd 通过
`docker exec campuscar-stm32-hoverboard` 在容器内启动桥，因此 `rclpy` 直接
订阅 `/fix`、`/imu`、`/odom`，无需 rosbridge。

## 网页端能否直连本地 IP？（调查结论）

**可以，但有混合内容约束：**

1. **`ws://` 只能从非 HTTPS 页面打开**。HTTPS（如 GitHub Pages）页面访问
   `ws://10.7.181.161:8900` 会被浏览器按混合内容拦截。
2. 本地开发页 `http://localhost:5173`（localhost 是安全上下文，浏览器定位
   `navigator.geolocation` 也可用）→ `ws://10.7.181.161:8900` **直连成功**，
   无需任何代理。
3. 若把构建产物放到车机或其他 HTTP 服务器上（如 `http://10.7.181.161:8081/`），
   同样可以直连 `ws://`，但该页面**不是安全上下文，浏览器定位不可用**（只能
   用小车 RTK 作为唯一定位源）。
4. 正式 HTTPS 部署需要车机启用 TLS 的 `wss://`（后续工作），或经由中继转发。

桥在 8900 端口同时提供普通 HTTP 状态页（健康检查，含 CORS 头）：

```bash
curl http://10.7.181.161:8900/
# { "service": "car7-wifi-bridge", "rtk": {"fixStatus": "rtk_fixed", ...}, "flags": {...} }
```

## 协议（与 BLE 完全一致）

消息格式与 `docs/robot-ble-protocol.md` 相同：UTF-8、一行一个 JSON 对象、
LF 结尾。**WebSocket 客户端必须保证每行以 LF 结束**（网页端
`encodeRobotMessage` 已带 LF）；桥内 `JSONLineFramer` 仍按字节流重组，
跨帧拆行也安全。桥同时接受 **text（0x1）与 binary（0x2）帧**——网页端
`socket.send(Uint8Array)` 发的是二进制帧，两者都按 JSONL 字节处理。
指令优先级（`rc > ble > nav`，`safety` 跨层）与字段完全沿用。

- 下行：`navigation_task` / `navigation_start` + `waypoint`* + `navigation_end`（流式）、
  `direction`、`goto_target`（单点经纬度目标，见 robot-ble-protocol.md）、
  `emergency_stop`，均带 `priority`。
- 上行：`ack`、`status`、`position`。`position` 在 BLE 合约基础上增加可选字段：
  - `fixStatus`：`rtk_fixed` / `rtk_float` / `dgps` / `gps_fix` / `no_fix` / `replay`（回放）
  - `speedMetersPerSecond`：来自 `/odom`
  - `accuracyMeters`：优先取 `/fix` 协方差对角线均方根，否则按解类型给默认值
    （固定解 0.03 m、浮点解 0.30 m、DGPS 1.0 m、GPS 2.5 m）

## 车机部署

### 文件与单元测试

```bash
# Mac 侧开发目录
artifacts/car7-wifi-bridge/
├── car7_wifi_bridge.py      # 桥（纯标准库 WebSocket + rclpy 遥测）
├── car7_protocol.py         # 协议层（与 BLE 桥同源）
├── test_car7_wifi_bridge.py # 单元测试（无 ROS/无网络）
├── car7-wifi-bridge.service # systemd 单元
└── deploy_car7_wifi.py      # 部署 + fe-ble-bridge worktree 提交

cd artifacts/car7-wifi-bridge && python3 test_car7_wifi_bridge.py
```

### systemd 服务

```bash
python3 artifacts/car7-wifi-bridge/deploy_car7_wifi.py --commit "feat(wifi_bridge): ..."
```

单元内容（已安装启用；`ExecStartPre` 先清理容器内残留实例，避免 systemd 重启
时旧进程占用 8900 端口导致 bind 失败）：

```ini
ExecStart=/usr/bin/docker exec campuscar-stm32-hoverboard bash -c \
  'source /opt/ros/humble/setup.bash && cd /workspace/campusCar-new-chassis/src/ble_bridge && \
   exec python3 car7_wifi_bridge.py --host 0.0.0.0 --port 8900 --direction \
   --replay-fallback --campuscar-export /workspace/campusCar-new-chassis/data/lubannav-campuscar-route.json'
```

- `--direction`：网页方向盘（direction 指令）经 move_executor 驱动真实底盘。
- `--replay-fallback`：RTK 无固定解时按路线航点回放位置，网页闭环仍可演示。
- **`--drive` 默认不启用**：启用后收到完整导航任务会自动启动 `gps_navigator.py`
  自主行驶（RTK 闭环）。需要现场核验（RTK 固定解、航向、速度上限、失联看门狗、
  实体急停）并由人工确认后才可开启，与 BLE 桥的安全立场一致。

日志与运维：

```bash
journalctl -u car7-wifi-bridge -f          # 桥日志（容器内 stdout 透传）
curl http://10.7.181.161:8900/              # 状态页
python3 tools/car7-wifi-tools/wifi_central_test.py   # Mac 侧闭环验收脚本
```

### 安全标志一览

| 标志 | 默认 | 说明 |
| --- | --- | --- |
| `--direction` | 关 | 执行网页方向指令（真实底盘，move_executor 自带低速/超时/断连保护） |
| `--drive` | 关 | 收到导航任务自动运行 gps_navigator（自主运动，需人工确认开启） |
| `--replay-fallback` | 开 | RTK 无解时回放航点位置（仅遥测，不驱动电机） |

## 网页端使用

1. 打开本地开发页 `http://localhost:5173/?mode=robot`（或 HTTP 部署页）。
2. “语音与设备 → 机器人联络”，传输方式选择 **WiFi 局域网**（默认）。
3. 车机地址保持 `ws://10.7.181.161:8900`（可在断开状态下修改，保存在
   `localStorage`），点击“连接车机”。
4. 连接成功后：方向盘、下发当前路线、STOP 与 BLE 完全一致；位置回传走 RTK。
5. 地图上橙色圆点 = 小车 RTK 位置（含航向），蓝色半透明圆点 = 浏览器定位兜底；
   地图左上角角标显示当前定位源（小车 RTK / 浏览器定位）。
6. 面板实时显示：定位源与 fixStatus、速度、进度条（RTK 位置沿路线计算的
   剩余距离与百分比）、距下一航点距离。

定位融合逻辑（`src/lib/positionStore.js`）：小车 RTK 位置 5 秒内新鲜 → 用
RTK；否则回落到 30 秒内新鲜的浏览器定位；都没有则显示无定位。

## 已知限制与后续

- **RTK 固定解**：室内无固定解时网页显示“路线回放（RTK 暂无固定解）”；
  推到室外后自动切换为真实 RTK 位置。
- **多客户端**：桥支持多连接并发（当前实现会向所有连接广播遥测）。

## 启用 wss（HTTPS 页面也能直连）

wss = WebSocket over TLS，**必须有证书**；但内网小车不需要公网/付费证书——
自己当 CA 给车机 IP 签发一张即可。三种路径按省事程度排序：

1. **零证书（现场演示首选）**：页面也用 HTTP（`http://localhost` 开发页或把
   构建产物放到车机/局域网 HTTP 服务器），直接 `ws://`，无需任何证书。
2. **本地 CA + wss（HTTPS 页面直连）**：`tools/car7-wifi-tools/make_car7_cert.sh`
   一次生成本地 CA 与车机证书（SAN 含 IP），把 `ca.crt` 装到每个使用设备
   （Mac 钥匙串 / Android 设置→安全→安装 CA 证书），车机桥以
   `--tls-cert/--tls-key` 启动，网页地址填 `wss://10.7.181.161:8443`。
   已实测：Python 客户端 `--ca ca.crt` 全链校验 + 浏览器 wss E2E 均通过。
3. **真证书**：有域名时用 acme.sh/certbot DNS-01 签 Let's Encrypt（内网无需
   入站 80/443），同样喂给 `--tls-cert/--tls-key`。

车机启用 wss（systemd 覆盖，端口 8443）：

```bash
sudo systemctl edit car7-wifi-bridge
# [Service]
# ExecStart=/usr/bin/docker exec campuscar-stm32-hoverboard bash -c \
#   'source /opt/ros/humble/setup.bash && cd /workspace/campusCar-new-chassis/src/ble_bridge && \
#    exec python3 car7_wifi_bridge.py --host 0.0.0.0 --port 8443 --direction --replay-fallback \
#    --tls-cert /workspace/campusCar-new-chassis/src/ble_bridge/tls/server.crt \
#    --tls-key /workspace/campusCar-new-chassis/src/ble_bridge/tls/server.key'
sudo systemctl restart car7-wifi-bridge
curl -k https://10.7.181.161:8443/        # TLS 状态页（-k 仅自测）
python3 tools/car7-wifi-tools/wifi_central_test.py --url wss://10.7.181.161:8443 --ca ca.crt
```

> 自签证书浏览器没有“继续前往”按钮（WebSocket 不同于普通 HTTPS 页面），所以
> 必须让浏览器信任签发 CA；`make_car7_cert.sh` 的 `--install-macos` /
> Android 安装流程就是做这件事。

## 车机突然不可达（WiFi 掉线）排查

车机 Intel 组合卡 WiFi 本身不稳定（正是我们弃用 BLE 的原因），运行中可能
掉线。网页表现为“连接超时”、SSH/curl 均不通：

1. 确认车机是否还在同一局域网：`ping 10.7.181.161`、`nc -z 10.7.181.161 22`。
2. 现场检查车机 WiFi：`nmcli device status` / `ip a show wlo1`；掉线则重连
   （`nmcli dev wifi connect <SSID>` 或重启 NetworkManager）。
3. 桥随 systemd 自启且掉线自动重启：`systemctl status car7-wifi-bridge`；
   手动重启 `sudo systemctl restart car7-wifi-bridge`。
4. 重启后自检：`curl http://10.7.181.161:8900/`（状态页）→
   `python3 tools/car7-wifi-tools/wifi_central_test.py`（闭环验收）。
