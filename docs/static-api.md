# 静态 GET API 参考

GitHub Pages 不运行服务端代码。LubanNav 在构建期（`npm run generate:api`，脚本 `scripts/generate-static-api.mjs`）为所有公开地点组合预计算路径并输出独立 JSON 文件。任何 HTTP 客户端（包括 AI / 机器人后端）无需执行 JavaScript、无需鉴权即可直接 GET。

- Base URL（线上）：`https://gistudio.github.io/LubanNav/api/v1/`
- 机器可读目录：`GET .../api/v1/catalog.json`（`schemaVersion 1.8`，含全部端点与示例）
- 网页版说明：`.../api/`（`index.html`）
- 内容全部为 UTF-8 JSON；静态托管缓存策略由 Pages 决定，客户端可自行缓存。

## 1. 端点目录

| 端点 | 说明 |
| --- | --- |
| `GET v1/locations.json` | 29 个公开地点的目录与路由绑定 |
| `GET v1/events.json` | 仓库内置活动配置（网页本地自定义活动不在此公开） |
| `GET v1/routing-graph.json` | 完整寻路图：节点、边、模式权限、地点绑定（后端离线 A\* 的唯一输入） |
| `GET v1/routes/{from}/{to}.{mode}.json` | 预计算路线；`mode ∈ {pedestrian, robot}`，29×29×2 = 1682 个文件。每条含稀疏 `path`、加密 `navigationWaypoints`（≤ 2.5 m）与 `highlights`（途经点介绍） |
| `GET v1/robot-ble-protocol.json` | 机器人 BLE 协议的机器可读描述 |
| `GET v1/walkable-surfaces.image.geojson` | 渲染图提取的水泥色平面候选（归一化图像坐标，研究性） |
| `GET v1/walkable-surfaces.wgs84.geojson` | 八栋楼控制点配准后的候选面（WGS84，研究性） |
| `GET v1/walkable-registration-report.json` | 配准残差报告 |

## 2. locations.json — 地点目录

`schemaVersion: "1.2"`。顶层：`dataset`（数据集元信息与免责声明）、`count`、`locations[]`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | **稳定地点 ID**，全部 API 与 URL 参数的合约锚点 |
| `name` / `en` | string | 中文显示名 / 英文名 |
| `category` | string | `entrance` / `academic` / `indoor` / `service` / `residence` / `sports` |
| `aliases` | string[] | 自然语言别名（如 `西翼大学`、`W2电梯`） |
| `poiType` | string? | `lobby` / `elevator` / `platform` / `restaurant`，普通地点为 `null` |
| `level` / `servedLevels` | string / string[]? | 所在楼层 / 电梯服务楼层（如 `["1".."5"]`） |
| `routing` | object | 路由绑定，见下 |

`routing`（即 `getLocationBinding()` 的无模式输出）：

| 字段 | 说明 |
| --- | --- |
| `entrance` | 入口坐标与来源：`source ∈ {osm-entrance, inferred-building-boundary, location-coordinate, local-entrance-poi}`，含 `osmFeatureId`、`osmEntranceId`；本地 POI 另有 `level`、`evidence`、`verificationStatus`、`buildingBoundaryDistanceMeters` |
| `destination` | 实际目的地坐标（有室内路线时为室内终点，否则为 `null`） |
| `roadNodeId` / `roadNode` | 绑定的 OSM 道路节点 ID 与内嵌节点对象（含经纬度） |
| `accessNodeId` / `accessNode` | 室内入口过渡节点（如有） |
| `snapDistanceMeters` | 入口到道路节点的吸附距离（米） |
| `modeNodeIds` / `modeNodes` | 分模式路由节点 ID 与内嵌节点对象 |
| `indoorRoute` | 室内路线元数据（楼层、模式权限、核验状态、`networkId`），无则 `null` |
| `routingByMode` | `{pedestrian, robot}` 各自的 `{destination, routingNodeId, routingNode, connectorDistanceMeters, indoorAccess}` |

## 3. events.json — 内置活动

`schemaVersion: "1.0"`。`events[]` 每项：`id`、`name`、`dateLabel`、`description` 与场所字段：

