# LubanNav Web Bluetooth 机器人协议 v1

此协议用于 LubanNav 网页与 BLE 机器人小车之间的任务下发和遥测回传。浏览器是 BLE Central / GATT Client，小车是 BLE Peripheral / GATT Server。

## GATT 合约

默认采用 Nordic UART Service 兼容 UUID，网页“GATT 与分包设置”中可以修改：

默认设备名前缀为 `car7`，浏览器设备选择器只显示名称以该字符串开头的设备。清空该设置可显示所有附近 BLE 设备。

| 用途 | 默认 UUID | 属性 |
| --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service |
| Command / RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write 或 Write Without Response |
| Telemetry / TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

小车应在 BLE advertisement 中包含 Service UUID，或至少允许连接后发现该服务。若固件已有自定义 GATT 表，直接在网页设置中填写三个完整 UUID。

网页连接诊断依次标记 `device-selection`、`gatt-connect`、`primary-service`、`command-characteristic`、`telemetry-characteristic` 和 `notifications`。扫描到名称只证明设备可被发现；只有后三类 UUID 与固件 GATT 表一致并成功开启 Notify，通信通道才算就绪。

## 帧与分包

- 字符编码：UTF-8。
- 消息格式：一行一个 JSON 对象，以 LF（`0x0A`）结束。
- 默认每次 GATT 写入 185 字节（现代 Android+BlueZ 协商 MTU ≥185B），包间隔 5 ms；优先 Write Without Response。旧 20B MTU 固件请在面板调回 `chunkBytes=20`。
- 小车必须先按字节拼接收到的包，遇到 LF 后再对完整行做 UTF-8 解码和 JSON 解析。不要逐包解码 UTF-8，因为多字节字符可能跨包。
- GATT 操作必须顺序执行，不应并发读写同一连接。
- 若路线传输中触发紧急停止，网页会先发送一个 LF 丢弃未完成行，再发送完整 `emergency_stop`。固件应忽略该无效残行并继续解析下一行。

## 网页到小车

### 导航任务

只有 `robot` 模式路线可以下发。网页不会在路线变化时自动发送，必须由操作者点击“下发当前路线”。

`route.waypoints` 来自路线的 **加密导航点列**（`navigationWaypoints`）：对寻路图节点之间的线段做线性插值，使相邻点间距不超过 2.5 米（`route.waypointSpacingMeters`），满足小车每 2–3 米一个点的控制需求。`interpolated=true` 的点是插值点，`nodeId` 为 `null`；小车可以直接按点序跟踪，无需自行补点。

```json
{
  "protocol": "luban-nav-ble",
  "protocolVersion": 1,
  "type": "navigation_task",
  "taskId": "task-example",
  "createdAt": "2026-08-13T08:00:00.000Z",
  "dataset": "hkustgz-layered-routing-v3",
  "route": {
    "from": "main-entrance",
    "to": "library",
    "mode": "robot",
    "coordinateSystem": "WGS84 longitude/latitude",
    "distanceMeters": 942,
    "durationSeconds": 1178,
    "waypointSpacingMeters": 2.5,
    "waypoints": [
      {
        "sequence": 0,
        "nodeId": "main-entrance",
        "longitude": 113.4776815,
        "latitude": 22.8883663,
        "kind": "entrance",
        "indoor": false,
        "level": null,
        "interpolated": false
      },
      {
        "sequence": 1,
        "nodeId": null,
        "longitude": 113.4777049,
        "latitude": 22.8884435,
        "kind": "interpolated",
        "indoor": false,
        "level": null,
        "interpolated": true
      }
    ]
  }
}
```

小车收到完整消息并验证字段后，应返回 `ack`。网页传输完成只代表字节已写入 GATT，并不代表小车接受或执行了任务。

### 流式路线下发（JSONL 一行一条命令，默认方式）

加密后的路线有数百个航点，整份 `navigation_task` 文档可能要几十 KB，小车必须等整份文件收完才能解析。因此网页**默认改用流式下发**：每一行都是一个完整的独立命令，接收端逐行解析、收到第一个航点即可开始导航，无需缓冲整份文档：

```text
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_start","taskId":"task-stream","createdAt":"2026-08-13T08:00:00.000Z","dataset":"hkustgz-layered-routing-v3","route":{"from":"main-entrance","to":"library","mode":"robot","coordinateSystem":"WGS84 longitude/latitude","distanceMeters":942,"durationSeconds":1178,"waypointSpacingMeters":2.5,"waypointCount":415}}
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"waypoint","taskId":"task-stream","sequence":0,"nodeId":"main-entrance","longitude":113.4776815,"latitude":22.8883663,"kind":"entrance","indoor":false,"level":null,"interpolated":false}
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"waypoint","taskId":"task-stream","sequence":1,"nodeId":null,"longitude":113.4777049,"latitude":22.8884435,"kind":"interpolated","indoor":false,"level":null,"interpolated":true}
...（每条 waypoint 一行，与加密点列顺序一致）...
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_end","taskId":"task-stream","waypointCount":415}
```

行为契约：

