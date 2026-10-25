# cocos-mcp

English | [简体中文](./README.md)

A Cocos Creator 3.8 editor extension that turns the editor into an MCP (Model Context Protocol) service, so AI coding agents like ZCode / Claude Code can create nodes, attach components, bind `@property` references, save prefabs, import assets and capture the scene — **working in the editor like a human, instead of only generating code as text**.

The MCP protocol (JSON-RPC 2.0) is hand-written with zero third-party SDKs. Streamable HTTP by default, stdio compatible.

## Features

- **31 MCP tools** (29 ops + 2 built-ins): scene tree query, node CRUD & move, component attach, reference binding (equivalent to Inspector drag & drop, nested prefabs and batch supported), prefab saving, TS script creation (waits for compile to get the cid), asset import / delete, scene capture, batch runs (params can reference previous results);
- **Message channel first**: operations go through `Editor.Message` and enter the editor's undo / dirty system, so they persist into scenes / prefabs normally;
- **Process management**: start / stop the mcp-server child process from the panel; it is recycled when the extension reloads;
- **AI conventions injection**: one click writes the design guideline into the project root `AGENTS.md` (idempotent anchor merge, user content untouched); a matching `conventions` tool is exposed over MCP;
- **Secure defaults**: both the MCP endpoint and the internal bridge listen on `127.0.0.1` only; the bridge uses a random port + random Bearer token; optional `COCOS_MCP_TOKEN` static auth.

## Requirements

- Cocos Creator **3.8.8+**
- Node.js **>= 16** (runs the mcp-server child process, installs panel deps)

## Install

```bash
# 1. Put it into your Creator project (git clone or download the zip)
git clone https://github.com/lixxix/cocos-mcp.git <your-project>/extensions/cocos-mcp

# 2. Install the panel runtime dependency (just fs-extra)
cd <your-project>/extensions/cocos-mcp
npm install --production
```

The compiled output `dist/` is committed, so **no npm run build is needed**. Open the project in Cocos Creator and enable cocos-mcp in "Developer → Extension Manager". (Without step 2 the main process still works, but the panel fails to load due to missing fs-extra.)

## Quick Start

### 1. Start the server

Open the panel via "Extension → Cocos MCP Console", keep the default port `3002`, click "Start MCP". Status refreshes every 2.5s; the child process is owned by the extension and survives panel close.

### 2. Connect an MCP client

ZCode / Claude Code style config:

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

### 3. Optional: enable auth

Set `COCOS_MCP_TOKEN=<random-string>` before starting, then add to the client config:

```json
"headers": { "Authorization": "Bearer <the same random string>" }
```

### Panel

- **MCP Server card**: start / stop / custom port, shows endpoint and pid; instances left over from an editor restart are reported as external;
- **Write AGENTS.md**: idempotently writes `mcp-server/conventions.md` into the project root `AGENTS.md`;
- **Reload Extension**: one-click reload after changing extension code.

## Tool Overview (29 ops + 2 built-ins = 31)

| Group | Tools |
|---|---|
| Scene | `scene_status` `scene_tree` `scene_save` `scene_reopen` `scene_capture` |
| Node | `node_create` `node_delete` `node_move`(`_engine`) `node_set_property`(`_engine`) `node_bind_property` `node_create_prefab` `node_debug` |
| Component / script | `node_add_component` `node_remove_component` `node_list_components` `node_create_component_msg` `script_create` `script_list` `scene_script_info` `scene_script_demo` |
| Asset | `asset_list` `asset_delete` `asset_import` |
| Batch / process | `batch_run` (params may reference previous results via `"$0.uuid"`) `mcp_status` `mcp_restart` `editor_info` |
| Built-in | `bridge_status` (bridge diagnostics) `conventions` (guideline query) |

Full parameter reference and the `node_set_property` path syntax: [mcp-server/README.md](./mcp-server/README.md).

## Architecture

```
MCP client (ZCode / Claude Code …)
   │  Streamable HTTP · JSON-RPC 2.0 · http://127.0.0.1:3002/mcp
   ▼
mcp-server (standalone Node process, lives in mcp-server/)
   │  HTTP 127.0.0.1:<random port> + Bearer token (port file <project>/temp/cocos-mcp/bridge.json)
   ▼
Extension bridge, bridge.ts (inside the editor main process)
   │  Editor.Message (enters the undo system)
   ▼
scene / asset-db (Cocos Creator)
```

| Module | Role |
|---|---|
| `source/operations.ts` | Operation catalog: every capability (name / schema / run); one op maps to one MCP tool |
| `source/bridge.ts` | Local HTTP bridge: random port + token, translates tool calls into operations |
| `source/mcp-process.ts` | Start / stop / status / probe of the mcp-server child process |
| `source/agents-md.ts` | Idempotently writes the conventions guideline into the project root AGENTS.md |
| `source/main.ts` | Extension main process, message entry |
| `source/scene.ts` | Scene script (engine channel: engine APIs, capture) |
| `source/panels/default/` | Console panel |
| `mcp-server/index.js` | MCP server: protocol implementation + tool routing; runs without the bridge (built-in tools only) |

## Security

- Both the MCP endpoint and the bridge listen on `127.0.0.1` only;
- The bridge generates a random token per start; all `/op`, `/ops` requests require `Authorization: Bearer <token>`;
- Optional `COCOS_MCP_TOKEN` adds static auth to the MCP endpoint itself (401 when missing);
- Message-channel operations enter the editor undo history.

## Development

```bash
npm install
npm run build        # npx tsc: source/ -> dist/
```

- Changed `source/operations.ts`: the bridge hot-loads the latest dist per call — no extension reload needed;
- Changed main process / panel / scene script: click "Reload Extension" in the panel;
- Changed `mcp-server/index.js`: use the `mcp_restart` tool or restart from the panel;
- Self-check: `node mcp-server/index.js --check` (prints transport mode, bridge status and the full tool list).
