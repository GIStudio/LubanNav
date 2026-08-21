# car7 WiFi 真机调试工具

不依赖浏览器/前端 UI，直接以 **WebSocket 客户端**（与网页相同的 JSONL 协议）
连接车机 `car7-wifi-bridge`，验收 WiFi 闭环。

| 脚本 | 说明 |
| --- | --- |
| `wifi_central_test.py` | 闭环验收：握手 → 流式导航任务 → ack/navigating → 位置遥测 → direction stop → emergency_stop |

纯 Python 3 标准库（手写 RFC 6455 客户端），无需安装任何包。

## 用法

```bash
# 默认连真机 ws://10.7.181.161:8900
python3 wifi_central_test.py

# 指定地址 / 航点数
python3 wifi_central_test.py --url ws://127.0.0.1:8901 --waypoints 6

# 危险：真实移动验收（前进 10cm → 后退 10cm，需确保车轮离地或场地安全）
python3 wifi_central_test.py --direction-motion
```

输出示例：

```text
[1] WebSocket handshake: ws://10.7.181.161:8900
    connected
[2] streaming navigation task (8 waypoints)
    ack: accepted (streaming 8 waypoints)
    status: navigating
[3] position telemetry (replay fallback while RTK has no fix)
    pos[1] fix=replay lat=22.88836 lon=113.47768 hdg=47.87 acc=0.03
[4] direction stop (no motion)
    ack: accepted
[6] emergency stop
    ack: stopped
PASS  car7 WiFi bridge closed loop verified
```

车机侧日志：`journalctl -u car7-wifi-bridge -f`（或容器内
`/workspace/campusCar-new-chassis/data/logs/wifi_bridge.log`）。
