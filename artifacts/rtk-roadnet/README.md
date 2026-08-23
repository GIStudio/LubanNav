# RTK Fixed 持久化日志 + 自动路网构建

解决"小车每次启动都会清空 RTK 记录"：原 `path_recorder.py` 是**会话式**记录
（每次启动内存从空开始、每会话存独立时间戳文件）。本方案改为**追加式持久化
日志 + 自动增量构路网**，随车 systemd 自启。

## 数据流

```
/ fix (NavSatFix, status==4 = RTK_FIXED)
        │  rtk_fixed_logger.py（只记 Fixed，0.5m 稀疏化，追加不截断）
        ▼
data/logs/rtk_fixed.jsonl   （JSONL，跨启动保留，含 session_start 标记）
        │  roadnet_builder.py --watch（每个新点关联最近 3 个点）
        ▼
data/maps/campus_road_network.json  （节点 + 边，原子写盘）
```

**状态码约定**（与 `src/rtk_tools/core/bridge.py` 的 `STATUS_MAP` 一致）：

| status | 含义 | 是否记录 |
| --- | --- | --- |
| 4 | RTK_FIXED（固定解，厘米级） | ✅ 记录 |
| 5 | RTK_FLOAT（浮点解） | ❌ |
| 1 | DGPS_FIX | ❌ |
| 0 / -1 | GPS / 无信号 | ❌ |

## 文件（部署到 campusCar/src/rtk_tools/）

| 文件 | 说明 |
| --- | --- |
| `rtk_fixed_logger.py` | ROS2 节点：订阅 `/fix`，只把 `status==4` 追加写 `data/logs/rtk_fixed.jsonl`；发布 `/rtk_fixed_log/status` 统计 |
| `roadnet_builder.py` | 纯 Python 服务：读取日志增量构图（每点关联最近 k=3 个点，默认边长上限 25m、同点合并半径 0.5m），原子写 `data/maps/campus_road_network.json`；`--watch` 常驻 / `--rebuild` 一次性重建 |
| `rtk_fixed_logger_run.sh` | logger 启动包装（source ROS 或走 `RTK_ROADNET_CONTAINER` 容器），systemd 用 |
| `rtk_roadnet_start.sh` | 一键 `start|stop|status`（有 systemd 走 systemctl，否则 nohup 兜底） |
| `rtk-fixed-logger.service` | systemd：logger 开机自启 + 守护 |
| `rtk-roadnet-builder.service` | systemd：builder 开机自启 + 守护（依赖 logger） |
| `test_roadnet_builder.py` | 纯逻辑单测（无 ROS 依赖） |

## 安装（开机自启 + 进程守护）

```bash
cd /home/pc/campusCar
sudo cp src/rtk_tools/rtk-fixed-logger.service /etc/systemd/system/
sudo cp src/rtk_tools/rtk-roadnet-builder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rtk-fixed-logger rtk-roadnet-builder
systemctl status rtk-fixed-logger rtk-roadnet-builder
journalctl -u rtk-fixed-logger -f      # 日志
tail -f data/logs/rtk_fixed.jsonl      # 原始 Fixed 记录
```

手动调试（无 systemd）：`bash src/rtk_tools/rtk_roadnet_start.sh start`

## 使用与验证

1. **确认 Fixed 过滤正确**：`ros2 topic echo /fix --once`，看 `status.status`；只有 4 会进日志。
2. **建图**：沿校园小路走一遍（Fixed 优先），走完 `python3 src/rtk_tools/roadnet_builder.py --rebuild` 立即重建核对。
3. **查看路网**：`data/maps/campus_road_network.json`——`nodes[]`（经纬度/首次-末次时间/计数）、`edges[]`（from/to/距离），`buildRule` 记录构图参数。
4. **后台自动**：logger + builder 由 systemd 守护，新 Fixed 点实时增量入网。

## 注意

- 日志只增不删；如需归档可另加 logrotate，别用 `open(...,"w")` 截断。
- `max_edge_m=25` 防止把相距很远的孤立点连成"跨空"边；若要严格"最近 3 个点不限距离"，加 `--max-edge 0`（会退化为全量扫描，点多时慢）。
- `status==4` 是**本系统**的 RTK_FIXED 约定；若换了接收机驱动导致 status 语义不同，用 `rtk_fixed_logger.py --fixed-statuses "..."` 调整。
- builder 是纯文件服务（无 ROS 依赖），logger 需要 ROS2（宿主已 source 或 `RTK_ROADNET_CONTAINER` 指定容器）。