- `mainVenue`（必有）、`checkIn`（可空）、`breakoutVenues[]`、`accommodations[]`、`diningRecommendations[]`。
- 场所对象：`{id, name, locationId, floor, room, note}`；`locationId` 为 `null` 表示尚未绑定地图地点，不能触发导航。

## 4. routing-graph.json — 完整寻路图

`schemaVersion: "1.0"`，后端离线 A\* / Dijkstra 的唯一输入，不依赖另一份 OSM 数据。

| 字段 | 说明 |
| --- | --- |
| `dataset` | 数据集元信息（当前 `hkustgz-layered-routing-v4`） |
| `coordinateSystem` | `WGS84 longitude/latitude` |
| `directed` | `false`（无向图） |
| `modes` | `[{id, label, speedMetersPerSecond, accessibleOnly}]` |
| `routing.engine` | `layered-osm-indoor-a-star` |
| `routing.allowedHighways` | `["footway","path","pedestrian","service"]` |
| `routing.indoorHighways` | `["corridor","elevator"]` |
| `routing.locationBindingPolicy` | 使用 `locations[id].routingByMode[mode].routingNodeId` 作为图端点，并把 `connectorDistanceMeters` 计入路径成本 |
| `graph.nodes[]` | 节点：`id`、`osmNodeId`、`longitude`、`latitude`、`kind`、`name`、`indoor`、`outdoor`、`level`、`servedLevels`、`source`、`verificationStatus` |
| `graph.edges[]` | 边：`id`、`from`、`to`、`distanceMeters`、`highway`、`modes[]`、`segmentType`、`indoor`、`level`、`source`、`accessAssumed`，室内/垂直边另有 `indoorFeatureId`、`fromLevel`/`toLevel`、`vertical`、`routingPenaltyMeters` |
| `graph.routableNodeIds` | 步行与机器人共享最大连通分量的节点 ID |
| `locations` | 与 §2 相同的绑定（每个地点附 `id/name/en`） |
| `sources` | 室外 OSM 快照与室内补丁的来源信息 |
| `stats` | 节点/边/分量/入口来源计数等生成统计 |

`segmentType` 取值：`osm-road`、`entrance-connector`、`location-connector`、`indoor-path`、`indoor-entrance`、`vertical-connector`、`outdoor-platform`。

### 后端离线寻路接入步骤

1. GET 并缓存本文件；用 `graph.nodes` 建节点索引，用 `graph.edges` 建无向邻接表。
2. 从 `locations[地点ID].routing.routingByMode[模式]` 读取 `routingNodeId`、完整 `routingNode` 与 `connectorDistanceMeters`。
3. 只保留 `edge.modes` 包含当前模式的边，以 `distanceMeters`（如需一致选路行为可加 `routingPenaltyMeters`）为权重跑 A\* 或 Dijkstra。
4. 把起终点的 `connectorDistanceMeters` 计入总距离。节点坐标已内嵌，无需查询 OSM。

起终点都在公开地点列表中时，更简单的方式是直接 GET 预计算路线（§5）。

## 5. routes/{from}/{to}.{mode}.json — 预计算路线

`schemaVersion: "1.4"`。`status` 为 `ok` 或 `no_route`（后者只含 `request`、`routing`、`disclaimer`）。

### 顶层字段

| 字段 | 说明 |
| --- | --- |
| `dataset` | 数据集 ID |
| `request` | `{from, to, mode}` 回显 |
| `summary` | 汇总，见下 |
| `path[]` | 可直接绘制的有序点列（每个图节点一个点，用于画线；**不是**下发给小车的点列） |
| `navigationWaypoints[]` | **下发给机器人的加密点列**：相邻两点间距 ≤ 2.5 m，见下 |
| `highlights[]` | 途经点介绍（路线附近的 POI 与用途），见下 |
| `segments[]` | 后端导航应优先使用的有序路段 |
| `geometry` | GeoJSON `LineString`（`path` 的坐标序列） |
| `instructions[]` | 中文分步指引 |
| `routing` | 引擎信息、`osmWayIds`、`indoorFeatureIds`、起终点绑定（`origin`/`destination`，含 `selectedDestination`、`routingNodeId`、`connectorDistanceMeters`、`indoorAccess`） |
| `disclaimer` | 数据来源与免责声明 |

