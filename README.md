# cocos-mcp

[English](./README.en.md) | 简体中文

Cocos Creator 3.8 编辑器扩展：把编辑器变成一个 MCP（Model Context Protocol）服务，让 ZCode / Claude Code 等 AI 编码助手直接创建节点、挂组件、绑定 `@property` 引用、保存预制体、导入资源、截场景图——**像人一样在编辑器里干活，而不是只生成代码文本**。

MCP 协议为手写实现（JSON-RPC 2.0），零第三方 SDK 依赖；默认 Streamable HTTP 传输，兼容 stdio。

## 特性

- **35 个 MCP 工具**（33 op + 2 内置）：场景树查询、场景新建 / 打开预制体、节点增删移动、组件挂载、引用绑定（等价属性检查器拖拽，支持嵌套 prefab 与批量）、预制体保存、TS 脚本创建（等编译拿 cid）、资源导入 / 删除、场景截图、项目设计分辨率、批量执行（参数可引用前项结果）；
- **消息通道优先**：操作走 `Editor.Message`，进编辑器 undo / dirty 体系，可正常保存进 scene / prefab；
- **进程托管**：面板一键启动 / 停止 MCP Server 子进程，扩展重载时自动回收；
- **AI 协作规范注入**：一键把设计规范写入项目根 `AGENTS.md`（锚点幂等合并，不碰用户内容），AI 助手会话自动读取；MCP 侧同步提供 `conventions` 工具；
- **安全默认**：MCP 端点与内部桥只监听 `127.0.0.1`，桥使用随机端口 + 随机 Bearer token，可选 `COCOS_MCP_TOKEN` 静态鉴权。

## 环境要求

- Cocos Creator **3.8.8+**
- Node.js **>= 16**（运行 mcp-server 子进程、安装面板依赖）

## 安装

```bash
# 1. 放进你的 Creator 项目（git clone 或下载 zip 解压均可）
git clone https://github.com/<你的用户名>/cocos-mcp.git <你的项目>/extensions/cocos-mcp

# 2. 安装面板运行依赖（仅 fs-extra）
cd <你的项目>/extensions/cocos-mcp
npm install --production
```

编译产物 `dist/` 已随仓库提交，**无需 npm run build**。用 Cocos Creator 打开项目，在「开发者 → 扩展管理器」里启用 cocos-mcp 即可。（跳过第 2 步时扩展主进程仍可工作，但面板会因缺 fs-extra 加载失败。）

## 扩展自更新

面板「版本与更新」区块支持检查新版本并一键更新。更新源配置在扩展 `package.json` 的 `update` 字段：

```json
"update": {
    "repo": "owner/cocos-mcp",        // GitHub 仓库（owner/repo），空 = 未配置更新
    "branch": "main",                 // 更新来源分支
    "subdir": "extensions/cocos-mcp"  // 仓库内扩展所在子目录；仓库根就是扩展时留 ""
}
```

工作方式：

- **检查更新**：对比本地版本与 `raw.githubusercontent.com` 上该分支 `package.json` 的版本，结果缓存 1 小时（打开面板自动检查，也可点按钮强制刷新）；
- **一键更新**：下载分支 zip → System32 bsdtar / PowerShell 解压 → 校验版本不低于当前 → 覆盖扩展目录（旧目录改名为同级的 `.cocos-mcp.bak-<时间戳>`，目录被占用时退化为原地覆盖）→ 自动重载扩展；
- 更新前会自动停掉 MCP Server，更新完成后需在面板重新点「启动 MCP」。

发布新版本：改代码 → bump `package.json` 的 `version` → `npm run pack:zip`（脚本先重新编译，再生成 `release/cocos-mcp-v<版本>.zip`，内含单个 `cocos-mcp/` 目录、编译产物与生产依赖闭包，解压到 `<项目>/extensions/` 即装好）→ push 到 `update` 配置的分支。**分支推送驱动已有用户的自动更新**；zip 可作为 GitHub Release 附件，供新用户首次手动安装。

## 快速开始

### 1. 启动服务

菜单「扩展 → Cocos MCP 控制台」打开面板，端口默认 `3002`，点「启动 MCP」。状态每 2.5 秒自动刷新；子进程由扩展托管，面板关闭不影响运行。

### 2. 接入 MCP 客户端

ZCode / Claude Code 风格配置：

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

