# 数据管线与脚本

本文描述从 OSM 原始数据到静态 API 的完整管线，以及每个脚本的用法、参数、输出与算法规则。

## 1. 管线总览

```text
Overpass API ──fetch-osm-campus.mjs──▶ public/data/campus-osm.geojson ─┐
                                                                        │
人工维护 ──────────────────────────▶ public/data/campus-indoor.geojson ─┤
                                                                        ▼
                                        generate-osm-routing.mjs（scripts/lib/osm-routing.mjs）
                                                                        │
                                                                        ▼
                                                      src/data/osm-routing.json
                                                                        │
                            src/data/campus.js + src/lib/pathfinding.js │
                                                                        ▼
                                              generate-static-api.mjs
                                                                        │
                                                                        ▼
                                        public/api/v1/**（静态 GET API）

本地 3D 渲染图 ──extract-walkable-surfaces.py──▶ 图像坐标候选面
                       │
                       └──register-walkable-surfaces.py──▶ WGS84 候选面 + 配准报告
                                          （八栋楼控制点：config/eight-building-registration.json）

全部数据源 ──export-gis-layers.py──▶ artifacts/gis/（GeoJSON / GeoPackage / QGIS 工程）
```

npm scripts 与脚本对应关系：

| npm script | 脚本 | 作用 |
| --- | --- | --- |
| `refresh:osm` | `fetch-osm-campus.mjs` + `generate-osm-routing.mjs` | 刷新 OSM 快照并重建路网 |
| `generate:routing` | `generate-osm-routing.mjs` | 离线重建 `src/data/osm-routing.json` |
| `generate:api` | `generate-static-api.mjs` | 重建 `public/api/v1/` |
| `extract:walkable` | `extract-walkable-surfaces.py`（uv） | 渲染图水泥色平面提取 |
| `register:walkable` | `register-walkable-surfaces.py`（uv） | 八栋楼控制点 WGS84 配准 |
| `export:gis` | `export-gis-layers.py`（uv） | GIS 图层导出 |
| `build` | routing + api + `vite build` | 完整构建 |

## 2. scripts/fetch-osm-campus.mjs — OSM 快照刷新

向公共 Overpass API 请求固定校园范围（bbox：纬度 22.8855–22.895，经度 113.474–113.484），查询 `building`（way/relation）、`highway`（way）、`natural=water`、`waterway` 与 `entrance` / `routing:entrance` 节点，`out geom` 带几何输出。

- 端点容错：`overpass-api.de` 失败后自动切换 `overpass.kumi.systems`；单请求超时 120 s。
- 要素分类：`entrance → building → water → waterway → road` 的判定顺序；道路要素保留 OSM 节点 ID 数组 `osmNodeIds`（路网节点稳定 ID 的来源）。
- 标签白名单：`name`、`name:en`、`ref`、`building`、`building:levels`、`highway`、`service`、`surface`、`foot`、`access`、`natural`、`water`、`waterway`、`bridge`、`tunnel`、`layer`、`entrance`、`routing:entrance`、`wheelchair`、`level`。
- 几何处理：way 裁剪到 bbox（至少一个顶点在内）、多边形闭环、relation 只取 `outer` 环。
- 输出：`public/data/campus-osm.geojson`，顶层含 `bbox`、`attribution`、`license=ODbL-1.0`、`source`、`fetchedAt`、`overpassEndpoint`。

参数：

| 参数 | 说明 |
| --- | --- |
| `--input <path>` | 用本地 Overpass JSON 代替联网抓取（`endpoint` 记为 `local-input`） |
| `--entrances-input <path>` | 合并额外的入口节点 payload（按元素 ID 去重） |

刷新后必须执行 `npm test` 与 `npm run build` 审查派生数据；GeoJSON 是需要提交的来源数据。

## 3. scripts/generate-osm-routing.mjs + scripts/lib/osm-routing.mjs — 路网生成

完全离线、可复现。输入 `campus-osm.geojson` + `campus-indoor.geojson` + `src/data/campus.js`（地点目录与建筑映射），输出 `src/data/osm-routing.json`（`schemaVersion 2.0`）。

### 3.1 buildRoadGraph — 道路转图

