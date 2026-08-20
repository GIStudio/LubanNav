# 前端模块接口参考

本文列出 `src/` 下每个模块的职责与对外接口（导出函数、类、常量、组件 props 与事件）。所有 `src/lib` 模块均为纯逻辑模块（配合同名 `*.test.js` 单元测试使用）；少数 React hooks 也放在 `src/lib/`，它们只是纯函数之上的薄胶水（见 §9.6、§7.5）。

## 1. 数据模块

### src/data/campus.js — 地点目录与模式（稳定合约）

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `DATASET` | object | 数据集元信息：`id=hkustgz-layered-routing-v4`、版本、坐标系、OSM 来源 / 署名 / 许可证、免责声明 |
| `CAMPUS_BOUNDS` | `[[lat,lon],[lat,lon]]` | 校园边界（南纬/西 → 北纬/东），用于地图限制与旧版 x/y 坐标换算 |
| `NODES` | array | 29 个公开地点节点：`id`、`name`、`en`、旧版 `x/y`、`category`、`aliases[]`、`public`、`longitude/latitude`，部分含 `poiType`、`level`、`servedLevels` |
| `PUBLIC_LOCATIONS` | array | `NODES.filter(n => n.public)` |
| `NODE_BY_ID` | object | `id → node` 索引 |
| `LOCATION_OSM_FEATURES` | object | `地点 ID → OSM 建筑 way/relation ID 列表`，入口吸附的建筑匹配依据 |
| `MODES` | object | `pedestrian`（1.25 m/s）与 `robot`（0.8 m/s，`accessibleOnly=true`） |

### src/data/events.js — 内置活动

`EVENT_SCHEMA_VERSION='1.0'`、`DEFAULT_EVENT_ID='august-device-demo-2026'`、`DEFAULT_EVENTS`（八月真机展示活动：三楼主会场，其余场所待配置）。

### src/data/osm-routing.json — 生成的寻路图（构建产物，Git 忽略）

`schemaVersion: "2.0"`，由 `scripts/generate-osm-routing.mjs` 写入：`graph.{nodes,edges,routableNodeIds}`、`locations`（绑定）、`stats`、`source`/`indoorSource`、`allowedHighways`、`indoorHighways`。只被 `src/lib/pathfinding.js` 直接消费。

## 2. 路由内核 src/lib/pathfinding.js

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `findRoute` | `(from, to, modeId='pedestrian') → RouteResponse` | 统一路由入口。校验公开地点与模式后在合并图上跑 A\*（Haversine 启发，边权 = `distanceMeters + routingPenaltyMeters`）。起终点相同时返回零距离响应；不连通返回 `status:'no_route'`。响应结构见 [static-api.md §5](static-api.md) |
| `getLocationBinding` | `(locationId) → object \| null` | 地点绑定（入口、目的地、道路节点、分模式 `routingByMode`），供地图标记与 `locations.json` 使用 |
| `getRoutingGraph` | `() → object` | 完整寻路图（`routing-graph.json` 的内容） |
| `formatDuration` | `(seconds) → string` | `<60s → "N 秒"`，否则向上取整为 `"N 分钟"` |

内部要点：

- 邻接表按模式预构建（`ADJACENCY_BY_MODE`），边过滤 `edge.modes`。
- 目的地选择：地点的 `indoorRoute.modes` 包含当前模式时用 `destination`（室内终点），否则用 `entrance`。
- 连接段：当模式路由节点就是道路节点时，`snapDistanceMeters` 作为 `location-connector` 段计入；室内网络节点绑定的地点连接段距离为 0。
- `instructions` 由路段构成推导（OSM 道路、进楼、电梯楼层、室内通道、室外平台），中文输出。

## 3. 本地解析 src/lib/destinationParser.js

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `matchLocation` | `(fragment) → location \| null` | 三级模糊匹配：归一化精确 → 双向包含（取最长名）→ Levenshtein 比率 ≤ 0.34。归一化会去空白/标点并剥离「号楼/大楼/大厦」 |
| `parseNavigationQuery` | `(query, currentOrigin='main-entrance') → ParsedIntent` | 识别 `从X到Y` / `from X to Y` / `带我去X` 等句式；`机器人/robot/轮椅/无障碍` 关键词切换 `mode=robot`。返回 `{intent:'navigate'|'greeting'|'unknown', from, to, mode, understood}` |

