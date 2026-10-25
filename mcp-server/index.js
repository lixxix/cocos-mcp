#!/usr/bin/env node
'use strict';

/**
 * cocos-mcp-server
 *
 * 独立的 MCP Server 进程，默认 Streamable HTTP 传输（--stdio 可退回 stdio），
 * 零第三方依赖（MCP 协议手写实现，不引入任何现成 MCP 服务或 SDK）。
 *
 * 链路：
 *   MCP 客户端 --HTTP(127.0.0.1:3002/mcp, Streamable HTTP / JSON-RPC 2.0)--> 本进程
 *            --HTTP(127.0.0.1)--> Creator 扩展桥 --> scene / asset-db
 *
 * 工具切分：扩展操作层里的一个 op 就是一个 tool。
 * tools/list 实时从扩展桥拉取，inputSchema 直接用 op 自带的 JSON Schema。
 *
 * 环境变量：
 *   COCOS_MCP_PROJECT   项目根目录（默认取 <项目>/extensions/cocos-mcp/mcp-server 的上三级目录）
 *   COCOS_MCP_BRIDGE    扩展桥端口文件路径（默认 <项目>/temp/cocos-mcp/bridge.json）
 *   COCOS_MCP_TRANSPORT 传输方式：http（默认）| stdio
 *   COCOS_MCP_HOST      HTTP 监听地址（默认 127.0.0.1）
 *   COCOS_MCP_PORT      HTTP 监听端口（默认 3002）
 *   COCOS_MCP_PATH      HTTP 端点路径（默认 /mcp）
 *   COCOS_MCP_TOKEN     可选。设置后所有 MCP 请求必须带 Authorization: Bearer <token>
 *
 * 命令行：
 *   node index.js               以 Streamable HTTP 模式运行（默认）
 *   node index.js --stdio       以 stdio 模式运行（旧方式，兼容保留）
 *   node index.js --port 3210   指定 HTTP 端口
 *   node index.js --host 0.0.0.0 指定监听地址
 *   node index.js --check       自检：打印桥接状态与工具列表后退出
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const argv = process.argv.slice(2);

function argValue(flag) {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

// 本文件在 <项目>/extensions/cocos-mcp/mcp-server/ 下，项目根为上三级
const PROJECT_DIR = process.env.COCOS_MCP_PROJECT || path.resolve(__dirname, '..', '..', '..');
const BRIDGE_FILE = process.env.COCOS_MCP_BRIDGE || path.join(PROJECT_DIR, 'temp', 'cocos-mcp', 'bridge.json');

// 版本号以 mcp-server/package.json 为单一来源，避免两处手工维护不一致
const SERVER_INFO = { name: 'cocos-mcp-server', version: require('./package.json').version };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Streamable HTTP 传输自 2025-03-26 引入，HTTP 模式下客户端没给可识别版本时回落到它
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

// ------------------------------------------------ 传输模式与 HTTP 配置

const MODE =
    argv.includes('--stdio') ? 'stdio' :
    argv.includes('--http') ? 'http' :
    process.env.COCOS_MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http';

const HTTP_HOST = argValue('--host') || process.env.COCOS_MCP_HOST || '127.0.0.1';
const HTTP_PORT = parseInt(argValue('--port') || process.env.COCOS_MCP_PORT || '3002', 10);
const HTTP_PATH = normalizePath(process.env.COCOS_MCP_PATH || '/mcp');
const AUTH_TOKEN = process.env.COCOS_MCP_TOKEN || '';

/** 会话空闲超过该时长即过期（毫秒） */
const SESSION_IDLE_MS = 60 * 60 * 1000;
/** 请求体大小上限 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function normalizePath(value) {
    if (!value.startsWith('/')) value = `/${value}`;
    if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
    return value;
}

// ---------------------------------------------------------------- JSON-RPC

const JSON_RPC_ERROR = {
    PARSE: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
};

/** 带 JSON-RPC 错误码的异常，dispatch 抛出后按 code 回包 */
class RpcError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// ---------------------------------------------------------------- 桥接客户端

function logError(...args) {
    // stdio 模式下 stdout 是协议通道不能污染，HTTP 模式下统一走 stderr 也无妨
    console.error('[cocos-mcp-server]', ...args);
}

