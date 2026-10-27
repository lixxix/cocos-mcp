// @ts-ignore
import packageJSON from '../package.json';
import { listOperations, runOperation } from './operations';
import { log } from './logger';
import { MAIN_BUILD } from './build-info';
import { startBridge, stopBridge, getBridge } from './bridge';
import { startMcpServer, stopMcpServer, mcpServerStatus, McpServerState } from './mcp-process';
import { writeAgentsMd, AgentsMdResult } from './agents-md';
import { checkForUpdate, applyUpdate as applyUpdateOp, UpdateCheckResult, UpdateApplyResult } from './updater';
import { OperationRequest, OperationResult } from './types';

/**
 * 扩展主进程。
 *
 * 这里是自研 MCP 服务的唯一可信执行端：
 *  - 面板按钮通过消息调用这里的 mcp-start / mcp-stop / mcp-status / agents-md-write；
 *  - MCP Server 把 tool 调用翻译成 { op, params }，经本地 HTTP 桥（bridge.ts）
 *    在本进程内直接执行 operations（不经过 run-operation 消息）；
 *  - run-operation / list-operations 消息保留给外部脚本与调试；
 *  - 场景操作一律通过 Editor.Message 转发给 scene / asset-db 包，
 *    扩展自己不去直接改 .scene / .prefab / .anim / .meta 文件。
 */

/** run-operation 执行结果的广播事件名（订阅方自行监听） */
export const RESULT_EVENT = 'cocos-mcp:operation-result';

export const methods: { [key: string]: (...any: any) => any } = {
    /**
     * 打开扩展面板
     */
    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    /**
     * 统一操作入口：执行任意 op（MCP 工具默认走 HTTP 桥，不经过本消息）
     * @param payload { op: string, params?: object }
     */
    async runOperation(payload: OperationRequest): Promise<OperationResult> {
        const request = payload || ({ op: '' } as OperationRequest);
        const op = request.op || '';
        const params = request.params || {};
        const start = Date.now();

        let result: OperationResult;
        try {
            const data = await runOperation(op, params);
            result = { ok: true, op, data, cost: Date.now() - start, ts: Date.now() };
            log('run-operation', result);
        } catch (e: any) {
            const message = e && e.message ? e.message : String(e);
            result = { ok: false, op, error: message, cost: Date.now() - start, ts: Date.now() };
            log('run-operation', result, 'error');
        }

        // 把结果广播出去：面板可以订阅，未来的 MCP Server 也可以订阅
        try {
            Editor.Message.broadcast(RESULT_EVENT, result as any);
        } catch (e) {
            // 广播失败不影响返回值
        }
        return result;
    },

    /**
     * 列出所有可用操作（MCP tools/list 的数据源）
     */
    listOperations() {
        const list = listOperations();
        log('list-operations', list);
        return list;
    },

    /**
     * 查询本地 HTTP 桥的状态（端口 / 端口文件 / token）
     */
    bridgeStatus() {
        const bridge = getBridge();
        return {
            running: !!bridge,
            port: bridge ? bridge.port : null,
            file: bridge ? bridge.file : null,
            projectPath: bridge ? bridge.projectPath : null,
            build: bridge ? bridge.build : MAIN_BUILD_STAMP,
        };
    },

    /**
     * 启动 mcp-server 子进程（Streamable HTTP）
     * @param payload { port?: number }
     */
    async mcpStart(payload: { port?: number }): Promise<{ ok: boolean; state?: McpServerState; error?: string }> {
        const port = Number(payload && payload.port) || 3002;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, error: `非法端口：${port}（允许 1 - 65535）` };
        }
        try {
            const state = await startMcpServer(port);
            return { ok: true, state };
        } catch (e: any) {
            const message = e && e.message ? e.message : String(e);
            log('mcp-start', { ok: false, port, error: message }, 'error');
            return { ok: false, error: message };
        }
    },

    /**
     * 停止 mcp-server 子进程
     */
    async mcpStop(): Promise<{ ok: boolean; state?: McpServerState; error?: string }> {
        try {
            const state = await stopMcpServer();
            return { ok: true, state };
        } catch (e: any) {
            const message = e && e.message ? e.message : String(e);
            log('mcp-stop', { ok: false, error: message }, 'error');
            return { ok: false, error: message };
        }
    },

    /**
     * 查询 mcp-server 运行状态
     */
    async mcpStatus(): Promise<McpServerState> {
        return mcpServerStatus();
    },

    /**
     * 把扩展内 mcp-server/conventions.md 设计规范写入项目根 AGENTS.md（幂等）
     */
    agentsMdWrite(): AgentsMdResult {
        return writeAgentsMd();
    },

    /**
     * 检查扩展更新（对比 GitHub 更新源的 package.json 版本）
     * @param payload { force?: boolean } force=true 跳过 1 小时缓存强制联网
     */
    async checkUpdate(payload?: { force?: boolean }): Promise<UpdateCheckResult> {
        try {
            return await checkForUpdate(payload);
        } catch (e: any) {
            const message = e && e.message ? e.message : String(e);
            log('check-update', { error: message }, 'error');
            return { ok: false, current: String((packageJSON as any).version || ''), hasUpdate: false, error: message };
        }
    },

    /**
     * 执行扩展更新：下载 zip 覆盖扩展目录（先自动停 MCP Server）。
     * 重载扩展由面板在拿到成功结果后触发，主进程不自己 disable 自己。
     */
    async applyUpdate(): Promise<UpdateApplyResult> {
        try {
            const result = await applyUpdateOp();
            log('apply-update', result);
            return result;
        } catch (e: any) {
            const message = e && e.message ? e.message : String(e);
            log('apply-update', { error: message }, 'error');
            return { ok: false, from: String((packageJSON as any).version || ''), error: message };
        }
    },
};

/** 主进程代码版本戳：写进日志，用来确认编辑器里跑的是哪一份代码 */
const MAIN_BUILD_STAMP = MAIN_BUILD;

/**
 * 扩展启动
 */
export function load() {
    log('extension-load', {
        build: MAIN_BUILD_STAMP,
        name: packageJSON.name,
        version: packageJSON.version,
        node: process.version,
    });
    ensureBridge();
}

/**
 * 扩展卸载
 */
export function unload() {
    void stopMcpServer();
    stopBridge();
    log('extension-unload', { name: packageJSON.name });
}

/**
 * 确保本地 HTTP 桥已启动（幂等）。
 * 面板的「直连模式」也会调用它，这样不重载扩展也能起桥。
 */
export function ensureBridge() {
    return startBridge();
}
