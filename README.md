# LubanNav

面向香港科技大学（广州）校园的轻量导航 Web 应用原型。它提供轻量 OpenStreetMap Canvas 地图、由 OSM `highway=footway/path/pedestrian/service` 与分层室内通道共同组成的 A* 路网、建筑入口吸附、AI 导航助手式对话与本地自然语言目的地解析、可被 AI/机器人客户端直接 HTTP GET 的静态 JSON 路径 API，以及浏览器通过 BLE GATT 与机器人小车进行任务和位置通信的 Web Bluetooth 控制面板。

> 当前版本是工程演示，不是学校官方导航产品。室外建筑、入口、水域和道路来自 [OpenStreetMap](https://www.openstreetmap.org/way/894157108)，地图数据采用 [ODbL 1.0](https://www.openstreetmap.org/copyright)；本地室内补丁会单独标明来源和核验状态。OSM 缺少入口时会推断建筑边界入口，导航拓扑与可通行性仍未经现场测绘，不可直接用于真实机器人运动控制。

## 为什么静态站点也能提供 GET API

GitHub Pages 不运行服务端代码。构建时，LubanNav 会为所有公开地点组合预计算路径，并输出独立 JSON 文件。因此普通 HTTP 客户端无需执行 JavaScript，也能直接获得路线：

```text
GET https://<user>.github.io/<repo>/api/v1/locations.json
GET https://<user>.github.io/<repo>/api/v1/routing-graph.json
GET https://<user>.github.io/<repo>/api/v1/robot-ble-protocol.json
GET https://<user>.github.io/<repo>/api/v1/routes/main-entrance/library.pedestrian.json
GET https://<user>.github.io/<repo>/api/v1/routes/dorm-5/sports-hall.robot.json
```

已知地点对可以直接读取预计算路线。需要在自己的后端运行 A* 时，只需缓存 `routing-graph.json`；它内含全部节点坐标、边、模式权限、地点入口和分模式图节点绑定，不依赖另一份 OSM 数据。完整机器可读目录位于 `api/v1/catalog.json`，网页 API 说明位于 `api/`。

响应示例：

```json
{
  "schemaVersion": "1.3",
  "dataset": "hkustgz-layered-routing-v3",
  "status": "ok",
  "request": {
    "from": "main-entrance",
    "to": "library",
    "mode": "pedestrian"
  },
  "summary": {
    "distanceMeters": 993,
    "durationSeconds": 795,
    "distanceEstimated": true,
    "roadDistanceMeters": 896,
    "connectorDistanceMeters": 46,
    "indoorDistanceMeters": 51,
    "segmentCount": 38
  },
  "path": [
    {
      "id": "main-entrance",
      "kind": "entrance",
      "entranceSource": "osm-entrance",
      "longitude": 113.4776815,
      "latitude": 22.8883663
    }
  ],
  "segments": [
    {
      "id": "way/1192908727/1",
      "from": {"id": "osm-node/10763132989", "longitude": 113.4776815, "latitude": 22.8883663},
      "to": {"id": "osm-node/11073090128", "longitude": 113.4777049, "latitude": 22.8884435},
      "distanceMeters": 8.913,
      "highway": "service",
      "osmWayId": 1192908727,
      "segmentType": "osm-road",
      "modes": ["pedestrian", "robot"]
    }
  ],
  "geometry": {"type": "LineString", "coordinates": [[113.4776815, 22.8883663], [113.4777049, 22.8884435]]},
  "routing": {
    "engine": "layered-osm-indoor-a-star",
    "allowedHighways": ["footway", "path", "pedestrian", "service"],
    "indoorHighways": ["corridor"],
    "indoorFeatureIds": ["local/library-level-0-main-corridor"],
    "osmWayIds": [1192908727, 1154868989]
  },
  "instructions": ["从主入口出发", "...", "沿0层室内通道前行约 51 米", "抵达图书馆馆内目的地"],
  "disclaimer": "..."
}
```

网页本身也支持可复现的 GET 查询参数：

```text
/?from=main-entrance&to=library&mode=pedestrian
/?q=从宿舍5到饭堂
```

第二种链接需要浏览器执行页面 JavaScript；需要原始 JSON 时使用上面的静态 API。

`path` 是可直接绘制的有序点列，并同时提供 WGS84 `longitude` / `latitude` 和早期客户端使用的 `x` / `y`；后者只为兼容保留，不应解释为地理坐标。`segments` 是后端导航应优先使用的有序路段，逐段给出起终点经纬度、距离、`highway`、`segmentType`、可用模式、OSM way 或室内要素来源。`geometry` 是可直接读取的 GeoJSON `LineString`。

### 无 OSM 后端如何自行寻路

1. GET 并缓存 `api/v1/routing-graph.json`，用 `graph.nodes` 建立节点索引，用 `graph.edges` 建立无向邻接表。
2. 从 `locations[地点ID].routing.routingByMode[模式]` 读取 `routingNodeId`、完整 `routingNode` 和 `connectorDistanceMeters`。
3. 只保留 `edge.modes` 包含当前模式的边，使用 `distanceMeters` 作为 A* 或 Dijkstra 权重。
4. 将起终点的 `connectorDistanceMeters` 计入总距离；地点入口和图节点的坐标都已内嵌，无需查询 OSM node/way。

如果起点和终点都在公开地点列表中，更简单的方式是直接 GET 预计算路线 JSON；其 `segments` 已经是从入口到目的地的完整有序路径。

## 浏览器连接机器人小车

LubanNav 使用 [Web Bluetooth API](https://developer.chrome.com/docs/capabilities/bluetooth) 让网页作为 BLE Central / GATT Client 连接机器人小车。GitHub Pages 是 HTTPS 安全上下文；设备选择仍必须由操作者点击按钮触发，浏览器不会在后台静默连接设备。

推荐使用 Android Chrome，或支持 Web Bluetooth 的 macOS / Windows / ChromeOS Chromium 浏览器。小车必须提供 BLE GATT Service；传统 Bluetooth Classic RFCOMM 串口不属于 Web Bluetooth 的能力范围。

使用流程：

1. 在导航对象中选择“机器人”，确认路线避开未核验的室内段。
2. 展开“GATT 与分包设置”，填写小车固件的 Service、Command/RX 和 Telemetry/TX UUID。默认值兼容 Nordic UART Service。
3. 点击“选择并连接小车”，在浏览器设备选择器中人工选择设备。
4. 点击“下发当前路线”。网页把路线编码为 UTF-8 JSON Lines，默认按 20 字节顺序写入；切换路线不会自动向小车发送。
5. 小车通过 TX Notify 回传 `position`、`ack` 或 `status`。合法 WGS84 位置会显示在地图上。
6. “STOP”会中止未完成的路线传输并优先发送 `emergency_stop`，但不能替代物理急停。

固件消息、分包重组和安全边界详见 [`docs/robot-ble-protocol.md`](docs/robot-ble-protocol.md)，机器可读合约位于 `api/v1/robot-ble-protocol.json`。

> 当前仓库只验证了模拟 GATT 设备的连接、分包、任务和位置消息。正式小车仍需用真实 UUID 和固件联调，并在小车端实现失联看门狗、指令去重、定位、避障、制动和实体急停。

## 本地开发

要求 Node.js 20+：

```bash
npm install
npm run dev
```

验证并构建：

```bash
npm test
npm run build
npm run preview
```

`npm run build` 会先生成 `routing-graph.json`、地点绑定和 `public/api/v1/routes/` 静态路径响应，再由 Vite 写入 `dist/`。生成文件被 Git 忽略，避免提交大量机械产物。

## OSM 数据层

网页不会在运行时请求 OSM 在线瓦片。`public/data/campus-osm.geojson` 是一个约 76 KB 的同源快照，只保留：

- `building` 建筑；
- `entrance` / `routing:entrance` 入口点；
- `highway` 道路和步行路径；
- `natural=water` 水面；
- `waterway` 水系。

需要刷新时运行：

```bash
npm run refresh:osm
npm test
npm run build
```

刷新脚本向公共 Overpass API 请求固定校园范围，白名单保留必要标签和道路的 OSM 节点 ID，并写入来源、抓取时间、边界、署名和许可证。随后它会自动重建 `src/data/osm-routing.json`。刷新后的 GeoJSON 与路网 JSON 都是需要审查并提交的来源/派生数据，不在普通构建中联网生成。

### OSM 路网与入口吸附规则

`npm run generate:routing` 完全离线、可复现地执行以下步骤：

1. 只选择 `footway`、`path`、`pedestrian`、`service`，过滤 `access=no/private` 和明确禁止步行的道路；机器人模式另外过滤 `wheelchair=no` 与明确不可通行的松软路面。
2. 使用每条 OSM way 的原始节点 ID 将相邻坐标转成带米制距离的无向边，并保留最大的步行/机器人共同连通分量。
3. 若建筑边界已有有效 OSM `entrance=*`，优先使用该点；若没有，则计算建筑边界上距离可通行道路节点最近的点，并标记为 `inferred-building-boundary`。
4. 将入口绑定到最近道路节点，记录 `roadNodeId`、`snapDistanceMeters`、建筑/入口 OSM ID 与来源。
5. 把通过校验的室内入口、走廊和地点锚点接入同一张图，A* 根据模式在室外与室内边上统一搜索。

当前快照与室内补丁生成 322 个节点、337 条边，其中 OSM 共同连通分量有 277 个节点；25 个公开地点均有绑定。API 不仅返回 `roadNodeId`，还内嵌对应节点坐标并提供完整路网下载；单条路线将 OSM 道路、入口连接段与室内段逐段返回，便于调用方离线导航并识别推断部分。

### 如何添加室内搜索空间

OSM 推荐让建筑入口节点同时连接室内外路径，室内线性导航路径使用 `highway=corridor`、`indoor=yes` 和 `level=*`；完整楼层也可以进一步使用 [Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging) 的 `indoor=corridor/area/room` 面要素。

当前 OSM 没有港科大广州图书馆的室内要素，也没有西翼/东翼大堂入口点，因此 `public/data/campus-indoor.geojson` 保存可独立审查的本地入口与室内路由补丁。

`entrancePoi` 用于补充可搜索的本地入口锚点。西翼大堂沿用用户确认的 POI；东翼大堂入口按西翼 POI 在 W1 中的相对端部位置映射到 E1，对应坐标为 `[113.4776200, 22.8904414]`。生成器要求入口 POI 位于目标建筑内且距建筑边界不超过 5 米，并记录 `evidence`、`inferredFrom` 与 `verificationStatus`。稳定地点 ID 仍为 `west-concourse` 和 `east-concourse`，旧称“西翼大学 / 东翼大学”继续作为搜索别名。

每条室内路径至少需要：

```json
{
  "properties": {
    "featureClass": "indoorPath",
    "locationId": "library",
    "buildingFeatureId": "way/1098450394",
    "highway": "corridor",
    "indoor": "yes",
    "level": "0",
    "modes": ["pedestrian"],
    "verificationStatus": "approximate-unverified"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [113.4776064, 22.8925129],
      [113.4778300, 22.8923900],
      [113.4780569, 22.8923387]
    ]
  }
}
```

生成器会拒绝入口偏差超过 3 米、室内点落到建筑轮廓外、缺少楼层或没有步行权限的补丁。未核验室内段默认只加入 `pedestrian`；只有现场验证门宽、坡度、门禁和机器人可达性后，同时设置 `"modes": ["pedestrian", "robot"]` 与 `"robotValidated": true`，才会进入机器人搜索空间。

图书馆当前加入约 51 米的 0 层室内段。其可步行性来自用户确认，但几何和楼层编号仍是近似假定；步行路线进入馆内锚点，机器人路线仍止于建筑入口。

## GitHub Pages 部署

仓库已经包含 `.github/workflows/deploy-pages.yml`。将默认分支推送为 `main` 后，在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。此后每次推送到 `main` 都会先测试、构建，再部署 Pages。

Vite 使用相对 `base`，因此可同时部署在用户主页和项目子路径，无需填写仓库名。

## 代码边界

```text
src/data/campus.js             稳定地点 ID、别名、OSM 建筑映射与模式
public/data/campus-osm.geojson 建筑、入口、水域和道路的 OSM 快照
public/data/campus-indoor.geojson  分层室内路径补丁与核验状态
src/data/osm-routing.json      自动生成的 OSM 寻路图与入口绑定
src/lib/pathfinding.js         室内外统一图上的 A* 路由与机器可读响应
src/lib/destinationParser.js   本地中英文意图/地点解析
src/components/CampusMap.jsx   Leaflet Canvas 地图、地点和路线叠加
src/components/ChatAssistant.jsx  对话入口
src/components/RobotControl.jsx     Web Bluetooth 连接、任务下发与遥测面板
scripts/fetch-osm-campus.mjs      OSM / Overpass 快照刷新器
scripts/lib/osm-routing.mjs       道路转图、连通分量与入口吸附算法
scripts/generate-osm-routing.mjs  OSM 寻路图生成器
scripts/generate-static-api.mjs   GitHub Pages 静态 GET API 生成器
docs/robot-ble-protocol.md        BLE GATT、JSON Lines 分包与固件消息合约
```

地点 ID 仍是稳定 API 合约；OSM way/node ID、入口来源和吸附距离是可随数据刷新变化的派生信息。真实机器人部署还需要至少增加：厘米级或满足任务要求的定位、现场可通行性校验、动态避障、门禁/电梯接口、实时封路、速度与制动安全层，以及人工急停机制。

## “AI 对话”的准确含义

当前导航助手使用确定性的本地意图解析与模糊地点匹配，不调用外部大模型，也不上传用户文本。优势是体积极小、离线可用、结果可复现。后续若接入 LLM，应只让模型产出受约束的 `{from, to, mode}` 提案，再由本地路由内核验证地点与计算路径；不要让模型直接生成机器人运动轨迹。
