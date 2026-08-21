# car7 蓝牙链路故障排查（2026-08-20 实测记录）

本页记录 LubanNav 前端 → car7 BLE 桥 → 执行器 → 底盘整条链路的实测排查过程与结论，
供后续复现同类问题时直接对照。

## 链路图

```
浏览器 Web Bluetooth ──GATT──▶ car7_ble_bridge.py（BlueZ 外设）
                                    │ 方向指令（--direction 模式）
                                    ▼
                        move_executor.py（容器内, 127.0.0.1:9099, odom 闭环）
                                    │ FORWARD/BACKWARD/LEFT/RIGHT/STOP
                                    ▼
                        ROS2 /cmd_vel → hoverboard_driver → STM32 底盘
```

## 问题 1：连接成功但指令不执行（已解决）

**现象**：网页能连上 car7、收到遥测，但方向指令无效。

**根因**：车机 BLE 桥以 **telemetry-only** 模式运行——BOOT 日志明示
`no motor or ROS2 output`。`car7_ble_bridge.py` 对 direction 指令直接回
`rejected: direction control disabled`；导航任务虽被"接受"，但只是回放位置遥测，
从不驱动电机。

**修复**（车机 campusCar 仓库，commit `8905512`）：
1. 桥以 `--direction` 启动（`car7-ble-bridge.service` 的 ExecStart 已固化）
2. 启动容器内执行器（`move-executor.service`，127.0.0.1:9099）
3. 容器持久化：`docker run -d --restart unless-stopped ...`

**验证**：`direction_test_central.py` 全过；执行器日志实测
`FORWARD 0.15 → DONE 0.1502`、`LEFT 15° → DONE 15.2844`（odom 实测）。

## 问题 2：广播间歇不可见（部分解决，仍有遗留）

**现象**：Mac/手机扫描时 car7 时有时无（60s 连续扫描常为 0 事件，偶见 RSSI -46 dBm 的强信号）。

**已修复的诱因**：
- 桥每 30s `bounce_advertisement()`（unregister→register）制造周期性不可见窗口
  → 改为幂等补注册（keepalive 不再 unregister）
- Advertisement 缺 `Discoverable: True`（BlueZ 不加 AD Flags，多数扫描器不上报）
  → 已补
- Intel 组合卡 USB **autosuspend**（`power/control=auto`，空闲挂起、广播停止）
  → 已禁用 + udev 规则 `99-bluetooth-nosuspend.rules` 持久化

**共存实验（决定性）**：40 秒持续扫描（allow_duplicates）对比——

| 条件 | car7 广告事件 |
| --- | --- |
| WiFi 开启（视频流在跑） | 0 条/60s（多次复现） |
| WiFi 关闭（wlo1 down 45s） | 4 条/40s（RSSI -46/-53） |
| WiFi 开启（流已停） | 0–2 条/40s |

结论：**Intel 组合卡（8087:0033，WiFi+BT 共享天线）的 WiFi/BT 共存压制**是广播
间歇的主因；bluetoothd 的 HCI 命令全部 Success，但射频层被共存逻辑饿死。

**已排除的尝试**：`bluetoothd --experimental`（无效）；`btmgmt advertising on`
（MGMT 设置可置位但为空广告）；广告对象加 `MinInterval/MaxInterval`（**非法
dbus 属性，会注册失败 `Failed to parse advertisement`，勿加**）。

**后续选项**：
1. **NUC WiFi 改用 5GHz**（BT 只在 2.4GHz，无共存冲突）——最省事，先试这个
2. 更换 USB BLE dongle（CSR8510A10 / RTL8761B，20-60 元，Linux 免驱），
   把 BlueZ 默认控制器切到 dongle 并禁用 Intel 蓝牙
3. 2.4GHz 信道调优 / 限制视频流带宽

## 排查工具

- 本仓库 `tools/car7-ble-tools/`：验收/驱动/扫描脚本（bleak，无需浏览器）
- 车机 `journalctl -u car7-ble-bridge -f`、`journalctl -u move-executor -f`
- 车机 `btmgmt info`（MGMT 设置）、`btmon`（HCI 级抓包）、`hciconfig hci0`
