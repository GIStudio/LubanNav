# 用 Mac 模拟 car7，使用 Android 手机验收 LubanNav BLE

> **真机已部署（2026-08）**：car7 NUC（`pc@10.7.181.161`）已运行 Linux/BlueZ 移植版
> BLE 桥（`/home/pc/campusCar/src/ble_bridge/`，日志 `data/logs/ble_bridge.log`）。
> 页面（Chrome/Edge 或 Android 平板 Chrome）打开右侧“语音与设备 → 机器人联络”，
> 选择 `car7` 即可直连，无需本机模拟器。默认 telemetry-only；实车移动验收用
> `scripts/ble_bridge_start.sh --move-test`（前进 10cm → 停止 → 后退 10cm）。
> 下方“用 Mac 模拟 car7”流程保留给没有真机的开发场景。

## 测试边界

本机模拟器实现真实的 BLE 广播、GATT Service、写入、Notify 和分包重组，但只把路线航点回放成位置遥测。它不会发布 ROS2 `/cmd_vel`，也不会驱动电机。因此，这轮测试可以验证网页通信闭环，不能证明真实小车的定位、控制或制动安全。

手机必须使用支持 Web Bluetooth 的 Android Chrome/Chromium。页面来自 GitHub Pages 的 HTTPS 安全上下文；iPhone/iPad Safari 不提供该网页所需的 Web Bluetooth API。

## 1. 在 Mac 启动模拟器

在 LubanNav 仓库根目录运行：

```bash
npm run ble:simulator -- --step-ms 750 --campuscar-export /tmp/lubannav-campuscar-route.json
```

首次运行时允许 Terminal 或 Codex 使用蓝牙。成功后终端应出现：

```text
[BOOT] telemetry-only mode; no motor or ROS2 output
[BLE] adapter powered on
[READY] advertising car7 with NUS service 6e400001-b5a3-f393-e0a9-e50e24dcca9e
```

如果没有 `READY`：

- `unauthorized`：到“系统设置 → 隐私与安全性 → 蓝牙”授权，再重启命令。
- `powered off`：打开 Mac 蓝牙。
- `advertising failed`：退出其他正在广播相同服务的进程，再启动一次。

## 2. Android 手机连接

1. 打开 Android 蓝牙并允许 Chrome 的“附近设备”权限。
2. 用 Chrome 打开 [LubanNav 机器人模式](https://gistudio.github.io/LubanNav/?mode=robot)。
3. 计算一条机器人路线，展开“机器人联络”。保持默认设备名前缀和三个 NUS UUID。
4. 点击“选择并连接小车”，在系统选择器中选择 `car7`。不要从 Android 系统蓝牙设置页预先配对；GATT 测试不要求传统配对。
5. 页面显示已连接后，点击“下发当前路线”。

成功时 Mac 依次打印 `LINK`、`TASK`、`POS`；网页通信记录收到 `accepted`、`navigating`、连续 `position` 和 `arrived`，地图上的机器人位置沿路线移动。

## 3. 验收 STOP 与断连

- 路线回放期间点击网页 `STOP`。Mac 应打印 `stopped: emergency_stop ...`，网页收到 `ack/status=stopped`，之后不再出现新的 `POS`。
- 再次下发路线，然后关闭手机蓝牙或断开页面连接。Mac 应打印 `phone unsubscribed` 并停止回放。
- 长路线传输中点击 `STOP` 时，网页会先写入一个 LF。模拟器会丢弃中断的半行，再解析完整的 `emergency_stop`，避免把残缺路线当成命令。

## 4. 与 campusCar 现有代码的接口

对公开仓库 [`phuang305/campusCar`](https://github.com/phuang305/campusCar) 当前代码的审查结果：

- 没有 BLE/GATT server，不能直接被 Web Bluetooth 连接。
- 运动控制边界是 ROS2 `geometry_msgs/Twist` 的 `/cmd_vel`。
- [`src/rtk_tools/gps_navigator.py`](https://github.com/phuang305/campusCar/blob/main/src/rtk_tools/gps_navigator.py) 可读取一整条 GPS 航点 JSON，并通过 `/fix` 闭环跟踪；这是 LubanNav 完整路线最合适的现有入口。
- [`src/ue_bridge.py`](https://github.com/phuang305/campusCar/blob/main/src/ue_bridge.py) 可接收单个经纬度目标或短时方向指令，并具有指令超时停车逻辑，但不等价于完整路线任务。

启用 `--campuscar-export` 后，模拟器每次收到路线都会原子写出 campusCar `gps_navigator.py` 可读取的格式：

```json
{
  "origin": {"lat": 22.888, "lon": 113.477, "alt": 0},
  "waypoints": [
    {"lat": 22.888, "lon": 113.477, "alt": 0}
  ]
}
```

在真实 NUC 上只能先做不接电机或车轮离地的检查。确认路线坐标、RTK `/fix`、航向、底盘方向、速度上限、失联看门狗和实体急停后，才可由人工显式运行类似命令：

```bash
python3 src/rtk_tools/gps_navigator.py \
  --waypoints /path/to/lubannav-campuscar-route.json \
  --speed 0.2
```

不要让 BLE 进程收到任务后自动启动该命令。正式 NUC 适配层应默认 `dry-run`，并增加人工解锁、任务去重、路线范围检查、定位质量门限、ROS2 节点健康检查、通信超时停车和独立实体急停。公开仓库当前没有顶层 LICENSE，因此这里只对接数据格式和 ROS2 接口，不复制其实现代码。