## 4. 活动模式 src/lib/eventMode.js

存储键：`lubannav.event-profiles.v1`（localStorage）。

| 导出 | 说明 |
| --- | --- |
| `createEventPlace(id, name)` / `createBlankEvent(id)` | 构造空场所 / 空活动 |
| `normalizeEventConfig(input, fallbackId)` | 清洗与校验活动配置（字段截断、`locationId` 必须是公开地点），非法返回 `null` |
| `defaultEventProfiles()` | 内置活动的规范化副本 |
| `loadEventProfiles(storage)` / `saveEventProfiles(events, storage)` | localStorage 读写；本地配置按 ID 覆盖默认活动 |
| `upsertEventProfile(events, input)` / `restoreDefaultEvent(events, eventId)` | 插入/更新；恢复默认 |
| `eventPlaces(event)` | 展平为 `[{role, roleLabel, place}]`（主会场/签到/分会场/住宿/食堂） |
| `resolveEventNavigationQuery(query, event, currentOrigin, currentMode)` | 活动语境导航解析：场所名匹配优先于角色关键词（主会场/签到/分会场/住宿/吃饭）。返回 `{detected, understood, ...}`；多匹配 → `error:'ambiguous_event_place'`，未绑定 → `error:'event_place_unbound'` |
| `eventAssistantContext(event)` | 生成注入语音助手的当前活动上下文文本（含「未绑定不得猜测」约束） |

## 5. 语音导航工具 src/lib/voiceNavigation.js

| 导出 | 说明 |
| --- | --- |
| `NAVIGATION_TOOL_NAME` | `'set_navigation_route'` |
| `NAVIGATION_TOOL` | OpenAI 兼容 function 定义：`from`/`to` 为地点 ID 枚举，`mode` 枚举，`required:['to']`（冻结对象，直接用于 `session.update.tools`） |
| `campusLocationCatalog()` | `id=名称；…` 形式的地点清单文本，注入助手 instructions |
| `resolveNavigationCommand(input, currentOrigin, currentMode)` | 白名单解析工具参数：精确 ID 优先，否则走 `matchLocation`；起点缺省沿用当前起点。返回 `{intent:'navigate', understood, from, to, mode, error}`，`error ∈ {unknown_origin, unknown_destination, null}` |

## 6. 助手知识库 src/lib/assistantKnowledge.js

| 导出 | 说明 |
| --- | --- |
| `CACHED_REPLIES` | 本地缓存回答文本表：`greeting/thanks/goodbye/capabilities/school/hubs/location/weather/carry` |
| `getCachedAssistantReply(query)` | 归一化后按精确组匹配，再用正则兜底天气 / 随身物品类问题；命中返回 `{key, text, source:'local-cache'}`，否则 `null` |
| `formatCampusDateTime(now)` / `formatCampusTime(now)` | `Asia/Shanghai`（固定 UTC+8）的日期时间格式化：`2026年8月18日 星期二 16:50` / `16:50` |
| `buildLiveContext({now, startedAt, routeContext, robotPosition})` | 自动刷新的实时语音上下文：当前时间 + 导航进度。有 `robotPosition` 时用 BLE 遥测沿路线算真实进度（`routeContext.path`）；否则按 `startedAt`（路线开始时间）与 `durationSeconds` 做匀速估算；接近目的地时附加"可主动提醒带好随身物品" |
| `buildCampusAssistantInstructions(routeContext, event, weather, liveContext)` | 拼装实时语音会话的 system instructions：身份与语气、稳定事实、能力与天气边界（Open-Meteo 开源数据，广州南沙区·校园中心）、**会话开场先问去向、路线确定后带伞提醒**、**机器人模式出发放包提醒**、**到达目的地随身物品提醒**、`liveContext` 实时导航上下文（网页自动刷新，估算/遥测进度）、3 楼露天平台提醒（按目的地）、导航工具强制调用规则、当前路线上下文、地点清单、活动上下文 |

