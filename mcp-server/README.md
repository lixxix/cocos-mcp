# cocos-mcp-server

自研的 Cocos Creator MCP Server。**独立进程、默认 Streamable HTTP 传输（兼容 stdio）、零第三方依赖**（MCP 协议手写实现，不引入任何现成 MCP 服务或 SDK）。

## 链路

```
MCP 客户端
   │  Streamable HTTP / JSON-RPC 2.0（http://127.0.0.1:3002/mcp）
   ▼
cocos-mcp-server (本目录, node index.js)
   │  HTTP  127.0.0.1:<随机端口>  + Bearer token
   ▼
扩展桥 (extensions/cocos-mcp/source/bridge.ts)
   │  Editor.Message
   ▼
scene / asset-db 进程
```

## 启动

方式一：**在 Creator 面板里启动（推荐）**。打开「扩展 → Cocos MCP 控制台」面板，
顶部的 MCP Server 卡片可以自定义端口、一键启动 / 停止，并实时显示运行状态。

方式二：命令行直接启动（mcp-server 随 cocos-mcp 扩展分发，位于扩展目录内）。

```powershell
node extensions\cocos-mcp\mcp-server\index.js
```

默认以 **Streamable HTTP** 模式运行，端点 `http://127.0.0.1:3002/mcp`。
启动日志会打印实际监听地址、桥接状态。

| 参数 | 说明 |
|---|---|
| `--port <端口>` | HTTP 监听端口（默认 3002） |
| `--host <地址>` | HTTP 监听地址（默认 127.0.0.1） |
| `--stdio` | 退回旧的 stdio 传输（兼容保留） |
| `--check` | 自检模式，见下 |

会话约定：客户端 `POST /mcp` 调 `initialize`，响应头里拿到 `Mcp-Session-Id`，
后续请求都必须带这个头；会话空闲 1 小时过期，过期后返回 404，重新 initialize 即可。
`DELETE /mcp`（带会话头）可主动结束会话；`GET /mcp` 返回 405（本服务没有服务端主动推送）。

## 前置条件

1. Cocos Creator（3.8.8+）打开已安装 cocos-mcp 扩展的项目，且**扩展已启用**。
2. 扩展主进程已启动本地 HTTP 桥，会写出端口文件：

   ```
   <项目>/temp/cocos-mcp/bridge.json
   ```

   内容示例：

   ```json
   {
     "port": 41234,
     "token": "a1b2c3…",
     "pid": 12345,
     "projectPath": "<项目绝对路径>",
     "build": "main-20261023-1725",
     "startedAt": 1792746346382
   }
   ```

   扩展主进程没重载就不会有桥。面板顶部会有提示，点「重载扩展」按钮即可。

## 自检

```powershell
node extensions\cocos-mcp\mcp-server\index.js --check
```

输出传输模式、桥状态、健康检查结果、完整工具列表。桥没起来时退出码为 1。

## 接入 MCP 客户端

先启动 server，然后在客户端配置里指向 HTTP 端点（以 ZCode / Claude Code 风格为例）：

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp"
    }
  }
}
```

需要鉴权时先设置环境变量 `COCOS_MCP_TOKEN=<随机串>` 再启动，客户端配置里带上：

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer <同一个随机串>"
      }
    }
  }
}
```

