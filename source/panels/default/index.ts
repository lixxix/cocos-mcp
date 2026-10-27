import { readFileSync, existsSync } from 'fs-extra';
import { join } from 'path';
import { log, getLogDir } from '../../logger';
import { MAIN_BUILD, PANEL_BUILD } from '../../build-info';

/**
 * Cocos MCP 控制面板
 *
 * 面板不含业务逻辑，只提供四件事：
 *  1. 启动 / 停止 MCP Server（状态每 2.5 秒自动刷新）；
 *  2. 把设计规范写入项目根 AGENTS.md；
 *  3. 检查更新 / 一键更新（更新后自动重载扩展）；
 *  4. 重载扩展。
 *
 * 全部通过消息调用扩展主进程；消息通道不通（主进程尚未重载）时
 * 自动兜底直连最新的 dist/main.js，改完代码不重启编辑器也能用。
 */

const EXTENSION_NAME = 'cocos-mcp';

/** dist 目录：<扩展>/dist */
const DIST_DIR = join(__dirname, '..', '..');

interface PanelElements {
    [key: string]: HTMLElement | null;
}

/** MCP Server 状态轮询定时器 */
let mcpTimer: any = null;

/** 顶部提示条（操作结果反馈） */
function showHint(elements: PanelElements, text: string): void {
    const hint = elements.hint;
    if (hint) {
        hint.textContent = text;
        hint.style.display = 'block';
    }
    log('panel-hint', { text });
}

/**
 * 加载 dist 下最新的模块（清掉模块缓存）。
 * 这样扩展主进程还没重载时，面板也能直连最新代码。
 */
function loadDistModuleFresh(file: string): any {
    const selfDir = join(__dirname);
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(DIST_DIR) && !key.startsWith(selfDir)) {
            delete require.cache[key];
        }
    }
    return require(file);
}

/** 直连模式：加载最新的 dist/main.js，并顺手把本地 HTTP 桥拉起来（幂等） */
function loadMainFresh(): any {
    const main = loadDistModuleFresh(join(DIST_DIR, 'main.js'));
    try {
        if (typeof main.ensureBridge === 'function') {
            main.ensureBridge();
        }
    } catch (e) {
        log('panel-bridge', { error: String(e) }, 'warn');
    }
    return main;
}

/**
 * 桥自愈：
 * 桥正常应该跑在扩展主进程里（生命周期 = 编辑器）。
 * 如果扩展主进程还没重载，端口文件里的 build 会比当前代码旧，
 * 这时在面板进程内临时起一个新桥（带 operations 热加载），让 MCP 立刻可用。
 * 代价：面板关掉桥就断，所以会提示用户去重载扩展。
 */
function ensureFreshBridge(elements: PanelElements): void {
    const file = join(getLogDir(), 'bridge.json');
    let stale = true;
    let current = '';
    try {
        if (existsSync(file)) {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            current = parsed.build || '';
            stale = current !== MAIN_BUILD;
        }
    } catch (e) {
        stale = true;
    }

    if (!stale) {
        log('panel-bridge', { status: '主进程桥为最新', build: current });
        return;
    }

    try {
        const bridge = loadDistModuleFresh(join(DIST_DIR, 'bridge.js'));
        bridge.startBridge();
        const info = bridge.getBridge ? bridge.getBridge() : null;
        log('panel-bridge', { status: '已临时启动新桥', port: info && info.port, build: MAIN_BUILD });
        showHint(elements,
            '扩展主进程尚未重载（桥是旧版 ' + (current || '无') + '）。' +
            '已在面板进程内临时启动新桥，MCP 现在就能用；' +
            '但面板一关桥就断——要长期可用，请点「重载扩展」或在「开发者 → 扩展管理器」里停用/启用 cocos-mcp。');
    } catch (e: any) {
        log('panel-bridge', { error: e && e.message ? e.message : String(e) }, 'error');
        showHint(elements, '临时桥启动失败：' + (e && e.message ? e.message : String(e)));
    }
}