几何辅助（供 `buildLiveContext` 计算沿路线进度）：`src/lib/geo.js` 新增 `polylineLengthMeters(polyline)` 与 `distanceAlongPolylineMeters(point, polyline)`（投影点到折线起点的累计距离）。

## 6.1 天气 src/lib/weather.js

| 导出 | 说明 |
| --- | --- |
| `CAMPUS_WEATHER_REGION` | `'广州南沙区'` —— 天气区域的展示名 |
| `CAMPUS_WEATHER_COORDINATES` | `{latitude: 22.89025, longitude: 113.479}` —— 港科广校园中心（广州南沙区） |
| `WEATHER_CACHE_TTL_MS` | 10 分钟 TTL 缓存 |
| `OPEN_METEO_ENDPOINT` | `https://api.open-meteo.com/v1/forecast`（开源免密钥、带 CORS） |
| `RAIN_WEATHER_CODES` / `weatherConditionLabel(code, isDay)` | WMO 天气码分类 / 中文标签 |
| `buildWeatherUrl(coordinates)` | 拼 Open-Meteo URL：`current` 温度/湿度/体感/降水/天气码 + `daily` 降水概率/紫外线，`timezone=Asia/Shanghai`，无任何 key |
| `normalizeWeatherPayload(payload)` | 归一化响应 → `{available, source:'open-meteo', temperatureC, conditionLabel, precipitationProbabilityMax, uvIndexMax, umbrella, sunscreen, rainingNow, rainExpected, thunderstorm, cold, ...}` |
| `buildWeatherAdvisory(weather)` | 生成口语化天气建议（含 3 楼露天平台的带伞 / 防滑 / 防晒 / 雷暴提醒） |
| `fetchWeather({coordinates, fetchImpl, timeoutMs, cache})` | 4 s 超时 + TTL 缓存拉取；任何失败返回 `{available:false, source:'unavailable', error}`（助手不得编造天气） |

## 7. Qwen 实时会话 src/lib/qwenRealtime.js

| 导出 | 说明 |
| --- | --- |
| `DEFAULT_VOICE_CONFIG` | `{gatewayEndpoint, model:'qwen3.5-omni-flash-realtime', voice:'Tina', maxSessionMs:180000}`；网关地址优先级 `VITE_VOICE_GATEWAY_URL` → `VITE_VOICE_TOKEN_URL` → 内置函数计算地址 |
| `VoiceSessionError` | 带 `code` 的错误类：`access-code`、`offer-sdp`、`gateway-network`、`gateway-rejected`（含 HTTP `status`）、`gateway-payload`、`unsupported-browser`、`microphone-denied/missing`、`webrtc-disconnected`、`model-error` 等 |
| `requestWebRtcAnswer({endpoint, accessCode, offerSdp, fetchImpl})` | 与网关交换 SDP，返回 Answer SDP 字符串；校验访问码非空与 `v=0` 开头 |
| `buildSessionUpdate({instructions, voice})` | `session.update` 事件：PCM 16k 输入 / 24k 输出、`qwen3-asr-flash-realtime` 转写、`semantic_vad`(0.5 / 800ms)、`max_tokens:512`、`temperature:0.6`、`enable_search:false`、`tools:[NAVIGATION_TOOL]` |
| `buildFunctionCallOutput(callId, output)` | `conversation.item.create`（`function_call_output`）事件 |
| `buildResponseCreate()` | `response.create` 事件（工具结果回传后触发模型继续） |
| `waitForIceGatheringComplete(pc, timeoutMs=8000)` | ICE 收集完成或超时 |
| `QwenRealtimeSession` | 会话类（继承 `EventTarget`），见下 |

`QwenRealtimeSession` 构造参数：`{accessCode, instructions, audioElement, gatewayEndpoint, fetchImpl, mediaDevices, PeerConnection, maxSessionMs, functionHandlers}`。

