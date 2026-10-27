"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
/**
 * 场景脚本（scene script）
 *
 * 官方机制：contributions.scene.script 指向本文件，它与 assets/ 下的脚本同进程运行，
 * 因此可以拿到引擎 API（require('cc')）。
 *
 * 调用方式：
 *   Editor.Message.request('scene', 'execute-scene-script', {
 *       name: '<扩展包名>', method: '<methods 里的方法名>', args: [ 纯 JSON 数据 ],
 *   })
 *
 * 注意：跨进程数据只走 JSON，返回值必须是纯 JSON，不能返回 cc.Node 这类原生对象。
 */
// 官方文档给的兜底：把编辑器安装目录的 node_modules 加入模块搜索路径，才能 require 到 cc。
// 3.8.x 场景进程通常已经内置了 cc 模块，这里保留兜底逻辑。
// 注意：这段是模块顶层代码，必须自己兜住异常，否则一旦抛错整个场景脚本都加载不了。
try {
    if (!module.paths) {
        module.paths = [];
    }
    const editorModules = (0, path_1.join)(Editor.App.path, 'node_modules');
    if (!module.paths.includes(editorModules)) {
        module.paths.push(editorModules);
    }
}
catch (e) {
    console.warn('[cocos-mcp] 场景脚本初始化模块搜索路径失败:', e);
}
let cachedEngine = null;
/** 获取引擎对象，失败时抛出可读错误 */
function getEngine() {
    if (cachedEngine)
        return cachedEngine;
    try {
        cachedEngine = require('cc');
    }
    catch (e) {
        try {
            const editorModules2 = (0, path_1.join)(Editor.App.path, 'node_modules');
            if (!module.paths) {
                module.paths = [];
            }
            if (!module.paths.includes(editorModules2)) {
                module.paths.push(editorModules2);
            }
            cachedEngine = require('cc');
        }
        catch (e2) {
            throw new Error(`场景脚本无法加载 cc 模块: ${String(e2)}`);
        }
    }
    return cachedEngine;
}
/** 把引擎对象转成纯 JSON */
function plain(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(plain);
    const result = {};
    for (const key of Object.keys(value)) {
        result[key] = plain(value[key]);
    }
    return result;
}
/**
 * 按 uuid 递归查找节点。
 * 注意：cc.find() 收的是「路径」而不是 uuid，getChildByUuid() 只查直接子节点，
 * 深层节点（孙节点及以下）两者都找不到，所以这里自己递归。
 */
function findByUuid(node, uuid) {
    if (!node)
        return null;
    if (node.uuid === uuid)
        return node;
    const children = node.children || [];
    for (const child of children) {
        const found = findByUuid(child, uuid);
        if (found)
            return found;
    }
    return null;
}
/**
 * 在整个场景里按 uuid 找节点或组件实例（组件引用绑定的目标可以是组件本身）
 */
function findInstanceByUuid(scene, uuid) {
    const walk = (node) => {
        if (!node)
            return null;
        if (node.uuid === uuid)
            return node;
        for (const comp of node.components || []) {
            if (comp.uuid === uuid)
                return comp;
        }
        for (const child of node.children || []) {
            const hit = walk(child);
            if (hit)
                return hit;
        }
        return null;
    };
    return walk(scene);
}
/**
 * 把一个引用值描述成纯 JSON（跨进程只走 JSON，不能带引擎对象）：
 * 节点 -> { kind:'node', uuid, name }
 * 组件 -> { kind:'component', uuid, name, type }（type 是类名，如 ItemBadge / Sprite）
 * 资产 -> { kind:'asset', uuid, type }
 * 其余 -> { kind:'raw', value } / { kind:'array', items }
 * 绑定验证（node.bindProperty 回读）用。
 */
function describeRef(cc, value) {
    if (value === null || value === undefined)
        return null;
    const typeName = (obj) => {
        try {
            return cc.js.getClassName(obj) || '';
        }
        catch (e) {
            return '';
        }
    };
    try {
        if (value instanceof cc.Node)
            return { kind: 'node', uuid: value.uuid, name: value.name };
        if (value instanceof cc.Component) {
            return { kind: 'component', uuid: value.uuid, name: value.name, type: typeName(value) };
        }
        if (value instanceof cc.Asset) {
            return { kind: 'asset', uuid: value._uuid || value.uuid || '', type: typeName(value) };
        }
    }
    catch (e) { /* 走不到的兜底 */ }
    if (Array.isArray(value)) {
        return { kind: 'array', items: value.slice(0, 10).map((item) => describeRef(cc, item)) };
    }
    return { kind: 'raw', value: plain(value) };
}
/**
 * 把 JSON 值解析成引擎对象：
 *   { __uuid: 'xxx' }      -> 场景里的节点 / 组件实例（引用绑定）
 *   { __vec: [x,y(,z)] }   -> Vec2 / Vec3
 *   { __size: [w,h] }      -> Size
 *   { __color: [r,g,b,a] } -> Color
 * 其余原样返回。
 */
function resolveValue(cc, scene, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    if (typeof value.__uuid === 'string') {
        const target = findInstanceByUuid(scene, value.__uuid);
        if (!target) {
            throw new Error(`__uuid 引用找不到目标: ${value.__uuid}`);
        }
        return target;
    }
    if (Array.isArray(value.__vec)) {
        const v = value.__vec.map(Number);
        return v.length === 2 ? new cc.Vec2(v[0], v[1]) : new cc.Vec3(v[0], v[1], v[2] || 0);
    }
    if (Array.isArray(value.__size)) {
        return new cc.Size(Number(value.__size[0]), Number(value.__size[1]));
    }
    if (Array.isArray(value.__color)) {
        return new cc.Color(Number(value.__color[0]), Number(value.__color[1]), Number(value.__color[2]), Number(value.__color[3]));
    }
    return value;
}
/** 递归找第一个指定类型的组件（不依赖 Scene 上是否有 getComponentInChildren） */
function findFirstComponent(node, cls) {
    if (!node)
        return null;
    const comp = node.getComponent ? node.getComponent(cls) : null;
    if (comp)
        return comp;
    for (const child of node.children || []) {
        const hit = findFirstComponent(child, cls);
        if (hit)
            return hit;
    }
    return null;
}
/** 递归收集所有指定类型的组件 */
function collectComponents(node, cls, out) {
    if (!node)
        return;
    const comp = node.getComponent ? node.getComponent(cls) : null;
    if (comp)
        out.push(comp);
    for (const child of node.children || [])
        collectComponents(child, cls, out);
}
/**
 * 编辑模式下场景不是连续渲染的，EVENT_AFTER_DRAW 不会自己来，需要主动触发重绘。
 * 返回实际用到的触发方式（none 表示两种接口都没找到）。
 */