function readBridgeFile() {
    try {
        return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function bridgeRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const bridge = readBridgeFile();
        if (!bridge) {
            reject(new Error(
                `找不到桥端口文件：${BRIDGE_FILE}\n` +
                '请先在 Cocos Creator 中打开（或重新加载）cocos-mcp 扩展面板，桥会自动启动。'
            ));
            return;
        }
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {
            'Authorization': `Bearer ${bridge.token}`,
            'Content-Type': 'application/json; charset=utf-8',
        };
        if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request({
            host: '127.0.0.1',
            port: bridge.port,
            path: urlPath,
            method,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try {
                    parsed = text ? JSON.parse(text) : {};
                } catch (e) {
                    reject(new Error(`桥返回的不是合法 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`));
                    return;
                }
                if (res.statusCode === 401) {
                    reject(new Error(`桥鉴权失败（HTTP 401），token 可能已过期，请重新加载扩展`));
                    return;
                }
                resolve(parsed);
            });
        });
        req.on('error', (e) => reject(new Error(`无法连接扩展桥 http://127.0.0.1:${bridge.port}：${e.message}`)));
        if (payload !== null) req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------- 工具

/** 始终存在的诊断工具（不依赖扩展桥） */
const BUILTIN_TOOLS = [
    {
        name: 'bridge_status',
        description: '查询 Cocos MCP 桥接状态（端口、进程、代码版本、端口文件路径），用于排查编辑器是否就绪',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'conventions',
        description: 'Cocos Creator 3.8 开发规范（核心原则/节点引用/节点层级/预制体划分/事件通信/交付要求）。在编写或修改任何 Cocos 代码、搭节点层级、拆预制体之前必须先调用本工具阅读规范；可传 section 只取标题匹配的小节（如 prefab、事件、交付）',
        inputSchema: {
            type: 'object',
            properties: {
                section: {
                    type: 'string',
                    description: '可选。只返回标题匹配该关键词的小节（如 "prefab"、"事件"），不传返回全文',
                },
            },
            additionalProperties: false,
        },
    },
];

/** 规范文档全文（conventions.md 与本文件同目录） */
function readConventions() {
    const file = path.join(__dirname, 'conventions.md');
    return fs.readFileSync(file, 'utf8');
}

/** 按 ## 小节标题关键词抽取规范片段 */
function pickConventionsSection(fullText, keyword) {
    const lines = fullText.split('\n');
    const blocks = [];
    let current = null;
    for (const line of lines) {
        const m = /^## (.+)$/.exec(line);
        if (m) {
            current = { title: m[1], body: [line] };
            blocks.push(current);
        } else if (current) {
            current.body.push(line);
        }
    }
    const lower = String(keyword).toLowerCase();
    const hits = blocks.filter((b) => b.title.toLowerCase().includes(lower));
    if (hits.length === 0) {
        return null;
    }
    return hits.map((b) => b.body.join('\n').trimEnd()).join('\n\n');
}