- 只选 `highway ∈ {footway, path, pedestrian, service}` 的 LineString。
- 步行权限：`foot ∈ {no,private}` 拒绝；`access ∈ {no,private}` 且 `foot` 非 `{yes,designated,permissive}` 拒绝。
- 机器人权限：在步行权限基础上，`wheelchair=no` 拒绝；`surface ∈ {dirt,earth,grass,gravel,ground,mud,sand,unpaved}` 拒绝。
- 节点 ID：有 OSM 节点 ID 用 `osm-node/<id>`，否则 `coordinate/<lon7>,<lat7>`。
- 边：相邻坐标对生成无向边（同键保留更短者），`distanceMeters` 为 Haversine 米制距离；`accessAssumed` 标记通行权为推断的边。
- 连通分量：分别计算步行与机器人最大连通分量，取交集为 `routableNodeIds`。

### 3.2 bindLocationsToRoadGraph — 地点入口吸附

对每个公开地点按优先级选择入口：

1. **OSM 标签入口**：地点映射建筑边界 2.5 m 内的有效入口点（排除 `entrance=no/exit/emergency` 与禁用访问）；优先级 `routing:entrance=main` > `routing:entrance=*` > `entrance=main` > 其他，同级取距边界最近；来源记 `osm-entrance`。
2. **推断建筑边界入口**：无标签入口时，取建筑边界上距任一可通行道路节点最近的点；来源记 `inferred-building-boundary`。
3. **入口类地点回退**：`category=entrance` 的地点可匹配 150 m 内最近的标签入口。
4. **坐标锚点**：其余地点直接取最近道路节点；来源记 `location-coordinate`。

输出绑定：`entrance`（坐标/来源/OSM ID）、`roadNodeId`、`snapDistanceMeters`、`matchedBuildingFeatureIds`。

### 3.3 applyEntrancePoiOverrides — 本地入口 POI

室内补丁中 `featureClass=entrancePoi` 的 Point 要素覆盖绑定（用于西翼/东翼大堂）：

- 校验：必须位于目标建筑内部且距建筑边界 ≤ 5 m，否则生成失败。
- 记录 `evidence`、`inferredFrom`、`verificationStatus`；来源记 `local-entrance-poi`，并重算最近道路节点与吸附距离。

### 3.4 addIndoorRoutesToGraph — 单建筑室内路径

`featureClass=indoorPath` 的 LineString 要素（示例见仓库 README「如何添加室内搜索空间」）：

- 校验（任一失败即中止生成）：起端与绑定入口距离 ≤ 3 m；其余点全部落在建筑轮廓内；`level` 必填；`modes` 必须显式包含 `pedestrian`；`robot` 仅在 `robotValidated=true` 时保留；`access=no/private` 跳过。
- 构图：入口过渡节点 `indoor/<locationId>/level-<level>/entrance` + 逐段节点；室外道路节点到入口的 `entrance-connector` 边（步行/机器人均可用）+ 室内 `indoor-path` 边。
- 绑定更新：`accessNodeId`、`modeNodeIds`（各模式可达的最深节点）、`destination`（室内终点）、`indoorRoute` 元数据。

### 3.5 addIndoorNetworkToGraph — 共享室内网络

三类要素（W2/E2 大堂、电梯、三楼平台）：

| featureClass | 几何 | 关键属性 |
| --- | --- | --- |
| `indoorNetworkNode` | Point | `nodeId`、`level`、可选 `locationId`（绑定地点）、`outdoorLocationId`（接室外道路）、`entryLocationId`/`entryNodeId`（借用其他地点入口）、`outdoor=true`（室外平台）、`routingPenaltyMeters`（默认 250）、`modes`/`robotValidated` |
| `indoorNetworkLink` | LineString | `fromNodeId`/`toNodeId`、`highway`（默认 `corridor`）、`vertical=true` 或 `highway=elevator` 判为垂直边、`outdoor=true` 判为室外平台边、显式 `distanceMeters`（必须为正） |
| `indoorVerticalConnector` | Point | `nodeId`、`levels[]`（≥2）、`defaultLevel`、`levelHeightMeters`（默认 4.2）、`locationId` 只绑定到默认层 |

规则：

- 垂直连接器展开为逐层节点 `<nodeId>-<level>f` 与相邻层电梯边（距离 = 层差 × 层高）。
- 带 `outdoorLocationId` 的节点生成 `indoor-entrance` 边接该地点的道路节点，边权附加换楼惩罚；**惩罚只影响选路，API 报告距离不累计**。
- Link 的首末坐标必须与所引用节点相距 ≤ 3 m；节点与边重复即报错。
- 边 `segmentType`：垂直 → `vertical-connector`；室外 → `outdoor-platform`；其余 → `indoor-path`。
- 地点绑定：`locationId` 节点的坐标成为目的地；`entryLocationId` 允许借用其他地点的入口与道路节点（如三楼平台借用 W2/E2 电梯链）。

