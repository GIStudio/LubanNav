# LubanNav Web Bluetooth 机器人协议 v1

此协议用于 LubanNav 网页与 BLE 机器人小车之间的任务下发和遥测回传。浏览器是 BLE Central / GATT Client，小车是 BLE Peripheral / GATT Server。

## GATT 合约

默认采用 Nordic UART Service 兼容 UUID，网页“GATT 与分包设置”中可以修改：

| 用途 | 默认 UUID | 属性 |
| --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service |
| Command / RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write 或 Write Without Response |
| Telemetry / TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

小车应在 BLE advertisement 中包含 Service UUID，或至少允许连接后发现该服务。若固件已有自定义 GATT 表，直接在网页设置中填写三个完整 UUID。

## 帧与分包

- 字符编码：UTF-8。
- 消息格式：一行一个 JSON 对象，以 LF（`0x0A`）结束。
- 默认每次 GATT 写入最多 20 字节，包间隔 12 ms；可根据固件和 MTU 实测调整。
- 小车必须先按字节拼接收到的包，遇到 LF 后再对完整行做 UTF-8 解码和 JSON 解析。不要逐包解码 UTF-8，因为多字节字符可能跨包。
- GATT 操作必须顺序执行，不应并发读写同一连接。
- 若路线传输中触发紧急停止，网页会先发送一个 LF 丢弃未完成行，再发送完整 `emergency_stop`。固件应忽略该无效残行并继续解析下一行。

## 网页到小车

### 导航任务

只有 `robot` 模式路线可以下发。网页不会在路线变化时自动发送，必须由操作者点击“下发当前路线”。

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
    "waypoints": [
      {
        "sequence": 0,
        "nodeId": "main-entrance",
        "longitude": 113.4776815,
        "latitude": 22.8883663,
        "kind": "entrance",
        "indoor": false,
        "level": null
      }
    ]
  }
}
```

小车收到完整消息并验证字段后，应返回 `ack`。网页传输完成只代表字节已写入 GATT，并不代表小车接受或执行了任务。

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
