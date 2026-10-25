import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getLogDir, log } from './logger';
import { MAIN_BUILD } from './build-info';

/**
 * 本地 HTTP 桥
 *
 * 外部进程（MCP Server）无法直接访问 Creator 的消息总线，
 * 所以由扩展在 127.0.0.1 上开一个极小的 HTTP 端点，把 tool 调用转成 operations 调用。
 *
 * 设计要点：
 *  - 只监听 127.0.0.1，不对外暴露；
 *  - 随机端口 + 端口文件（bridge.json），避免多开编辑器时端口冲突；
 *  - 每次启动生成随机 token，调用必须带 Authorization: Bearer <token>；
 *  - 请求/响应全部是纯 JSON。
 */

export interface BridgeInfo {
    /** 端口 */
    port: number;
    /** 鉴权 token */
    token: string;
    /** 端口文件路径 */
    file: string;
    /** 扩展主进程 pid */
    pid: number;
    /** 项目路径 */
    projectPath: string;
    /** 代码版本戳 */
    build: string;
    /** 启动时间戳 */
    startedAt: number;
}

let server: Server | null = null;
let info: BridgeInfo | null = null;

/**
 * 每次调用都重新加载 operations 模块。
 * 这样改完操作层代码后，只需要重新编译 dist，MCP 侧立刻生效，
 * 不用重载扩展（重载扩展只在改了 contributions / 场景脚本时才需要）。
 */
function freshOperations(): any {
    const modulePath = require.resolve('./operations');
    delete require.cache[modulePath];
    return require(modulePath);
}

/** 端口文件路径：<项目>/temp/cocos-mcp/bridge.json */
export function getBridgeFile(): string {
    return join(getLogDir(), 'bridge.json');
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res: ServerResponse, status: number, payload: any): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
}

function authorized(req: IncomingMessage): boolean {
    if (!info) return false;
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    return token.length > 0 && token === info.token;
}

/** 启动桥（幂等） */
export function startBridge(): BridgeInfo | null {
    if (server && info) {
        return info;
    }

    const token = randomBytes(24).toString('hex');
    const file = getBridgeFile();

    try {
        const dir = getLogDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
        log('bridge', `无法创建日志目录: ${String(e)}`, 'warn');
    }

    const created = createServer((req, res) => {
        void (async () => {
            try {
                if (req.method === 'OPTIONS') {
                    sendJson(res, 204, {});
                    return;
                }

                const url = (req.url || '/').split('?')[0];

                // 健康检查不需要鉴权，方便探活
                if (req.method === 'GET' && url === '/health') {
                    sendJson(res, 200, {
                        ok: true,
                        build: MAIN_BUILD,
                        projectPath: Editor.Project.path,
                        editorVersion: Editor.App.version,
                        startedAt: info?.startedAt,
                        pid: process.pid,
                    });
                    return;
                }

                if (!authorized(req)) {
                    sendJson(res, 401, { ok: false, error: '未授权：缺少或错误的 Bearer token' });
                    return;
                }

                if (req.method === 'GET' && url === '/ops') {
                    sendJson(res, 200, { ok: true, ops: freshOperations().listOperations() });
                    return;
                }

                if (req.method === 'POST' && url === '/op') {
                    const raw = await readBody(req);
                    let payload: any = {};
                    try {
                        payload = raw ? JSON.parse(raw) : {};
                    } catch (e) {
                        sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON: ${String(e)}` });
                        return;
                    }
                    const op = payload.op || '';
                    const params = payload.params || {};
                    const start = Date.now();
                    try {
                        const data = await freshOperations().runOperation(op, params);
                        sendJson(res, 200, { ok: true, op, data, cost: Date.now() - start, ts: Date.now() });
                    } catch (e: any) {
                        const message = e && e.message ? e.message : String(e);
                        sendJson(res, 200, { ok: false, op, error: message, cost: Date.now() - start, ts: Date.now() });
                    }
                    return;
                }

                sendJson(res, 404, { ok: false, error: `未知端点: ${req.method} ${url}` });
            } catch (e: any) {
                const message = e && e.message ? e.message : String(e);
                log('bridge', `请求处理异常: ${message}`, 'error');
                try {
                    sendJson(res, 500, { ok: false, error: message });
                } catch (ignored) {
                    // 响应可能已经发出
                }
            }
        })();
    });

    created.on('error', (e: any) => {
        log('bridge', `HTTP 服务启动失败: ${e && e.message ? e.message : String(e)}`, 'error');
    });

    // 端口 0 = 让系统分配一个可用端口，天然避开多开编辑器的冲突
    created.listen(0, '127.0.0.1', () => {
        const address = created.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        info = {
            port,
            token,
            file,
            pid: process.pid,
            projectPath: Editor.Project.path,
            build: MAIN_BUILD,
            startedAt: Date.now(),
        };
        server = created;

        try {
            writeFileSync(file, JSON.stringify(info, null, 2), 'utf8');
        } catch (e) {
            log('bridge', `写端口文件失败: ${String(e)}`, 'error');
        }

        log('bridge', `已启动 http://127.0.0.1:${port}  端口文件: ${file}`);
    });

    return info;
}

/** 停止桥（幂等） */
export function stopBridge(): void {
    if (server) {
        try {
            server.close();
        } catch (e) {
            // ignore
        }
        server = null;
    }
    if (info) {
        try {
            // 只删自己写的端口文件，避免误删其它编辑器实例的
            if (existsSync(info.file)) {
                const raw = require('fs').readFileSync(info.file, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed && parsed.pid === info.pid) {
                    unlinkSync(info.file);
                }
            }
        } catch (e) {
            // ignore
        }
        log('bridge', '已停止');
        info = null;
    }
}

/** 当前桥信息（未启动时为 null） */
export function getBridge(): BridgeInfo | null {
    return info;
}