/** 消息名 -> 直连模式下的 methods 方法名 */
const DIRECT_METHOD_MAP: { [key: string]: string } = {
    'mcp-start': 'mcpStart',
    'mcp-stop': 'mcpStop',
    'mcp-status': 'mcpStatus',
    'agents-md-write': 'agentsMdWrite',
    'check-update': 'checkUpdate',
    'apply-update': 'applyUpdate',
};

/** 调用扩展主进程的方法，消息通道不通时自动兜底直连 */
async function callMcpMethod(method: string, args?: any): Promise<any> {
    try {
        return await Editor.Message.request(EXTENSION_NAME, method, args);
    } catch (e: any) {
        const message = e && e.message ? e.message : String(e);
        if (!/does not exist/i.test(message)) throw e;
        const main = loadMainFresh();
        const fn = main && main.methods && main.methods[DIRECT_METHOD_MAP[method]];
        if (typeof fn !== 'function') {
            throw new Error(`直连模式找不到方法 ${DIRECT_METHOD_MAP[method]}（扩展主进程尚未重载）`);
        }
        return fn(args);
    }
}

/** 把 mcp-status 的返回渲染到 MCP Server 卡片 */
function renderMcpState(elements: PanelElements, state: any): void {
    const dot = elements.mcpDot;
    const text = elements.mcpStatusText;
    const btnStart = elements.btnMcpStart as HTMLButtonElement | null;
    const btnStop = elements.btnMcpStop as HTMLButtonElement | null;
    const input = elements.inputMcpPort as HTMLInputElement | null;
    if (!dot || !text) return;

    if (state && state.running) {
        dot.className = 'status-dot running';
        const parts = [`运行中 · ${state.url}`];
        if (state.pid) parts.push(`pid ${state.pid}`);
        if (state.owned === false) parts.push('外部实例');
        if (state.endpointAlive === false) parts.push('端点无响应');
        text.textContent = parts.join(' · ');
        if (btnStart) btnStart.disabled = true;
        if (btnStop) btnStop.disabled = false;
    } else {
        dot.className = 'status-dot stopped';
        if (state && state.lastExit) {
            const exit = state.lastExit;
            text.textContent = `未启动（上次退出 code=${exit.code === null ? '未知' : exit.code}`
                + `${exit.signal ? ` signal=${exit.signal}` : ''}）`;
        } else {
            text.textContent = '未启动';
        }
        if (btnStart) btnStart.disabled = false;
        if (btnStop) btnStop.disabled = true;
    }

    // 端口输入框：用户没改过就用“上次使用的端口”作为默认值
    if (input && !input.dataset.touched && state && state.lastPort) {
        input.value = String(state.lastPort);
    }
    if (state && state.notice) {
        showHint(elements, String(state.notice));
    }
}

/** 拉取并渲染 MCP Server 状态 */
async function refreshMcpStatus(elements: PanelElements): Promise<void> {
    try {
        const state = await callMcpMethod('mcp-status');
        renderMcpState(elements, state);
    } catch (e: any) {
        const text = elements.mcpStatusText;
        if (text) text.textContent = `状态获取失败：${e && e.message ? e.message : String(e)}`;
    }
}

/** 把 check-update 的返回渲染到「版本与更新」区块 */
function renderUpdateState(elements: PanelElements, result: any): void {
    const text = elements.updateStatusText;
    const btnApply = elements.btnApplyUpdate as HTMLButtonElement | null;
    if (!text) return;

    const suffix = result && result.cached ? '（1 小时内缓存）' : '';
    if (result && result.ok) {
        if (result.hasUpdate) {
            text.textContent = `当前 v${result.current} · 最新 v${result.latest}${suffix}，发现新版本！`;
            text.classList.add('update-available');
            if (btnApply) btnApply.disabled = false;
        } else {
            text.textContent = `当前 v${result.current} · 已是最新${suffix}`;
            text.classList.remove('update-available');
            if (btnApply) btnApply.disabled = true;
        }
    } else {
        text.classList.remove('update-available');
        const error = result && result.error ? `：${result.error}` : '';
        text.textContent = `当前 v${result && result.current ? result.current : '?'} · 检查失败${error}`;
        if (btnApply) btnApply.disabled = true;
    }
}