- 方法：`start()`（麦克风 → PeerConnection → DataChannel `oai-events` → Offer/Answer → 3 分钟计时）、`stop(reason)`、`updateInstructions(text)`、`setMicrophoneEnabled(bool)`、`send(payload)`。
- 事件（`addEventListener`）：`status`（`detail.{status,message}`）、`user-transcript-delta` / `user-transcript`、`assistant-transcript-delta` / `assistant-transcript`、`function-call`、`error`。
- `status` 取值：`requesting-microphone`、`connecting`、`authorizing`、`listening`、`user-speaking`、`thinking`、`assistant-speaking`、`audio-blocked`、`time-limit`、`ended`、`error`。
- 安全机制：`event_id` 去重（`seenEventIds`）、`call_id` 去重（`completedFunctionCalls`）；未注册工具返回 `unsupported_tool`；工具执行异常返回 `tool_execution_failed`。
- WebRTC `connectionState` 变为 `failed/disconnected` 时自动 `fail()` 并清理。

## 7.5 共享语音会话 src/lib/voiceSession.js

两个语音 UI（菜单内的 `VoiceAssistant` 面板与地图上的 `VoiceQuickControl` 麦克风坞）共享的实时会话 store。会话生命周期、`status`、转写、`accessCode`、`supported` 收归一处，App 不再用 `ref` + 状态回调在两个组件之间传话。

| 导出 | 说明 |
| --- | --- |
| `voiceSession` | 模块级 store：`{subscribe, snapshot, setAccessCode, attachAudio, setHandlers, updateInstructions, start, stop}`。`start()` 用当前 `accessCode` + `attachAudio` 注册的音频元素 + `setHandlers` 注册的回调（`onUserTranscript` / `onAssistantTranscript` / `onNavigationCommand`）创建 `QwenRealtimeSession` |
| `useVoiceSession()` | `useSyncExternalStore` 封装，返回 `{status, statusMessage, liveTranscript, accessCode, supported, active, configured, start, stop, setAccessCode}` |

要点：`updateInstructions` 在会话已启动时走 `session.updateInstructions`；`start` 在非活跃状态、不支持或未填访问码时是安全的 no-op。访问码持久化到 localStorage（键 `luban-nav:voice-access-code`）：`setAccessCode` 保存、清空输入移除、模块初始化时自动读回；localStorage 不可用时优雅降级为仅内存。配套 `voiceSession.test.js`。

## 8. 机器人协议 src/lib/robotProtocol.js

协议常量：`ROBOT_PROTOCOL_NAME='luban-nav-ble'`、`ROBOT_PROTOCOL_VERSION=1`。

| 导出 | 说明 |
| --- | --- |
| `DEFAULT_BLE_CONFIG` | 设备名前缀 `car7`、NUS 三 UUID、`chunkBytes:185`、`interChunkDelayMs:5`、`directionSpeedMetersPerSecond:2.0`（= ROS 上限 4.0 m/s 的一半） |
| `normalizeBleConfig(input)` | 合并默认值并校验：UUID 必须为完整格式，`chunkBytes ∈ [1,512]`，`interChunkDelayMs ∈ [0,1000]` |
| `bluetoothRequestOptions(config)` | `requestDevice` 参数：有前缀时用 `filters:[{namePrefix}]`，空前缀 `acceptAllDevices`；`optionalServices=[serviceUuid]` |
| `encodeRobotMessage(message)` | JSON + `\n` → UTF-8 字节 |
| `splitBleChunks(bytes, chunkBytes)` | 按字节切分（多字节字符可能跨包，固件端必须先拼包再解码） |
| `createTaskId(now, random)` | `task-<base36 时间>-<base36 随机>` |
| `createNavigationTask(route, options)` | 由 `status='ok'` 且 `mode='robot'` 的路线构造任务；航点含 `sequence/nodeId/longitude/latitude/kind/indoor/level`（坐标保留 7 位小数） |
| `createEmergencyStop(options)` | `emergency_stop` 消息，默认 `reason:'operator_request'` |
| `normalizeRobotMessage(message)` | 遥测校验：协议名 / 版本 / 类型；`position` 校验经纬度有限且范围合法，补 `receivedAt` |
| `RobotMessageDecoder` | Notify 流式解码器：`push(value)` 返回完整消息数组，缓冲上限 64 KB（超限重置并抛错）；`reset()` |
| `getRobotProtocolDescriptor()` | 机器可读协议描述（`robot-ble-protocol.json` 内容） |

