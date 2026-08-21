# car7 BLE 真机调试工具

不依赖浏览器/前端 UI，直接以 **BLE Central** 角色（与网页相同的 GATT 客户端行为）连接 car7，
用于真机链路测试与回归。

## 环境准备（macOS）

```bash
uv venv /tmp/bleak-venv --python 3.12
uv pip install --python /tmp/bleak-venv/bin/python bleak
# macOS 首次使用会请求蓝牙权限（系统设置 → 隐私与安全 → 蓝牙）
```

## 工具

| 脚本 | 用途 |
| --- | --- |
| `macos_ble_central_test.py` | **闭环验收**：订阅遥测 → 下发 `navigation_task`（20B 分包）→ 验证 accepted/navigating/position/arrived → 第二个任务中插入 LF+`emergency_stop` → 验证 stopped。修复了跨包 JSONL 重组（与前端 decoder 一致） |
| `drive_car7.py` | 方向指令序列驱动底盘（forward 0.3m → left 30° → backward 0.3m → stop），打印每个 ack |
| `scan_dups.py` | `allow_duplicates=True` 持续扫描 60s，统计 car7 广告事件速率——用于诊断"广播间歇不可见"（持续广播应每秒多条；0 条/60s = 未广播或过滤） |
| `scan_car7.py` | 25s 定向扫描，按设备名/地址寻找 car7（含服务数据） |

## 用法

```bash
/tmp/bleak-venv/bin/python tools/car7-ble-tools/macos_ble_central_test.py --name car7
/tmp/bleak-venv/bin/python tools/car7-ble-tools/drive_car7.py
/tmp/bleak-venv/bin/python tools/car7-ble-tools/scan_dups.py
```

## 依赖的后端状态（车机侧）

- BLE 桥 `car7-ble-bridge.service` 以 `--direction` 模式运行（方向指令驱动底盘；
  telemetry-only 模式下 direction 会被回 `rejected: direction control disabled`）
- 移动执行器 `move-executor.service`（容器内，127.0.0.1:9099，odom 闭环）
- 底盘未上电时：连接/遥测/任务回放仍可验证，方向移动无法验证

## 故障排查速查

详见 `docs/car7-ble-troubleshooting.md`。