### summary

| 字段 | 说明 |
| --- | --- |
| `distanceMeters` | 总距离（米，四舍五入） |
| `durationSeconds` | 按模式速度估算（步行 1.25 m/s、机器人 0.8 m/s，向上取整） |
| `distanceEstimated` | 恒为 `true`（未经实测标定） |
| `roadDistanceMeters` / `connectorDistanceMeters` / `indoorDistanceMeters` / `outdoorPlatformDistanceMeters` | 分段距离 |
| `segmentCount` | `segments` 数量 |
| `navigationWaypointCount` | `navigationWaypoints` 的点数 |
| `maxNavigationSpacingMeters` | 相邻加密点的最大间距（≤ 2.5） |

### navigationWaypoints[] — 加密导航点列

OSM / 室内图节点之间常常相隔几十米，真实小车需要 2–3 m 一个点。构建期在 `path` 上做线性插值加密（`scripts` 与 `src/lib/routeDensification.js` 同源逻辑），相邻点间距不超过 2.5 m：

| 字段 | 说明 |
| --- | --- |
| `sequence` | 从 0 开始的顺序号 |
| `nodeId` | 图节点 ID；插值点（`interpolated=true`）为 `null` |
| `longitude` / `latitude` | WGS84 坐标（7 位小数） |
| `kind` | `interpolated`（插值点）或原图节点类型 |
| `interpolated` | `false` 为原图节点，`true` 为线性插值点 |
| `indoor` / `outdoor` / `level` / `servedLevels` | 空间属性（插值点继承所在段起点） |
| `edgeIndex` / `fromNodeId` / `toNodeId` | 插值点所在的原路径段 |
| `distanceMeters` | 与上一个点的间距（米） |

BLE 下发（`navigation_task`）直接使用该点列；网页机器人面板的“路径点”数量也取自这里。

### highlights[] — 途经点介绍

路线周围 80 米内、按“到达顺序”排序的公开 POI（排除起终点，最多 8 个），供语音/文字助手在长路线中逐点介绍：

| 字段 | 说明 |
| --- | --- |
| `id` / `name` / `en` | 稳定地点 ID 与名称 |
| `category` / `poiType` / `level` | 地点分类、POI 类型（如 `platform`）、楼层 |
| `description` | 一两句话的用途介绍（`src/data/poiDescriptions.js`） |
| `distanceMeters` | POI 到路线的最近距离（米，≤ 80） |
| `approachIndex` | 沿 `path` 的到达位置（段索引），用于按顺序介绍 |
| `longitude` / `latitude` | 路线上最接近该 POI 的点坐标 |

### path[] 点对象

端点（起/终点）字段：`id`、`name`、`kind`、`role`（`origin`/`destination`/`origin-destination`）、`longitude`、`latitude`、兼容旧客户端的 `x`/`y`（归一化本地坐标，**不是地理坐标**）、`entranceSource`、`osmFeatureId`、`osmEntranceId`、`indoor`、`outdoor`、`level`、`servedLevels`、`levelAssumed`、`source`、`verificationStatus`。

中间节点字段：`id`、`name`、`kind`、`osmNodeId`、`longitude`、`latitude`、`x`/`y`、`indoor`、`outdoor`、`indoorTransition`、`level`、`servedLevels`、`source`、`verificationStatus`。

### segments[] 路段对象

| 字段 | 说明 |
| --- | --- |
| `id` | 路段 ID（如 `way/1192908727/1`、`location/library/destination-connector`） |
| `from` / `to` | 路段端点 `{id, longitude, latitude, kind, indoor, outdoor, level}` |
| `distanceMeters` | 路段长度（米） |
| `highway` | `footway`/`path`/`pedestrian`/`service`/`corridor`/`elevator`/`connector` |
| `segmentType` | 见 §4 取值表 |
| `modes` | 该段允许的出行模式 |
| `osmWayId` / `indoorFeatureId` | 来源要素 ID（二选一，可空） |
| `indoor` / `outdoor` / `level` / `fromLevel` / `toLevel` / `vertical` | 空间属性 |
| `source` / `verificationStatus` / `accessAssumed` | 来源与核验状态；`accessAssumed=true` 表示通行权为推断 |