function kickRepaint(cc) {
    try {
        const cce = globalThis.cce;
        if (cce && cce.Engine && typeof cce.Engine.repaintInEditMode === 'function') {
            cce.Engine.repaintInEditMode();
            return 'repaintInEditMode';
        }
    }
    catch ( /* ignore */_a) { /* ignore */ }
    try {
        if (cc.game && typeof cc.game.step === 'function') {
            cc.game.step();
            return 'game.step';
        }
    }
    catch ( /* ignore */_b) { /* ignore */ }
    return 'none';
}
function load() {
    try {
        const cc = getEngine();
        console.log(`[cocos-mcp] 场景脚本已加载, 引擎版本 ${cc.ENGINE_VERSION || 'unknown'}`);
    }
    catch (e) {
        console.error('[cocos-mcp] 场景脚本加载失败:', e);
    }
}
function unload() {
    cachedEngine = null;
}
/** 场景脚本对外暴露的方法，通过 execute-scene-script 调用 */
exports.methods = {
    /**
     * 读取引擎与当前场景信息
     */
    engineInfo() {
        const cc = getEngine();
        const scene = cc.director.getScene();
        return {
            engineVersion: cc.ENGINE_VERSION || (cc.game && cc.game.version) || '',
            sceneName: scene ? scene.name : null,
            sceneUuid: scene ? scene.uuid : null,
            childCount: scene ? scene.children.length : 0,
        };
    },
    /**
     * 用引擎 API 在当前场景下创建一个节点
     * @param name 节点名
     * @param position { x, y, z }
     */
    createNode(name = 'MCP_Engine_Node', position) {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const pos = position || {};
        const node = new cc.Node(String(name || 'MCP_Engine_Node'));
        node.setPosition(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
        scene.addChild(node);
        return {
            ok: true,
            uuid: node.uuid,
            name: node.name,
            position: plain(node.position),
            parent: scene.name,
        };
    },
    /**
     * 用引擎 API 移动节点
     * @param uuid 节点 uuid
     * @param position { x, y, z }
     */
    moveNode(uuid, position) {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const target = findByUuid(scene, uuid);
        if (!target) {
            return { ok: false, error: `找不到节点: ${uuid}` };
        }
        const pos = position || {};
        target.setPosition(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
        return {
            ok: true,
            uuid: target.uuid,
            name: target.name,
            position: plain(target.position),
        };
    },
    /**
     * 列出当前场景的节点（引擎侧视角）
     */
    listNodes() {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const walk = (node, depth) => {
            const item = {
                uuid: node.uuid,
                name: node.name,
                depth,
                active: node.active,
                components: (node.components || []).map((comp) => { var _a; return comp.name || ((_a = comp.constructor) === null || _a === void 0 ? void 0 : _a.name) || '?'; }),
                children: [],
            };
            for (const child of node.children) {
                item.children.push(...walk(child, depth + 1));
            }
            return [item];
        };
        const nodes = scene.children.reduce((acc, child) => acc.concat(walk(child, 0)), []);
        return { ok: true, scene: scene.name, count: nodes.length, nodes };
    },
    /**
     * 用引擎 API 给节点挂组件。
     *
     * 编辑器消息通道的 create-component 对内置组件（cc.Sprite）有效，
     * 但挂用户自定义脚本组件时无效——自定义脚本的 ccclass 需要在场景进程里
     * 已经注册，所以这条路要走引擎。
     *
     * @param nodeUuid 节点 uuid
     * @param component 组件类名或 cid
     */
    addComponentToNode(nodeUuid, component) {
        var _a;
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const target = findByUuid(scene, nodeUuid);
        if (!target) {
            return { ok: false, error: `找不到节点: ${nodeUuid}` };
        }
        // 先按类名查，再按 cid 查（_idToClass 表）
        let cls = null;
        try {
            cls = cc.js.getClassByName(component);
        }
        catch (e) {
            cls = null;
        }
        if (!cls) {
            try {
                cls = cc.js.getClassById(component);
            }
            catch (e) {
                cls = null;
            }
        }
        if (!cls) {
            // 兜底：在已注册类名表里找（忽略大小写）
            try {
                const nameMap = cc.js._nameToClass;
                if (nameMap && typeof nameMap.forEach === 'function') {
                    let found = null;
                    nameMap.forEach((value, key) => {
                        if (!found && key && key.toLowerCase() === String(component).toLowerCase()) {
                            found = value;
                        }
                    });
                    cls = found;
                }
            }
            catch (e) {
                cls = null;
            }
        }
        if (!cls) {
            // 诊断：把已注册的用户类名列出来
            let registered = [];
            try {
                const nameMap = cc.js._nameToClass;
                if (nameMap && typeof nameMap.forEach === 'function') {
                    nameMap.forEach((value, key) => {
                        if (key && !key.startsWith('cc.') && key.indexOf('.') < 0)
                            registered.push(key);
                    });
                }
            }
            catch (e) {
                registered = [];
            }
            return {
                ok: false,
                error: `引擎里找不到组件类「${component}」（可能脚本模块还没在场景进程里加载）`,
                registeredUserClasses: registered.slice(0, 50),
            };
        }
        try {
            const comp = target.addComponent(cls);
            return {
                ok: true,
                node: target.uuid,
                component: comp ? (comp.name || ((_a = comp.constructor) === null || _a === void 0 ? void 0 : _a.name)) : component,
                componentUuid: comp ? comp.uuid : '',
                className: comp && comp.constructor ? comp.constructor.name : component,
            };
        }
        catch (e) {
            return { ok: false, error: `addComponent 失败: ${e && e.message ? e.message : String(e)}` };
        }
    },
    /**
     * 用引擎 API 给节点或组件设置属性（编辑器消息通道搞不定的场景用它兜底，
     * 比如给自定义脚本组件绑定 @property 引用）。
     * @param nodeUuid 节点 uuid
     * @param component 组件类名或 cid；空字符串表示设置节点本身的属性
     * @param prop 属性名
     * @param value 纯 JSON 值，支持 __uuid / __vec / __size / __color 特殊形式
     */
    setNodeProperty(nodeUuid, component, prop, value) {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const node = findByUuid(scene, nodeUuid);
        if (!node) {
            return { ok: false, error: `找不到节点: ${nodeUuid}` };
        }
        let host = node;
        let hostName = 'node';
        const compName = String(component || '').trim();
        if (compName && compName !== 'node') {
            let cls = null;
            try {
                cls = cc.js.getClassByName(compName);
            }
            catch (e) {
                cls = null;
            }
            if (!cls) {
                try {
                    cls = cc.js.getClassById(compName);
                }
                catch (e) {
                    cls = null;
                }
            }
            if (!cls) {
                return {
                    ok: false,
                    error: `引擎里找不到组件类「${compName}」`,
                    nodeComponents: (node.components || []).map((c) => c.name || '?'),
                };
            }
            host = node.getComponent(cls);
            if (!host) {
                return {
                    ok: false,
                    error: `节点 ${node.name} 上没有组件「${compName}」`,
                    nodeComponents: (node.components || []).map((c) => c.name || '?'),
                };
            }
            hostName = compName;
        }
        try {
            const resolved = resolveValue(cc, scene, value);
            if (host === node && prop === 'position') {
                node.setPosition(Number(resolved === null || resolved === void 0 ? void 0 : resolved.x) || 0, Number(resolved === null || resolved === void 0 ? void 0 : resolved.y) || 0, Number(resolved === null || resolved === void 0 ? void 0 : resolved.z) || 0);
            }
            else {
                host[prop] = resolved;
            }
            return {
                ok: true,
                node: node.uuid,
                nodeName: node.name,
                target: hostName,
                prop,
                applied: plain(host === node && prop === 'position' ? node.position : host[prop]),
            };
        }
        catch (e) {
            return { ok: false, error: `设置属性失败: ${e && e.message ? e.message : String(e)}` };
        }
    },
    /**
     * 回读组件当前的属性值（node.bindProperty 绑定后的验证通道）。
     * 引用值返回 { kind:'node'|'component'|'asset', uuid, ... }，普通值返回 { kind:'raw', value }。
     * @param nodeUuid 节点 uuid
     * @param component 组件索引（字符串数字）/ 类名 / 组件 uuid；'node' 或空表示节点本身
     * @param prop 属性名
     */
    readComponentProperty(nodeUuid, component, prop) {
        var _a;
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const node = findByUuid(scene, nodeUuid);
        if (!node) {
            return { ok: false, error: `找不到节点: ${nodeUuid}` };
        }
        let host = node;
        const compSpec = String(component || '').trim();
        if (compSpec && compSpec !== 'node') {
            if (/^\d+$/.test(compSpec)) {
                host = (node.components || [])[parseInt(compSpec, 10)] || null;
            }
            if (!host) {
                host = (node.components || []).find((comp) => {
                    if (!comp)
                        return false;
                    if (comp.uuid === compSpec)
                        return true;
                    let clsName = '';
                    let ctorName = '';
                    try {
                        clsName = cc.js.getClassName(comp) || '';
                    }
                    catch (e) {
                        clsName = '';
                    }
                    if (comp.constructor)
                        ctorName = comp.constructor.name || '';
                    const bare = compSpec.startsWith('cc.') ? compSpec.slice(3) : compSpec;
                    return clsName === compSpec || ctorName === compSpec ||
                        clsName === bare || ctorName === bare;
                }) || null;
            }
            if (!host) {
                const names = (node.components || []).map((comp) => {
                    try {
                        return cc.js.getClassName(comp) || comp.name || '?';
                    }
                    catch (e) {
                        return (comp === null || comp === void 0 ? void 0 : comp.name) || '?';
                    }
                });
                return { ok: false, error: `节点 ${node.name} 上找不到组件「${compSpec}」`, nodeComponents: names };
            }
        }
        let value;
        try {
            value = host[prop];
        }
        catch (e) {
            return { ok: false, error: `读取属性 ${prop} 失败: ${(_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : String(e)}` };
        }
        return {
            ok: true,
            node: node.uuid,
            nodeName: node.name,
            prop,
            ref: describeRef(cc, value),
        };
    },
    /**
     * 列出引擎侧已注册的类名（诊断用）
     */
    listRegisteredClasses() {
        const cc = getEngine();
        const names = [];
        try {
            const nameMap = cc.js._nameToClass;
            if (nameMap && typeof nameMap.forEach === 'function') {
                nameMap.forEach((value, key) => { if (key)
                    names.push(key); });
            }
        }
        catch (e) {
            return { ok: false, error: String(e) };
        }
        const userClasses = names.filter((n) => !n.startsWith('cc.') && n.indexOf('.') < 0);
        return { ok: true, total: names.length, userClasses, sample: names.slice(0, 40) };
    },
    /**
     * 兼容旧方法名：主进程如果还在调 captureScene，转给 captureCanvas。
     */
    async captureScene(maxW = 768) {
        console.log('[cocos-mcp] captureScene(旧名) -> 转发给 captureCanvas');
        return exports.methods.captureCanvas(maxW, true);
    },
    /**
     * 诊断：不渲染，只报告截图所需的条件是否具备。出问题时先调这个。
     */
    captureDiag() {
        var _a, _b;
        console.log('[cocos-mcp] captureDiag called');
        const info = { ok: true };
        try {
            const cc = getEngine();
            info.engineVersion = cc.ENGINE_VERSION || '';
            const scene = cc.director.getScene();
            info.hasScene = !!scene;
            info.sceneName = scene ? scene.name : null;
            if (scene) {
                const canvasComp = findFirstComponent(scene, cc.Canvas);
                info.hasCanvas = !!canvasComp;
                if (canvasComp) {
                    const ui = canvasComp.node.getComponent(cc.UITransform);
                    info.canvasNode = canvasComp.node.name;
                    info.canvasLayer = canvasComp.node.layer;
                    info.canvasSize = ui ? [ui.contentSize.width, ui.contentSize.height] : null;
                    info.canvasBoundCamera = canvasComp.cameraComponent ? canvasComp.cameraComponent.node.name : null;
                }
                const cams = [];
                collectComponents(scene, cc.Camera, cams);
                info.cameras = cams.map((c) => ({
                    node: c.node.name,
                    priority: c.priority,
                    visibility: c.visibility,
                    hasTargetTexture: !!c.targetTexture,
                }));
            }
            const cce = globalThis.cce;
            info.hasCce = !!cce;
            info.hasRepaintInEditMode = !!(cce && cce.Engine && typeof cce.Engine.repaintInEditMode === 'function');
            info.hasGameStep = !!(cc.game && typeof cc.game.step === 'function');
            info.hasRenderTexture = typeof cc.RenderTexture === 'function';
            info.hasDocument = typeof document !== 'undefined';
        }
        catch (e) {
            info.ok = false;
            info.error = (_b = (_a = e === null || e === void 0 ? void 0 : e.stack) !== null && _a !== void 0 ? _a : e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : String(e);
        }
        return info;
    },
    /**
     * 截取 Canvas 内容为 base64 JPEG（离屏渲染：不含网格 / Gizmo，不受场景视图缩放平移影响）。
     *
     * 做法：把渲染 Canvas 的相机临时指向一张 RenderTexture，等 2 帧后 readPixels，
     * 再还原相机。编辑模式下场景不是连续渲染的，所以需要主动触发重绘（kick）。
     *
     * 失败时返回 { ok:false, stage, error }，stage 指明失败在哪一步：
     *   find-scene / find-canvas / find-camera / setup-rt / wait-frame / encode
     *
     * @param maxW  输出图宽度上限（等比缩小）
     * @param flipY 是否上下翻转像素（readPixels 通常是自下而上；图是倒的就传 false）
     */
    async captureCanvas(maxW = 768, flipY = true) {
        var _a, _b;
        console.log('[cocos-mcp] captureCanvas called', maxW, flipY);
        let stage = 'init';
        let cam = null;
        let oldTarget = null;
        let rt = null;
        let handler = null;
        let timer = null;
        let cc = null;
        try {
            cc = getEngine();
            stage = 'find-scene';
            const scene = cc.director.getScene();
            if (!scene)
                return { ok: false, stage, error: '当前没有打开的场景' };
            stage = 'find-canvas';
            const canvasComp = findFirstComponent(scene, cc.Canvas);
            if (!canvasComp)
                return { ok: false, stage, error: '场景里没有 Canvas' };
            const canvasNode = canvasComp.node;
            const ui = canvasNode.getComponent(cc.UITransform);
            if (!ui)
                return { ok: false, stage, error: 'Canvas 节点没有 UITransform' };
            const W = Math.max(1, Math.round(ui.contentSize.width));
            const H = Math.max(1, Math.round(ui.contentSize.height));
            stage = 'find-camera';
            cam = canvasComp.cameraComponent;
            if (!cam) {
                const cams = [];
                collectComponents(scene, cc.Camera, cams);
                cam = cams
                    .filter((c) => (c.visibility & canvasNode.layer) !== 0)
                    .sort((a, b) => b.priority - a.priority)[0];
            }
            if (!cam)
                return { ok: false, stage, error: '找不到渲染 Canvas 的相机' };
            console.log('[cocos-mcp] captureCanvas camera =', cam.node.name, 'size =', W, H);
            stage = 'setup-rt';
            rt = new cc.RenderTexture();
            rt.reset({ width: W, height: H });
            oldTarget = cam.targetTexture;
            cam.targetTexture = rt;
            stage = 'wait-frame';
            let kicked = 'none';
            const pixels = await new Promise((resolve, reject) => {
                let frames = 0;
                handler = () => {
                    frames++;
                    if (frames < 2)
                        return; // 第 1 帧让 targetTexture 生效，第 2 帧才是完整画面
                    cc.director.off(cc.Director.EVENT_AFTER_DRAW, handler);
                    handler = null;
                    try {
                        resolve(rt.readPixels(0, 0, W, H));
                    }
                    catch (e) {
                        reject(e);
                    }
                };
                cc.director.on(cc.Director.EVENT_AFTER_DRAW, handler);
                kicked = kickRepaint(cc);
                setTimeout(() => kickRepaint(cc), 150);
                setTimeout(() => kickRepaint(cc), 400);
                timer = setTimeout(() => reject(new Error(`等待渲染帧超时（触发方式: ${kicked}）`)), 3000);
            });
            if (!pixels || !pixels.length) {
                return { ok: false, stage, error: 'readPixels 返回空数据' };
            }
            stage = 'encode';
            const full = document.createElement('canvas');
            full.width = W;
            full.height = H;
            const ctx = full.getContext('2d');
            const img = ctx.createImageData(W, H);
            const row = W * 4;
            for (let y = 0; y < H; y++) {
                const sy = flipY ? (H - 1 - y) : y;
                img.data.set(pixels.subarray(sy * row, sy * row + row), y * row);
            }
            ctx.putImageData(img, 0, 0);
            const scale = Math.min(1, maxW / W);
            const out = document.createElement('canvas');
            out.width = Math.max(1, Math.round(W * scale));
            out.height = Math.max(1, Math.round(H * scale));
            out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
            const dataUrl = out.toDataURL('image/jpeg', 0.7);
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            return {
                ok: true,
                kicked,
                camera: cam.node.name,
                canvasWidth: W,
                canvasHeight: H,
                outputWidth: out.width,
                outputHeight: out.height,
                format: 'image/jpeg',
                bytes: Math.round(base64.length * 3 / 4),
                base64,
            };
        }
        catch (e) {
            console.error('[cocos-mcp] captureCanvas failed at', stage, e);
            return { ok: false, stage, error: (_b = (_a = e === null || e === void 0 ? void 0 : e.stack) !== null && _a !== void 0 ? _a : e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : String(e) };
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (handler && cc) {
                try {
                    cc.director.off(cc.Director.EVENT_AFTER_DRAW, handler);
                }
                catch ( /* ignore */_c) { /* ignore */ }
            }
            // 必须还原，否则场景里该相机会一直渲染到纹理
            if (cam) {
                try {
                    cam.targetTexture = oldTarget;
                }
                catch ( /* ignore */_d) { /* ignore */ }
            }
            if (rt) {
                try {
                    rt.destroy();
                }
                catch ( /* ignore */_e) { /* ignore */ }
            }
        }
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBeU1BLG9CQU9DO0FBRUQsd0JBRUM7QUFwTkQsK0JBQTRCO0FBRTVCOzs7Ozs7Ozs7Ozs7R0FZRztBQUVILDREQUE0RDtBQUM1RCxvQ0FBb0M7QUFDcEMsMkNBQTJDO0FBQzNDLElBQUksQ0FBQztJQUNELElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDZixNQUFjLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztJQUMvQixDQUFDO0lBQ0QsTUFBTSxhQUFhLEdBQUcsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUM7SUFDNUQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFNLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxFQUFFLENBQUM7UUFDekMsTUFBTSxDQUFDLEtBQU0sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUM7SUFDdEMsQ0FBQztBQUNMLENBQUM7QUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO0lBQ1QsT0FBTyxDQUFDLElBQUksQ0FBQyw4QkFBOEIsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNwRCxDQUFDO0FBRUQsSUFBSSxZQUFZLEdBQVEsSUFBSSxDQUFDO0FBRTdCLHVCQUF1QjtBQUN2QixTQUFTLFNBQVM7SUFDZCxJQUFJLFlBQVk7UUFBRSxPQUFPLFlBQVksQ0FBQztJQUN0QyxJQUFJLENBQUM7UUFDRCxZQUFZLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQ1QsSUFBSSxDQUFDO1lBQ0QsTUFBTSxjQUFjLEdBQUcsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUM7WUFDN0QsSUFB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QUFDO2dCQUFDLFFBQVEsWUFBWSxJQUFkLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUFDLENBQUM7WUFDMUUsSUFBSSxFQUFFLEVBQUUsQ0FBQztnQkFBQyxJQUFJLENBQUM7b0JBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUFDLENBQUM7Z0JBQUMsUUFBUSxZQUFZLElBQWQsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQUMsQ0FBQztRQUM1RCxDQUFDO0lBQ0wsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XG5cbi8qKlxuICog5Zy65pmv6ISa5pys77yIc2NlbmUgc2NyaXB077yJXG4gKlxuICog5a6Y5pa55py65Yi277yaY29udHJpYnV0aW9ucy5zY2VuZS5zY3JpcHQg5oyH5ZCR5pys5paH5Lu277yM5a6D5LiOIGFzc2V0cy8g5LiL55qE6ISa5pys5ZCM6L+b56iL6L+Q6KGM77yMXG4gKiDlm6DmraTlj6/ku6Xmi7/liLDlvJXmk44gQVBJ77yIcmVxdWlyZSgnY2MnKe+8ieOAglxuICpcbiAqIOiwg+eUqOaWueW8j++8mlxuICogICBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAqICAgICAgIG5hbWU6ICc85omp5bGV5YyF5ZCNPicsIG1ldGhvZDogJzxtZXRob2RzIOmHjOeahOaWueazleWQjT4nLCBhcmdzOiBbIOe6ryBKU09OIOaVsOaNriBdLFxuICogICB9KVxuICpcbiAqIOazqOaEj++8mui3qOi/m+eoi+aVsOaNruWPqui1sCBKU09O77yM6L+U5Zue5YC85b+F6aG75piv57qvIEpTT07vvIzkuI3og73ov5Tlm54gY2MuTm9kZSDov5nnsbvljp/nlJ/lr7nosaHjgIJcbiAqL1xuXG4vLyDlrpjmlrnmlofmoaPnu5nnmoTlhZzlupXvvJrmiornvJbovpHlmajlronoo4Xnm67lvZXnmoQgbm9kZV9tb2R1bGVzIOWKoOWFpeaooeWdl+aQnOe0oui3r+W+hO+8jOaJjeiDvSByZXF1aXJlIOWIsCBjY+OAglxuLy8gMy44Lngg5Zy65pmv6L+b56iL6YCa5bi45bey57uP5YaF572u5LqGIGNjIOaooeWdl++8jOi/memHjOS/neeVmeWFnOW6lemAu+i+keOAglxuLy8g5rOo5oSP77ya6L+Z5q615piv5qih5Z2X6aG25bGC5Luj56CB77yM5b+F6aG76Ieq5bex5YWc5L2P5byC5bi477yM5ZCm5YiZ5LiA5pem5oqb6ZSZ5pW05Liq5Zy65pmv6ISa5pys6YO95Yqg6L295LiN5LqG44CCXG50cnkge1xuICAgIGlmICghbW9kdWxlLnBhdGhzKSB7XG4gICAgICAgIChtb2R1bGUgYXMgYW55KS5wYXRocyA9IFtdO1xuICAgIH1cbiAgICBjb25zdCBlZGl0b3JNb2R1bGVzID0gam9pbihFZGl0b3IuQXBwLnBhdGgsICdub2RlX21vZHVsZXMnKTtcbiAgICBpZiAoIW1vZHVsZS5wYXRocyEuaW5jbHVkZXMoZWRpdG9yTW9kdWxlcykpIHtcbiAgICAgICAgbW9kdWxlLnBhdGhzIS5wdXNoKGVkaXRvck1vZHVsZXMpO1xuICAgIH1cbn0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oJ1tjb2Nvcy1tY3BdIOWcuuaZr+iEmuacrOWIneWni+WMluaooeWdl+aQnOe0oui3r+W+hOWksei0pTonLCBlKTtcbn1cblxubGV0IGNhY2hlZEVuZ2luZTogYW55ID0gbnVsbDtcblxuLyoqIOiOt+WPluW8leaTjuWvueixoe+8jOWksei0peaXtuaKm+WHuuWPr+ivu+mUmeivryAqL1xuZnVuY3Rpb24gZ2V0RW5naW5lKCk6IGFueSB7XG4gICAgaWYgKGNhY2hlZEVuZ2luZSkgcmV0dXJuIGNhY2hlZEVuZ2luZTtcbiAgICB0cnkge1xuICAgICAgICBjYWNoZWRFbmdpbmUgPSByZXF1aXJlKCdjYycpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGVkaXRvck1vZHVsZXMyID0gam9pbihFZGl0b3IuQXBwLnBhdGgsICdub2RlX21vZHVsZXMnKTtcbiAgICAgICAgICAgIGlmICghbW9kdWxlLnBhdGhzKSB7XG4gICAgICAgICAgICAgICAgKG1vZHVsZSBhcyBhbnkpLnBhdGhzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIW1vZHVsZS5wYXRocyEuaW5jbHVkZXMoZWRpdG9yTW9kdWxlczIpKSB7XG4gICAgICAgICAgICAgICAgbW9kdWxlLnBhdGhzIS5wdXNoKGVkaXRvck1vZHVsZXMyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhY2hlZEVuZ2luZSA9IHJlcXVpcmUoJ2NjJyk7XG4gICAgICAgIH0gY2F0Y2ggKGUyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+iEmuacrOaXoOazleWKoOi9vSBjYyDmqKHlnZc6ICR7U3RyaW5nKGUyKX1gKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gY2FjaGVkRW5naW5lO1xufVxuXG4vKiog5oqK5byV5pOO5a+56LGh6L2s5oiQ57qvIEpTT04gKi9cbmZ1bmN0aW9uIHBsYWluKHZhbHVlOiBhbnkpOiBhbnkge1xuICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIHZhbHVlO1xuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcChwbGFpbik7XG4gICAgY29uc3QgcmVzdWx0OiBhbnkgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyh2YWx1ZSkpIHtcbiAgICAgICAgcmVzdWx0W2tleV0gPSBwbGFpbih2YWx1ZVtrZXldKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLyoqXG4gKiDmjIkgdXVpZCDpgJLlvZLmn6Xmib7oioLngrnjgIJcbiAqIOazqOaEj++8mmNjLmZpbmQoKSDmlLbnmoTmmK/jgIzot6/lvoTjgI3ogIzkuI3mmK8gdXVpZO+8jGdldENoaWxkQnlVdWlkKCkg5Y+q5p+l55u05o6l5a2Q6IqC54K577yMXG4gKiDmt7HlsYLoioLngrnvvIjlrZnoioLngrnlj4rku6XkuIvvvInkuKTogIXpg73mib7kuI3liLDvvIzmiYDku6Xov5nph4zoh6rlt7HpgJLlvZLjgIJcbiAqL1xuZnVuY3Rpb24gZmluZEJ5VXVpZChub2RlOiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gbnVsbDtcbiAgICBpZiAobm9kZS51dWlkID09PSB1dWlkKSByZXR1cm4gbm9kZTtcbiAgICBjb25zdCBjaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRCeVV1aWQoY2hpbGQsIHV1aWQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICog5Zyo5pW05Liq5Zy65pmv6YeM5oyJIHV1aWQg5om+6IqC54K55oiW57uE5Lu25a6e5L6L77yI57uE5Lu25byV55So57uR5a6a55qE55uu5qCH5Y+v5Lul5piv57uE5Lu25pys6Lqr77yJXG4gKi9cbmZ1bmN0aW9uIGZpbmRJbnN0YW5jZUJ5VXVpZChzY2VuZTogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkge1xuICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55KTogYW55ID0+IHtcbiAgICAgICAgaWYgKCFub2RlKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKG5vZGUudXVpZCA9PT0gdXVpZCkgcmV0dXJuIG5vZGU7XG4gICAgICAgIGZvciAoY29uc3QgY29tcCBvZiBub2RlLmNvbXBvbmVudHMgfHwgW10pIHtcbiAgICAgICAgICAgIGlmIChjb21wLnV1aWQgPT09IHV1aWQpIHJldHVybiBjb21wO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiB8fCBbXSkge1xuICAgICAgICAgICAgY29uc3QgaGl0ID0gd2FsayhjaGlsZCk7XG4gICAgICAgICAgICBpZiAoaGl0KSByZXR1cm4gaGl0O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH07XG4gICAgcmV0dXJuIHdhbGsoc2NlbmUpO1xufVxuXG4vKipcbiAqIOaKiuS4gOS4quW8leeUqOWAvOaPj+i/sOaIkOe6ryBKU09O77yI6Leo6L+b56iL5Y+q6LWwIEpTT07vvIzkuI3og73luKblvJXmk47lr7nosaHvvInvvJpcbiAqIOiKgueCuSAtPiB7IGtpbmQ6J25vZGUnLCB1dWlkLCBuYW1lIH1cbiAqIOe7hOS7tiAtPiB7IGtpbmQ6J2NvbXBvbmVudCcsIHV1aWQsIG5hbWUsIHR5cGUgfe+8iHR5cGUg5piv57G75ZCN77yM5aaCIEl0ZW1CYWRnZSAvIFNwcml0Ze+8iVxuICog6LWE5LqnIC0+IHsga2luZDonYXNzZXQnLCB1dWlkLCB0eXBlIH1cbiAqIOWFtuS9mSAtPiB7IGtpbmQ6J3JhdycsIHZhbHVlIH0gLyB7IGtpbmQ6J2FycmF5JywgaXRlbXMgfVxuICog57uR5a6a6aqM6K+B77yIbm9kZS5iaW5kUHJvcGVydHkg5Zue6K+777yJ55So44CCXG4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlUmVmKGNjOiBhbnksIHZhbHVlOiBhbnkpOiBhbnkge1xuICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB0eXBlTmFtZSA9IChvYmo6IGFueSk6IHN0cmluZyA9PiB7XG4gICAgICAgIHRyeSB7IHJldHVybiBjYy5qcy5nZXRDbGFzc05hbWUob2JqKSB8fCAnJzsgfSBjYXRjaCAoZSkgeyByZXR1cm4gJyc7IH1cbiAgICB9O1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIGNjLk5vZGUpIHJldHVybiB7IGtpbmQ6ICdub2RlJywgdXVpZDogdmFsdWUudXVpZCwgbmFtZTogdmFsdWUubmFtZSB9O1xuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBjYy5Db21wb25lbnQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IGtpbmQ6ICdjb21wb25lbnQnLCB1dWlkOiB2YWx1ZS51dWlkLCBuYW1lOiB2YWx1ZS5uYW1lLCB0eXBlOiB0eXBlTmFtZSh2YWx1ZSkgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBjYy5Bc3NldCkge1xuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ2Fzc2V0JywgdXVpZDogdmFsdWUuX3V1aWQgfHwgdmFsdWUudXVpZCB8fCAnJywgdHlwZTogdHlwZU5hbWUodmFsdWUpIH07XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7IC8qIOi1sOS4jeWIsOeahOWFnOW6lSAqLyB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6ICdhcnJheScsIGl0ZW1zOiB2YWx1ZS5zbGljZSgwLCAxMCkubWFwKChpdGVtKSA9PiBkZXNjcmliZVJlZihjYywgaXRlbSkpIH07XG4gICAgfVxuICAgIHJldHVybiB7IGtpbmQ6ICdyYXcnLCB2YWx1ZTogcGxhaW4odmFsdWUpIH07XG59XG5cbi8qKlxuICog5oqKIEpTT04g5YC86Kej5p6Q5oiQ5byV5pOO5a+56LGh77yaXG4gKiAgIHsgX191dWlkOiAneHh4JyB9ICAgICAgLT4g5Zy65pmv6YeM55qE6IqC54K5IC8g57uE5Lu25a6e5L6L77yI5byV55So57uR5a6a77yJXG4gKiAgIHsgX192ZWM6IFt4LHkoLHopXSB9ICAgLT4gVmVjMiAvIFZlYzNcbiAqICAgeyBfX3NpemU6IFt3LGhdIH0gICAgICAtPiBTaXplXG4gKiAgIHsgX19jb2xvcjogW3IsZyxiLGFdIH0gLT4gQ29sb3JcbiAqIOWFtuS9meWOn+agt+i/lOWbnuOAglxuICovXG5mdW5jdGlvbiByZXNvbHZlVmFsdWUoY2M6IGFueSwgc2NlbmU6IGFueSwgdmFsdWU6IGFueSk6IGFueSB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWU7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZS5fX3V1aWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGZpbmRJbnN0YW5jZUJ5VXVpZChzY2VuZSwgdmFsdWUuX191dWlkKTtcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgX191dWlkIOW8leeUqOaJvuS4jeWIsOebruaghzogJHt2YWx1ZS5fX3V1aWR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRhcmdldDtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUuX192ZWMpKSB7XG4gICAgICAgIGNvbnN0IHYgPSB2YWx1ZS5fX3ZlYy5tYXAoTnVtYmVyKTtcbiAgICAgICAgcmV0dXJuIHYubGVuZ3RoID09PSAyID8gbmV3IGNjLlZlYzIodlswXSwgdlsxXSkgOiBuZXcgY2MuVmVjMyh2WzBdLCB2WzFdLCB2WzJdIHx8IDApO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZS5fX3NpemUpKSB7XG4gICAgICAgIHJldHVybiBuZXcgY2MuU2l6ZShOdW1iZXIodmFsdWUuX19zaXplWzBdKSwgTnVtYmVyKHZhbHVlLl9fc2l6ZVsxXSkpO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZS5fX2NvbG9yKSkge1xuICAgICAgICByZXR1cm4gbmV3IGNjLkNvbG9yKE51bWJlcih2YWx1ZS5fX2NvbG9yWzBdKSwgTnVtYmVyKHZhbHVlLl9fY29sb3JbMV0pLCBOdW1iZXIodmFsdWUuX19jb2xvclsyXSksIE51bWJlcih2YWx1ZS5fX2NvbG9yWzNdKSk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqIOmAkuW9kuaJvuesrOS4gOS4quaMh+Wumuexu+Wei+eahOe7hOS7tu+8iOS4jeS+nei1liBTY2VuZSDkuIrmmK/lkKbmnIkgZ2V0Q29tcG9uZW50SW5DaGlsZHJlbu+8iSAqL1xuZnVuY3Rpb24gZmluZEZpcnN0Q29tcG9uZW50KG5vZGU6IGFueSwgY2xzOiBhbnkpOiBhbnkge1xuICAgIGlmICghbm9kZSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY29tcCA9IG5vZGUuZ2V0Q29tcG9uZW50ID8gbm9kZS5nZXRDb21wb25lbnQoY2xzKSA6IG51bGw7XG4gICAgaWYgKGNvbXApIHJldHVybiBjb21wO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiB8fCBbXSkge1xuICAgICAgICBjb25zdCBoaXQgPSBmaW5kRmlyc3RDb21wb25lbnQoY2hpbGQsIGNscyk7XG4gICAgICAgIGlmIChoaXQpIHJldHVybiBoaXQ7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG4vKiog6YCS5b2S5pS26ZuG5omA5pyJ5oyH5a6a57G75Z6L55qE57uE5Lu2ICovXG5mdW5jdGlvbiBjb2xsZWN0Q29tcG9uZW50cyhub2RlOiBhbnksIGNsczogYW55LCBvdXQ6IGFueVtdKTogdm9pZCB7XG4gICAgaWYgKCFub2RlKSByZXR1cm47XG4gICAgY29uc3QgY29tcCA9IG5vZGUuZ2V0Q29tcG9uZW50ID8gbm9kZS5nZXRDb21wb25lbnQoY2xzKSA6IG51bGw7XG4gICAgaWYgKGNvbXApIG91dC5wdXNoKGNvbXApO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiB8fCBbXSkgY29sbGVjdENvbXBvbmVudHMoY2hpbGQsIGNscywgb3V0KTtcbn1cblxuLyoqXG4gKiDnvJbovpHmqKHlvI/kuIvlnLrmma/kuI3mmK/ov57nu63muLLmn5PnmoTvvIxFVkVOVF9BRlRFUl9EUkFXIOS4jeS8muiHquW3seadpe+8jOmcgOimgeS4u+WKqOinpuWPkemHjee7mOOAglxuICog6L+U5Zue5a6e6ZmF55So5Yiw55qE6Kem5Y+R5pa55byP77yIbm9uZSDooajnpLrkuKTnp43mjqXlj6Ppg73msqHmib7liLDvvInjgIJcbiAqL1xuZnVuY3Rpb24ga2lja1JlcGFpbnQoY2M6IGFueSk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY2NlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XG4gICAgICAgIGlmIChjY2UgJiYgY2NlLkVuZ2luZSAmJiB0eXBlb2YgY2NlLkVuZ2luZS5yZXBhaW50SW5FZGl0TW9kZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2NlLkVuZ2luZS5yZXBhaW50SW5FZGl0TW9kZSgpO1xuICAgICAgICAgICAgcmV0dXJuICdyZXBhaW50SW5FZGl0TW9kZSc7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB0cnkge1xuICAgICAgICBpZiAoY2MuZ2FtZSAmJiB0eXBlb2YgY2MuZ2FtZS5zdGVwID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYy5nYW1lLnN0ZXAoKTtcbiAgICAgICAgICAgIHJldHVybiAnZ2FtZS5zdGVwJztcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHJldHVybiAnbm9uZSc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNjID0gZ2V0RW5naW5lKCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbY29jb3MtbWNwXSDlnLrmma/ohJrmnKzlt7LliqDovb0sIOW8leaTjueJiOacrCAke2NjLkVOR0lORV9WRVJTSU9OIHx8ICd1bmtub3duJ31gKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tjb2Nvcy1tY3BdIOWcuuaZr+iEmuacrOWKoOi9veWksei0pTonLCBlKTtcbiAgICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XG4gICAgY2FjaGVkRW5naW5lID0gbnVsbDtcbn1cblxuLyoqIOWcuuaZr+iEmuacrOWvueWkluaatOmcsueahOaWueazle+8jOmAmui/hyBleGVjdXRlLXNjZW5lLXNjcmlwdCDosIPnlKggKi9cbmV4cG9ydCBjb25zdCBtZXRob2RzID0ge1xuICAgIC8qKlxuICAgICAqIOivu+WPluW8leaTjuS4juW9k+WJjeWcuuaZr+S/oeaBr1xuICAgICAqL1xuICAgIGVuZ2luZUluZm8oKTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZW5naW5lVmVyc2lvbjogY2MuRU5HSU5FX1ZFUlNJT04gfHwgKGNjLmdhbWUgJiYgY2MuZ2FtZS52ZXJzaW9uKSB8fCAnJyxcbiAgICAgICAgICAgIHNjZW5lTmFtZTogc2NlbmUgPyBzY2VuZS5uYW1lIDogbnVsbCxcbiAgICAgICAgICAgIHNjZW5lVXVpZDogc2NlbmUgPyBzY2VuZS51dWlkIDogbnVsbCxcbiAgICAgICAgICAgIGNoaWxkQ291bnQ6IHNjZW5lID8gc2NlbmUuY2hpbGRyZW4ubGVuZ3RoIDogMCxcbiAgICAgICAgfTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog55So5byV5pOOIEFQSSDlnKjlvZPliY3lnLrmma/kuIvliJvlu7rkuIDkuKroioLngrlcbiAgICAgKiBAcGFyYW0gbmFtZSDoioLngrnlkI1cbiAgICAgKiBAcGFyYW0gcG9zaXRpb24geyB4LCB5LCB6IH1cbiAgICAgKi9cbiAgICBjcmVhdGVOb2RlKG5hbWU6IHN0cmluZyA9ICdNQ1BfRW5naW5lX05vZGUnLCBwb3NpdGlvbj86IHsgeD86IG51bWJlcjsgeT86IG51bWJlcjsgej86IG51bWJlciB9KTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICBpZiAoIXNjZW5lKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmvJyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBvcyA9IHBvc2l0aW9uIHx8IHt9O1xuICAgICAgICBjb25zdCBub2RlID0gbmV3IGNjLk5vZGUoU3RyaW5nKG5hbWUgfHwgJ01DUF9FbmdpbmVfTm9kZScpKTtcbiAgICAgICAgbm9kZS5zZXRQb3NpdGlvbihOdW1iZXIocG9zLngpIHx8IDAsIE51bWJlcihwb3MueSkgfHwgMCwgTnVtYmVyKHBvcy56KSB8fCAwKTtcbiAgICAgICAgc2NlbmUuYWRkQ2hpbGQobm9kZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIHV1aWQ6IG5vZGUudXVpZCxcbiAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgIHBvc2l0aW9uOiBwbGFpbihub2RlLnBvc2l0aW9uKSxcbiAgICAgICAgICAgIHBhcmVudDogc2NlbmUubmFtZSxcbiAgICAgICAgfTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog55So5byV5pOOIEFQSSDnp7vliqjoioLngrlcbiAgICAgKiBAcGFyYW0gdXVpZCDoioLngrkgdXVpZFxuICAgICAqIEBwYXJhbSBwb3NpdGlvbiB7IHgsIHksIHogfVxuICAgICAqL1xuICAgIG1vdmVOb2RlKHV1aWQ6IHN0cmluZywgcG9zaXRpb24/OiB7IHg/OiBudW1iZXI7IHk/OiBudW1iZXI7IHo/OiBudW1iZXIgfSk6IGFueSB7XG4gICAgICAgIGNvbnN0IGNjID0gZ2V0RW5naW5lKCk7XG4gICAgICAgIGNvbnN0IHNjZW5lID0gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgaWYgKCFzY2VuZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZrycgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0YXJnZXQgPSBmaW5kQnlVdWlkKHNjZW5lLCB1dWlkKTtcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDmib7kuI3liLDoioLngrk6ICR7dXVpZH1gIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcG9zID0gcG9zaXRpb24gfHwge307XG4gICAgICAgIHRhcmdldC5zZXRQb3NpdGlvbihOdW1iZXIocG9zLngpIHx8IDAsIE51bWJlcihwb3MueSkgfHwgMCwgTnVtYmVyKHBvcy56KSB8fCAwKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgdXVpZDogdGFyZ2V0LnV1aWQsXG4gICAgICAgICAgICBuYW1lOiB0YXJnZXQubmFtZSxcbiAgICAgICAgICAgIHBvc2l0aW9uOiBwbGFpbih0YXJnZXQucG9zaXRpb24pLFxuICAgICAgICB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJflh7rlvZPliY3lnLrmma/nmoToioLngrnvvIjlvJXmk47kvqfop4bop5LvvIlcbiAgICAgKi9cbiAgICBsaXN0Tm9kZXMoKTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICBpZiAoIXNjZW5lKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmvJyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55LCBkZXB0aDogbnVtYmVyKTogYW55W10gPT4ge1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHtcbiAgICAgICAgICAgICAgICB1dWlkOiBub2RlLnV1aWQsXG4gICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgIGRlcHRoLFxuICAgICAgICAgICAgICAgIGFjdGl2ZTogbm9kZS5hY3RpdmUsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50czogKG5vZGUuY29tcG9uZW50cyB8fCBbXSkubWFwKChjb21wOiBhbnkpID0+IGNvbXAubmFtZSB8fCBjb21wLmNvbnN0cnVjdG9yPy5uYW1lIHx8ICc/JyksXG4gICAgICAgICAgICAgICAgY2hpbGRyZW46IFtdIGFzIGFueVtdLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikge1xuICAgICAgICAgICAgICAgIGl0ZW0uY2hpbGRyZW4ucHVzaCguLi53YWxrKGNoaWxkLCBkZXB0aCArIDEpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBbaXRlbV07XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IG5vZGVzID0gc2NlbmUuY2hpbGRyZW4ucmVkdWNlKChhY2M6IGFueVtdLCBjaGlsZDogYW55KSA9PiBhY2MuY29uY2F0KHdhbGsoY2hpbGQsIDApKSwgW10pO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgc2NlbmU6IHNjZW5lLm5hbWUsIGNvdW50OiBub2Rlcy5sZW5ndGgsIG5vZGVzIH07XG4gICAgfSxcblxuICAgIC8qKlxuICAgICAqIOeUqOW8leaTjiBBUEkg57uZ6IqC54K55oyC57uE5Lu244CCXG4gICAgICpcbiAgICAgKiDnvJbovpHlmajmtojmga/pgJrpgZPnmoQgY3JlYXRlLWNvbXBvbmVudCDlr7nlhoXnva7nu4Tku7bvvIhjYy5TcHJpdGXvvInmnInmlYjvvIxcbiAgICAgKiDkvYbmjILnlKjmiLfoh6rlrprkuYnohJrmnKznu4Tku7bml7bml6DmlYjigJTigJToh6rlrprkuYnohJrmnKznmoQgY2NjbGFzcyDpnIDopoHlnKjlnLrmma/ov5vnqIvph4xcbiAgICAgKiDlt7Lnu4/ms6jlhozvvIzmiYDku6Xov5nmnaHot6/opoHotbDlvJXmk47jgIJcbiAgICAgKlxuICAgICAqIEBwYXJhbSBub2RlVXVpZCDoioLngrkgdXVpZFxuICAgICAqIEBwYXJhbSBjb21wb25lbnQg57uE5Lu257G75ZCN5oiWIGNpZFxuICAgICAqL1xuICAgIGFkZENvbXBvbmVudFRvTm9kZShub2RlVXVpZDogc3RyaW5nLCBjb21wb25lbnQ6IHN0cmluZyk6IGFueSB7XG4gICAgICAgIGNvbnN0IGNjID0gZ2V0RW5naW5lKCk7XG4gICAgICAgIGNvbnN0IHNjZW5lID0gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcbiAgICAgICAgaWYgKCFzY2VuZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZrycgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0YXJnZXQgPSBmaW5kQnlVdWlkKHNjZW5lLCBub2RlVXVpZCk7XG4gICAgICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBg5om+5LiN5Yiw6IqC54K5OiAke25vZGVVdWlkfWAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOWFiOaMieexu+WQjeafpe+8jOWGjeaMiSBjaWQg5p+l77yIX2lkVG9DbGFzcyDooajvvIlcbiAgICAgICAgbGV0IGNsczogYW55ID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNscyA9IGNjLmpzLmdldENsYXNzQnlOYW1lKGNvbXBvbmVudCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGNscyA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFjbHMpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY2xzID0gY2MuanMuZ2V0Q2xhc3NCeUlkKGNvbXBvbmVudCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgY2xzID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoIWNscykge1xuICAgICAgICAgICAgLy8g5YWc5bqV77ya5Zyo5bey5rOo5YaM57G75ZCN6KGo6YeM5om+77yI5b+955Wl5aSn5bCP5YaZ77yJXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVNYXAgPSBjYy5qcy5fbmFtZVRvQ2xhc3M7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWVNYXAgJiYgdHlwZW9mIG5hbWVNYXAuZm9yRWFjaCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgZm91bmQ6IGFueSA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIG5hbWVNYXAuZm9yRWFjaCgodmFsdWU6IGFueSwga2V5OiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghZm91bmQgJiYga2V5ICYmIGtleS50b0xvd2VyQ2FzZSgpID09PSBTdHJpbmcoY29tcG9uZW50KS50b0xvd2VyQ2FzZSgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm91bmQgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIGNscyA9IGZvdW5kO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICBjbHMgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFjbHMpIHtcbiAgICAgICAgICAgIC8vIOiviuaWre+8muaKiuW3suazqOWGjOeahOeUqOaIt+exu+WQjeWIl+WHuuadpVxuICAgICAgICAgICAgbGV0IHJlZ2lzdGVyZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVNYXAgPSBjYy5qcy5fbmFtZVRvQ2xhc3M7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWVNYXAgJiYgdHlwZW9mIG5hbWVNYXAuZm9yRWFjaCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgICAgICBuYW1lTWFwLmZvckVhY2goKHZhbHVlOiBhbnksIGtleTogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoa2V5ICYmICFrZXkuc3RhcnRzV2l0aCgnY2MuJykgJiYga2V5LmluZGV4T2YoJy4nKSA8IDApIHJlZ2lzdGVyZWQucHVzaChrZXkpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJlZCA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6IGDlvJXmk47ph4zmib7kuI3liLDnu4Tku7bnsbvjgIwke2NvbXBvbmVudH3jgI3vvIjlj6/og73ohJrmnKzmqKHlnZfov5jmsqHlnKjlnLrmma/ov5vnqIvph4zliqDovb3vvIlgLFxuICAgICAgICAgICAgICAgIHJlZ2lzdGVyZWRVc2VyQ2xhc3NlczogcmVnaXN0ZXJlZC5zbGljZSgwLCA1MCksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbXAgPSB0YXJnZXQuYWRkQ29tcG9uZW50KGNscyk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgICAgIG5vZGU6IHRhcmdldC51dWlkLFxuICAgICAgICAgICAgICAgIGNvbXBvbmVudDogY29tcCA/IChjb21wLm5hbWUgfHwgY29tcC5jb25zdHJ1Y3Rvcj8ubmFtZSkgOiBjb21wb25lbnQsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50VXVpZDogY29tcCA/IGNvbXAudXVpZCA6ICcnLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZTogY29tcCAmJiBjb21wLmNvbnN0cnVjdG9yID8gY29tcC5jb25zdHJ1Y3Rvci5uYW1lIDogY29tcG9uZW50LFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgYWRkQ29tcG9uZW50IOWksei0pTogJHtlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog55So5byV5pOOIEFQSSDnu5noioLngrnmiJbnu4Tku7borr7nva7lsZ7mgKfvvIjnvJbovpHlmajmtojmga/pgJrpgZPmkJ7kuI3lrprnmoTlnLrmma/nlKjlroPlhZzlupXvvIxcbiAgICAgKiDmr5TlpoLnu5noh6rlrprkuYnohJrmnKznu4Tku7bnu5HlrpogQHByb3BlcnR5IOW8leeUqO+8ieOAglxuICAgICAqIEBwYXJhbSBub2RlVXVpZCDoioLngrkgdXVpZFxuICAgICAqIEBwYXJhbSBjb21wb25lbnQg57uE5Lu257G75ZCN5oiWIGNpZO+8m+epuuWtl+espuS4suihqOekuuiuvue9ruiKgueCueacrOi6q+eahOWxnuaAp1xuICAgICAqIEBwYXJhbSBwcm9wIOWxnuaAp+WQjVxuICAgICAqIEBwYXJhbSB2YWx1ZSDnuq8gSlNPTiDlgLzvvIzmlK/mjIEgX191dWlkIC8gX192ZWMgLyBfX3NpemUgLyBfX2NvbG9yIOeJueauiuW9ouW8j1xuICAgICAqL1xuICAgIHNldE5vZGVQcm9wZXJ0eShub2RlVXVpZDogc3RyaW5nLCBjb21wb25lbnQ6IHN0cmluZywgcHJvcDogc3RyaW5nLCB2YWx1ZTogYW55KTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICBpZiAoIXNjZW5lKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmvJyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKHNjZW5lLCBub2RlVXVpZCk7XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsOiKgueCuTogJHtub2RlVXVpZH1gIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgaG9zdDogYW55ID0gbm9kZTtcbiAgICAgICAgbGV0IGhvc3ROYW1lID0gJ25vZGUnO1xuICAgICAgICBjb25zdCBjb21wTmFtZSA9IFN0cmluZyhjb21wb25lbnQgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKGNvbXBOYW1lICYmIGNvbXBOYW1lICE9PSAnbm9kZScpIHtcbiAgICAgICAgICAgIGxldCBjbHM6IGFueSA9IG51bGw7XG4gICAgICAgICAgICB0cnkgeyBjbHMgPSBjYy5qcy5nZXRDbGFzc0J5TmFtZShjb21wTmFtZSk7IH0gY2F0Y2ggKGUpIHsgY2xzID0gbnVsbDsgfVxuICAgICAgICAgICAgaWYgKCFjbHMpIHtcbiAgICAgICAgICAgICAgICB0cnkgeyBjbHMgPSBjYy5qcy5nZXRDbGFzc0J5SWQoY29tcE5hbWUpOyB9IGNhdGNoIChlKSB7IGNscyA9IG51bGw7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghY2xzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogYOW8leaTjumHjOaJvuS4jeWIsOe7hOS7tuexu+OAjCR7Y29tcE5hbWV944CNYCxcbiAgICAgICAgICAgICAgICAgICAgbm9kZUNvbXBvbmVudHM6IChub2RlLmNvbXBvbmVudHMgfHwgW10pLm1hcCgoYzogYW55KSA9PiBjLm5hbWUgfHwgJz8nKSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaG9zdCA9IG5vZGUuZ2V0Q29tcG9uZW50KGNscyk7XG4gICAgICAgICAgICBpZiAoIWhvc3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBg6IqC54K5ICR7bm9kZS5uYW1lfSDkuIrmsqHmnInnu4Tku7bjgIwke2NvbXBOYW1lfeOAjWAsXG4gICAgICAgICAgICAgICAgICAgIG5vZGVDb21wb25lbnRzOiAobm9kZS5jb21wb25lbnRzIHx8IFtdKS5tYXAoKGM6IGFueSkgPT4gYy5uYW1lIHx8ICc/JyksXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGhvc3ROYW1lID0gY29tcE5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlVmFsdWUoY2MsIHNjZW5lLCB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoaG9zdCA9PT0gbm9kZSAmJiBwcm9wID09PSAncG9zaXRpb24nKSB7XG4gICAgICAgICAgICAgICAgbm9kZS5zZXRQb3NpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgTnVtYmVyKHJlc29sdmVkPy54KSB8fCAwLFxuICAgICAgICAgICAgICAgICAgICBOdW1iZXIocmVzb2x2ZWQ/LnkpIHx8IDAsXG4gICAgICAgICAgICAgICAgICAgIE51bWJlcihyZXNvbHZlZD8ueikgfHwgMFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGhvc3RbcHJvcF0gPSByZXNvbHZlZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICAgICAgbm9kZTogbm9kZS51dWlkLFxuICAgICAgICAgICAgICAgIG5vZGVOYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiBob3N0TmFtZSxcbiAgICAgICAgICAgICAgICBwcm9wLFxuICAgICAgICAgICAgICAgIGFwcGxpZWQ6IHBsYWluKGhvc3QgPT09IG5vZGUgJiYgcHJvcCA9PT0gJ3Bvc2l0aW9uJyA/IG5vZGUucG9zaXRpb24gOiBob3N0W3Byb3BdKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOiuvue9ruWxnuaAp+Wksei0pTogJHtlICYmIGUubWVzc2FnZSA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gIH07XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5Zue6K+757uE5Lu25b2T5YmN55qE5bGe5oCn5YC877yIbm9kZS5iaW5kUHJvcGVydHkg57uR5a6a5ZCO55qE6aqM6K+B6YCa6YGT77yJ44CCXG4gICAgICog5byV55So5YC86L+U5ZueIHsga2luZDonbm9kZSd8J2NvbXBvbmVudCd8J2Fzc2V0JywgdXVpZCwgLi4uIH3vvIzmma7pgJrlgLzov5Tlm54geyBraW5kOidyYXcnLCB2YWx1ZSB944CCXG4gICAgICogQHBhcmFtIG5vZGVVdWlkIOiKgueCuSB1dWlkXG4gICAgICogQHBhcmFtIGNvbXBvbmVudCDnu4Tku7bntKLlvJXvvIjlrZfnrKbkuLLmlbDlrZfvvIkvIOexu+WQjSAvIOe7hOS7tiB1dWlk77ybJ25vZGUnIOaIluepuuihqOekuuiKgueCueacrOi6q1xuICAgICAqIEBwYXJhbSBwcm9wIOWxnuaAp+WQjVxuICAgICAqL1xuICAgIHJlYWRDb21wb25lbnRQcm9wZXJ0eShub2RlVXVpZDogc3RyaW5nLCBjb21wb25lbnQ6IHN0cmluZywgcHJvcDogc3RyaW5nKTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICBpZiAoIXNjZW5lKSB7XG4gICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmvJyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKHNjZW5lLCBub2RlVXVpZCk7XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOaJvuS4jeWIsOiKgueCuTogJHtub2RlVXVpZH1gIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgaG9zdDogYW55ID0gbm9kZTtcbiAgICAgICAgY29uc3QgY29tcFNwZWMgPSBTdHJpbmcoY29tcG9uZW50IHx8ICcnKS50cmltKCk7XG4gICAgICAgIGlmIChjb21wU3BlYyAmJiBjb21wU3BlYyAhPT0gJ25vZGUnKSB7XG4gICAgICAgICAgICBpZiAoL15cXGQrJC8udGVzdChjb21wU3BlYykpIHtcbiAgICAgICAgICAgICAgICBob3N0ID0gKG5vZGUuY29tcG9uZW50cyB8fCBbXSlbcGFyc2VJbnQoY29tcFNwZWMsIDEwKV0gfHwgbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghaG9zdCkge1xuICAgICAgICAgICAgICAgIGhvc3QgPSAobm9kZS5jb21wb25lbnRzIHx8IFtdKS5maW5kKChjb21wOiBhbnkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb21wKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjb21wLnV1aWQgPT09IGNvbXBTcGVjKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNsc05hbWUgPSAnJztcbiAgICAgICAgICAgICAgICAgICAgbGV0IGN0b3JOYW1lID0gJyc7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7IGNsc05hbWUgPSBjYy5qcy5nZXRDbGFzc05hbWUoY29tcCkgfHwgJyc7IH0gY2F0Y2ggKGUpIHsgY2xzTmFtZSA9ICcnOyB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChjb21wLmNvbnN0cnVjdG9yKSBjdG9yTmFtZSA9IGNvbXAuY29uc3RydWN0b3IubmFtZSB8fCAnJztcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYmFyZSA9IGNvbXBTcGVjLnN0YXJ0c1dpdGgoJ2NjLicpID8gY29tcFNwZWMuc2xpY2UoMykgOiBjb21wU3BlYztcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNsc05hbWUgPT09IGNvbXBTcGVjIHx8IGN0b3JOYW1lID09PSBjb21wU3BlYyB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgY2xzTmFtZSA9PT0gYmFyZSB8fCBjdG9yTmFtZSA9PT0gYmFyZTtcbiAgICAgICAgICAgICAgICB9KSB8fCBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFob3N0KSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZXMgPSAobm9kZS5jb21wb25lbnRzIHx8IFtdKS5tYXAoKGNvbXA6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0cnkgeyByZXR1cm4gY2MuanMuZ2V0Q2xhc3NOYW1lKGNvbXApIHx8IGNvbXAubmFtZSB8fCAnPyc7IH0gY2F0Y2ggKGUpIHsgcmV0dXJuIGNvbXA/Lm5hbWUgfHwgJz8nOyB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYOiKgueCuSAke25vZGUubmFtZX0g5LiK5om+5LiN5Yiw57uE5Lu244CMJHtjb21wU3BlY33jgI1gLCBub2RlQ29tcG9uZW50czogbmFtZXMgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB2YWx1ZTogYW55O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdmFsdWUgPSBob3N0W3Byb3BdO1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGDor7vlj5blsZ7mgKcgJHtwcm9wfSDlpLHotKU6ICR7ZT8ubWVzc2FnZSA/PyBTdHJpbmcoZSl9YCB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgIG5vZGU6IG5vZGUudXVpZCxcbiAgICAgICAgICAgIG5vZGVOYW1lOiBub2RlLm5hbWUsXG4gICAgICAgICAgICBwcm9wLFxuICAgICAgICAgICAgcmVmOiBkZXNjcmliZVJlZihjYywgdmFsdWUpLFxuICAgICAgICB9O1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDliJflh7rlvJXmk47kvqflt7Lms6jlhoznmoTnsbvlkI3vvIjor4rmlq3nlKjvvIlcbiAgICAgKi9cbiAgICBsaXN0UmVnaXN0ZXJlZENsYXNzZXMoKTogYW55IHtcbiAgICAgICAgY29uc3QgY2MgPSBnZXRFbmdpbmUoKTtcbiAgICAgICAgY29uc3QgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBuYW1lTWFwID0gY2MuanMuX25hbWVUb0NsYXNzO1xuICAgICAgICAgICAgaWYgKG5hbWVNYXAgJiYgdHlwZW9mIG5hbWVNYXAuZm9yRWFjaCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIG5hbWVNYXAuZm9yRWFjaCgodmFsdWU6IGFueSwga2V5OiBzdHJpbmcpID0+IHsgaWYgKGtleSkgbmFtZXMucHVzaChrZXkpOyB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlckNsYXNzZXMgPSBuYW1lcy5maWx0ZXIoKG4pID0+ICFuLnN0YXJ0c1dpdGgoJ2NjLicpICYmIG4uaW5kZXhPZignLicpIDwgMCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b3RhbDogbmFtZXMubGVuZ3RoLCB1c2VyQ2xhc3Nlcywgc2FtcGxlOiBuYW1lcy5zbGljZSgwLCA0MCkgfTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog5YW85a655pen5pa55rOV5ZCN77ya5Li76L+b56iL5aaC5p6c6L+Y5Zyo6LCDIGNhcHR1cmVTY2VuZe+8jOi9rOe7mSBjYXB0dXJlQ2FudmFz44CCXG4gICAgICovXG4gICAgYXN5bmMgY2FwdHVyZVNjZW5lKG1heFcgPSA3NjgpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zb2xlLmxvZygnW2NvY29zLW1jcF0gY2FwdHVyZVNjZW5lKOaXp+WQjSkgLT4g6L2s5Y+R57uZIGNhcHR1cmVDYW52YXMnKTtcbiAgICAgICAgcmV0dXJuIChtZXRob2RzIGFzIGFueSkuY2FwdHVyZUNhbnZhcyhtYXhXLCB0cnVlKTtcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICog6K+K5pat77ya5LiN5riy5p+T77yM5Y+q5oql5ZGK5oiq5Zu+5omA6ZyA55qE5p2h5Lu25piv5ZCm5YW35aSH44CC5Ye66Zeu6aKY5pe25YWI6LCD6L+Z5Liq44CCXG4gICAgICovXG4gICAgY2FwdHVyZURpYWcoKTogYW55IHtcbiAgICAgICAgY29uc29sZS5sb2coJ1tjb2Nvcy1tY3BdIGNhcHR1cmVEaWFnIGNhbGxlZCcpO1xuICAgICAgICBjb25zdCBpbmZvOiBhbnkgPSB7IG9rOiB0cnVlIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYyA9IGdldEVuZ2luZSgpO1xuICAgICAgICAgICAgaW5mby5lbmdpbmVWZXJzaW9uID0gY2MuRU5HSU5FX1ZFUlNJT04gfHwgJyc7XG4gICAgICAgICAgICBjb25zdCBzY2VuZSA9IGNjLmRpcmVjdG9yLmdldFNjZW5lKCk7XG4gICAgICAgICAgICBpbmZvLmhhc1NjZW5lID0gISFzY2VuZTtcbiAgICAgICAgICAgIGluZm8uc2NlbmVOYW1lID0gc2NlbmUgPyBzY2VuZS5uYW1lIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChzY2VuZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbnZhc0NvbXAgPSBmaW5kRmlyc3RDb21wb25lbnQoc2NlbmUsIGNjLkNhbnZhcyk7XG4gICAgICAgICAgICAgICAgaW5mby5oYXNDYW52YXMgPSAhIWNhbnZhc0NvbXA7XG4gICAgICAgICAgICAgICAgaWYgKGNhbnZhc0NvbXApIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdWkgPSBjYW52YXNDb21wLm5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcbiAgICAgICAgICAgICAgICAgICAgaW5mby5jYW52YXNOb2RlID0gY2FudmFzQ29tcC5ub2RlLm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGluZm8uY2FudmFzTGF5ZXIgPSBjYW52YXNDb21wLm5vZGUubGF5ZXI7XG4gICAgICAgICAgICAgICAgICAgIGluZm8uY2FudmFzU2l6ZSA9IHVpID8gW3VpLmNvbnRlbnRTaXplLndpZHRoLCB1aS5jb250ZW50U2l6ZS5oZWlnaHRdIDogbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgaW5mby5jYW52YXNCb3VuZENhbWVyYSA9IGNhbnZhc0NvbXAuY2FtZXJhQ29tcG9uZW50ID8gY2FudmFzQ29tcC5jYW1lcmFDb21wb25lbnQubm9kZS5uYW1lIDogbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgY2FtczogYW55W10gPSBbXTtcbiAgICAgICAgICAgICAgICBjb2xsZWN0Q29tcG9uZW50cyhzY2VuZSwgY2MuQ2FtZXJhLCBjYW1zKTtcbiAgICAgICAgICAgICAgICBpbmZvLmNhbWVyYXMgPSBjYW1zLm1hcCgoYykgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgbm9kZTogYy5ub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHByaW9yaXR5OiBjLnByaW9yaXR5LFxuICAgICAgICAgICAgICAgICAgICB2aXNpYmlsaXR5OiBjLnZpc2liaWxpdHksXG4gICAgICAgICAgICAgICAgICAgIGhhc1RhcmdldFRleHR1cmU6ICEhYy50YXJnZXRUZXh0dXJlLFxuICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGNjZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xuICAgICAgICAgICAgaW5mby5oYXNDY2UgPSAhIWNjZTtcbiAgICAgICAgICAgIGluZm8uaGFzUmVwYWludEluRWRpdE1vZGUgPSAhIShjY2UgJiYgY2NlLkVuZ2luZSAmJiB0eXBlb2YgY2NlLkVuZ2luZS5yZXBhaW50SW5FZGl0TW9kZSA9PT0gJ2Z1bmN0aW9uJyk7XG4gICAgICAgICAgICBpbmZvLmhhc0dhbWVTdGVwID0gISEoY2MuZ2FtZSAmJiB0eXBlb2YgY2MuZ2FtZS5zdGVwID09PSAnZnVuY3Rpb24nKTtcbiAgICAgICAgICAgIGluZm8uaGFzUmVuZGVyVGV4dHVyZSA9IHR5cGVvZiBjYy5SZW5kZXJUZXh0dXJlID09PSAnZnVuY3Rpb24nO1xuICAgICAgICAgICAgaW5mby5oYXNEb2N1bWVudCA9IHR5cGVvZiBkb2N1bWVudCAhPT0gJ3VuZGVmaW5lZCc7XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgaW5mby5vayA9IGZhbHNlO1xuICAgICAgICAgICAgaW5mby5lcnJvciA9IGU/LnN0YWNrID8/IGU/Lm1lc3NhZ2UgPz8gU3RyaW5nKGUpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpbmZvO1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiDmiKrlj5YgQ2FudmFzIOWGheWuueS4uiBiYXNlNjQgSlBFR++8iOemu+Wxj+a4suafk++8muS4jeWQq+e9keagvCAvIEdpem1v77yM5LiN5Y+X5Zy65pmv6KeG5Zu+57yp5pS+5bmz56e75b2x5ZON77yJ44CCXG4gICAgICpcbiAgICAgKiDlgZrms5XvvJrmiormuLLmn5MgQ2FudmFzIOeahOebuOacuuS4tOaXtuaMh+WQkeS4gOW8oCBSZW5kZXJUZXh0dXJl77yM562JIDIg5bin5ZCOIHJlYWRQaXhlbHPvvIxcbiAgICAgKiDlho3ov5jljp/nm7jmnLrjgILnvJbovpHmqKHlvI/kuIvlnLrmma/kuI3mmK/ov57nu63muLLmn5PnmoTvvIzmiYDku6XpnIDopoHkuLvliqjop6blj5Hph43nu5jvvIhraWNr77yJ44CCXG4gICAgICpcbiAgICAgKiDlpLHotKXml7bov5Tlm54geyBvazpmYWxzZSwgc3RhZ2UsIGVycm9yIH3vvIxzdGFnZSDmjIfmmI7lpLHotKXlnKjlk6rkuIDmraXvvJpcbiAgICAgKiAgIGZpbmQtc2NlbmUgLyBmaW5kLWNhbnZhcyAvIGZpbmQtY2FtZXJhIC8gc2V0dXAtcnQgLyB3YWl0LWZyYW1lIC8gZW5jb2RlXG4gICAgICpcbiAgICAgKiBAcGFyYW0gbWF4VyAg6L6T5Ye65Zu+5a695bqm5LiK6ZmQ77yI562J5q+U57yp5bCP77yJXG4gICAgICogQHBhcmFtIGZsaXBZIOaYr+WQpuS4iuS4i+e/u+i9rOWDj+e0oO+8iHJlYWRQaXhlbHMg6YCa5bi45piv6Ieq5LiL6ICM5LiK77yb5Zu+5piv5YCS55qE5bCx5LygIGZhbHNl77yJXG4gICAgICovXG4gICAgYXN5bmMgY2FwdHVyZUNhbnZhcyhtYXhXID0gNzY4LCBmbGlwWSA9IHRydWUpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zb2xlLmxvZygnW2NvY29zLW1jcF0gY2FwdHVyZUNhbnZhcyBjYWxsZWQnLCBtYXhXLCBmbGlwWSk7XG4gICAgICAgIGxldCBzdGFnZSA9ICdpbml0JztcbiAgICAgICAgbGV0IGNhbTogYW55ID0gbnVsbDtcbiAgICAgICAgbGV0IG9sZFRhcmdldDogYW55ID0gbnVsbDtcbiAgICAgICAgbGV0IHJ0OiBhbnkgPSBudWxsO1xuICAgICAgICBsZXQgaGFuZGxlcjogYW55ID0gbnVsbDtcbiAgICAgICAgbGV0IHRpbWVyOiBhbnkgPSBudWxsO1xuICAgICAgICBsZXQgY2M6IGFueSA9IG51bGw7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNjID0gZ2V0RW5naW5lKCk7XG5cbiAgICAgICAgICAgIHN0YWdlID0gJ2ZpbmQtc2NlbmUnO1xuICAgICAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgICAgICAgICAgaWYgKCFzY2VuZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBzdGFnZSwgZXJyb3I6ICflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma8nIH07XG5cbiAgICAgICAgICAgIHN0YWdlID0gJ2ZpbmQtY2FudmFzJztcbiAgICAgICAgICAgIGNvbnN0IGNhbnZhc0NvbXAgPSBmaW5kRmlyc3RDb21wb25lbnQoc2NlbmUsIGNjLkNhbnZhcyk7XG4gICAgICAgICAgICBpZiAoIWNhbnZhc0NvbXApIHJldHVybiB7IG9rOiBmYWxzZSwgc3RhZ2UsIGVycm9yOiAn5Zy65pmv6YeM5rKh5pyJIENhbnZhcycgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhbnZhc05vZGUgPSBjYW52YXNDb21wLm5vZGU7XG4gICAgICAgICAgICBjb25zdCB1aSA9IGNhbnZhc05vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcbiAgICAgICAgICAgIGlmICghdWkpIHJldHVybiB7IG9rOiBmYWxzZSwgc3RhZ2UsIGVycm9yOiAnQ2FudmFzIOiKgueCueayoeaciSBVSVRyYW5zZm9ybScgfTtcbiAgICAgICAgICAgIGNvbnN0IFcgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKHVpLmNvbnRlbnRTaXplLndpZHRoKSk7XG4gICAgICAgICAgICBjb25zdCBIID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZCh1aS5jb250ZW50U2l6ZS5oZWlnaHQpKTtcblxuICAgICAgICAgICAgc3RhZ2UgPSAnZmluZC1jYW1lcmEnO1xuICAgICAgICAgICAgY2FtID0gY2FudmFzQ29tcC5jYW1lcmFDb21wb25lbnQ7XG4gICAgICAgICAgICBpZiAoIWNhbSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbXM6IGFueVtdID0gW107XG4gICAgICAgICAgICAgICAgY29sbGVjdENvbXBvbmVudHMoc2NlbmUsIGNjLkNhbWVyYSwgY2Ftcyk7XG4gICAgICAgICAgICAgICAgY2FtID0gY2Ftc1xuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKChjKSA9PiAoYy52aXNpYmlsaXR5ICYgY2FudmFzTm9kZS5sYXllcikgIT09IDApXG4gICAgICAgICAgICAgICAgICAgIC5zb3J0KChhLCBiKSA9PiBiLnByaW9yaXR5IC0gYS5wcmlvcml0eSlbMF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWNhbSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBzdGFnZSwgZXJyb3I6ICfmib7kuI3liLDmuLLmn5MgQ2FudmFzIOeahOebuOacuicgfTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdbY29jb3MtbWNwXSBjYXB0dXJlQ2FudmFzIGNhbWVyYSA9JywgY2FtLm5vZGUubmFtZSwgJ3NpemUgPScsIFcsIEgpO1xuXG4gICAgICAgICAgICBzdGFnZSA9ICdzZXR1cC1ydCc7XG4gICAgICAgICAgICBydCA9IG5ldyBjYy5SZW5kZXJUZXh0dXJlKCk7XG4gICAgICAgICAgICBydC5yZXNldCh7IHdpZHRoOiBXLCBoZWlnaHQ6IEggfSk7XG4gICAgICAgICAgICBvbGRUYXJnZXQgPSBjYW0udGFyZ2V0VGV4dHVyZTtcbiAgICAgICAgICAgIGNhbS50YXJnZXRUZXh0dXJlID0gcnQ7XG5cbiAgICAgICAgICAgIHN0YWdlID0gJ3dhaXQtZnJhbWUnO1xuICAgICAgICAgICAgbGV0IGtpY2tlZCA9ICdub25lJztcbiAgICAgICAgICAgIGNvbnN0IHBpeGVsczogVWludDhBcnJheSA9IGF3YWl0IG5ldyBQcm9taXNlPFVpbnQ4QXJyYXk+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgZnJhbWVzID0gMDtcbiAgICAgICAgICAgICAgICBoYW5kbGVyID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBmcmFtZXMrKztcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZyYW1lcyA8IDIpIHJldHVybjsgLy8g56ysIDEg5bin6K6pIHRhcmdldFRleHR1cmUg55Sf5pWI77yM56ysIDIg5bin5omN5piv5a6M5pW055S76Z2iXG4gICAgICAgICAgICAgICAgICAgIGNjLmRpcmVjdG9yLm9mZihjYy5EaXJlY3Rvci5FVkVOVF9BRlRFUl9EUkFXLCBoYW5kbGVyKTtcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7IHJlc29sdmUocnQucmVhZFBpeGVscygwLCAwLCBXLCBIKSBhcyBVaW50OEFycmF5KTsgfVxuICAgICAgICAgICAgICAgICAgICBjYXRjaCAoZSkgeyByZWplY3QoZSk7IH1cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGNjLmRpcmVjdG9yLm9uKGNjLkRpcmVjdG9yLkVWRU5UX0FGVEVSX0RSQVcsIGhhbmRsZXIpO1xuICAgICAgICAgICAgICAgIGtpY2tlZCA9IGtpY2tSZXBhaW50KGNjKTtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGtpY2tSZXBhaW50KGNjKSwgMTUwKTtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGtpY2tSZXBhaW50KGNjKSwgNDAwKTtcbiAgICAgICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAgICAgICAgICAgICAgICgpID0+IHJlamVjdChuZXcgRXJyb3IoYOetieW+hea4suafk+W4p+i2heaXtu+8iOinpuWPkeaWueW8jzogJHtraWNrZWR977yJYCkpLFxuICAgICAgICAgICAgICAgICAgICAzMDAwXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKCFwaXhlbHMgfHwgIXBpeGVscy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHN0YWdlLCBlcnJvcjogJ3JlYWRQaXhlbHMg6L+U5Zue56m65pWw5o2uJyB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzdGFnZSA9ICdlbmNvZGUnO1xuICAgICAgICAgICAgY29uc3QgZnVsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgICAgICAgICAgZnVsbC53aWR0aCA9IFc7XG4gICAgICAgICAgICBmdWxsLmhlaWdodCA9IEg7XG4gICAgICAgICAgICBjb25zdCBjdHggPSBmdWxsLmdldENvbnRleHQoJzJkJykhO1xuICAgICAgICAgICAgY29uc3QgaW1nID0gY3R4LmNyZWF0ZUltYWdlRGF0YShXLCBIKTtcbiAgICAgICAgICAgIGNvbnN0IHJvdyA9IFcgKiA0O1xuICAgICAgICAgICAgZm9yIChsZXQgeSA9IDA7IHkgPCBIOyB5KyspIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzeSA9IGZsaXBZID8gKEggLSAxIC0geSkgOiB5O1xuICAgICAgICAgICAgICAgIGltZy5kYXRhLnNldChwaXhlbHMuc3ViYXJyYXkoc3kgKiByb3csIHN5ICogcm93ICsgcm93KSwgeSAqIHJvdyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdHgucHV0SW1hZ2VEYXRhKGltZywgMCwgMCk7XG5cbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgbWF4VyAvIFcpO1xuICAgICAgICAgICAgY29uc3Qgb3V0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgICAgICAgICBvdXQud2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKFcgKiBzY2FsZSkpO1xuICAgICAgICAgICAgb3V0LmhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoSCAqIHNjYWxlKSk7XG4gICAgICAgICAgICBvdXQuZ2V0Q29udGV4dCgnMmQnKSEuZHJhd0ltYWdlKGZ1bGwsIDAsIDAsIG91dC53aWR0aCwgb3V0LmhlaWdodCk7XG5cbiAgICAgICAgICAgIGNvbnN0IGRhdGFVcmwgPSBvdXQudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgMC43KTtcbiAgICAgICAgICAgIGNvbnN0IGJhc2U2NCA9IGRhdGFVcmwuc2xpY2UoZGF0YVVybC5pbmRleE9mKCcsJykgKyAxKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgICAgICAga2lja2VkLFxuICAgICAgICAgICAgICAgIGNhbWVyYTogY2FtLm5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICBjYW52YXNXaWR0aDogVyxcbiAgICAgICAgICAgICAgICBjYW52YXNIZWlnaHQ6IEgsXG4gICAgICAgICAgICAgICAgb3V0cHV0V2lkdGg6IG91dC53aWR0aCxcbiAgICAgICAgICAgICAgICBvdXRwdXRIZWlnaHQ6IG91dC5oZWlnaHQsXG4gICAgICAgICAgICAgICAgZm9ybWF0OiAnaW1hZ2UvanBlZycsXG4gICAgICAgICAgICAgICAgYnl0ZXM6IE1hdGgucm91bmQoYmFzZTY0Lmxlbmd0aCAqIDMgLyA0KSxcbiAgICAgICAgICAgICAgICBiYXNlNjQsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tjb2Nvcy1tY3BdIGNhcHR1cmVDYW52YXMgZmFpbGVkIGF0Jywgc3RhZ2UsIGUpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBzdGFnZSwgZXJyb3I6IGU/LnN0YWNrID8/IGU/Lm1lc3NhZ2UgPz8gU3RyaW5nKGUpIH07XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICBpZiAoaGFuZGxlciAmJiBjYykgeyB0cnkgeyBjYy5kaXJlY3Rvci5vZmYoY2MuRGlyZWN0b3IuRVZFTlRfQUZURVJfRFJBVywgaGFuZGxlcik7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfSB9XG4gICAgICAgICAgICAvLyDlv4Xpobvov5jljp/vvIzlkKbliJnlnLrmma/ph4zor6Xnm7jmnLrkvJrkuIDnm7TmuLLmn5PliLDnurnnkIZcbiAgICAgICAgICAgIGlmIChjYW0pIHsgdHJ5IHsgY2FtLnRhcmdldFRleHR1cmUgPSBvbGRUYXJnZXQ7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfSB9XG4gICAgICAgICAgICBpZiAocnQpIHsgdHJ5IHsgcnQuZGVzdHJveSgpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH0gfVxuICAgICAgICB9XG4gICAgfSxcbn07XG4iXX0=