/** op 名 -> tool 名：scene.tree -> scene_tree，node.listComponents -> node_list_components */
function toToolName(opName) {
    return opName
        .replace(/\./g, '_')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

/** 拉取扩展的操作目录 */
async function fetchOps() {
    const res = await bridgeRequest('GET', '/ops');
    return Array.isArray(res.ops) ? res.ops : [];
}

/** 组装 tools/list 的结果 */
async function listTools() {
    const tools = BUILTIN_TOOLS.slice();
    let ops = [];
    try {
        ops = await fetchOps();
    } catch (e) {
        logError('拉取操作目录失败：', e && e.message ? e.message : e);
        return tools;
    }
    for (const op of ops) {
        tools.push({
            name: toToolName(op.name),
            description: `${op.title}：${op.description}`,
            inputSchema: op.schema || { type: 'object', properties: {} },
        });
    }
    return tools;
}

/** 调用一个 tool */
async function callTool(name, args) {
    if (name === 'bridge_status') {
        const bridge = readBridgeFile();
        const payload = {
            bridgeFile: BRIDGE_FILE,
            projectDir: PROJECT_DIR,
            bridge: bridge || null,
            running: !!bridge,
        };
        if (bridge) {
            try {
                payload.health = await bridgeRequest('GET', '/health');
            } catch (e) {
                payload.healthError = e && e.message ? e.message : String(e);
            }
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: !bridge,
        };
    }

    if (name === 'conventions') {
        const text = readConventions();
        const keyword = args && args.section;
        let body = text;
        let note = '';
        if (keyword) {
            const picked = pickConventionsSection(text, keyword);
            if (picked) {
                body = picked;
            } else {
                const titles = text.split('\n')
                    .map((l) => /^## (.+)$/.exec(l))
                    .filter(Boolean)
                    .map((m) => m[1]);
                note = `（没有匹配 "${keyword}" 的小节，已返回全文。可用小节：${titles.join(' / ')}）\n\n`;
            }
        }
        return {
            content: [{ type: 'text', text: note + body }],
            isError: false,
        };
    }

    const ops = await fetchOps();
    const op = ops.find((item) => toToolName(item.name) === name);
    if (!op) {
        return {
            content: [{ type: 'text', text: `未知工具：${name}` }],
            isError: true,
        };
    }

    const result = await bridgeRequest('POST', '/op', { op: op.name, params: args || {} });
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
    };
}

// ---------------------------------------------------------------- MCP 协议

async function dispatch(message) {
    const params = message.params || {};
    switch (message.method) {
        case 'initialize': {
            const requested = params.protocolVersion;
            const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : DEFAULT_PROTOCOL_VERSION;
            return {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
            };
        }
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: await listTools() };
        case 'tools/call':
            return await callTool(params.name, params.arguments || {});
        case 'resources/list':
            return { resources: [] };
        case 'prompts/list':
            return { prompts: [] };
        default:
            throw new RpcError(JSON_RPC_ERROR.METHOD_NOT_FOUND, `不支持的方法：${message.method}`);
    }
}

// ---------------------------------------------------------------- 会话管理（HTTP）

/** sessionId -> { createdAt, lastUsedAt } */
const sessions = new Map();

function createSession() {
    const id = crypto.randomUUID();
    sessions.set(id, { createdAt: Date.now(), lastUsedAt: Date.now() });
    return id;
}

/** 会话有效则刷新活跃时间并返回 true；不存在或已过期返回 false */
function touchSession(id) {
    const session = sessions.get(id);
    if (!session) return false;
    if (Date.now() - session.lastUsedAt > SESSION_IDLE_MS) {
        sessions.delete(id);
        return false;
    }
    session.lastUsedAt = Date.now();
    return true;
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastUsedAt > SESSION_IDLE_MS) sessions.delete(id);
    }
}

// ---------------------------------------------------------------- Streamable HTTP 传输

function httpLog(...args) {
    // HTTP 模式下 stdout 不是协议通道，可直接打印
    console.log('[cocos-mcp-server]', ...args);
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400',
    };
}

function writeJson(res, status, payload, extraHeaders) {
    const body = JSON.stringify(payload);
    const headers = Object.assign(corsHeaders(), extraHeaders);
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, headers);
    res.end(body);
}

function writeEmpty(res, status, extraHeaders) {
    const headers = Object.assign(corsHeaders(), { 'Content-Length': 0 }, extraHeaders);
    res.writeHead(status, headers);
    res.end();
}

