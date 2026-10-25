import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * 日志工具：同时输出到编辑器控制台与本地文件。
 * 文件落在 <项目>/temp/cocos-mcp/ipc.log，方便用命令行核对每一步的结果。
 */

let cachedLogFile = '';
let logDirOverride = '';

/** 强制指定日志目录（面板进程用，因为面板拿到的 Editor API 可能不含 Project） */
export function setLogDir(dir: string): void {
    if (dir && dir !== logDirOverride) {
        logDirOverride = dir;
        cachedLogFile = '';
    }
}

function stringify(payload: any): string {
    if (payload === undefined) return '';
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload, null, 2);
    } catch (e) {
        return String(payload);
    }
}

/**
 * 日志目录：<项目>/temp/cocos-mcp/
 *
 * 优先用 Editor.Project.path；拿不到时（例如面板进程、刚被重新 require 的模块副本）
 * 就从本模块自身位置往上数：<扩展>/dist/logger.js -> <项目>。
 * 保证主进程、面板进程、直连模式新加载的模块副本都写到同一个文件。
 */
export function getLogDir(): string {
    if (logDirOverride) return logDirOverride;
    const editor = typeof Editor !== 'undefined' ? (Editor as any) : null;
    if (editor?.Project?.path) {
        return join(editor.Project.path, 'temp', 'cocos-mcp');
    }
    return join(__dirname, '..', '..', '..', 'temp', 'cocos-mcp');
}

/** 日志文件路径 */
export function getLogFile(): string {
    if (!cachedLogFile) {
        const dir = getLogDir();
        try {
            mkdirSync(dir, { recursive: true });
        } catch (e) {
            // 目录创建失败不影响主流程
        }
        cachedLogFile = join(dir, 'ipc.log');
    }
    return cachedLogFile;
}

/**
 * 打印一条日志。
 * @param scope 作用域，例如 operations / scene-script
 * @param payload 附带数据（会被 JSON 序列化）
 * @param level info | warn | error
 */
export function log(scope: string, payload?: any, level: 'info' | 'warn' | 'error' = 'info'): void {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const body = payload === undefined ? '' : `\n${stringify(payload)}`;
    const line = `[${time}] [${level.toUpperCase()}] [${scope}]${body}\n`;

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }

    try {
        appendFileSync(getLogFile(), line, 'utf8');
    } catch (e) {
        // 写文件失败不影响主流程
    }
}