仍要 stdio 的客户端用旧方式（行为与 0.1.x 一致）：

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "command": "node",
      "args": ["<项目>/extensions/cocos-mcp/mcp-server/index.js", "--stdio"]
    }
  }
}
```

### curl 手动调试

```bash
# 1. initialize，从响应头拿 Mcp-Session-Id
curl -i -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. 后续请求带上 Mcp-Session-Id
curl -s -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <上一步拿到的会话 id>" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://127.0.0.1:3002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <会话 id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. 结束会话
curl -s -X DELETE http://127.0.0.1:3002/mcp -H "Mcp-Session-Id: <会话 id>"
```

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `COCOS_MCP_PROJECT` | 项目根目录 | 本文件的上三级目录（`<项目>/extensions/cocos-mcp/mcp-server`） |
| `COCOS_MCP_BRIDGE` | 桥端口文件路径 | `<项目>/temp/cocos-mcp/bridge.json` |
| `COCOS_MCP_TRANSPORT` | 传输方式：`http` / `stdio` | `http` |
| `COCOS_MCP_HOST` | HTTP 监听地址 | `127.0.0.1` |
| `COCOS_MCP_PORT` | HTTP 监听端口 | `3002` |
| `COCOS_MCP_PATH` | HTTP 端点路径 | `/mcp` |
| `COCOS_MCP_TOKEN` | 可选，静态 Bearer 鉴权 token | 空（不鉴权） |

## 工具

工具列表在运行时从扩展的操作目录动态拉取，**一个 op 一个 tool**，命名规则：`op 名` 中的 `.` 换成 `_`，驼峰转下划线并转小写（`node.addProperty` → `node_add_property`）：

| tool | 说明 | 参数 |
|---|---|---|
| `editor_info` | 编辑器 / 项目信息 | — |
| `scene_status` | 场景就绪 / 脏标记 / 选中节点 | — |
| `scene_tree` | 场景节点树（含 uuid、组件、坐标） | — |
| `node_create` | 创建节点；`builtin`/`prefab` 可一步实例化内置模板或任意预制体（完整子树 + 默认资源引用）。模板模式返回结构化 `nodes:[{name,uuid,parent,components}]`（父在前），`batch_run` 里用 `"$N.nodes[i].uuid"` 引用子节点，无需解析 `subtree` 文本 | `name?`, `parent?`, `builtin?`, `prefab?` |
| `node_delete` | 删除节点 | `uuid?` |
| `node_move` | 移动节点（编辑器消息通道，走 undo） | `uuid?`, `x?`, `y?`, `z?` |
| `node_move_engine` | 移动节点（场景脚本引擎通道） | `uuid?`, `x?`, `y?`, `z?` |
| `node_set_property` | 设置属性（消息通道，走 undo）：Label 文本 / 尺寸 / 颜色 / `@property` 引用绑定 | `uuid?`, `path`, `value?`, `type?`, `dump?` |
| `node_set_property_engine` | 设置属性（场景脚本引擎通道，引用绑定兜底） | `uuid?`, `component?`, `prop`, `value?` |
| `node_bind_property` | **绑定引用属性**（`@property` 组件/节点/资产引用，等价属性检查器拖拽，支持嵌套 prefab 内组件、批量多条逐条提交全部生效、自动回读验证） | `uuid?`, `component?`, `property`, `target?`, `type?`, `path?`, `bindings?` |
| `node_create_prefab` | 把场景节点（含子树）保存为 .prefab 资源，节点变为预制体实例（走 undo；父目录自动创建） | `node?`, `url?`, `overwrite?` |
| `prefab_open` | 打开预制体进入编辑模式（等价资源管理器双击）。注意：`scene/open-scene` 对 prefab uuid 无效；预制体模式下 `query-current-scene` 仍返回场景页签 uuid，本工具用 `query-node-tree` 根 uuid 变化确认切换。已处于预制体模式时直接报错（确认无未保存修改可传 `assumeClean=true`） | `url`, `saveCurrent?`, `assumeClean?`, `timeout?` |
| `scene_save` | 保存当前场景；预制体编辑模式下直接报错拒绝（该模式下保存是盲的且可能堵在保存对话框上） | — |
| `scene_open` | 打开场景，默认先保存再切换。预制体模式下直接报错；`assumeClean=true` 跳过检查（走 open-scene 直切；目标若是预制体背后的已加载场景会被忽略，先开别的未加载场景脱离再切回） | `url`, `saveCurrent?`, `assumeClean?`, `timeout?` |
| `scene_close` | 关闭当前场景文档，用于外部直改 .scene 后强制重开（场景文档切走后仍驻留内存，scene.open 对已加载文档只激活不重新解析）。脏场景直接拒绝（先 scene.save 或 `force=true`）；注意 3.8.8 实测 close-scene 对已打开文档可能返回 closed:false 关不掉，届时以「复制成新资产（新 uuid）再打开」替代 | `force?` |
| `asset_list` | 列出资源 | `pattern?`, `limit?` |
| `asset_delete` | 删除资源 | `uuid?`, `url?` |
| `asset_import` | 把磁盘文件/目录导入 assets 并等待 uuid 就绪（含子资源，如 spriteFrame）；`src` 省略 = 纯刷新模式（文件已写进 assets，只触发导入） | `src?`, `dbPath`, `waitTimeout?` |
| `scene_script_info` | 引擎信息（场景脚本通道） | — |
| `scene_script_demo` | 引擎 API 建节点 | `name?`, `x?`, `y?`, `z?` |
| `script_create` | 创建 TS 脚本并等它编译注册，返回 cid（用到的 cc 类型自动补 import） | `path?`, `className?`, `properties?`, `body?`, `overwrite?` |
| `script_list` | 列出已注册组件（含 cid / path / assetUuid） | — |
| `node_add_component` | 给节点挂组件 | `node?`, `component` |
| `node_remove_component` | 移除组件 | `component` |
| `node_list_components` | 列出节点上的组件（`node_set_property` 的 path 索引来源） | `node?` |
| `node_debug` | 节点原始 dump（摸字段名用） | `node` |
| `scene_capture` | 场景视口截图，base64 JPEG（需场景含 Canvas；可传 outPath 落盘） | `maxW?`, `outPath?` |
| `scene_reopen` | 保存并重开当前场景（外部写入的 .ts 编译后需这一步才能在引擎里挂载） | — |
| `scene_create` | 新建场景，等价资源管理器右键「新建 → 场景」（`asset-db/new-asset` + 内置模板；父目录自动创建；勿用 create-asset(null)——那会建出目录）；`open=true` 打开并轮询确认切换完成；预制体模式下 `open=true` 直接报错（`assumeClean=true` 跳过） | `url`, `template?`('2d'/'empty'), `open?`, `overwrite?`, `openTimeout?`, `assumeClean?` |
| `project_set_design_resolution` | 设置项目设计分辨率（等价项目设置面板；Profile 落盘 + 广播刷新画布，返回回读与落盘校验） | `width`, `height`, `fitWidth?`, `fitHeight?` |
| `node_create_component_msg` | 挂组件（`scene/create-component` 消息通道直通，支持脚本 cid） | `node`, `component` |
| `batch_run` | 批量顺序执行一组操作；参数支持 `"$0.uuid"`/`"$0.data.uuid"` 引用前项结果（可嵌套在对象/数组里）；不可嵌套。配合 `node_create` 的 `nodes` 结构与 `node_bind_property` 的 `bindings` 批量，可纯声明式完成「实例化模板→定位子节点→设属性→绑引用」整链 | `items`, `stopOnError?` |
| `mcp_status` | 查询 mcp-server 子进程运行状态（端口 / pid / 探活） | — |
| `mcp_restart` | 重启 mcp-server 子进程（改 mcp-server/index.js 后生效） | `port?` |
| `bridge_status` | 桥接诊断（内置） | — |
| `conventions` | Cocos Creator 3.8 开发规范查询（内置，不走桥）。写代码 / 搭层级 / 拆预制体前先读 | `section?`（按小节标题关键词过滤，如 `预制体`、`事件`、`交付`） |

`conventions` 的规范源是 [`conventions.md`](./conventions.md)（与本文件同目录），改它即改规范；扩展面板的「写入 AGENTS.md」按钮会把同一份源写入项目根 `AGENTS.md`，供 ZCode / Claude Code 等工具自动读取。

`node_create` 的 `parent` 取值：

| 值 | 行为 |
|---|---|
| 留空 | 建在**场景根**下（确定性，MCP 默认） |
| `@selection` | 建在编辑器当前选中节点下 |
| 具体 uuid | 建在该节点下 |

`node_create` 的模板模式（编辑器「创建」菜单同款机制：`create-node` + `assetUuid` 一步实例化，不是建空节点再挂组件）：

| 参数 | 行为 |
|---|---|
| `builtin` | 内置模板短名，对应 `db://internal/default_prefab/<短名>.prefab`；**常用模板都带子目录前缀**：UI 用 `ui/Button`、`ui/Label`、`ui/Sprite`、`ui/Canvas`、`ui/ScrollView`，3D 用 `3d/Cube`、`3d/Sphere`，灯光用 `light/Point Light`；裸短名 `Button`、`Label`、`Sprite` 不存在（会报「找不到 prefab 资产」，报错里会给出带前缀的正确写法）；全集用 `asset_list(pattern="db://internal/default_prefab/**/*.prefab")` 查 |
| `prefab` | 任意 prefab 资产（`db://` url 或 uuid，含项目自己的预制体），实例化进场景；与 `builtin` 二选一 |