## 9. BLE 客户端 src/lib/webBluetoothRobot.js

| 导出 | 说明 |
| --- | --- |
| `webBluetoothSupport(environment)` | `{supported, secureContext, apiAvailable, reason}`：HTTPS + `navigator.bluetooth.requestDevice` |
| `RobotConnectionError` | 带 `stage`、`causeName`、`context`（含 UUID / 设备名）的连接错误 |
| `WebBluetoothRobotClient` | GATT 客户端状态机，见下 |

客户端构造：`{bluetooth, config, sleep}`。状态：`idle → selecting → connecting → discovering(stage) → connected`，以及 `disconnected` / `error`；诊断阶段依次为 `device-selection`、`gatt-connect`、`primary-service`、`command-characteristic`、`telemetry-characteristic`、`notifications`。

- `connect()`：必须在用户手势调用链内直接执行（保留 user activation）；失败时按阶段包装为 `RobotConnectionError` 并释放 GATT 引用；用户取消选择器（`NotFoundError`）不算错误。
- `disconnect()`：取消传输、断开 GATT、状态 `disconnected`。
- `sendNavigationTask(route)`：同一时刻只允许一个路线传输（重复调用 reject）；记录 `lastTaskId`。
- `sendEmergencyStop()`：标记进行中和排队中的路线传输为已取消，队首插入 `emergency_stop`，并在字节流前补一个 LF（`prefixDelimiter`）让固件丢弃半行。
- 传输队列：顺序写入，优先 `writeValueWithoutResponse`（无逐包 ACK，速度快），其次 `writeValueWithResponse`，最后 `writeValue`；每包间隔 `interChunkDelayMs`；断连时队列整体 reject（`AbortError`）。
- 事件（`subscribe(listener)`）：`{type:'state'|'message'|'position'|'transfer-progress'|'sent'|'transfer-error'|'telemetry-error', ...}`；`transfer-progress` 含 `sentChunks/totalChunks`。
- `setConfig(config)`：连接中禁止修改。

## 9.5 地图图层构造 src/lib/mapLayers.js

纯 Leaflet 图层构造（不碰 React），从 `CampusMap.jsx` 移出：

| 导出 | 说明 |
| --- | --- |
| `addOsmLayers(map, data)` | 把 OSM GeoJSON 按要素类分层渲染（水、水系、道路底/面、建筑），tooltip 用要素自带名称 |
| `addIndoorLayers(map, data, t=translate)` | 室内路径/网络链接与垂直连接器图层；tooltip 绑定为**函数**（Leaflet 每次打开 tooltip 时重新求值），`t` 默认是 `i18n.js` 的 `translate`——在打开时读取当前语言，因此室内 tooltip 会随 zh/en 切换，无需重建图层 |

## 9.6 应用外壳 hooks（src/lib/useEventProfiles.js / src/lib/useRouteQueryState.js）

`App.jsx` 编排中枢瘦身后的两块胶水，纯逻辑仍全部在 `eventMode.js` / `pathfinding.js`：

| 导出 | 说明 |
| --- | --- |
| `useEventProfiles(params)` | `events` / `activeEventId`（`event` URL 参数初始化，含 `none`）/ `activeEvent`；`saveEvent(input)`（normalize → upsert → 持久化 → 激活）、`restoreDefault(eventId)`；`activeEventId` 同步回 URL |
| `useRouteQueryState(params)` | `from` / `to` / `mode`（URL 参数初始化）+ 双向 URL 同步；`applyNavigation(parsed)` —— 统一的"解析意图 → `findRoute` → 提交为当前路线"入口（文字对话、语音转写、语音工具三个入口共用），`status !== 'ok'` 时不提交状态 |

## 10. 组件

### App.jsx

