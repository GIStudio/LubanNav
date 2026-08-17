# car7 macOS BLE 模拟器（tools/car7-ble-simulator）

Swift 可执行程序，把带蓝牙的 Mac 变成 `car7` BLE GATT Peripheral，用于在没有真机时验收 LubanNav 网页的 BLE 闭环：GATT 连接、分包任务、位置回传、STOP、断连停止。

> **测试边界**：模拟器实现真实的 BLE 广播、GATT Service、写入、Notify 与分包重组，但只把收到的路线**回放成位置遥测**。它不发布 ROS2 `/cmd_vel`，也不驱动电机；可以验证通信闭环，不能证明真实小车的定位、控制或制动安全。

## 1. 运行

```bash
npm run ble:simulator              # 从仓库根目录运行（swift run）
npm run ble:simulator:test         # Swift 协议单元测试（swift test）
```

npm scripts 已设置独立模块缓存（`/tmp/lubannav-swift-module-cache`）并使用 `--disable-sandbox`。首次运行需在「系统设置 → 隐私与安全性 → 蓝牙」为 Terminal 授权。

命令行选项（`--` 之后传入）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--name NAME` | `car7` | 广播的 BLE 设备名 |
| `--step-ms MS` | `750` | 相邻航点回放的间隔（100–60000） |
| `--loop` | 关 | 收到 STOP/断连前循环回放路线 |
| `--campuscar-export PATH` | 无 | 每次收到路线时原子写出 campusCar `gps_navigator.py` 可读取的航点 JSON |
| `-h` / `--help` | — | 帮助 |

成功启动的终端输出：

```text
[BOOT] telemetry-only mode; no motor or ROS2 output
[BLE] adapter powered on
[READY] advertising car7 with NUS service 6e400001-b5a3-f393-e0a9-e50e24dcca9e
```

常见失败：`unauthorized`（去系统设置授权）、`powered off`（打开蓝牙）、`advertising failed`（退出占用相同服务的进程）。

## 2. Swift 包结构

`Package.swift`（swift-tools 6.0，平台 macOS 13，语言模式 v5）：

| Target | 类型 | 说明 |
| --- | --- | --- |
| `Car7Protocol` | library | 协议模型、解析器、帧器、编码器（平台无关，可被固件适配层复用） |
| `Car7Simulator` | executable | CoreBluetooth peripheral 模拟器；链接期嵌入 `Info.plist`（蓝牙权限描述） |
| `Car7ProtocolTests` | test | 解析与帧的单元测试 |

## 3. Car7Protocol API

| 符号 | 说明 |
| --- | --- |
| `Car7ProtocolConstants` | `protocolName="luban-nav-ble"`、`protocolVersion=1`、NUS 三 UUID（Service / Command / Telemetry） |
| `Car7Command` | `navigationTask(NavigationTask)` / `emergencyStop(EmergencyStop)`，附 `taskId` |
| `NavigationTask` / `NavigationRoute` / `NavigationWaypoint` | 任务模型：`taskId`、`route.{from,to,mode,distanceMeters,durationSeconds,waypoints[]}`；航点 `{sequence,nodeId,longitude,latitude}` |
| `EmergencyStop` | `commandId`、`taskId?`、`reason?` |
| `Car7CommandParser.parse(Data)` | 校验协议名/版本 → 按 `type` 解码；`navigation_task` 要求 `mode=robot`、航点非空、每个航点经纬度有限且在 WGS84 范围内 |
| `Car7CommandError` | `invalidProtocol` / `invalidVersion` / `unsupportedType` / `emptyRoute` / `invalidMode` / `invalidWaypoint(sequence:)` |
| `JSONLineFramer` | 字节流拼包、按 LF（`0x0A`）切帧；缓冲上限默认 1 MB，超限清空并抛 `bufferLimitExceeded`；`reset()` 丢弃半行 |
| `Acknowledgement` / `StatusMessage` / `PositionMessage` | 遥测消息模型（`Encodable`） |
| `Car7JSONEncoder.line(_:)` | JSON（sortedKeys）+ LF，用于 Notify |
| `CampusCarWaypointFile` | `{origin, waypoints[{lat,lon,alt:0}]}`，campusCar 导出格式 |
| `bearingDegrees(from:to:)` | 相邻航点的大圆航向角（0–360°），用于回放 `headingDegrees` |

## 4. 模拟器运行行为

GATT 表（与网页默认配置一致）：

| Characteristic | UUID | 属性 |
| --- | --- | --- |
| Command / RX | `6E400002-…` | Write + Write Without Response |
| Telemetry / TX | `6E400003-…` | Notify |

行为时序：

1. **广播**：设备名 + Service UUID 广告。
2. **订阅**：手机订阅 TX 后打印 `[LINK] ... mtu=N`，并发送 `status=ready`。
3. **接收任务**：RX 写入经 `JSONLineFramer` 拼包切帧 → `Car7CommandParser` 解析：
   - `navigation_task`：打印 `[TASK] accepted ...`，（可选）导出 campusCar 航点文件，回 `ack=accepted` + `status=navigating`，随后按 `--step-ms` 逐航点发送 `position`（含航向角、`accuracyMeters=1.5`、ISO8601 时间戳），结束时 `status=arrived`。
   - `emergency_stop`：停止回放，回 `ack=stopped` + `status=stopped`。
   - 无法解析的行打印 `[DROP]`——STOP 前的引导 LF 产生的残行即按此丢弃（与网页 `sendEmergencyStop` 的 `prefixDelimiter` 行为对应）。
4. **断连**：所有订阅者退订后清空待发队列并停止回放（`[LINK] phone unsubscribed`）。
5. **Notify 分包**：按 `max(20, 最小订阅者 MTU)` 切片排队，`updateValue` 背压时暂停、`peripheralManagerIsReady` 后继续冲刷。

日志标签：`BOOT` / `BLE` / `READY` / `LINK` / `TASK`（含 `stopped: emergency_stop ...` 停止原因）/ `POS` / `DROP` / `EXPORT` / `ERROR`。

## 5. 与网页 / campusCar 的接口

- 网页侧协议与验收流程：[robot-ble-protocol.md](robot-ble-protocol.md)、[car7-local-ble-test.md](car7-local-ble-test.md)。
- `--campuscar-export` 输出供公开仓库 `phuang305/campusCar` 的 `src/rtk_tools/gps_navigator.py` 读取（`{origin, waypoints}`，`alt=0`）。真实 NUC 上必须先做车轮离地检查，人工确认 RTK `/fix`、航向、速度上限、失联看门狗与实体急停后，才由人工显式运行导航命令；BLE 进程不得自动触发。
