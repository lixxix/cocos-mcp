import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { log } from './logger';

/**
 * AGENTS.md 规范注入。
 *
 * 把扩展内 mcp-server/conventions.md（单一事实源）写入项目根的 AGENTS.md，
 * 供 ZCode / Claude Code 等工具在会话中自动读取。
 *
 * 写入策略：用锚点注释包住规范段，AGENTS.md 里用户自己写的内容不动——
 *   - 文件不存在          → 创建（标题 + 说明 + 规范段）
 *   - 已有锚点段          → 只替换锚点之间的内容（重写生效，幂等）
 *   - 存在但没有锚点      → 追加到文件末尾
 */

const START_MARK = '<!-- cocos-mcp:conventions:start -->';
const END_MARK = '<!-- cocos-mcp:conventions:end -->';

export interface AgentsMdResult {
    ok: boolean;
    file: string;
    action: 'created' | 'updated' | 'appended';
    bytes: number;
    error?: string;
}

function projectRoot(): string {
    const editor = typeof Editor !== 'undefined' ? (Editor as any) : null;
    if (editor?.Project?.path) return editor.Project.path;
    // 直连模式兜底：<扩展>/dist/agents-md.js -> <项目>
    return join(__dirname, '..', '..', '..');
}

/** 扩展根目录（<项目>/extensions/cocos-mcp；编译产物在 dist/ 下，取其上级） */
function extensionRoot(): string {
    return join(__dirname, '..');
}

/** 规范源文件：<扩展>/mcp-server/conventions.md（随扩展分发） */
function conventionsFile(): string {
    return join(extensionRoot(), 'mcp-server', 'conventions.md');
}

function agentsFile(): string {
    return join(projectRoot(), 'AGENTS.md');
}

/** 读取规范源文件内容 */
export function readConventionsSource(): string {
    const file = conventionsFile();
    if (!existsSync(file)) {
        throw new Error(`规范源文件不存在：${file}`);
    }
    return readFileSync(file, 'utf8');
}

/**
 * 把规范写入项目根 AGENTS.md（幂等，可反复调用同步最新规范）。
 */
export function writeAgentsMd(): AgentsMdResult {
    const target = agentsFile();
    try {
        const conventions = readConventionsSource().trim();
        const block = [
            START_MARK,
            '<!-- 本段由 cocos-mcp 扩展维护：手动修改会在下次写入时被覆盖；要更新规范请改 cocos-mcp 扩展内 mcp-server/conventions.md -->',
            conventions,
            END_MARK,
        ].join('\n');

        let action: AgentsMdResult['action'];
        let next: string;
        if (!existsSync(target)) {
            action = 'created';
            next = `# AGENTS.md\n\n本文件面向 AI 编码助手（ZCode / Claude Code 等），定义本项目的协作规范。\n\n${block}\n`;
        } else {
            const current = readFileSync(target, 'utf8');
            const startIdx = current.indexOf(START_MARK);
            const endIdx = current.indexOf(END_MARK);
            if (startIdx >= 0 && endIdx > startIdx) {
                // 已有锚点段：连同段前导注释一起替换（含上一次遗留的换行）
                action = 'updated';
                next = current.slice(0, startIdx) + block + current.slice(endIdx + END_MARK.length);
            } else {
                action = 'appended';
                const sep = current.endsWith('\n') || current.length === 0 ? '' : '\n';
                next = `${current}${sep}\n${block}\n`;
            }
        }

        writeFileSync(target, next, 'utf8');
        const result: AgentsMdResult = { ok: true, file: target, action, bytes: Buffer.byteLength(next, 'utf8') };
        log('agents-md', { ok: true, action, file: target, bytes: result.bytes });
        return result;
    } catch (e: any) {
        const message = e && e.message ? e.message : String(e);
        log('agents-md', { ok: false, file: target, error: message }, 'error');
        return { ok: false, file: target, action: 'created', bytes: 0, error: message };
    }
}
