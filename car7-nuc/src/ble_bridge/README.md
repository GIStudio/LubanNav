# car7 WiFi Bridge（WebSocket 机器人链路）

> **开发协作**：car7 由两人共用。主工作区 `/home/pc/campusCar` 的 HEAD 属于
> 对方（`hoverboard` / `hardware/new-stm32-hikrobot`），**不要在主工作区执行
> checkout/commit**。我们的所有 git 操作都在独立 worktree
> `/home/pc/campusCar-fe`（分支 `fe-ble-bridge`，git 身份 `wsqstar`）中进行：
>
> ```bash
> git -C /home/pc/campusCar-fe status        # 查看我们的分支状态
> git -C /home/pc/campusCar-fe log --oneline -5
> ```
>
> 部署 + 提交用仓库根目录脚本（Mac 侧）：
> `python3 artifacts/car7-ble-bridge/deploy_car7.py --commit "feat(ble_bridge): ..."`
> 它会：上传文件到运行目录 → 同步到 worktree → 在 `fe-ble-bridge` 提交，全程不碰
> 对方 HEAD。运行进程读的是主工作区文件，部署后需按 `scripts/` 重启对应服务。

把 LubanNav 仓库 `tools/car7-ble-simulator`（macOS CoreBluetooth 模拟器）移植到真机
car7 NUC（Ubuntu 22.04 / BlueZ 5.64）的版本：用 BlueZ D-Bus GATT Server 在真机上
广播同名 NUS 服务，让 LubanNav 网页（或任意 Web Bluetooth central）直接连到真机。

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
| `car7_protocol.py` | Car7Protocol 协议层移植（模型、解析、帧器、编码、campusCar 导出、航向角） |
| `car7_ble_bridge.py` | BlueZ D-Bus GATT 外设主程序（CLI 与行为同 macOS 模拟器；`--direction` 执行网页方向步进，`--move-test` 驱动实车验收） |
| `move_executor.py` | 容器内 ROS2 移动执行器：odom 闭环短距离移动，TCP 127.0.0.1:9099 |
| `test_car7_protocol.py` | 协议层单元测试（对照 `Car7ProtocolTests.swift`） |
| `move_test_central.py` | Mac 侧 BLE 验收脚本（bleak）：下发任务并验证"前进 10cm → 停 → 后退 10cm" |
| `systemd/` | 已启用服务的源文件：`car7-ble-bridge.service`（direction 模式）与 `move-executor.service`（容器执行器自启） |
| `systemd/` | 已安装启用的服务源文件：`car7-ble-bridge.service`（direction 模式）与 `move-executor.service`（容器内执行器自启） |

依赖仅系统包：`python3-dbus`、`python3-gi`（Ubuntu 22.04 默认已装）。
安装：`sudo apt install python3-dbus python3-gi`（如缺失）。

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
| `--name NAME` | `car7` | 广播的 BLE 设备名 |
| `--step-ms MS` | `750` | 相邻航点回放间隔（100–60000） |
| `--loop` | 关 | 收到 STOP/断连前循环回放路线 |
| `--campuscar-export PATH` | 无 | 每次收到路线时原子写出 campusCar `gps_navigator.py` 可读取的航点 JSON |
| `--direction` | 关 | 手动方向指令经 move_executor(127.0.0.1:9099) 驱动真实底盘；不加则 direction 被拒绝（telemetry-only） |

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

## 开机自启与进程守护（systemd，当前已启用）

car7 已通过 systemd 托管 BLE 桥：**开机自启**（`multi-user.target` 依赖）+
**进程守护**（`Restart=on-failure`，异常退出 3 秒后自动拉起）。日志走
`journalctl`，不再使用 `data/logs/ble_bridge.log`。

```bash
systemctl status car7-ble-bridge            # enabled + active
journalctl -u car7-ble-bridge -f            # 跟随日志
sudo systemctl restart car7-ble-bridge      # 重新部署后重启
sudo systemctl stop car7-ble-bridge         # 手动停（守护不会自动拉起）
```

单元模板见 `src/ble_bridge/systemd/`；重新安装：

```bash
sudo cp src/ble_bridge/systemd/car7-ble-bridge.service /etc/systemd/system/
sudo cp src/ble_bridge/systemd/move-executor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now car7-ble-bridge.service move-executor.service
```

