import { spawn, ChildProcess } from 'child_process';
import { get as httpGet } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getLogDir, log } from './logger';
import { MAIN_BUILD } from './build-info';

/**
 * mcp-server 子进程管理（跑在扩展主进程里）。
 *
 * 面板的「启动 MCP / 停止」按钮最终都走到这里：
 *  - 启动：spawn `node <扩展>/mcp-server/index.js --port <端口>`（Streamable HTTP 模式）；
 *  - 状态：子进程存活 + HTTP 探活（GET /mcp 返回 405 也算活着）双重判定；
 *  - 遗留实例：编辑器重启后子进程可能还活着（孤儿），通过状态文件 + 探活识别出来，
 *    只上报不接管——它每次请求都会重新读 bridge.json，天然兼容新桥。
 *
 * 状态文件 <项目>/temp/cocos-mcp/mcp-server.json 记录 { port, pid, startedAt }，
 * 面板重新打开时用它恢复“上次使用的端口”并识别外部实例。
 */

export interface McpServerState {
    /** 子进程（或外部实例）是否在运行 */
    running: boolean;
    /** 监听端口 */
    port: number | null;
    /** 完整 MCP 端点，例如 http://127.0.0.1:3002/mcp */
    url: string | null;
    /** 进程 pid */
    pid: number | null;
    /** 是否由本扩展主进程启动（false = 编辑器重启后遗留的外部实例） */
    owned: boolean;
    /** 启动时间戳（毫秒） */
    startedAt: number | null;
    /** HTTP 端点探活结果 */
    endpointAlive: boolean;
    /** 上一次退出的信息，便于诊断（如端口被占用退出码 1） */
    lastExit: { code: number | null; signal: string | null; at: number } | null;
    /** 子进程最近输出（诊断用，最多保留 120 行） */
    recentOutput: string[];
    /** 最近一次使用的端口（面板输入框默认值） */
    lastPort: number;
    /** mcp-server/index.js 路径，不存在为 null */
    scriptPath: string | null;
    /** 给面板的提示（如外部实例无法由本扩展停止） */
    notice: string | null;
}

let child: ChildProcess | null = null;
let childPort: number | null = null;
let childStartedAt: number | null = null;
let lastExit: { code: number | null; signal: string | null; at: number } | null = null;
const recentOutput: string[] = [];
const MAX_OUTPUT_LINES = 120;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stateFile(): string {
    return join(getLogDir(), 'mcp-server.json');
}