模板模式返回值额外带 `template` / `templateUuid` / `nodeCount` / `subtree`（完整子树结构）；
`ui/*` 模板要求场景先有 Canvas（`canvasRequired`，Canvas 模板本身除外）；缺省节点名取模板名并按父节点去重（如 `Button-001`）。

`script_create` 与 `node_add_component` 的配合流程：

1. `script_create({ path: 'db://assets/scripts/Player.ts' })` → 返回 `cid`
2. `node_add_component({ node: '<节点uuid>', component: '<cid>' })` → 挂载成功

`script_create` 内部会**轮询等待脚本被 Creator 编译并注册为 ccclass**（默认 30 秒），
拿不到 cid 时会明确报错而不是静默返回。

`node_set_property` 的 path 写法（组件索引用 `node_list_components` 查）：

| path | 效果 |
|---|---|
| `position` | 节点坐标（value 传 `{x,y,z}`，自动补 `cc.Vec3`） |
| `components.0.string` | 第 0 个组件的文本（Label） |
| `components.0.contentSize` | 尺寸（value 传 `{width,height}`，自动补 `cc.Size`） |
| `components.0.color` | 颜色（value 传 `{r,g,b,a}`，自动补 `cc.Color`） |
| `components.3.tipLabel` | 自定义脚本属性（普通值）。**引用绑定一律改用 `node_bind_property`**，不要再手工拼 dump |

