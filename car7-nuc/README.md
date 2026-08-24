# campusCar · Cyber 鲁班校园机器人（第 7 组）

**项目名称：** 迎宾带路机器人（比格小狗 IP）  
**队伍：** 带路比格组 / campusCar-7  
**负责人：** 黄品睿  
**GitHub 仓库：** [https://github.com/phuang305/campusCar](https://github.com/phuang305/campusCar)

本仓库是小车车载 NUC 侧的控制与联调工程：STM32 双 UART 底盘驱动、海康工业相机图传、RTK 定位、ROS2 运动控制、UE5 / 网页遥控，以及 GPS 采点与点对点导航工具。面向 Cyber 鲁班「校园迎宾带路」场景——在户外用 RTK 知道车在哪，再把人从一点带到另一点。

---

## 项目简介

### 要解决什么问题

在校园场景中接待访客，通过语音 / 前端选择目的地后，由机器人引导带路。结题阶段验收重点为：

- 底盘可前后左右运动，并可安全停止（急停 / 人工接管）
- RTK 固定解定位稳定，位置可在校园大脑（UE）中展示
- 可用遥控器、NUC（ROS）、UE 控制车辆
- 前端交互与带路闭环持续联调中

### 本仓库覆盖的能力

| 模块 | 说明 | 状态（结题材料口径） |
|------|------|----------------------|
| 底盘运动与停止 | STM32 前后驱动器 UART → `ros2_control` / `/cmd_vel` | 已完成 |
| 定位 | RTK → `/fix`，可对接 UE 位置话题 | 已完成 |
| 图传 | Hikrobot GigE → RTSP / HLS / MJPEG | 联调中 |
| UE 对接 | rosbridge + `ue_bridge`（方向指令 / 目标点导航） | 联调中 |
| 网页遥控 | `web_teleop` 手机/电脑方向与速度控制 | 可用 |
| GPS 采点 / 航点导航 | `path_recorder` + `gps_navigator`（无 IMU 可用 RTK 航迹角） | 可用 |
| 前端语音交互 UI | 另有前端工程；本仓提供 ROS / RTK / 底盘侧接口 | 开发中 |

> 详细验收与演示安排见结题报告《CyberLUBAN_FinalReport_Group7》。

---

## 系统架构（简图）

```text
手机 / PC 网页遥控          UE5 校园大脑              前端 UI（语音/选点）
        │                      │                          │
        ▼                      ▼                          ▼
   web_teleop              rosbridge :9090            指令 → ROS / 业务桥
        │                      │
        └──────────┬───────────┘
                   ▼
              /cmd_vel  ←── ue_bridge / gps_navigator / GUI / 键盘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
  hoverboard_driver      RTK nmea → /fix
  (前/后 UART STM32)         │
         │                   ▼
         ▼            path_recorder / gps_navigator
     差速四轮底盘              （采点 / 点对点带路）
         │
  Hikrobot 相机 → RTSP:8554 / HLS:8888 / MJPEG:8080
```

---

## 运行环境

### 硬件

- 车载工控机（NUC 等），建议 Ubuntu 22.04
- STM32 前后驱动器（双路 5V TTL UART，115200 8N1）
- Hikrobot `MV-CS016-10GC` GigE 工业相机（可选）
- RTK 接收机（USB 串口，户外 Fixed 解）
- 物理急停、遥控接管可用

### 软件

| 项目 | 版本 / 说明 |
|------|-------------|
| OS | Ubuntu 22.04 LTS（推荐） |
| ROS | ROS 2 Humble |
| 容器 | Docker（镜像 `campuscar:humble`，推荐主路径） |
| Python | 3.10（Humble 自带） |
| 网络 | 校园网；NUC 常作 `192.168.100.1`（以实车为准） |

常用端口：

| 端口 | 用途 |
|------|------|
| `8554` | RTSP 视频 |
| `8888` | HLS（UE 推荐拉流） |
| `8080` | MJPEG 预览 |
| `8090` | 网页遥控 `web_teleop` |
| `9090` | rosbridge（UE / 调试） |

---

## 仓库结构

```text
campusCar/
├── README.md                 # 本说明
├── config/
│   ├── robot.env             # 通用配置入口
│   └── profiles/             # 硬件 profile（默认 stm32_hoverboard_4wd）
├── docker/                   # Dockerfile / compose
├── docs/                     # 启动、Docker、UE、部署备忘等
├── hardware/hoverboard_driver/   # STM32 底盘 ros2_control 驱动源码
├── scripts/                  # 一键启动 / 探测 / Docker / 遥控等
├── src/                      # Python 节点与工具
│   ├── car_gui.py            # 控制台 GUI
│   ├── ue_bridge.py          # UE 指令桥
│   ├── web_teleop.py         # 网页遥控
│   ├── rtk_tools/            # RTK 采点、航点导航、路网工具
│   └── ...
└── data/                     # 日志、采点路径、UE 样例指令等（大体积日志不入库）
```

更细的联调备忘见：

- [`docs/快速启动指南.md`](docs/快速启动指南.md)
- [`docs/Docker部署指南.md`](docs/Docker部署指南.md)
- [`docs/UE对接文档.md`](docs/UE对接文档.md)
- [`docs/部署调试备忘.md`](docs/部署调试备忘.md)

---

## 安装方式

推荐在 NUC 上用 Docker 隔离 ROS2 依赖（宿主机仍负责串口 / 网口 / 急停等真实硬件）。

### 1. 克隆仓库

```bash
git clone https://github.com/phuang305/campusCar.git
cd campusCar
```

实车目录也可能是 `~/campusCar-new-chassis`（与本仓同一套代码）。

### 2. 安装 Docker 并构建镜像（首次）

```bash
./scripts/install_docker.sh    # 若尚未安装 Docker
./scripts/docker_build.sh      # 构建 campuscar:humble
```

### 3. 本地敏感配置（不要提交到 Git）

```bash
cp config/profiles/stm32_hoverboard_4wd.env \
   config/profiles/stm32_hoverboard_4wd.local.env
# 编辑 local 文件：串口路径、相机 GUID、限速等
```

建议把前后串口写成稳定的 `/dev/serial/by-id/...`。  
工程默认限速偏保守（如 `HOVERBOARD_COMMAND_LIMIT_RPM`）；确认架空轮、方向与急停之前，不要盲目提高。

### 4. 进入运行环境

```bash
./scripts/docker_run_stm32.sh
# 容器内工作目录一般为 /workspace/campusCar-new-chassis
```

非 Docker 路径：先 `./scripts/deploy_dependencies.sh`，再本机 source ROS2 Humble 后运行同名脚本。

---

## 使用说明

### 全栈启动 / 停止 / 自检

在 Docker shell 或已配置好的 ROS 环境中：

```bash
./scripts/stm32_hoverboard_probe.sh   # 先确认双串口与依赖
./scripts/hikrobot_camera_probe.sh    # 有相机时
./scripts/launch_all.sh               # 底盘 + 相机 + 视频 + RTK + rosbridge + UE 桥 + GUI
./scripts/check_all.sh
./scripts/stop_all.sh
```

启动后可关注：

- 控制 GUI / 键盘遥控
- MJPEG：`http://<NUC_IP>:8080`
- HLS（UE）：`http://<NUC_IP>:8888/robot_cam/index.m3u8`
- rosbridge：`<NUC_IP>:9090`

### 网页遥控（前后左右 + 调速）

```bash
./scripts/web_teleop.sh
# 手机浏览器打开 http://<NUC局域网IP>:8090/
```

### 户外 RTK 采 5 点 → 点对点走（可无 IMU）

1. 确认 `/fix` 为 Fixed  
2. 采点：

```bash
python3 src/rtk_tools/path_recorder.py
# 到每个点按 m 打点，按 s 保存 → data/recorded_paths/
```

3. 导航（用 RTK 位移推航迹角作航向）：

```bash
python3 src/rtk_tools/gps_navigator.py \
  --waypoints data/recorded_paths/path_xxx.json \
  --speed 0.35 --radius 0.8 --wheelbase 0.45
```

有外接 IMU 后可用 `./scripts/imu_heading_start.sh` 增强静止航向。详见快速启动指南中的「户外小范围导航」。

### UE 联调（方向 / 目标点）

- 协议与样例：[`docs/UE对接文档.md`](docs/UE对接文档.md)、`data/ue_fixtures/`
- 自测回放：`./scripts/ue_cmd_selftest.sh`

---

## 安全须知

- 外场测试需有人看护人流；急停按钮保持显眼可用  
- 首次务必架空车轮或确认急停后再上电遥控  
- 软件限速与 `HOVERBOARD_COMMAND_LIMIT_RPM` 未验证前保持保守  
- 切断 TTL / 物理急停是最终安全手段；不要只依赖软件停车  

---

## 团队与分工（结题材料）

| 方向 | 主要同学 |
|------|----------|
| 底盘 / 定位 / ROS / NUC / UE 联调 | 黄品睿 |
| 前端交互、语音与愿景展示 | 王怡雯 |
| 急停、机械结构、安全 | 丁俊超、林子铨 |
| 布线与工业相机安装 | 何柏霖 |

---

## 许可证与声明

本仓库用于 Cyber 鲁班校园机器人课程项目交付与现场验收。硬件协议、相机驱动与第三方包请遵循各自原许可证。本地密码、串口映射等请放在被 `.gitignore` 忽略的 `*.local.env` 中，勿推送到公开仓库。

---

## 相关链接

- 源代码仓库：https://github.com/phuang305/campusCar  
- 快速上手：[`docs/快速启动指南.md`](docs/快速启动指南.md)  
- Docker：[`docs/Docker部署指南.md`](docs/Docker部署指南.md)  
- UE 对接：[`docs/UE对接文档.md`](docs/UE对接文档.md)  