- `car7-ble-bridge.service`：以 `--direction` 启动，网页方向键/路线经执行器驱动底盘。
- `move-executor.service`：容器内 odom 闭环执行器（127.0.0.1:9099），依赖
  `campuscar-stm32-hoverboard` 容器；容器以
  `docker run -d --restart unless-stopped ... campuscar:humble bash -c 'cd /workspace/campusCar-new-chassis && ./scripts/launch_all.sh --profile stm32_hoverboard_4wd'`
  持久化运行（重启自恢复）。
- 底盘未上电时桥仍可连接与回放遥测；direction 需执行器与底盘就绪才能验证移动。

停止：`pkill -f car7_ble_bridge.py`（BlueZ 会在 D-Bus 连接断开时自动注销服务与广告）。

## 实车移动测试（--move-test）

默认是遥测回放（与 macOS 模拟器一致）。`--move-test` 开启后，收到任意
`navigation_task` 就执行固定的实车验收序列：

```
forward 10cm -> 立即停止 -> backward 10cm -> 停止
```

移动由容器内的 `move_executor.py`（ROS2 节点，odom 闭环，执行器默认 0.06 m/s 仅用于
`--move-test` 验收序列、超时 15 s、TCP 断连即停）执行；BLE 桥通过 `127.0.0.1:9099`
与它通信（容器 `--net=host`）。网页摇杆速度由 ROS 侧数据推导：默认 2.0 m/s
（= ROS 线速度上限 4.0 m/s 的一半），每步位移仍按 `amountMeters`（默认 0.15 m）截断，
所以高速只会缩短单步耗时，不会让单步跑远。BLE 收到 `emergency_stop` 会立即向执行器发 STOP。

启动顺序（见 `scripts/`）：

```bash
/home/pc/campusCar/scripts/move_executor_start.sh     # 容器内执行器
/home/pc/campusCar/scripts/ble_bridge_start.sh --move-test   # 宿主 BLE 桥
```

Mac 验收：

```bash
pip install bleak
python3 move_test_central.py   # 扫描 car7 -> 订阅 -> 下发任务 -> 等 arrived
```

移动前必须确认车辆周围无障碍、车轮状态正常；本序列由 BLE 任务触发，
操作者应始终站在可触及实体急停的位置。

## 流式路线下发（JSONL 一行一条命令）

加密后的路线有数百个航点，如果整份打包成一条 `navigation_task` JSON，接收端必须等
整份文件收完才能解析。因此网页默认改用 **JSONL 流式下发**：每一行都是一个完整命令，
接收端逐行解析、无需缓冲整份文档，收到第一个航点即可开始导航：

```text
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_start","taskId":"task-x","route":{"from":"...","to":"...","mode":"robot","waypointSpacingMeters":2.5,"waypointCount":415},...}
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"waypoint","taskId":"task-x","sequence":0,"nodeId":null,"longitude":113.4776,"latitude":22.8884,"kind":"interpolated","indoor":false,"level":null,"interpolated":true,...}
...（每条 waypoint 一行，与 navigationWaypoints 顺序一致）...
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_end","taskId":"task-x","waypointCount":415}
```

行为契约：

- `navigation_start` 只带任务头与 `waypointCount`，桥收到后**立即回 `ack/accepted`**（message 注明期望航点数）。
- 每条 `waypoint` 独立校验（taskId 匹配、sequence 严格递增、WGS84 边界），坏行只 `DROP` 该行，不影响后续。
- 遥测模式收到第一个航点即回 `status/navigating` 并开始回放；`navigation_end` 校验航点数（不匹配回 `status/fault`），campusCar 导出与 `--move-test` 只在路线完整后触发。
- `emergency_stop` / `direction` 随时可穿插在任意行之间，优先级不变。
- 旧式单文档 `navigation_task` 仍受支持（等价于立即收到完整路线），旧测试与脚本不受影响。

## GATT 表

| Characteristic | UUID | 属性 |
| --- | --- | --- |
| Command / RX | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | Write + Write Without Response |
| Telemetry / TX | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | Notify |

订阅 TX 后发送 `status=ready`（message 为 `car7 NUC BLE bridge`，与 macOS 模拟器区分）。
Notify 分包按 `max(20, 协商 MTU-3)` 切片，与模拟器 `max(20, MTU)` 语义对应。

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