/** 请求检查更新并刷新「版本与更新」区块；force=true 跳过缓存强制联网 */
async function refreshUpdateState(elements: PanelElements, force: boolean): Promise<void> {
    const btnCheck = elements.btnCheckUpdate as HTMLButtonElement | null;
    if (btnCheck) btnCheck.disabled = true;
    try {
        const result = await callMcpMethod('check-update', { force });
        renderUpdateState(elements, result);
        if (!result || !result.ok) {
            const message = result && result.error ? result.error : '未知错误';
            log('panel-update-check', { error: message }, 'warn');
            if (force) showHint(elements, `检查更新失败：${message}`);
        }
    } catch (e: any) {
        renderUpdateState(elements, null);
        if (force) showHint(elements, `检查更新失败：${e && e.message ? e.message : String(e)}`);
    } finally {
        if (btnCheck) btnCheck.disabled = false;
    }
}

/** 重载扩展：能拿到 Editor.Package 就自动做，拿不到就给出人工步骤 */
function reloadExtension(elements: PanelElements): void {
    const pkg = (Editor as any)?.Package;
    let pkgPath = '';
    try {
        pkgPath = pkg?.getPath?.(EXTENSION_NAME) || '';
    } catch (e) {
        pkgPath = '';
    }
    if (!pkg || !pkgPath) {
        showHint(elements,
            '当前面板拿不到 Editor.Package，无法自动重载。请手动操作：' +
            '「开发者 → 扩展管理器」→ 停用 cocos-mcp → 再启用；或直接重启编辑器。');
        return;
    }
    log('panel-reload', { path: pkgPath });
    try {
        pkg.disable(pkgPath);
        // disable 会把扩展主进程干掉，enable 走的是编辑器主进程的消息队列
        pkg.enable(pkgPath);
        showHint(elements, `已重载扩展 ${pkgPath}。若面板被关闭，请重新打开「Cocos MCP 控制台」。`);
    } catch (e: any) {
        showHint(elements, `重载失败：${e && e.message ? e.message : String(e)}`);
    }
}