function readStateFile(): any | null {
    try {
        if (!existsSync(stateFile())) return null;
        return JSON.parse(readFileSync(stateFile(), 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeStateFile(data: any): void {
    try {
        const dir = getLogDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(stateFile(), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        log('mcp-process', `写状态文件失败: ${String(e)}`, 'warn');
    }
}

function removeStateFile(): void {
    try {
        if (existsSync(stateFile())) unlinkSync(stateFile());
    } catch (e) {
        // ignore
    }
}

/** 扩展根目录（<项目>/extensions/cocos-mcp；编译产物在 dist/ 下，取其上级） */
function extensionRoot(): string {
    return join(__dirname, '..');
}

/** mcp-server/index.js 路径（<扩展>/mcp-server/index.js） */
function serverScript(): string | null {
    const candidate = join(extensionRoot(), 'mcp-server', 'index.js');
    return existsSync(candidate) ? candidate : null;
}

function pushOutput(text: string): void {
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        recentOutput.push(line);
    }
    if (recentOutput.length > MAX_OUTPUT_LINES) {
        recentOutput.splice(0, recentOutput.length - MAX_OUTPUT_LINES);
    }
}

/**
 * HTTP 探活：GET /mcp。
 * Streamable HTTP 模式下 GET 会返回 405，但只要有任何 HTTP 响应就说明服务在跑。
 */
function probeEndpoint(port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (alive: boolean) => {
            if (settled) return;
            settled = true;
            resolve(alive);
        };
        try {
            const req = httpGet({ host: '127.0.0.1', port, path: '/mcp', timeout: timeoutMs }, (res) => {
                res.resume();
                finish(true);
            });
            req.on('timeout', () => {
                req.destroy();
                finish(false);
            });
            req.on('error', () => finish(false));
        } catch (e) {
            finish(false);
        }
    });
}

function buildState(partial: Partial<McpServerState>): McpServerState {
    const saved = readStateFile();
    return {
        running: false,
        port: null,
        url: null,
        pid: null,
        owned: false,
        startedAt: null,
        endpointAlive: false,
        lastExit,
        recentOutput: recentOutput.slice(),
        lastPort: (saved && Number(saved.port)) || 3002,
        scriptPath: serverScript(),
        notice: null,
        ...partial,
    };
}

/** 查询 mcp-server 运行状态（子进程优先，其次识别外部实例） */
export async function mcpServerStatus(): Promise<McpServerState> {
    if (child && child.exitCode === null && childPort !== null) {
        return buildState({
            running: true,
            port: childPort,
            url: `http://127.0.0.1:${childPort}/mcp`,
            pid: child.pid || null,
            owned: true,
            startedAt: childStartedAt,
            endpointAlive: await probeEndpoint(childPort),
        });
    }

    // 本扩展没拉子进程：检查状态文件，识别编辑器重启前遗留的外部实例
    const saved = readStateFile();
    if (saved && Number(saved.port) > 0 && Number(saved.pid) > 0) {
        if (await probeEndpoint(Number(saved.port))) {
            return buildState({
                running: true,
                port: Number(saved.port),
                url: `http://127.0.0.1:${Number(saved.port)}/mcp`,
                pid: Number(saved.pid),
                owned: false,
                startedAt: Number(saved.startedAt) || null,
                endpointAlive: true,
                notice: '该 MCP Server 不是当前编辑器会话启动的（编辑器重启后遗留），仍可正常使用；'
                    + '如需停止请在终端结束进程，或换端口启动新实例。',
            });
        }
        // 端口上没服务了，状态文件是脏数据
        removeStateFile();
    }

    return buildState({});
}

/**
 * 启动 mcp-server 子进程。
 * @param port 监听端口（1 - 65535）
 */
export async function startMcpServer(port: number): Promise<McpServerState> {
    const script = serverScript();
    if (!script) {
        throw new Error(`未找到 mcp-server：${join(extensionRoot(), 'mcp-server', 'index.js')}`);
    }

    if (child && child.exitCode === null) {
        if (childPort !== null && childPort !== port) {
            throw new Error(`MCP Server 已在端口 ${childPort} 运行，如需换端口请先停止`);
        }
        return mcpServerStatus();
    }

    if (await probeEndpoint(port)) {
        throw new Error(`端口 ${port} 已有服务在监听（可能是遗留的 MCP Server），请换一个端口`);
    }

    const nodeBin = process.env.COCOS_MCP_NODE || 'node';
    childPort = port;
    childStartedAt = Date.now();
    lastExit = null;
    pushOutput(`$ ${nodeBin} ${script} --port ${port}`);

    try {
        child = spawn(nodeBin, [script, '--port', String(port)], {
            cwd: Editor.Project.path,
            env: Object.assign({}, process.env, { COCOS_MCP_PROJECT: Editor.Project.path }),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (e: any) {
        child = null;
        childPort = null;
        throw new Error(`启动 mcp-server 失败：${e && e.message ? e.message : String(e)}`);
    }

    const running = child;

    if (running.stdout) {
        running.stdout.setEncoding('utf8');
        running.stdout.on('data', (chunk: string) => pushOutput(chunk));
    }
    if (running.stderr) {
        running.stderr.setEncoding('utf8');
        running.stderr.on('data', (chunk: string) => pushOutput(chunk));
    }

    running.on('error', (e: Error) => {
        pushOutput(`[spawn-error] ${e.message}`);
        const hint = /ENOENT/i.test(e.message)
            ? '（未找到 node 可执行文件：请安装 Node.js 并加入 PATH，或设置环境变量 COCOS_MCP_NODE 指向 node.exe）'
            : '';
        log('mcp-process', `spawn 失败: ${e.message} ${hint}`, 'error');
        if (child === running) {
            child = null;
            childPort = null;
            lastExit = { code: null, signal: null, at: Date.now() };
        }
        removeStateFile();
    });

    running.on('exit', (code, signal) => {
        pushOutput(`[exit] code=${code} signal=${signal || ''}`);
        log('mcp-process', `子进程退出 code=${code} signal=${signal || ''}`);
        if (child === running) {
            child = null;
            childPort = null;
            lastExit = { code, signal: signal || null, at: Date.now() };
        }
        // 只清理自己写的状态文件，避免误删其它实例的
        const saved = readStateFile();
        if (saved && Number(saved.pid) === running.pid) removeStateFile();
    });

    writeStateFile({ port, pid: running.pid, startedAt: childStartedAt, build: MAIN_BUILD });
    log('mcp-process', `已启动 mcp-server --port ${port} pid=${running.pid}`);

    // 最多等 3 秒确认 HTTP 端点真正起来（端口占用等失败会走 exit 分支）
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (child !== running) break; // 已退出
        if (await probeEndpoint(port, 500)) break;
        await sleep(250);
    }

    return mcpServerStatus();
}

/** 停止 mcp-server（只停本扩展启动的子进程；外部实例只上报不越权） */
export async function stopMcpServer(): Promise<McpServerState> {
    if (!child || child.exitCode !== null) {
        // 本会话没有子进程，可能是外部实例
        const state = await mcpServerStatus();
        if (state.running && !state.owned) {
            return buildState({
                ...state,
                notice: '该实例不是当前编辑器会话启动的，本扩展无法停止它；'
                    + `请在终端结束进程 pid=${state.pid}，或直接继续使用它。`,
            });
        }
        return state;
    }

    const running = child;
    const pid = running.pid;
    log('mcp-process', `停止 mcp-server pid=${pid}`);
    try {
        running.kill();
    } catch (e) {
        log('mcp-process', `kill 失败: ${String(e)}`, 'warn');
    }

    // 优雅退出最多等 2 秒，超时强杀（mcp-server 收到 SIGTERM 会自行 close）
    const deadline = Date.now() + 2000;
    while (child === running && Date.now() < deadline) {
        await sleep(100);
    }
    if (child === running) {
        try {
            if (pid) process.kill(pid);
        } catch (e) {
            // 进程可能刚好退出了
        }
    }

    return mcpServerStatus();
}