参数留空时，`node_*` 系列会回退到层级管理器当前选中的节点。

### 引用绑定：`node_bind_property`

给组件的引用类型属性（`@property(Label/Sprite/自定义脚本/Node/SpriteFrame…)`）做绑定，
等价于在属性检查器里拖拽，走 `scene/set-property` 消息通道（进 undo、可保存进 prefab/scene），
嵌套 prefab 实例内部的组件也能定位（自动生成 `targetOverrides` 序列化落盘）。

`target` 四种写法：

| target | 含义 |
|---|---|
| `{"node":"Pannel/badge","component":"ItemBadge"}` | 组件引用（推荐）：node 收 uuid 或路径，component 收类名/索引/cid，自动解析目标 uuid 与 dump 类型 |
| `{"node":"Canvas/Bg"}` | 节点引用（`cc.Node`） |
| `{"asset":"db://assets/x.png/spriteFrame"}` | 资产引用（自动查 asset-db 拿 uuid 与类型） |
| `null` | 解绑 |

- 属性所在节点：`uuid` 传 uuid 或路径（留空 = 当前选中节点）；组件：`component` 传索引/类名/cid。
- 批量：`bindings: [{uuid, component, property, target}, …]`，一次提交一条 undo。
- 绑定后自动回读场景实际引用验证，不一致直接报错（回读能力需要扩展重载后生效，旧场景进程会降级为 `unavailable`）。

```json
node_bind_property({
  "uuid": "<MarketCard 节点uuid>",
  "component": "MarketCardView",
  "property": "badge",
  "target": { "node": "Pannel/badge", "component": "ItemBadge" }
})
```


## 安全

- MCP HTTP 端点与扩展桥都只监听 `127.0.0.1`，不对外暴露；
- 需要鉴权时设置 `COCOS_MCP_TOKEN`，所有 MCP 请求必须带 `Authorization: Bearer <token>`，缺失返回 401；
- 扩展桥每次启动生成随机 token，所有 `/op`、`/ops` 请求必须带 `Authorization: Bearer <token>`，缺失返回 401；
- 请求与响应全部是纯 JSON（跨进程 IPC 限制）。

## 开发

```powershell
# 改完扩展代码后重新编译
cd extensions\cocos-mcp; npm run build
```