function httpError(res, status, id, code, message, extraHeaders) {
    writeJson(res, status, { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }, extraHeaders);
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                const error = new Error(`请求体超过 ${limit} 字节上限`);
                error.statusCode = 413;
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function headerValue(req, name) {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
}

/** 处理 POST /mcp：单条或批量 JSON-RPC 消息 */
async function handlePost(req, res, rawBody) {
    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (e) {
        httpError(res, 400, null, JSON_RPC_ERROR.PARSE, `请求体不是合法 JSON：${e && e.message ? e.message : e}`);
        return;
    }

    const isBatch = Array.isArray(message);
    const messages = isBatch ? message : [message];
    if (messages.length === 0) {
        httpError(res, 400, null, JSON_RPC_ERROR.INVALID_REQUEST, '批量请求不能为空数组');
        return;
    }

    // initialize 是会话的起点；其余请求带未知/过期的 Mcp-Session-Id 时直接原地复活。
    // 实测多数客户端（ZCode）拿到 404 后并不会重新 initialize，而是拿着旧 id 反复重试，
    // 拒绝只会让会话永久卡死；session 仅用于空闲回收，不承载安全语义。
    const hasInitialize = messages.some((item) => item && item.method === 'initialize');
    if (!hasInitialize) {
        const sessionId = headerValue(req, 'mcp-session-id');
        if (!sessionId) {
            httpError(res, 400, null, JSON_RPC_ERROR.INVALID_REQUEST, '缺少 Mcp-Session-Id 请求头，请先调用 initialize 建立会话');
            return;
        }
        if (!touchSession(sessionId)) {
            sessions.set(sessionId, { createdAt: Date.now(), lastUsedAt: Date.now() });
            logError(`会话 ${sessionId} 不存在或已过期，已原地复活`);
        }
    }

    const responses = [];
    let newSessionId = null;
    for (const item of messages) {
        if (!item || typeof item !== 'object' || typeof item.method !== 'string') {
            responses.push({
                jsonrpc: '2.0',
                id: item && item.id !== undefined ? item.id : null,
                error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: '非法的 JSON-RPC 消息' },
            });
            continue;
        }
        // notification（没有 id）不需要回包
        if (item.id === undefined || item.id === null) continue;
        try {
            const result = await dispatch(item);
            responses.push({ jsonrpc: '2.0', id: item.id, result });
            if (item.method === 'initialize') newSessionId = createSession();
        } catch (e) {
            const code = e instanceof RpcError ? e.code : JSON_RPC_ERROR.INTERNAL;
            responses.push({
                jsonrpc: '2.0',
                id: item.id,
                error: { code, message: e && e.message ? e.message : String(e) },
            });
            logError('处理失败：', e && e.message ? e.message : e);
        }
    }

    if (responses.length === 0) {
        // 整批都是 notification：按规范返回 202，无响应体
        writeEmpty(res, 202);
        return;
    }
    writeJson(res, 200, isBatch ? responses : responses[0], newSessionId ? { 'Mcp-Session-Id': newSessionId } : undefined);
}

/** 处理 DELETE /mcp：客户端主动结束会话 */
function handleDelete(req, res) {
    const sessionId = headerValue(req, 'mcp-session-id');
    if (!sessionId) {
        httpError(res, 400, null, JSON_RPC_ERROR.INVALID_REQUEST, '缺少 Mcp-Session-Id 请求头');
        return;
    }
    sessions.delete(sessionId);
    writeEmpty(res, 200);
}

