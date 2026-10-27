"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const logger_1 = require("../../logger");
const build_info_1 = require("../../build-info");
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
const DIST_DIR = (0, path_1.join)(__dirname, '..', '..');
/** MCP Server 状态轮询定时器 */
let mcpTimer = null;
/** 顶部提示条（操作结果反馈） */
function showHint(elements, text) {
    const hint = elements.hint;
    if (hint) {
        hint.textContent = text;
        hint.style.display = 'block';
    }
    (0, logger_1.log)('panel-hint', { text });
}
/**
 * 加载 dist 下最新的模块（清掉模块缓存）。
 * 这样扩展主进程还没重载时，面板也能直连最新代码。
 */
function loadDistModuleFresh(file) {
    const selfDir = (0, path_1.join)(__dirname);
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(DIST_DIR) && !key.startsWith(selfDir)) {
            delete require.cache[key];
        }
    }
    return require(file);
}
/** 直连模式：加载最新的 dist/main.js，并顺手把本地 HTTP 桥拉起来（幂等） */
function loadMainFresh() {
    const main = loadDistModuleFresh((0, path_1.join)(DIST_DIR, 'main.js'));
    try {
        if (typeof main.ensureBridge === 'function') {
            main.ensureBridge();
        }
    }
    catch (e) {
        (0, logger_1.log)('panel-bridge', { error: String(e) }, 'warn');
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
function ensureFreshBridge(elements) {
    const file = (0, path_1.join)((0, logger_1.getLogDir)(), 'bridge.json');
    let stale = true;
    let current = '';
    try {
        if ((0, fs_extra_1.existsSync)(file)) {
            const parsed = JSON.parse((0, fs_extra_1.readFileSync)(file, 'utf8'));
            current = parsed.build || '';
            stale = current !== build_info_1.MAIN_BUILD;
        }
    }
    catch (e) {
        stale = true;
    }
    if (!stale) {
        (0, logger_1.log)('panel-bridge', { status: '主进程桥为最新', build: current });
        return;
    }
    try {
        const bridge = loadDistModuleFresh((0, path_1.join)(DIST_DIR, 'bridge.js'));
        bridge.startBridge();
        const info = bridge.getBridge ? bridge.getBridge() : null;
        (0, logger_1.log)('panel-bridge', { status: '已临时启动新桥', port: info && info.port, build: build_info_1.MAIN_BUILD });
        showHint(elements, '扩展主进程尚未重载（桥是旧版 ' + (current || '无') + '）。' +
            '已在面板进程内临时启动新桥，MCP 现在就能用；' +
            '但面板一关桥就断——要长期可用，请点「重载扩展」或在「开发者 → 扩展管理器」里停用/启用 cocos-mcp。');
    }
    catch (e) {
        (0, logger_1.log)('panel-bridge', { error: e && e.message ? e.message : String(e) }, 'error');
        showHint(elements, '临时桥启动失败：' + (e && e.message ? e.message : String(e)));
    }
}
/** 消息名 -> 直连模式下的 methods 方法名 */
const DIRECT_METHOD_MAP = {
    'mcp-start': 'mcpStart',
    'mcp-stop': 'mcpStop',
    'mcp-status': 'mcpStatus',
    'agents-md-write': 'agentsMdWrite',
    'check-update': 'checkUpdate',
    'apply-update': 'applyUpdate',
};
/** 调用扩展主进程的方法，消息通道不通时自动兜底直连 */
async function callMcpMethod(method, args) {
    try {
        return await Editor.Message.request(EXTENSION_NAME, method, args);
    }
    catch (e) {
        const message = e && e.message ? e.message : String(e);
        if (!/does not exist/i.test(message))
            throw e;
        const main = loadMainFresh();
        const fn = main && main.methods && main.methods[DIRECT_METHOD_MAP[method]];
        if (typeof fn !== 'function') {
            throw new Error(`直连模式找不到方法 ${DIRECT_METHOD_MAP[method]}（扩展主进程尚未重载）`);
        }
        return fn(args);
    }
}
/** 把 mcp-status 的返回渲染到 MCP Server 卡片 */
function renderMcpState(elements, state) {
    const dot = elements.mcpDot;
    const text = elements.mcpStatusText;
    const btnStart = elements.btnMcpStart;
    const btnStop = elements.btnMcpStop;
    const input = elements.inputMcpPort;
    if (!dot || !text)
        return;
    if (state && state.running) {
        dot.className = 'status-dot running';
        const parts = [`运行中 · ${state.url}`];
        if (state.pid)
            parts.push(`pid ${state.pid}`);
        if (state.owned === false)
            parts.push('外部实例');
        if (state.endpointAlive === false)
            parts.push('端点无响应');
        text.textContent = parts.join(' · ');
        if (btnStart)
            btnStart.disabled = true;
        if (btnStop)
            btnStop.disabled = false;
    }
    else {
        dot.className = 'status-dot stopped';
        if (state && state.lastExit) {
            const exit = state.lastExit;
            text.textContent = `未启动（上次退出 code=${exit.code === null ? '未知' : exit.code}`
                + `${exit.signal ? ` signal=${exit.signal}` : ''}）`;
        }
        else {
            text.textContent = '未启动';
        }
        if (btnStart)
            btnStart.disabled = false;
        if (btnStop)
            btnStop.disabled = true;
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
async function refreshMcpStatus(elements) {
    try {
        const state = await callMcpMethod('mcp-status');
        renderMcpState(elements, state);
    }
    catch (e) {
        const text = elements.mcpStatusText;
        if (text)
            text.textContent = `状态获取失败：${e && e.message ? e.message : String(e)}`;
    }
}
/** 把 check-update 的返回渲染到「版本与更新」区块 */
function renderUpdateState(elements, result) {
    const text = elements.updateStatusText;
    const btnApply = elements.btnApplyUpdate;
    if (!text)
        return;
    const suffix = result && result.cached ? '（1 小时内缓存）' : '';
    if (result && result.ok) {
        if (result.hasUpdate) {
            text.textContent = `当前 v${result.current} · 最新 v${result.latest}${suffix}，发现新版本！`;
            text.classList.add('update-available');
            if (btnApply)
                btnApply.disabled = false;
        }
        else {
            text.textContent = `当前 v${result.current} · 已是最新${suffix}`;
            text.classList.remove('update-available');
            if (btnApply)
                btnApply.disabled = true;
        }
    }
    else {
        text.classList.remove('update-available');
        const error = result && result.error ? `：${result.error}` : '';
        text.textContent = `当前 v${result && result.current ? result.current : '?'} · 检查失败${error}`;
        if (btnApply)
            btnApply.disabled = true;
    }
}
/** 请求检查更新并刷新「版本与更新」区块；force=true 跳过缓存强制联网 */
async function refreshUpdateState(elements, force) {
    const btnCheck = elements.btnCheckUpdate;
    if (btnCheck)
        btnCheck.disabled = true;
    try {
        const result = await callMcpMethod('check-update', { force });
        renderUpdateState(elements, result);
        if (!result || !result.ok) {
            const message = result && result.error ? result.error : '未知错误';
            (0, logger_1.log)('panel-update-check', { error: message }, 'warn');
            if (force)
                showHint(elements, `检查更新失败：${message}`);
        }
    }
    catch (e) {
        renderUpdateState(elements, null);
        if (force)
            showHint(elements, `检查更新失败：${e && e.message ? e.message : String(e)}`);
    }
    finally {
        if (btnCheck)
            btnCheck.disabled = false;
    }
}
/** 重载扩展：能拿到 Editor.Package 就自动做，拿不到就给出人工步骤 */
function reloadExtension(elements) {
    var _a;
    const pkg = Editor === null || Editor === void 0 ? void 0 : Editor.Package;
    let pkgPath = '';
    try {
        pkgPath = ((_a = pkg === null || pkg === void 0 ? void 0 : pkg.getPath) === null || _a === void 0 ? void 0 : _a.call(pkg, EXTENSION_NAME)) || '';
    }
    catch (e) {
        pkgPath = '';
    }
    if (!pkg || !pkgPath) {
        showHint(elements, '当前面板拿不到 Editor.Package，无法自动重载。请手动操作：' +
            '「开发者 → 扩展管理器」→ 停用 cocos-mcp → 再启用；或直接重启编辑器。');
        return;
    }
    (0, logger_1.log)('panel-reload', { path: pkgPath });
    try {
        pkg.disable(pkgPath);
        // disable 会把扩展主进程干掉，enable 走的是编辑器主进程的消息队列
        pkg.enable(pkgPath);
        showHint(elements, `已重载扩展 ${pkgPath}。若面板被关闭，请重新打开「Cocos MCP 控制台」。`);
    }
    catch (e) {
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
    template: (0, fs_extra_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: (0, fs_extra_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
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
        const elements = this.$;
        try {
            (0, logger_1.log)('panel-ready', { build: build_info_1.PANEL_BUILD, dir: (0, logger_1.getLogDir)() });
        }
        catch (e) {
            console.warn('[cocos-mcp] 面板日志初始化失败:', e);
        }
        // ---- MCP Server：端口输入 + 启动 / 停止 + 轮询刷新 ----
        const mcpPortInput = elements.inputMcpPort;
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
                void callMcpMethod('mcp-start', { port }).then((result) => {
                    if (result && result.state)
                        renderMcpState(elements, result.state);
                    if (result && !result.ok && result.error)
                        showHint(elements, `启动失败：${result.error}`);
                }).catch((e) => {
                    showHint(elements, `启动失败：${e && e.message ? e.message : String(e)}`);
                });
            });
        }
        const mcpStopButton = elements.btnMcpStop;
        if (mcpStopButton) {
            mcpStopButton.addEventListener('click', () => {
                void callMcpMethod('mcp-stop', {}).then((result) => {
                    if (result && result.state)
                        renderMcpState(elements, result.state);
                    if (result && !result.ok && result.error)
                        showHint(elements, `停止失败：${result.error}`);
                }).catch((e) => {
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
                void callMcpMethod('agents-md-write').then((result) => {
                    if (result && result.ok) {
                        const actionText = result.action === 'created' ? '已创建' : result.action === 'updated' ? '已更新' : '已追加';
                        showHint(elements, `${actionText} ${result.file}（${result.bytes} 字节）。AI 助手下次会话会自动读取。`);
                    }
                    else {
                        showHint(elements, `写入失败：${result && result.error ? result.error : '未知错误'}`);
                    }
                }).catch((e) => {
                    showHint(elements, `写入失败：${e && e.message ? e.message : String(e)}`);
                });
            });
        }
        // ---- 版本与更新：打开面板自动检查（走缓存），按钮可强制刷新/一键更新 ----
        const btnCheckUpdate = elements.btnCheckUpdate;
        if (btnCheckUpdate) {
            btnCheckUpdate.addEventListener('click', () => {
                void refreshUpdateState(elements, true);
            });
        }
        const btnApplyUpdate = elements.btnApplyUpdate;
        if (btnApplyUpdate) {
            btnApplyUpdate.addEventListener('click', () => {
                if (btnCheckUpdate)
                    btnCheckUpdate.disabled = true;
                btnApplyUpdate.disabled = true;
                const statusText = elements.updateStatusText;
                if (statusText) {
                    statusText.classList.remove('update-available');
                    statusText.textContent = '正在更新：下载 → 解压 → 覆盖扩展目录…（可能需要几十秒）';
                }
                void callMcpMethod('apply-update').then((result) => {
                    if (result && result.ok) {
                        renderUpdateState(elements, { ok: true, current: result.to, hasUpdate: false });
                        showHint(elements, `已更新到 v${result.to}，正在重载扩展…${result.notice || ''}`);
                        reloadExtension(elements);
                    }
                    else {
                        showHint(elements, `更新失败：${result && result.error ? result.error : '未知错误'}`);
                        void refreshUpdateState(elements, true);
                    }
                }).catch((e) => {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx1Q0FBb0Q7QUFDcEQsK0JBQTRCO0FBQzVCLHlDQUE4QztBQUM5QyxpREFBMkQ7QUFFM0Q7Ozs7Ozs7Ozs7O0dBV0c7QUFFSCxNQUFNLGNBQWMsR0FBRyxXQUFXLENBQUM7QUFFbkMsd0JBQXdCO0FBQ3hCLE1BQU0sUUFBUSxHQUFHLElBQUEsV0FBSSxFQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFNN0MseUJBQXlCO0FBQ3pCLElBQUksUUFBUSxHQUFRLElBQUksQ0FBQztBQUV6QixvQkFBb0I7QUFDcEIsU0FBUyxRQUFRLENBQUMsUUFBdUIsRUFBRSxJQUFZO0lBQ25ELE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUM7SUFDM0IsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUNQLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztJQUNqQyxDQUFDO0lBQ0QsSUFBQSxZQUFHLEVBQUMsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxtQkFBbUIsQ0FBQyxJQUFZO0lBQ3JDLE1BQU0sT0FBTyxHQUFHLElBQUEsV0FBSSxFQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ2hDLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUMzQyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDdkQsT0FBTyxP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Q0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztvQkFDckUsS0FBSyxrQkFBa0IsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLENBQUM7Z0JBQzVDLENBQUMsQ0FBQyxDQUFDO1lBQ1AsQ0FBQyxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsS0FBSyxrQkFBa0IsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFekMsaUJBQWlCO1FBQ2pCLE1BQU0sWUFBWSxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUM7UUFDeEMsSUFBSSxZQUFZLEVBQUUsQ0FBQztZQUNmLFlBQVksQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFO2dCQUN4QyxlQUFlLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDOUIsQ0FBQyxDQUFDLENBQUM7UUFDUCxDQUFDO1FBRUQsa0NBQWtDO1FBQ2xDLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFDRCxLQUFLO1FBQ0QsSUFBSSxRQUFRLEVBQUUsQ0FBQztZQUNYLGFBQWEsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN4QixRQUFRLEdBQUcsSUFBSSxDQUFDO1FBQ3BCLENBQUM7SUFDTCxDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSAnZnMtZXh0cmEnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgbG9nLCBnZXRMb2dEaXIgfSBmcm9tICcuLi8uLi9sb2dnZXInO1xuaW1wb3J0IHsgTUFJTl9CVUlMRCwgUEFORUxfQlVJTEQgfSBmcm9tICcuLi8uLi9idWlsZC1pbmZvJztcblxuLyoqXG4gKiBDb2NvcyBNQ1Ag5o6n5Yi26Z2i5p2/XG4gKlxuICog6Z2i5p2/5LiN5ZCr5Lia5Yqh6YC76L6R77yM5Y+q5o+Q5L6b5Zub5Lu25LqL77yaXG4gKiAgMS4g5ZCv5YqoIC8g5YGc5q2iIE1DUCBTZXJ2ZXLvvIjnirbmgIHmr48gMi41IOenkuiHquWKqOWIt+aWsO+8ie+8m1xuICogIDIuIOaKiuiuvuiuoeinhOiMg+WGmeWFpemhueebruaguSBBR0VOVFMubWTvvJtcbiAqICAzLiDmo4Dmn6Xmm7TmlrAgLyDkuIDplK7mm7TmlrDvvIjmm7TmlrDlkI7oh6rliqjph43ovb3mianlsZXvvInvvJtcbiAqICA0LiDph43ovb3mianlsZXjgIJcbiAqXG4gKiDlhajpg6jpgJrov4fmtojmga/osIPnlKjmianlsZXkuLvov5vnqIvvvJvmtojmga/pgJrpgZPkuI3pgJrvvIjkuLvov5vnqIvlsJrmnKrph43ovb3vvInml7ZcbiAqIOiHquWKqOWFnOW6leebtOi/nuacgOaWsOeahCBkaXN0L21haW4uanPvvIzmlLnlrozku6PnoIHkuI3ph43lkK/nvJbovpHlmajkuZ/og73nlKjjgIJcbiAqL1xuXG5jb25zdCBFWFRFTlNJT05fTkFNRSA9ICdjb2Nvcy1tY3AnO1xuXG4vKiogZGlzdCDnm67lvZXvvJo85omp5bGVPi9kaXN0ICovXG5jb25zdCBESVNUX0RJUiA9IGpvaW4oX19kaXJuYW1lLCAnLi4nLCAnLi4nKTtcblxuaW50ZXJmYWNlIFBhbmVsRWxlbWVudHMge1xuICAgIFtrZXk6IHN0cmluZ106IEhUTUxFbGVtZW50IHwgbnVsbDtcbn1cblxuLyoqIE1DUCBTZXJ2ZXIg54q25oCB6L2u6K+i5a6a5pe25ZmoICovXG5sZXQgbWNwVGltZXI6IGFueSA9IG51bGw7XG5cbi8qKiDpobbpg6jmj5DnpLrmnaHvvIjmk43kvZznu5Pmnpzlj43ppojvvIkgKi9cbmZ1bmN0aW9uIHNob3dIaW50KGVsZW1lbnRzOiBQYW5lbEVsZW1lbnRzLCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBoaW50ID0gZWxlbWVudHMuaGludDtcbiAgICBpZiAoaGludCkge1xuICAgICAgICBoaW50LnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgICAgaGludC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICB9XG4gICAgbG9nKCdwYW5lbC1oaW50JywgeyB0ZXh0IH0pO1xufVxuXG4vKipcbiAqIOWKoOi9vSBkaXN0IOS4i+acgOaWsOeahOaooeWdl++8iOa4heaOieaooeWdl+e8k+WtmO+8ieOAglxuICog6L+Z5qC35omp5bGV5Li76L+b56iL6L+Y5rKh6YeN6L295pe277yM6Z2i5p2/5Lmf6IO955u06L+e5pyA5paw5Luj56CB44CCXG4gKi9cbmZ1bmN0aW9uIGxvYWREaXN0TW9kdWxlRnJlc2goZmlsZTogc3RyaW5nKTogYW55IHtcbiAgICBjb25zdCBzZWxmRGlyID0gam9pbihfX2Rpcm5hbWUpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHJlcXVpcmUuY2FjaGUpKSB7XG4gICAgICAgIGlmIChrZXkuc3RhcnRzV2l0aChESVNUX0RJUikgJiYgIWtleS5zdGFydHNXaXRoKHNlbGZEaXIpKSB7XG4gICAgICAgICAgICBkZWxldGUgcmVxdWlyZS5jYWNoZVtrZXldO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXF1aXJlKGZpbGUpO1xufVxuXG4vKiog55u06L+e5qih5byP77ya5Yqg6L295pyA5paw55qEIGRpc3QvbWFpbi5qc++8jOW5tumhuuaJi+aKiuacrOWcsCBIVFRQIOahpeaLiei1t+adpe+8iOW5guetie+8iSAqL1xuZnVuY3Rpb24gbG9hZE1haW5GcmVzaCgpOiBhbnkge1xuICAgIGNvbnN0IG1haW4gPSBsb2FkRGlzdE1vZHVsZUZyZXNoKGpvaW4oRElTVF9ESVIsICdtYWluLmpzJykpO1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgbWFpbi5lbnN1cmVCcmlkZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIG1haW4uZW5zdXJlQnJpZGdlKCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZygncGFuZWwtYnJpZGdlJywgeyBlcnJvcjogU3RyaW5nKGUpIH0sICd3YXJuJyk7XG4gICAgfVxuICAgIHJldHVybiBtYWluO1xufVxuXG4vKipcbiAqIOahpeiHquaEiO+8mlxuICog5qGl5q2j5bi45bqU6K+l6LeR5Zyo5omp5bGV5Li76L+b56iL6YeM77yI55Sf5ZG95ZGo5pyfID0g57yW6L6R5Zmo77yJ44CCXG4gKiDlpoLmnpzmianlsZXkuLvov5vnqIvov5jmsqHph43ovb3vvIznq6/lj6Pmlofku7bph4znmoQgYnVpbGQg5Lya5q+U5b2T5YmN5Luj56CB5pen77yMXG4gKiDov5nml7blnKjpnaLmnb/ov5vnqIvlhoXkuLTml7botbfkuIDkuKrmlrDmoaXvvIjluKYgb3BlcmF0aW9ucyDng63liqDovb3vvInvvIzorqkgTUNQIOeri+WIu+WPr+eUqOOAglxuICog5Luj5Lu377ya6Z2i5p2/5YWz5o6J5qGl5bCx5pat77yM5omA5Lul5Lya5o+Q56S655So5oi35Y676YeN6L295omp5bGV44CCXG4gKi9cbmZ1bmN0aW9uIGVuc3VyZUZyZXNoQnJpZGdlKGVsZW1lbnRzOiBQYW5lbEVsZW1lbnRzKTogdm9pZCB7XG4gICAgY29uc3QgZmlsZSA9IGpvaW4oZ2V0TG9nRGlyKCksICdicmlkZ2UuanNvbicpO1xuICAgIGxldCBzdGFsZSA9IHRydWU7XG4gICAgbGV0IGN1cnJlbnQgPSAnJztcbiAgICB0cnkge1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhmaWxlKSkge1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKSk7XG4gICAgICAgICAgICBjdXJyZW50ID0gcGFyc2VkLmJ1aWxkIHx8ICcnO1xuICAgICAgICAgICAgc3RhbGUgPSBjdXJyZW50ICE9PSBNQUlOX0JVSUxEO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBzdGFsZSA9IHRydWU7XG4gICAgfVxuXG4gICAgaWYgKCFzdGFsZSkge1xuICAgICAgICBsb2coJ3BhbmVsLWJyaWRnZScsIHsgc3RhdHVzOiAn5Li76L+b56iL5qGl5Li65pyA5pawJywgYnVpbGQ6IGN1cnJlbnQgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBicmlkZ2UgPSBsb2FkRGlzdE1vZHVsZUZyZXNoKGpvaW4oRElTVF9ESVIsICdicmlkZ2UuanMnKSk7XG4gICAgICAgIGJyaWRnZS5zdGFydEJyaWRnZSgpO1xuICAgICAgICBjb25zdCBpbmZvID0gYnJpZGdlLmdldEJyaWRnZSA/IGJyaWRnZS5nZXRCcmlkZ2UoKSA6IG51bGw7XG4gICAgICAgIGxvZygncGFuZWwtYnJpZGdlJywgeyBzdGF0dXM6ICflt7LkuLTml7blkK/liqjmlrDmoaUnLCBwb3J0OiBpbmZvICYmIGluZm8ucG9ydCwgYnVpbGQ6IE1BSU5fQlVJTEQgfSk7XG4gICAgICAgIHNob3dIaW50KGVsZW1lbnRzLFxuICAgICAgICAgICAgJ+aJqeWxleS4u+i/m+eoi+WwmuacqumHjei9ve+8iOahpeaYr+aXp+eJiCAnICsgKGN1cnJlbnQgfHwgJ+aXoCcpICsgJ++8ieOAgicgK1xuICAgICAgICAgICAgJ+W3suWcqOmdouadv+i/m+eoi+WGheS4tOaXtuWQr+WKqOaWsOahpe+8jE1DUCDnjrDlnKjlsLHog73nlKjvvJsnICtcbiAgICAgICAgICAgICfkvYbpnaLmnb/kuIDlhbPmoaXlsLHmlq3igJTigJTopoHplb/mnJ/lj6/nlKjvvIzor7fngrnjgIzph43ovb3mianlsZXjgI3miJblnKjjgIzlvIDlj5HogIUg4oaSIOaJqeWxleeuoeeQhuWZqOOAjemHjOWBnOeUqC/lkK/nlKggY29jb3MtbWNw44CCJyk7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIGxvZygncGFuZWwtYnJpZGdlJywgeyBlcnJvcjogZSAmJiBlLm1lc3NhZ2UgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSwgJ2Vycm9yJyk7XG4gICAgICAgIHNob3dIaW50KGVsZW1lbnRzLCAn5Li05pe25qGl5ZCv5Yqo5aSx6LSl77yaJyArIChlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSkpO1xuICAgIH1cbn1cblxuLyoqIOa2iOaBr+WQjSAtPiDnm7Tov57mqKHlvI/kuIvnmoQgbWV0aG9kcyDmlrnms5XlkI0gKi9cbmNvbnN0IERJUkVDVF9NRVRIT0RfTUFQOiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9ID0ge1xuICAgICdtY3Atc3RhcnQnOiAnbWNwU3RhcnQnLFxuICAgICdtY3Atc3RvcCc6ICdtY3BTdG9wJyxcbiAgICAnbWNwLXN0YXR1cyc6ICdtY3BTdGF0dXMnLFxuICAgICdhZ2VudHMtbWQtd3JpdGUnOiAnYWdlbnRzTWRXcml0ZScsXG4gICAgJ2NoZWNrLXVwZGF0ZSc6ICdjaGVja1VwZGF0ZScsXG4gICAgJ2FwcGx5LXVwZGF0ZSc6ICdhcHBseVVwZGF0ZScsXG59O1xuXG4vKiog6LCD55So5omp5bGV5Li76L+b56iL55qE5pa55rOV77yM5raI5oGv6YCa6YGT5LiN6YCa5pe26Ieq5Yqo5YWc5bqV55u06L+eICovXG5hc3luYyBmdW5jdGlvbiBjYWxsTWNwTWV0aG9kKG1ldGhvZDogc3RyaW5nLCBhcmdzPzogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChFWFRFTlNJT05fTkFNRSwgbWV0aG9kLCBhcmdzKTtcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGUgJiYgZS5tZXNzYWdlID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgICAgICBpZiAoIS9kb2VzIG5vdCBleGlzdC9pLnRlc3QobWVzc2FnZSkpIHRocm93IGU7XG4gICAgICAgIGNvbnN0IG1haW4gPSBsb2FkTWFpbkZyZXNoKCk7XG4gICAgICAgIGNvbnN0IGZuID0gbWFpbiAmJiBtYWluLm1ldGhvZHMgJiYgbWFpbi5tZXRob2RzW0RJUkVDVF9NRVRIT0RfTUFQW21ldGhvZF1dO1xuICAgICAgICBpZiAodHlwZW9mIGZuICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebtOi/nuaooeW8j+aJvuS4jeWIsOaWueazlSAke0RJUkVDVF9NRVRIT0RfTUFQW21ldGhvZF1977yI5omp5bGV5Li76L+b56iL5bCa5pyq6YeN6L2977yJYCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZuKGFyZ3MpO1xuICAgIH1cbn1cblxuLyoqIOaKiiBtY3Atc3RhdHVzIOeahOi/lOWbnua4suafk+WIsCBNQ1AgU2VydmVyIOWNoeeJhyAqL1xuZnVuY3Rpb24gcmVuZGVyTWNwU3RhdGUoZWxlbWVudHM6IFBhbmVsRWxlbWVudHMsIHN0YXRlOiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCBkb3QgPSBlbGVtZW50cy5tY3BEb3Q7XG4gICAgY29uc3QgdGV4dCA9IGVsZW1lbnRzLm1jcFN0YXR1c1RleHQ7XG4gICAgY29uc3QgYnRuU3RhcnQgPSBlbGVtZW50cy5idG5NY3BTdGFydCBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgY29uc3QgYnRuU3RvcCA9IGVsZW1lbnRzLmJ0bk1jcFN0b3AgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudHMuaW5wdXRNY3BQb3J0IGFzIEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsO1xuICAgIGlmICghZG90IHx8ICF0ZXh0KSByZXR1cm47XG5cbiAgICBpZiAoc3RhdGUgJiYgc3RhdGUucnVubmluZykge1xuICAgICAgICBkb3QuY2xhc3NOYW1lID0gJ3N0YXR1cy1kb3QgcnVubmluZyc7XG4gICAgICAgIGNvbnN0IHBhcnRzID0gW2Dov5DooYzkuK0gwrcgJHtzdGF0ZS51cmx9YF07XG4gICAgICAgIGlmIChzdGF0ZS5waWQpIHBhcnRzLnB1c2goYHBpZCAke3N0YXRlLnBpZH1gKTtcbiAgICAgICAgaWYgKHN0YXRlLm93bmVkID09PSBmYWxzZSkgcGFydHMucHVzaCgn5aSW6YOo5a6e5L6LJyk7XG4gICAgICAgIGlmIChzdGF0ZS5lbmRwb2ludEFsaXZlID09PSBmYWxzZSkgcGFydHMucHVzaCgn56uv54K55peg5ZON5bqUJyk7XG4gICAgICAgIHRleHQudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKCcgwrcgJyk7XG4gICAgICAgIGlmIChidG5TdGFydCkgYnRuU3RhcnQuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBpZiAoYnRuU3RvcCkgYnRuU3RvcC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGRvdC5jbGFzc05hbWUgPSAnc3RhdHVzLWRvdCBzdG9wcGVkJztcbiAgICAgICAgaWYgKHN0YXRlICYmIHN0YXRlLmxhc3RFeGl0KSB7XG4gICAgICAgICAgICBjb25zdCBleGl0ID0gc3RhdGUubGFzdEV4aXQ7XG4gICAgICAgICAgICB0ZXh0LnRleHRDb250ZW50ID0gYOacquWQr+WKqO+8iOS4iuasoemAgOWHuiBjb2RlPSR7ZXhpdC5jb2RlID09PSBudWxsID8gJ+acquefpScgOiBleGl0LmNvZGV9YFxuICAgICAgICAgICAgICAgICsgYCR7ZXhpdC5zaWduYWwgPyBgIHNpZ25hbD0ke2V4aXQuc2lnbmFsfWAgOiAnJ33vvIlgO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGV4dC50ZXh0Q29udGVudCA9ICfmnKrlkK/liqgnO1xuICAgICAgICB9XG4gICAgICAgIGlmIChidG5TdGFydCkgYnRuU3RhcnQuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKGJ0blN0b3ApIGJ0blN0b3AuZGlzYWJsZWQgPSB0cnVlO1xuICAgIH1cblxuICAgIC8vIOerr+WPo+i+k+WFpeahhu+8mueUqOaIt+ayoeaUuei/h+WwseeUqOKAnOS4iuasoeS9v+eUqOeahOerr+WPo+KAneS9nOS4uum7mOiupOWAvFxuICAgIGlmIChpbnB1dCAmJiAhaW5wdXQuZGF0YXNldC50b3VjaGVkICYmIHN0YXRlICYmIHN0YXRlLmxhc3RQb3J0KSB7XG4gICAgICAgIGlucHV0LnZhbHVlID0gU3RyaW5nKHN0YXRlLmxhc3RQb3J0KTtcbiAgICB9XG4gICAgaWYgKHN0YXRlICYmIHN0YXRlLm5vdGljZSkge1xuICAgICAgICBzaG93SGludChlbGVtZW50cywgU3RyaW5nKHN0YXRlLm5vdGljZSkpO1xuICAgIH1cbn1cblxuLyoqIOaLieWPluW5tua4suafkyBNQ1AgU2VydmVyIOeKtuaAgSAqL1xuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaE1jcFN0YXR1cyhlbGVtZW50czogUGFuZWxFbGVtZW50cyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgY2FsbE1jcE1ldGhvZCgnbWNwLXN0YXR1cycpO1xuICAgICAgICByZW5kZXJNY3BTdGF0ZShlbGVtZW50cywgc3RhdGUpO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZWxlbWVudHMubWNwU3RhdHVzVGV4dDtcbiAgICAgICAgaWYgKHRleHQpIHRleHQudGV4dENvbnRlbnQgPSBg54q25oCB6I635Y+W5aSx6LSl77yaJHtlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gO1xuICAgIH1cbn1cblxuLyoqIOaKiiBjaGVjay11cGRhdGUg55qE6L+U5Zue5riy5p+T5Yiw44CM54mI5pys5LiO5pu05paw44CN5Yy65Z2XICovXG5mdW5jdGlvbiByZW5kZXJVcGRhdGVTdGF0ZShlbGVtZW50czogUGFuZWxFbGVtZW50cywgcmVzdWx0OiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCB0ZXh0ID0gZWxlbWVudHMudXBkYXRlU3RhdHVzVGV4dDtcbiAgICBjb25zdCBidG5BcHBseSA9IGVsZW1lbnRzLmJ0bkFwcGx5VXBkYXRlIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgICBpZiAoIXRleHQpIHJldHVybjtcblxuICAgIGNvbnN0IHN1ZmZpeCA9IHJlc3VsdCAmJiByZXN1bHQuY2FjaGVkID8gJ++8iDEg5bCP5pe25YaF57yT5a2Y77yJJyA6ICcnO1xuICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0Lm9rKSB7XG4gICAgICAgIGlmIChyZXN1bHQuaGFzVXBkYXRlKSB7XG4gICAgICAgICAgICB0ZXh0LnRleHRDb250ZW50ID0gYOW9k+WJjSB2JHtyZXN1bHQuY3VycmVudH0gwrcg5pyA5pawIHYke3Jlc3VsdC5sYXRlc3R9JHtzdWZmaXh977yM5Y+R546w5paw54mI5pys77yBYDtcbiAgICAgICAgICAgIHRleHQuY2xhc3NMaXN0LmFkZCgndXBkYXRlLWF2YWlsYWJsZScpO1xuICAgICAgICAgICAgaWYgKGJ0bkFwcGx5KSBidG5BcHBseS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGV4dC50ZXh0Q29udGVudCA9IGDlvZPliY0gdiR7cmVzdWx0LmN1cnJlbnR9IMK3IOW3suaYr+acgOaWsCR7c3VmZml4fWA7XG4gICAgICAgICAgICB0ZXh0LmNsYXNzTGlzdC5yZW1vdmUoJ3VwZGF0ZS1hdmFpbGFibGUnKTtcbiAgICAgICAgICAgIGlmIChidG5BcHBseSkgYnRuQXBwbHkuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGV4dC5jbGFzc0xpc3QucmVtb3ZlKCd1cGRhdGUtYXZhaWxhYmxlJyk7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzdWx0ICYmIHJlc3VsdC5lcnJvciA/IGDvvJoke3Jlc3VsdC5lcnJvcn1gIDogJyc7XG4gICAgICAgIHRleHQudGV4dENvbnRlbnQgPSBg5b2T5YmNIHYke3Jlc3VsdCAmJiByZXN1bHQuY3VycmVudCA/IHJlc3VsdC5jdXJyZW50IDogJz8nfSDCtyDmo4Dmn6XlpLHotKUke2Vycm9yfWA7XG4gICAgICAgIGlmIChidG5BcHBseSkgYnRuQXBwbHkuZGlzYWJsZWQgPSB0cnVlO1xuICAgIH1cbn1cblxuLyoqIOivt+axguajgOafpeabtOaWsOW5tuWIt+aWsOOAjOeJiOacrOS4juabtOaWsOOAjeWMuuWdl++8m2ZvcmNlPXRydWUg6Lez6L+H57yT5a2Y5by65Yi26IGU572RICovXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoVXBkYXRlU3RhdGUoZWxlbWVudHM6IFBhbmVsRWxlbWVudHMsIGZvcmNlOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgYnRuQ2hlY2sgPSBlbGVtZW50cy5idG5DaGVja1VwZGF0ZSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgaWYgKGJ0bkNoZWNrKSBidG5DaGVjay5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FsbE1jcE1ldGhvZCgnY2hlY2stdXBkYXRlJywgeyBmb3JjZSB9KTtcbiAgICAgICAgcmVuZGVyVXBkYXRlU3RhdGUoZWxlbWVudHMsIHJlc3VsdCk7XG4gICAgICAgIGlmICghcmVzdWx0IHx8ICFyZXN1bHQub2spIHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSByZXN1bHQgJiYgcmVzdWx0LmVycm9yID8gcmVzdWx0LmVycm9yIDogJ+acquefpemUmeivryc7XG4gICAgICAgICAgICBsb2coJ3BhbmVsLXVwZGF0ZS1jaGVjaycsIHsgZXJyb3I6IG1lc3NhZ2UgfSwgJ3dhcm4nKTtcbiAgICAgICAgICAgIGlmIChmb3JjZSkgc2hvd0hpbnQoZWxlbWVudHMsIGDmo4Dmn6Xmm7TmlrDlpLHotKXvvJoke21lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgcmVuZGVyVXBkYXRlU3RhdGUoZWxlbWVudHMsIG51bGwpO1xuICAgICAgICBpZiAoZm9yY2UpIHNob3dIaW50KGVsZW1lbnRzLCBg5qOA5p+l5pu05paw5aSx6LSl77yaJHtlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAoYnRuQ2hlY2spIGJ0bkNoZWNrLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxufVxuXG4vKiog6YeN6L295omp5bGV77ya6IO95ou/5YiwIEVkaXRvci5QYWNrYWdlIOWwseiHquWKqOWBmu+8jOaLv+S4jeWIsOWwsee7meWHuuS6uuW3peatpemqpCAqL1xuZnVuY3Rpb24gcmVsb2FkRXh0ZW5zaW9uKGVsZW1lbnRzOiBQYW5lbEVsZW1lbnRzKTogdm9pZCB7XG4gICAgY29uc3QgcGtnID0gKEVkaXRvciBhcyBhbnkpPy5QYWNrYWdlO1xuICAgIGxldCBwa2dQYXRoID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgICAgcGtnUGF0aCA9IHBrZz8uZ2V0UGF0aD8uKEVYVEVOU0lPTl9OQU1FKSB8fCAnJztcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHBrZ1BhdGggPSAnJztcbiAgICB9XG4gICAgaWYgKCFwa2cgfHwgIXBrZ1BhdGgpIHtcbiAgICAgICAgc2hvd0hpbnQoZWxlbWVudHMsXG4gICAgICAgICAgICAn5b2T5YmN6Z2i5p2/5ou/5LiN5YiwIEVkaXRvci5QYWNrYWdl77yM5peg5rOV6Ieq5Yqo6YeN6L2944CC6K+35omL5Yqo5pON5L2c77yaJyArXG4gICAgICAgICAgICAn44CM5byA5Y+R6ICFIOKGkiDmianlsZXnrqHnkIblmajjgI3ihpIg5YGc55SoIGNvY29zLW1jcCDihpIg5YaN5ZCv55So77yb5oiW55u05o6l6YeN5ZCv57yW6L6R5Zmo44CCJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbG9nKCdwYW5lbC1yZWxvYWQnLCB7IHBhdGg6IHBrZ1BhdGggfSk7XG4gICAgdHJ5IHtcbiAgICAgICAgcGtnLmRpc2FibGUocGtnUGF0aCk7XG4gICAgICAgIC8vIGRpc2FibGUg5Lya5oqK5omp5bGV5Li76L+b56iL5bmy5o6J77yMZW5hYmxlIOi1sOeahOaYr+e8lui+keWZqOS4u+i/m+eoi+eahOa2iOaBr+mYn+WIl1xuICAgICAgICBwa2cuZW5hYmxlKHBrZ1BhdGgpO1xuICAgICAgICBzaG93SGludChlbGVtZW50cywgYOW3sumHjei9veaJqeWxlSAke3BrZ1BhdGh944CC6Iul6Z2i5p2/6KKr5YWz6Zet77yM6K+36YeN5paw5omT5byA44CMQ29jb3MgTUNQIOaOp+WItuWPsOOAjeOAgmApO1xuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICBzaG93SGludChlbGVtZW50cywgYOmHjei9veWksei0pe+8miR7ZSAmJiBlLm1lc3NhZ2UgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVkaXRvci5QYW5lbC5kZWZpbmUoe1xuICAgIGxpc3RlbmVyczoge1xuICAgICAgICBzaG93KCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1tjb2Nvcy1tY3BdIOmdouadv+W3suaYvuekuicpO1xuICAgICAgICB9LFxuICAgICAgICBoaWRlKCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1tjb2Nvcy1tY3BdIOmdouadv+W3sumakOiXjycpO1xuICAgICAgICB9LFxuICAgIH0sXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0Zi04JyksXG4gICAgc3R5bGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy9zdHlsZS9kZWZhdWx0L2luZGV4LmNzcycpLCAndXRmLTgnKSxcbiAgICAkOiB7XG4gICAgICAgIGFwcDogJyNhcHAnLFxuICAgICAgICBoaW50OiAnI2hpbnQnLFxuICAgICAgICBtY3BEb3Q6ICcjbWNwLWRvdCcsXG4gICAgICAgIG1jcFN0YXR1c1RleHQ6ICcjbWNwLXN0YXR1cy10ZXh0JyxcbiAgICAgICAgYnRuTWNwU3RhcnQ6ICcjYnRuLW1jcC1zdGFydCcsXG4gICAgICAgIGJ0bk1jcFN0b3A6ICcjYnRuLW1jcC1zdG9wJyxcbiAgICAgICAgaW5wdXRNY3BQb3J0OiAnI2lucHV0LW1jcC1wb3J0JyxcbiAgICAgICAgYnRuQWdlbnRzTWQ6ICcjYnRuLWFnZW50cy1tZCcsXG4gICAgICAgIHVwZGF0ZVN0YXR1c1RleHQ6ICcjdXBkYXRlLXN0YXR1cy10ZXh0JyxcbiAgICAgICAgYnRuQ2hlY2tVcGRhdGU6ICcjYnRuLWNoZWNrLXVwZGF0ZScsXG4gICAgICAgIGJ0bkFwcGx5VXBkYXRlOiAnI2J0bi1hcHBseS11cGRhdGUnLFxuICAgICAgICBidG5SZWxvYWQ6ICcjYnRuLXJlbG9hZCcsXG4gICAgfSxcbiAgICByZWFkeSgpIHtcbiAgICAgICAgY29uc3QgZWxlbWVudHMgPSB0aGlzLiQgYXMgdW5rbm93biBhcyBQYW5lbEVsZW1lbnRzO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsb2coJ3BhbmVsLXJlYWR5JywgeyBidWlsZDogUEFORUxfQlVJTEQsIGRpcjogZ2V0TG9nRGlyKCkgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybignW2NvY29zLW1jcF0g6Z2i5p2/5pel5b+X5Yid5aeL5YyW5aSx6LSlOicsIGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gLS0tLSBNQ1AgU2VydmVy77ya56uv5Y+j6L6T5YWlICsg5ZCv5YqoIC8g5YGc5q2iICsg6L2u6K+i5Yi35pawIC0tLS1cbiAgICAgICAgY29uc3QgbWNwUG9ydElucHV0ID0gZWxlbWVudHMuaW5wdXRNY3BQb3J0IGFzIEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsO1xuICAgICAgICBpZiAobWNwUG9ydElucHV0KSB7XG4gICAgICAgICAgICAvLyDnlKjmiLfmiYvliqjmlLnov4fnq6/lj6PlkI7vvIzkuI3lho3ooqvigJzkuIrmrKHkvb/nlKjnmoTnq6/lj6PigJ3opobnm5ZcbiAgICAgICAgICAgIG1jcFBvcnRJbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgICAgICAgICAgICBtY3BQb3J0SW5wdXQuZGF0YXNldC50b3VjaGVkID0gJzEnO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBtY3BTdGFydEJ1dHRvbiA9IGVsZW1lbnRzLmJ0bk1jcFN0YXJ0O1xuICAgICAgICBpZiAobWNwU3RhcnRCdXR0b24pIHtcbiAgICAgICAgICAgIG1jcFN0YXJ0QnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvcnQgPSBwYXJzZUludCgobWNwUG9ydElucHV0ICYmIG1jcFBvcnRJbnB1dC52YWx1ZSkgfHwgJzMwMDInLCAxMCkgfHwgMzAwMjtcbiAgICAgICAgICAgICAgICB2b2lkIGNhbGxNY3BNZXRob2QoJ21jcC1zdGFydCcsIHsgcG9ydCB9KS50aGVuKChyZXN1bHQ6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVzdWx0ICYmIHJlc3VsdC5zdGF0ZSkgcmVuZGVyTWNwU3RhdGUoZWxlbWVudHMsIHJlc3VsdC5zdGF0ZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQgJiYgIXJlc3VsdC5vayAmJiByZXN1bHQuZXJyb3IpIHNob3dIaW50KGVsZW1lbnRzLCBg5ZCv5Yqo5aSx6LSl77yaJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goKGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYOWQr+WKqOWksei0pe+8miR7ZSAmJiBlLm1lc3NhZ2UgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG1jcFN0b3BCdXR0b24gPSBlbGVtZW50cy5idG5NY3BTdG9wO1xuICAgICAgICBpZiAobWNwU3RvcEJ1dHRvbikge1xuICAgICAgICAgICAgbWNwU3RvcEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICB2b2lkIGNhbGxNY3BNZXRob2QoJ21jcC1zdG9wJywge30pLnRoZW4oKHJlc3VsdDogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0LnN0YXRlKSByZW5kZXJNY3BTdGF0ZShlbGVtZW50cywgcmVzdWx0LnN0YXRlKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlc3VsdCAmJiAhcmVzdWx0Lm9rICYmIHJlc3VsdC5lcnJvcikgc2hvd0hpbnQoZWxlbWVudHMsIGDlgZzmraLlpLHotKXvvJoke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaCgoZTogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHNob3dIaW50KGVsZW1lbnRzLCBg5YGc5q2i5aSx6LSl77yaJHtlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgdm9pZCByZWZyZXNoTWNwU3RhdHVzKGVsZW1lbnRzKTtcbiAgICAgICAgbWNwVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgICAgICB2b2lkIHJlZnJlc2hNY3BTdGF0dXMoZWxlbWVudHMpO1xuICAgICAgICB9LCAyNTAwKTtcblxuICAgICAgICAvLyAtLS0tIEFHRU5UUy5tZCDop4TojIPms6jlhaUgLS0tLVxuICAgICAgICBjb25zdCBhZ2VudHNNZEJ1dHRvbiA9IGVsZW1lbnRzLmJ0bkFnZW50c01kO1xuICAgICAgICBpZiAoYWdlbnRzTWRCdXR0b24pIHtcbiAgICAgICAgICAgIGFnZW50c01kQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHZvaWQgY2FsbE1jcE1ldGhvZCgnYWdlbnRzLW1kLXdyaXRlJykudGhlbigocmVzdWx0OiBhbnkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlc3VsdCAmJiByZXN1bHQub2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvblRleHQgPSByZXN1bHQuYWN0aW9uID09PSAnY3JlYXRlZCcgPyAn5bey5Yib5bu6JyA6IHJlc3VsdC5hY3Rpb24gPT09ICd1cGRhdGVkJyA/ICflt7Lmm7TmlrAnIDogJ+W3sui/veWKoCc7XG4gICAgICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYCR7YWN0aW9uVGV4dH0gJHtyZXN1bHQuZmlsZX3vvIgke3Jlc3VsdC5ieXRlc30g5a2X6IqC77yJ44CCQUkg5Yqp5omL5LiL5qyh5Lya6K+d5Lya6Ieq5Yqo6K+75Y+W44CCYCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYOWGmeWFpeWksei0pe+8miR7cmVzdWx0ICYmIHJlc3VsdC5lcnJvciA/IHJlc3VsdC5lcnJvciA6ICfmnKrnn6XplJnor68nfWApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goKGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYOWGmeWFpeWksei0pe+8miR7ZSAmJiBlLm1lc3NhZ2UgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIC0tLS0g54mI5pys5LiO5pu05paw77ya5omT5byA6Z2i5p2/6Ieq5Yqo5qOA5p+l77yI6LWw57yT5a2Y77yJ77yM5oyJ6ZKu5Y+v5by65Yi25Yi35pawL+S4gOmUruabtOaWsCAtLS0tXG4gICAgICAgIGNvbnN0IGJ0bkNoZWNrVXBkYXRlID0gZWxlbWVudHMuYnRuQ2hlY2tVcGRhdGUgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgICAgICBpZiAoYnRuQ2hlY2tVcGRhdGUpIHtcbiAgICAgICAgICAgIGJ0bkNoZWNrVXBkYXRlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHZvaWQgcmVmcmVzaFVwZGF0ZVN0YXRlKGVsZW1lbnRzLCB0cnVlKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgYnRuQXBwbHlVcGRhdGUgPSBlbGVtZW50cy5idG5BcHBseVVwZGF0ZSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgICAgIGlmIChidG5BcHBseVVwZGF0ZSkge1xuICAgICAgICAgICAgYnRuQXBwbHlVcGRhdGUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGJ0bkNoZWNrVXBkYXRlKSBidG5DaGVja1VwZGF0ZS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnRuQXBwbHlVcGRhdGUuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IHN0YXR1c1RleHQgPSBlbGVtZW50cy51cGRhdGVTdGF0dXNUZXh0O1xuICAgICAgICAgICAgICAgIGlmIChzdGF0dXNUZXh0KSB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1c1RleHQuY2xhc3NMaXN0LnJlbW92ZSgndXBkYXRlLWF2YWlsYWJsZScpO1xuICAgICAgICAgICAgICAgICAgICBzdGF0dXNUZXh0LnRleHRDb250ZW50ID0gJ+ato+WcqOabtOaWsO+8muS4i+i9vSDihpIg6Kej5Y6LIOKGkiDopobnm5bmianlsZXnm67lvZXigKbvvIjlj6/og73pnIDopoHlh6DljYHnp5LvvIknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2b2lkIGNhbGxNY3BNZXRob2QoJ2FwcGx5LXVwZGF0ZScpLnRoZW4oKHJlc3VsdDogYW55KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0Lm9rKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW5kZXJVcGRhdGVTdGF0ZShlbGVtZW50cywgeyBvazogdHJ1ZSwgY3VycmVudDogcmVzdWx0LnRvLCBoYXNVcGRhdGU6IGZhbHNlIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgc2hvd0hpbnQoZWxlbWVudHMsIGDlt7Lmm7TmlrDliLAgdiR7cmVzdWx0LnRvfe+8jOato+WcqOmHjei9veaJqeWxleKApiR7cmVzdWx0Lm5vdGljZSB8fCAnJ31gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlbG9hZEV4dGVuc2lvbihlbGVtZW50cyk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYOabtOaWsOWksei0pe+8miR7cmVzdWx0ICYmIHJlc3VsdC5lcnJvciA/IHJlc3VsdC5lcnJvciA6ICfmnKrnn6XplJnor68nfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgdm9pZCByZWZyZXNoVXBkYXRlU3RhdGUoZWxlbWVudHMsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goKGU6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBzaG93SGludChlbGVtZW50cywgYOabtOaWsOWksei0pe+8miR7ZSAmJiBlLm1lc3NhZ2UgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgICAgICAgICAgICAgICAgIHZvaWQgcmVmcmVzaFVwZGF0ZVN0YXRlKGVsZW1lbnRzLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgdm9pZCByZWZyZXNoVXBkYXRlU3RhdGUoZWxlbWVudHMsIGZhbHNlKTtcblxuICAgICAgICAvLyAtLS0tIOmHjei9veaJqeWxlSAtLS0tXG4gICAgICAgIGNvbnN0IHJlbG9hZEJ1dHRvbiA9IGVsZW1lbnRzLmJ0blJlbG9hZDtcbiAgICAgICAgaWYgKHJlbG9hZEJ1dHRvbikge1xuICAgICAgICAgICAgcmVsb2FkQnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlbG9hZEV4dGVuc2lvbihlbGVtZW50cyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOahpeiHquaEiO+8muS4u+i/m+eoi+acqumHjei9veaXtuWcqOmdouadv+i/m+eoi+WGheS4tOaXtui1t+ahpe+8jOS/neivgSBNQ1Ag5Y+v55SoXG4gICAgICAgIGVuc3VyZUZyZXNoQnJpZGdlKGVsZW1lbnRzKTtcbiAgICB9LFxuICAgIGNsb3NlKCkge1xuICAgICAgICBpZiAobWNwVGltZXIpIHtcbiAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwobWNwVGltZXIpO1xuICAgICAgICAgICAgbWNwVGltZXIgPSBudWxsO1xuICAgICAgICB9XG4gICAgfSxcbn0pO1xuIl19