### 3.6 输出统计

`stats` 含节点/边总数、步行/机器人/共享分量规模、地点数、OSM 入口数、各来源入口计数、最大吸附距离、室内路径与网络计数、垂直边数等。控制台打印摘要（当前快照：341 节点、358 边、29 地点、最大吸附若干米）。

## 4. scripts/generate-static-api.mjs — 静态 API 生成

与网页共用 `src/lib/pathfinding.js`，输出到 `public/api/v1/`：

1. 清空并重建 `routes/`。
2. `locations.json`（schema 1.2）：地点目录 + `getLocationBinding()`。
3. `events.json`（schema 1.0）：`defaultEventProfiles()`。
4. `routing-graph.json`：`getRoutingGraph()`。
5. `robot-ble-protocol.json`：`getRobotProtocolDescriptor()`。
6. 复制可通行面三件套（image/wgs84 GeoJSON + 配准报告）。
7. `catalog.json`（schema 1.8）：端点、模式、路由引擎说明、加密航点策略与示例。
8. 遍历 29×29 地点对 × 2 模式，`findRoute()` 全量写入 `routes/{from}/{to}.{mode}.json`（1682 个文件）。

## 5. scripts/extract-walkable-surfaces.py — 水泥色平面提取

`uv run --script`，固定 `numpy==2.3.2`、`pillow==11.3.0`，Python ≥ 3.11。

```bash
npm run extract:walkable -- \
  --input /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--input` | 必填 | 渲染图路径（记录 SHA-256） |
| `--output-dir` | 必填 | 输出目录 |
| `--config` | 无 | `config/walkable-surfaces-render.json`：阈值覆盖、`excludeRegions`、`roofRegions`（归一化多边形） |
| `--max-width` | 1176 | 处理前最大宽度（LANCZOS 缩放） |
| `--vector-step` | 4 | 矢量化网格步长（像素） |
| `--min-area-pixels` | 140 | 最小连通面积 |

算法：低饱和（≤0.27）、低色差（≤0.24）、亮度 ≥0.22 的像素判为水泥候选 → 闭运算 + 开运算去缝隙噪声 → 排除区域 → （配置 `roofRegions` 时）分割地面/屋顶 → 网格连通分量 → 边界环追踪（最紧顺时针续接）→ 双段折线简化（容差 0.9 px）→ 归一化图像坐标多边形。

输出：`walkable-surface-mask.png`（及 ground/roof 分量）、`walkable-surfaces-preview.png`（绿=地面、品红=屋顶叠加）、`walkable-surfaces.image.geojson`（所有要素 `routingEnabled=false`、`verificationStatus=image-derived-unverified`、附 `reviewRequired` 清单）、`walkable-surfaces-summary.json`（像素比例、多边形计数、SHA-256）。

## 6. scripts/register-walkable-surfaces.py — 八栋楼 WGS84 配准

```bash
npm run register:walkable -- \
  --image /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces-registration
```

| 参数 | 说明 |
| --- | --- |
| `--image` | 必须与配置 `sourceImageSha256` 一致 |
| `--image-surfaces` | 提取步骤的 `walkable-surfaces.image.geojson` |
| `--osm` | `public/data/campus-osm.geojson`（控制楼目标质心来源） |
| `--config` | `config/eight-building-registration.json` |
| `--output-dir` | 输出目录 |

算法：

1. 配置必须含 **恰好 8 个唯一控制楼**（W1–W4、E1–E4，手工屋顶质心像素）；目标取 OSM 建筑多边形质心（缺少任一建筑即报错）。
2. 目标经纬度转局部米制平面（参考点为八质心均值），像素归一化后拟合 3×3 投影单应矩阵（最小二乘，秩 < 8 判退化）。
3. 指标：拟合残差（米）、反投影残差（像素）、逐点留一验证残差；按配置验收（`maxFitResidualMeters=15`、`maxLeaveOneOutResidualMeters=45`）。
4. 全部候选面经单应矩阵变换到 WGS84（坐标 7 位小数）。