### 示例

```text
GET v1/routes/main-entrance/library.pedestrian.json      # 室外 + 51 m 室内段
GET v1/routes/dorm-5/sports-hall.robot.json              # 机器人模式
GET v1/routes/w2-elevator/third-floor-platform.pedestrian.json  # 电梯跨楼层
```

`status: ok` 示例（节选）：

```json
{
  "schemaVersion": "1.4",
  "status": "ok",
  "request": {"from": "main-entrance", "to": "library", "mode": "pedestrian"},
  "summary": {"distanceMeters": 993, "durationSeconds": 795, "segmentCount": 38, "navigationWaypointCount": 421, "maxNavigationSpacingMeters": 2.5},
  "segments": [
    {
      "id": "way/1192908727/1",
      "from": {"id": "osm-node/10763132989", "longitude": 113.4776815, "latitude": 22.8883663},
      "to": {"id": "osm-node/11073090128", "longitude": 113.4777049, "latitude": 22.8884435},
      "distanceMeters": 8.913,
      "highway": "service",
      "segmentType": "osm-road",
      "modes": ["pedestrian", "robot"]
    }
  ],
  "geometry": {"type": "LineString", "coordinates": [[113.4776815, 22.8883663]]}
}
```

## 6. robot-ble-protocol.json — BLE 协议描述符

`schemaVersion: "1.0"`。由 `getRobotProtocolDescriptor()` 生成，与 [robot-ble-protocol.md](robot-ble-protocol.md) 同源：

- `protocol` = `luban-nav-ble`，`protocolVersion` = 1；
- `transport`：角色（浏览器 Central / 小车 Peripheral）、UTF-8 JSON Lines 帧约定、默认 GATT UUID 与分包参数、顺序写入要求；
- `diagnostics.stages`：六阶段连接诊断；
- `browserToRobot`：`navigation_task` 必填字段与航点顺序约定、`emergency_stop` 的 LF 重同步行为；
- `robotToBrowser`：`position`、`ack` 示例；
- `safety`：传输层不替代定位、避障、制动与实体急停的声明。

## 7. 可通行面候选（研究性端点）

三个端点均标注 `routingEnabled=false`，不进入导航：

- `walkable-surfaces.image.geojson`：`coordinateSpace=normalized-image`（0..1，左上原点）；要素属性含 `surfaceClass`、`surface=concrete`、`evidence=cement-color-and-visible-planarity`、`pixelAreaApprox`；顶层含源图 SHA-256、`reviewRequired` 清单。
- `walkable-surfaces.wgs84.geojson`：配准后的候选面；顶层 `registration` 块含模型、状态、RMSE 与控制楼列表；要素属性增加 `registrationModel`、`registrationStatus ∈ {control-fit-accepted-review-pending, control-fit-rejected}`。
- `walkable-registration-report.json`：`metrics`（`fitRmseMeters`、`fitMaxResidualMeters`、`reprojectionRmsePixels`、`leaveOneOutRmseMeters` 等）、`acceptance` 阈值、逐楼 `controls[]`、`limitations`。

## 8. 网页查询参数（非 JSON API）

网页本身支持可复现的 GET 查询参数（需要浏览器执行 JavaScript）：

```text
/?from=main-entrance&to=library&mode=pedestrian
/?from=...&to=...&mode=robot&event=august-device-demo-2026   # event=none 关闭活动模式
/?q=从宿舍5到饭堂                                            # 首次加载时消费的自然语言
```

需要原始 JSON 时请使用上面的静态 API。

## 9. 重新生成

```bash
npm run refresh:osm     # 可选：刷新 OSM 快照并自动重建路网
npm run generate:routing
npm run generate:api    # 重建 public/api/v1/ 全部文件（先清空 routes/）
npm test                # 验证快照与绑定
```

地点 ID 是稳定合约；OSM way/node ID、吸附距离与具体坐标属于派生信息，可能随数据刷新变化。