应用外壳与全局状态：路线状态与 URL 同步（`useRouteQueryState`）、活动档案 CRUD（`useEventProfiles`）、对话消息、机器人位置、系统菜单开关。负责 `handleQuery`（活动解析 → 通用解析 → 缓存回答）、语音工具回调 `handleVoiceNavigationCommand`（解析 → `applyNavigation` 寻路验证 → 更新状态并返回工具结果）；语音会话本身已移入共享 store（§7.5），App 不再桥接 ref/状态。挂载时读取 `?accessCode=` 链接参数并 `voiceSession.setAccessCode(...)` 预填/覆盖保存演示访问码，随即从 URL 删除该参数（凭据不留在地址栏、历史或复制分享链接）。

### components/CampusMap.jsx

| prop | 说明 |
| --- | --- |
| `route` | 当前路线响应（绘制路线、室内高亮、`fitBounds`） |
| `destination` | 当前目的地 ID（高亮标记） |
| `robotPosition` | BLE 位置消息（橙色标记 + 航向 tooltip） |
| `onSelectDestination(id)` | 点击地点标记回调 |

内部：初始化 Leaflet 地图（自定义 pane、边界、缩放范围 16–21）、加载两份 GeoJSON 并交给 `src/lib/mapLayers.js`（§9.5）分层渲染、分类过滤按钮、`ResizeObserver` 自适应、加载/失败状态提示。

### components/ChatAssistant.jsx

`props: {messages, onSend}`。本地对话列表、三个示例问题按钮（`带我去图书馆`、`学校简介`、`今天要带伞吗`）、输入框与发送。

### components/EventPanel.jsx

`props: {events, activeEventId, onSelectEvent, onSaveEvent, onRestoreDefault, onNavigate}`。活动下拉、配置表单（主会场/签到/分会场/住宿/食堂的场所编辑、地点绑定选择器）、场所「导航」按钮、恢复默认。

### components/VoiceAssistant.jsx

`props: {route, event, routeStartedAt, robotPosition, onUserTranscript, onAssistantTranscript, onNavigationCommand}`。访问码输入与会话开始/结束界面。会话本身在共享 store（§7.5）：本组件只把 `<audio>` 元素、转写/导航回调与 instructions 流注册进 store，按钮直接调 `useVoiceSession()` 的 `start/stop`；instructions 随路线、活动、天气变化自动 `updateInstructions`，并每 30 秒重建一次包含当前时间与导航进度（`routeStartedAt` + `robotPosition`）的实时上下文（§6 `buildLiveContext`）。

### components/VoiceQuickControl.jsx

`props: {onConfigure}`。地图下方常驻麦克风，直接读共享会话 store（§7.5）：未配置/不支持 → 打开设置（`onConfigure`）；已配置 → 一键开始/结束；会话中显示转写与状态文案。不再接收 `state` / `onToggle`。

### components/SystemMenu.jsx

`props: {open, onClose, activePanel, onSelectPanel, route, event, onVoiceUserTranscript, onVoiceAssistantTranscript, onVoiceNavigationCommand, onRobotPosition, robotPosition, routeStartedAt}`。右上角模态对话框，两个 tab（实时语音 / 机器人联络），Esc 或点击遮罩关闭，焦点管理。语音面板只传回调（`robotPosition` / `routeStartedAt` 供实时上下文用），不再透传 `voiceControlRef` / `onVoiceControlStateChange`。

### components/RobotControl.jsx

`props: {route, onRobotPosition}`。BLE 配置表单（localStorage 键 `luban-nav:ble-config:v2`）、连接/断开、下发路线、STOP、传输进度条、最新位置、最近 5 条通信记录；按连接阶段输出友好中文错误（见 §9 阶段）。手动方向盘已拆为 `RobotDirectionPad`。

### components/RobotDirectionPad.jsx

`props: {connected, configLocked, client, config, onUpdateConfig}`。手动方向控制（前/左/停/右/后，按住 450ms 连续）与速度滑块；步长/速度来自 `config`，滑块写回走 `onUpdateConfig`，`configLocked` 时滑块禁用。自包含组件，仅依赖 BLE client 发 `sendDirection`。

## 11. 样式与入口

- `src/main.jsx`：挂载 `<App/>` 到 `#app`。
- `src/styles.css`：全部样式（深色工程风主题），无 CSS 框架。
- `index.html`：Vite 壳，`lang=zh-CN`，PWA manifest 引用，noscript 提示。