输出：`walkable-surfaces.wgs84.geojson`（`registrationStatus=control-fit-accepted-review-pending` 或 `control-fit-rejected`，仍 `routingEnabled=false`）、`registration-report.json`（含单应矩阵、指标、逐楼控制点、局限性声明）、`eight-building-registration-preview.jpg`（轮廓 + 控制点叠加）。

**配准数值通过 ≠ 通行资格**：仅表示八栋楼控制点足以支持初始几何配准。

## 7. scripts/export-gis-layers.py — GIS 图层导出

```bash
npm run export:gis    # 等价 uv run --script scripts/export-gis-layers.py
```

读取权威数据源，输出到 `artifacts/gis/`：

| 图层 | 几何 | 来源 |
| --- | --- | --- |
| `indoor_paths` | LineString | `campus-indoor.geojson` 的室内网络 link |
| `outdoor_paths` | LineString | `campus-osm.geojson` 的 `featureClass=road` |
| `poi_points` | Point | 应用地点目录（`locations.json`）+ 室内 POI + 未被地点覆盖的 OSM 入口，去重合并 |
| `building_polygons` | Polygon | OSM 建筑轮廓 |
| `walkable_surfaces` | Polygon | 配准后的候选面（仅参考） |

产物：

- `geojson/<layer>.geojson`：每层独立 GeoJSON（CRS84），属性扁平化（数组转逗号串）以适配 GIS 属性表。
- `lubannav-campus.gpkg`：多图层 GeoPackage（经 `ogr2ogr`，EPSG:4326 + 空间索引；未安装 GDAL 时跳过并提示）。
- `lubannav-campus.qgs`：最小 QGIS 工程，含图层样式配色、捕捉设置（12 px 顶点捕捉）与校园范围画布。

## 8. scripts/render-osm-reference.mjs — OSM 参考图

把 `campus-osm.geojson` 渲染成简单 SVG（水面/道路/建筑 + 名称标注），默认写 `/tmp/lubannav-osm-reference.svg`，用于人工核对建筑与道路关系。用法：`node scripts/render-osm-reference.mjs [input] [output.svg]`。

## 9. 配置文件

### config/walkable-surfaces-render.json

| 字段 | 说明 |
| --- | --- |
| `thresholds` | `maxSaturation`/`maxChroma`/`minLuminance` 颜色阈值 |
| `excludeRegions` | 归一化图像坐标排除多边形 |
| `roofRegions` | 归一化屋顶区域（用于地面/屋顶分割；为空则输出未分类候选） |
| `reviewState` | 人工复核状态记录 |

### config/eight-building-registration.json

| 字段 | 说明 |
| --- | --- |
| `model` | `projective-homography` |
| `sourceImageSha256` | 必须与配准输入图像一致 |
| `controlPoints[]` | `{building, image:[x,y], evidence}`，8 个唯一楼 |
| `acceptance` | `maxFitResidualMeters`、`maxLeaveOneOutResidualMeters` |
| `reviewState` | 控制点复核状态 |

## 10. 数据集文件说明

### public/data/campus-osm.geojson

OSM 同源快照，`featureClass ∈ {building, entrance, road, water, waterway}`；道路含 `osmNodeIds`；顶层含署名、许可证、抓取时间、Overpass 端点。约 76 KB。

### public/data/campus-indoor.geojson

本地室内补丁（可独立审查），`featureClass` 取值与生成器消费方式：

| featureClass | 消费方 | 说明 |
| --- | --- | --- |
| `entrancePoi` | §3.3 | 大堂入口锚点（西翼用户确认；东翼由西翼相对位置映射） |
| `indoorPath` | §3.4 | 单建筑室内路径（当前仅图书馆 0 层约 51 m） |
| `indoorNetworkNode` | §3.5 | 大堂/平台/餐厅/楼层节点 |
| `indoorNetworkLink` | §3.5 | 同层通道与电梯垂直边 |
| `indoorVerticalConnector` | §3.5 | W2/E2 电梯（服务 1–5F，默认层 1） |

所有室内要素必须携带 `source`、`evidence`、`verificationStatus` 等溯源字段；未核验段默认仅步行。

### public/data/walkable-surfaces/

`walkable-surface-mask.png`、`walkable-surfaces-summary.json`、`walkable-surfaces.image.geojson`、`walkable-surfaces.wgs84.geojson`、`registration-report.json`——均为研究性复核产物，`routingEnabled=false`。详见 `public/data/README.md`。