module.exports = Editor.Panel.define({
    listeners: {
        show() {
            console.log('[cocos-mcp] 面板已显示');
        },
        hide() {
            console.log('[cocos-mcp] 面板已隐藏');
        },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        app: '#app',
        hint: '#hint',
        mcpDot: '#mcp-dot',
        mcpStatusText: '#mcp-status-text',
        btnMcpStart: '#btn-mcp-start',
        btnMcpStop: '#btn-mcp-stop',
        inputMcpPort: '#input-mcp-port',
        btnAgentsMd: '#btn-agents-md',
        updateStatusText: '#update-status-text',
        btnCheckUpdate: '#btn-check-update',
        btnApplyUpdate: '#btn-apply-update',
        btnReload: '#btn-reload',
    },
    ready() {
        const elements = this.$ as unknown as PanelElements;

        try {
            log('panel-ready', { build: PANEL_BUILD, dir: getLogDir() });
        } catch (e) {
            console.warn('[cocos-mcp] 面板日志初始化失败:', e);
        }

        // ---- MCP Server：端口输入 + 启动 / 停止 + 轮询刷新 ----
        const mcpPortInput = elements.inputMcpPort as HTMLInputElement | null;
        if (mcpPortInput) {
            // 用户手动改过端口后，不再被“上次使用的端口”覆盖
            mcpPortInput.addEventListener('input', () => {
                mcpPortInput.dataset.touched = '1';
            });
        }

        const mcpStartButton = elements.btnMcpStart;
        if (mcpStartButton) {
            mcpStartButton.addEventListener('click', () => {
                const port = parseInt((mcpPortInput && mcpPortInput.value) || '3002', 10) || 3002;
                void callMcpMethod('mcp-start', { port }).then((result: any) => {
                    if (result && result.state) renderMcpState(elements, result.state);
                    if (result && !result.ok && result.error) showHint(elements, `启动失败：${result.error}`);
                }).catch((e: any) => {
                    showHint(elements, `启动失败：${e && e.message ? e.message : String(e)}`);
                });
            });
        }

        const mcpStopButton = elements.btnMcpStop;
        if (mcpStopButton) {
            mcpStopButton.addEventListener('click', () => {
                void callMcpMethod('mcp-stop', {}).then((result: any) => {
                    if (result && result.state) renderMcpState(elements, result.state);
                    if (result && !result.ok && result.error) showHint(elements, `停止失败：${result.error}`);
                }).catch((e: any) => {
                    showHint(elements, `停止失败：${e && e.message ? e.message : String(e)}`);
                });
            });
        }

        void refreshMcpStatus(elements);
        mcpTimer = setInterval(() => {
            void refreshMcpStatus(elements);
        }, 2500);

        // ---- AGENTS.md 规范注入 ----
        const agentsMdButton = elements.btnAgentsMd;
        if (agentsMdButton) {
            agentsMdButton.addEventListener('click', () => {
                void callMcpMethod('agents-md-write').then((result: any) => {
                    if (result && result.ok) {
                        const actionText = result.action === 'created' ? '已创建' : result.action === 'updated' ? '已更新' : '已追加';
                        showHint(elements, `${actionText} ${result.file}（${result.bytes} 字节）。AI 助手下次会话会自动读取。`);
                    } else {
                        showHint(elements, `写入失败：${result && result.error ? result.error : '未知错误'}`);
                    }
                }).catch((e: any) => {
                    showHint(elements, `写入失败：${e && e.message ? e.message : String(e)}`);
                });
            });
        }

        // ---- 版本与更新：打开面板自动检查（走缓存），按钮可强制刷新/一键更新 ----
        const btnCheckUpdate = elements.btnCheckUpdate as HTMLButtonElement | null;
        if (btnCheckUpdate) {
            btnCheckUpdate.addEventListener('click', () => {
                void refreshUpdateState(elements, true);
            });
        }

        const btnApplyUpdate = elements.btnApplyUpdate as HTMLButtonElement | null;
        if (btnApplyUpdate) {
            btnApplyUpdate.addEventListener('click', () => {
                if (btnCheckUpdate) btnCheckUpdate.disabled = true;
                btnApplyUpdate.disabled = true;
                const statusText = elements.updateStatusText;
                if (statusText) {
                    statusText.classList.remove('update-available');
                    statusText.textContent = '正在更新：下载 → 解压 → 覆盖扩展目录…（可能需要几十秒）';
                }
                void callMcpMethod('apply-update').then((result: any) => {
                    if (result && result.ok) {
                        renderUpdateState(elements, { ok: true, current: result.to, hasUpdate: false });
                        showHint(elements, `已更新到 v${result.to}，正在重载扩展…${result.notice || ''}`);
                        reloadExtension(elements);
                    } else {
                        showHint(elements, `更新失败：${result && result.error ? result.error : '未知错误'}`);
                        void refreshUpdateState(elements, true);
                    }
                }).catch((e: any) => {
                    showHint(elements, `更新失败：${e && e.message ? e.message : String(e)}`);
                    void refreshUpdateState(elements, true);
                });
            });
        }

        void refreshUpdateState(elements, false);

        // ---- 重载扩展 ----
        const reloadButton = elements.btnReload;
        if (reloadButton) {
            reloadButton.addEventListener('click', () => {
                reloadExtension(elements);
            });
        }

        // 桥自愈：主进程未重载时在面板进程内临时起桥，保证 MCP 可用
        ensureFreshBridge(elements);
    },
    close() {
        if (mcpTimer) {
            clearInterval(mcpTimer);
            mcpTimer = null;
        }
    },
});