function startHttp() {
    const server = http.createServer((req, res) => {
        void (async () => {
            try {
                const url = normalizePath((req.url || '/').split('?')[0]);
                if (url !== HTTP_PATH) {
                    writeJson(res, 404, { error: `未知端点 ${req.method} ${url}，MCP 端点是 ${HTTP_PATH}` });
                    return;
                }

                if (req.method === 'OPTIONS') {
                    writeEmpty(res, 204);
                    return;
                }

                // 可选的静态 token 鉴权（COCOS_MCP_TOKEN 设置时启用）
                if (AUTH_TOKEN) {
                    const header = req.headers.authorization || '';
                    const token = header.replace(/^Bearer\s+/i, '').trim();
                    if (token !== AUTH_TOKEN) {
                        httpError(res, 401, null, JSON_RPC_ERROR.INVALID_REQUEST, '未授权：缺少或错误的 Bearer token', {
                            'WWW-Authenticate': 'Bearer',
                        });
                        return;
                    }
                }

                if (req.method === 'POST') {
                    const raw = await readBody(req, MAX_BODY_BYTES);
                    await handlePost(req, res, raw);
                    return;
                }

                if (req.method === 'GET' || req.method === 'HEAD') {
                    // 没有服务端主动推送的场景（无 listChanged / 通知），按规范以 405 告知不支持 GET 流
                    writeEmpty(res, 405, { Allow: 'POST, DELETE, OPTIONS' });
                    return;
                }

                if (req.method === 'DELETE') {
                    handleDelete(req, res);
                    return;
                }

                writeEmpty(res, 405, { Allow: 'GET, POST, DELETE, OPTIONS' });
            } catch (e) {
                const status = e && e.statusCode ? e.statusCode : 500;
                const message = e && e.message ? e.message : String(e);
                logError('HTTP 请求处理异常：', message);
                if (!res.headersSent) {
                    httpError(res, status, null, JSON_RPC_ERROR.INTERNAL, message);
                } else {
                    res.end();
                }
            }
        })();
    });

    server.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
            httpLog(`端口 ${HTTP_PORT} 已被占用。用 --port <端口> 或环境变量 COCOS_MCP_PORT 换一个。`);
        } else {
            httpLog('HTTP 服务异常：', e && e.message ? e.message : e);
        }
        process.exit(1);
    });

    server.listen(HTTP_PORT, HTTP_HOST, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : HTTP_PORT;
        httpLog(`MCP Streamable HTTP 已启动: http://${HTTP_HOST}:${port}${HTTP_PATH}`);
        httpLog(`项目目录  : ${PROJECT_DIR}`);
        httpLog(`桥端口文件: ${BRIDGE_FILE}`);
        const bridge = readBridgeFile();
        if (bridge) {
            httpLog(`桥状态    : 运行中 http://127.0.0.1:${bridge.port}（pid ${bridge.pid}）`);
        } else {
            httpLog('桥状态    : 未启动（请在 Creator 里打开 cocos-mcp 扩展面板；桥就绪前 tools/list 只会返回 bridge_status）');
        }
        if (AUTH_TOKEN) httpLog('鉴权      : 已开启（Authorization: Bearer ***）');
    });

    // 定期清理过期会话；unref 不阻止进程退出
    setInterval(() => cleanExpiredSessions(), 10 * 60 * 1000).unref();

    const shutdown = () => {
        httpLog('收到退出信号，正在关闭…');
        server.close(() => process.exit(0));
        // 兜底：连接未及时断开也强制退出
        setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------- stdio 传输（兼容保留）

function send(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleMessage(message) {
    // notification（没有 id）不需要回包
    if (message.id === undefined || message.id === null) return;
    try {
        const result = await dispatch(message);
        send({ jsonrpc: '2.0', id: message.id, result });
    } catch (e) {
        const code = e instanceof RpcError ? e.code : JSON_RPC_ERROR.INTERNAL;
        logError('处理失败：', e && e.message ? e.message : e);
        send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code, message: e && e.message ? e.message : String(e) },
        });
    }
}

function startStdio() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) {
                let message;
                try {
                    message = JSON.parse(line);
                } catch (e) {
                    logError('收到非法 JSON 行：', line.slice(0, 200));
                    message = null;
                }
                if (message) void handleMessage(message);
            }
            index = buffer.indexOf('\n');
        }
    });
    process.stdin.on('end', () => process.exit(0));
    logError(`stdio 模式已启动，项目目录 ${PROJECT_DIR}，桥端口文件 ${BRIDGE_FILE}`);
}

// ---------------------------------------------------------------- 自检模式

async function selfCheck() {
    console.log('=== cocos-mcp-server 自检 ===');
    console.log('项目目录  :', PROJECT_DIR);
    console.log('端口文件  :', BRIDGE_FILE);
    console.log('传输模式  :', MODE === 'stdio' ? 'stdio' : `Streamable HTTP http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}`);
    const bridge = readBridgeFile();
    if (!bridge) {
        console.log('桥状态    : 未启动（请在 Creator 里打开 cocos-mcp 扩展面板）');
        process.exit(1);
    }
    console.log('桥状态    : 运行中');
    console.log('  地址    :', `http://127.0.0.1:${bridge.port}`);
    console.log('  pid     :', bridge.pid);
    console.log('  build   :', bridge.build);

    const health = await bridgeRequest('GET', '/health');
    console.log('健康检查  :', JSON.stringify(health));

    const tools = await listTools();
    console.log(`\n工具列表（${tools.length} 个）：`);
    for (const tool of tools) {
        console.log(`  - ${tool.name}`);
    }
    process.exit(0);
}

// ---------------------------------------------------------------- 入口

if (process.argv.includes('--check')) {
    selfCheck().catch((e) => {
        console.error('自检失败：', e && e.message ? e.message : e);
        process.exit(1);
    });
} else if (MODE === 'stdio') {
    startStdio();
} else {
    startHttp();
}