### 3. 可选：开启鉴权

先设置环境变量 `COCOS_MCP_TOKEN=<随机串>` 再启动，客户端配置加：

```json
"headers": { "Authorization": "Bearer <同一个随机串>" }
```

### 面板功能

- **MCP Server 卡片**：启动 / 停止 / 自定义端口，显示端点地址与 pid；编辑器重启后遗留的实例会被识别为「外部实例」；
- **「写入 AGENTS.md」**：把规范源 `mcp-server/conventions.md` 幂等写入当前项目根 `AGENTS.md`；
- **「版本与更新」**：显示当前 / 最新版本，发现新版本时高亮，一键更新后自动重载扩展（见「扩展自更新」）；
- **「重载扩展」**：改完扩展代码后一键重载，等价于扩展管理器停用再启用。

## 工具一览（33 op + 2 内置 = 35）

| 分组 | 工具 |
|---|---|
| 场景 | `scene_status` `scene_tree` `scene_create` `scene_save` `scene_reopen` `scene_capture` |
| 预制体 | `node_create_prefab` `prefab_open` |
| 项目 | `project_set_design_resolution`（设计分辨率，等价项目设置面板） |
| 节点 | `node_create` `node_delete` `node_move`(`_engine`) `node_set_property`(`_engine`) `node_bind_property` `node_create_prefab` `node_debug` |
| 组件 / 脚本 | `node_add_component` `node_remove_component` `node_list_components` `node_create_component_msg` `script_create` `script_list` `scene_script_info` `scene_script_demo` |
| 资源 | `asset_list` `asset_delete` `asset_import` |
| 批量 / 进程 | `batch_run`（参数支持 `"$0.uuid"` 引用前项结果） `mcp_status` `mcp_restart` `editor_info` |
| 内置 | `bridge_status`（桥接诊断） `conventions`（开发规范查询） |

完整参数说明与 `node_set_property` 的 path 写法见 [mcp-server/README.md](./mcp-server/README.md)。

## 架构

```
MCP 客户端（ZCode / Claude Code …）
   │  Streamable HTTP · JSON-RPC 2.0 · http://127.0.0.1:3002/mcp
   ▼
mcp-server（独立 Node 进程，位于 mcp-server/）
   │  HTTP 127.0.0.1:<随机端口> + Bearer token（端口文件 <项目>/temp/cocos-mcp/bridge.json）
   ▼
扩展桥 bridge.ts（编辑器主进程内）
   │  Editor.Message（进 undo 体系）
   ▼
scene / asset-db（Cocos Creator）
```

| 模块 | 职责 |
|---|---|
| `source/operations.ts` | 操作目录：全部能力的定义（名称 / Schema / 执行），一个 op 对应一个 MCP tool |
| `source/bridge.ts` | 本地 HTTP 桥：随机端口 + 随机 token，把工具调用转成 operations 执行 |
| `source/mcp-process.ts` | mcp-server 子进程的启动 / 停止 / 状态 / 探活 |
| `source/agents-md.ts` | 把 conventions.md 规范幂等写入项目根 AGENTS.md |
| `source/main.ts` | 扩展主进程，消息入口 |
| `source/scene.ts` | 场景脚本（引擎通道：引擎 API、截图） |
| `source/panels/default/` | 控制台面板 |
| `mcp-server/index.js` | MCP Server：协议实现 + 工具路由，不依赖扩展也能起进程（无桥时仅内置工具可用） |

## 安全

- MCP HTTP 端点与扩展桥都只监听 `127.0.0.1`，不对外暴露；
- 桥每次启动生成随机 token，所有 `/op`、`/ops` 请求必须带 `Authorization: Bearer <token>`；
- 可选 `COCOS_MCP_TOKEN` 为 MCP 端点本身加静态鉴权，缺失返回 401；
- 走消息通道的操作进入编辑器 undo 历史，误操作可撤销。

## 开发

```bash
npm install
npm run build        # npx tsc：source/ -> dist/
```

- 改 `source/operations.ts`：桥按调用热加载最新 dist，无需重载扩展；
- 改主进程 / 面板 / 场景脚本：在面板点「重载扩展」；
- 改 `mcp-server/index.js`：用 `mcp_restart` 工具或面板重启进程；
- 自检：`node mcp-server/index.js --check`（打印传输模式、桥状态与完整工具列表）。