1. `navigation_start` 只带任务头与 `waypointCount`。接收端应**立即回 `ack/accepted`**（可在 message 注明期望航点数）。
2. 每条 `waypoint` 独立校验：`taskId` 匹配、`sequence` 从 0 严格递增、WGS84 边界。坏行只丢弃该行，不影响后续行；`interpolated=true` 的插值点 `nodeId` 为 `null`。
3. 收到第一个航点即可回 `status/navigating` 并开始跟踪；后续航点到达后补充进缓冲。回放速度超过到达速度时原地等待下一个航点。
4. `navigation_end` 校验 `waypointCount` 与已收航点数一致；不一致回 `status/fault`（message 说明 received/expected）。campusCar 航点导出与实车移动序列只在路线完整后触发。
5. `emergency_stop` / `direction` 是独立行，可随时穿插在任意两行之间；网页在急停前先写一个 LF 丢弃传输中的半行。
6. 旧式单文档 `navigation_task` 仍受支持（等价于立即收到完整路线），旧脚本与固件可平滑升级。

### 紧急停止

```json
{
  "protocol": "luban-nav-ble",
  "protocolVersion": 1,
  "type": "emergency_stop",
  "commandId": "stop-example",
  "taskId": "task-example",
  "createdAt": "2026-08-13T08:01:00.000Z",
  "reason": "operator_request"
}
```

固件收到后应立即停止运动、清除当前任务，并返回确认。浏览器按钮只能作为辅助入口，不能替代小车上的物理急停、制动和失联看门狗。

## 指令优先级（rc > ble > nav，safety 跨层）

所有下行指令携带 `priority` 字段；固件按下表仲裁：

| 优先级 | 值 | 来源 | 固件行为 |
| --- | --- | --- | --- |
| 最高 | `rc` | 物理遥控器（不在 BLE 通道内） | 硬件信号检测到遥控器接管后，忽略所有 BLE 运动指令并暂停导航，直到释放接管 |
| 中 | `ble` | `direction` 手动指令 | 收到即抢占：暂停/取消当前导航任务并切换手动步进模式；恢复自主导航只能靠新的 `navigation_task` |
| 低 | `nav` | `navigation_task` / 流式路线 | 新任务取消旧任务；可被 `direction`、`emergency_stop` 或遥控器随时打断 |
| 跨层 | `safety` | `emergency_stop` | 任何时刻优先于一切：立即停止、清除任务，直到显式恢复 |

实现约定：

- 手动指令抢占导航时，网页只**中断剩余路线包的传输**（不发送 `emergency_stop`）；固件看到 `priority: ble` 的 `direction` 时应自行放弃不完整的流（缺少 `navigation_end` 即视为任务中止）。
- 网页下发新导航任务前会清空排队的手动方向指令。
- 遥控器接管由固件硬件层处理（如遥控器信号直接切断驱动、或 GPIO 中断标记），BLE 通道不表达也不参与该仲裁。

## 故障排查：已连接但指令不执行

连接成功 ≠ 能写指令。浏览器控制台会输出 `[ble]` 前缀的诊断日志，按顺序检查：

1. **命令特征可写性**：连接后控制台输出 `command characteristic` 的 `properties`。若 `write`/`writeWithoutResponse` 均为 false，说明填写的 Command UUID 是只读特征（或写错了 UUID），固件无法接收指令。
2. **写入方法**：`write -> writeValueWithoutResponse / writeValueWithResponse / legacy writeValue` 标明实际使用的写入路径；老固件若只支持带响应写入，会退回 `writeValueWithResponse`。
3. **MTU 与分包**：`enqueue` 会打印每块大小（默认 185 字节）。若写入报 `Value too long` 类错误，说明连接协商的 MTU 不足，把面板里的"分包字节"调到 ≤20 并降低 `interChunkDelayMs`。
4. **操作队列**：`drain start / sent / operation failed` 显示每条指令的传输过程；`enqueue rejected` 说明发送时未处于 connected 状态。

面板日志也会显示"命令特征：可写/不可写"一行，以及每条指令的发送/失败结果。

## 小车到网页

Telemetry / TX Characteristic 启用 Notify，以同样的 JSON Lines 格式发送。

### 位置

```json
{
  "protocol": "luban-nav-ble",
  "protocolVersion": 1,
  "type": "position",
  "taskId": "task-example",
  "longitude": 113.4776815,
  "latitude": 22.8883663,
  "headingDegrees": 35,
  "accuracyMeters": 1.5,
  "timestamp": "2026-08-13T08:00:02.000Z"
}
```

`longitude`、`latitude` 必须是 WGS84 十进制度。网页会验证合法范围并把最新位置显示在地图上。

### 确认与状态

```json
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"ack","taskId":"task-example","status":"accepted"}
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"status","taskId":"task-example","status":"navigating"}
```

建议状态至少支持：`accepted`、`rejected`、`navigating`、`arrived`、`stopped`、`fault`。发生拒绝或故障时，可增加 `reason` 和 `message` 字段。

## 安全边界

Web Bluetooth 仅承担近距离通信。实际机器人仍必须在小车端实现定位质量检查、路径跟踪、动态避障、速度与制动限制、门禁/坡度约束、失联停止、指令去重、任务超时和实体急停。在完成现场验证前，不应将本项目路线直接用于无人值守控制。

机器可读版本由构建生成在 `api/v1/robot-ble-protocol.json`。
