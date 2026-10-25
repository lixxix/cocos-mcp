import { join } from 'path';

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
        (module as any).paths = [];
    }
    const editorModules = join(Editor.App.path, 'node_modules');
    if (!module.paths!.includes(editorModules)) {
        module.paths!.push(editorModules);
    }
} catch (e) {
    console.warn('[cocos-mcp] 场景脚本初始化模块搜索路径失败:', e);
}

let cachedEngine: any = null;

/** 获取引擎对象，失败时抛出可读错误 */
function getEngine(): any {
    if (cachedEngine) return cachedEngine;
    try {
        cachedEngine = require('cc');
    } catch (e) {
        try {
            const editorModules2 = join(Editor.App.path, 'node_modules');
            if (!module.paths) {
                (module as any).paths = [];
            }
            if (!module.paths!.includes(editorModules2)) {
                module.paths!.push(editorModules2);
            }
            cachedEngine = require('cc');
        } catch (e2) {
            throw new Error(`场景脚本无法加载 cc 模块: ${String(e2)}`);
        }
    }
    return cachedEngine;
}

/** 把引擎对象转成纯 JSON */
function plain(value: any): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(plain);
    const result: any = {};
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
function findByUuid(node: any, uuid: string): any {
    if (!node) return null;
    if (node.uuid === uuid) return node;
    const children = node.children || [];
    for (const child of children) {
        const found = findByUuid(child, uuid);
        if (found) return found;
    }
    return null;
}

/**
 * 在整个场景里按 uuid 找节点或组件实例（组件引用绑定的目标可以是组件本身）
 */
function findInstanceByUuid(scene: any, uuid: string): any {
    const walk = (node: any): any => {
        if (!node) return null;
        if (node.uuid === uuid) return node;
        for (const comp of node.components || []) {
            if (comp.uuid === uuid) return comp;
        }
        for (const child of node.children || []) {
            const hit = walk(child);
            if (hit) return hit;
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
function describeRef(cc: any, value: any): any {
    if (value === null || value === undefined) return null;
    const typeName = (obj: any): string => {
        try { return cc.js.getClassName(obj) || ''; } catch (e) { return ''; }
    };
    try {
        if (value instanceof cc.Node) return { kind: 'node', uuid: value.uuid, name: value.name };
        if (value instanceof cc.Component) {
            return { kind: 'component', uuid: value.uuid, name: value.name, type: typeName(value) };
        }
        if (value instanceof cc.Asset) {
            return { kind: 'asset', uuid: value._uuid || value.uuid || '', type: typeName(value) };
        }
    } catch (e) { /* 走不到的兜底 */ }
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
function resolveValue(cc: any, scene: any, value: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
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
function findFirstComponent(node: any, cls: any): any {
    if (!node) return null;
    const comp = node.getComponent ? node.getComponent(cls) : null;
    if (comp) return comp;
    for (const child of node.children || []) {
        const hit = findFirstComponent(child, cls);
        if (hit) return hit;
    }
    return null;
}

/** 递归收集所有指定类型的组件 */
function collectComponents(node: any, cls: any, out: any[]): void {
    if (!node) return;
    const comp = node.getComponent ? node.getComponent(cls) : null;
    if (comp) out.push(comp);
    for (const child of node.children || []) collectComponents(child, cls, out);
}

/**
 * 编辑模式下场景不是连续渲染的，EVENT_AFTER_DRAW 不会自己来，需要主动触发重绘。
 * 返回实际用到的触发方式（none 表示两种接口都没找到）。
 */
function kickRepaint(cc: any): string {
    try {
        const cce = (globalThis as any).cce;
        if (cce && cce.Engine && typeof cce.Engine.repaintInEditMode === 'function') {
            cce.Engine.repaintInEditMode();
            return 'repaintInEditMode';
        }
    } catch { /* ignore */ }
    try {
        if (cc.game && typeof cc.game.step === 'function') {
            cc.game.step();
            return 'game.step';
        }
    } catch { /* ignore */ }
    return 'none';
}

export function load(): void {
    try {
        const cc = getEngine();
        console.log(`[cocos-mcp] 场景脚本已加载, 引擎版本 ${cc.ENGINE_VERSION || 'unknown'}`);
    } catch (e) {
        console.error('[cocos-mcp] 场景脚本加载失败:', e);
    }
}

export function unload(): void {
    cachedEngine = null;
}

/** 场景脚本对外暴露的方法，通过 execute-scene-script 调用 */
export const methods = {
    /**
     * 读取引擎与当前场景信息
     */
    engineInfo(): any {
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
    createNode(name: string = 'MCP_Engine_Node', position?: { x?: number; y?: number; z?: number }): any {
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
    moveNode(uuid: string, position?: { x?: number; y?: number; z?: number }): any {
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
    listNodes(): any {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const walk = (node: any, depth: number): any[] => {
            const item = {
                uuid: node.uuid,
                name: node.name,
                depth,
                active: node.active,
                components: (node.components || []).map((comp: any) => comp.name || comp.constructor?.name || '?'),
                children: [] as any[],
            };
            for (const child of node.children) {
                item.children.push(...walk(child, depth + 1));
            }
            return [item];
        };
        const nodes = scene.children.reduce((acc: any[], child: any) => acc.concat(walk(child, 0)), []);
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
    addComponentToNode(nodeUuid: string, component: string): any {
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
        let cls: any = null;
        try {
            cls = cc.js.getClassByName(component);
        } catch (e) {
            cls = null;
        }
        if (!cls) {
            try {
                cls = cc.js.getClassById(component);
            } catch (e) {
                cls = null;
            }
        }
        if (!cls) {
            // 兜底：在已注册类名表里找（忽略大小写）
            try {
                const nameMap = cc.js._nameToClass;
                if (nameMap && typeof nameMap.forEach === 'function') {
                    let found: any = null;
                    nameMap.forEach((value: any, key: string) => {
                        if (!found && key && key.toLowerCase() === String(component).toLowerCase()) {
                            found = value;
                        }
                    });
                    cls = found;
                }
            } catch (e) {
                cls = null;
            }
        }

        if (!cls) {
            // 诊断：把已注册的用户类名列出来
            let registered: string[] = [];
            try {
                const nameMap = cc.js._nameToClass;
                if (nameMap && typeof nameMap.forEach === 'function') {
                    nameMap.forEach((value: any, key: string) => {
                        if (key && !key.startsWith('cc.') && key.indexOf('.') < 0) registered.push(key);
                    });
                }
            } catch (e) {
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
                component: comp ? (comp.name || comp.constructor?.name) : component,
                componentUuid: comp ? comp.uuid : '',
                className: comp && comp.constructor ? comp.constructor.name : component,
            };
        } catch (e: any) {
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
    setNodeProperty(nodeUuid: string, component: string, prop: string, value: any): any {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const node = findByUuid(scene, nodeUuid);
        if (!node) {
            return { ok: false, error: `找不到节点: ${nodeUuid}` };
        }

        let host: any = node;
        let hostName = 'node';
        const compName = String(component || '').trim();
        if (compName && compName !== 'node') {
            let cls: any = null;
            try { cls = cc.js.getClassByName(compName); } catch (e) { cls = null; }
            if (!cls) {
                try { cls = cc.js.getClassById(compName); } catch (e) { cls = null; }
            }
            if (!cls) {
                return {
                    ok: false,
                    error: `引擎里找不到组件类「${compName}」`,
                    nodeComponents: (node.components || []).map((c: any) => c.name || '?'),
                };
            }
            host = node.getComponent(cls);
            if (!host) {
                return {
                    ok: false,
                    error: `节点 ${node.name} 上没有组件「${compName}」`,
                    nodeComponents: (node.components || []).map((c: any) => c.name || '?'),
                };
            }
            hostName = compName;
        }

        try {
            const resolved = resolveValue(cc, scene, value);
            if (host === node && prop === 'position') {
                node.setPosition(
                    Number(resolved?.x) || 0,
                    Number(resolved?.y) || 0,
                    Number(resolved?.z) || 0
                );
            } else {
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
        } catch (e: any) {
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
    readComponentProperty(nodeUuid: string, component: string, prop: string): any {
        const cc = getEngine();
        const scene = cc.director.getScene();
        if (!scene) {
            return { ok: false, error: '当前没有打开的场景' };
        }
        const node = findByUuid(scene, nodeUuid);
        if (!node) {
            return { ok: false, error: `找不到节点: ${nodeUuid}` };
        }

        let host: any = node;
        const compSpec = String(component || '').trim();
        if (compSpec && compSpec !== 'node') {
            if (/^\d+$/.test(compSpec)) {
                host = (node.components || [])[parseInt(compSpec, 10)] || null;
            }
            if (!host) {
                host = (node.components || []).find((comp: any) => {
                    if (!comp) return false;
                    if (comp.uuid === compSpec) return true;
                    let clsName = '';
                    let ctorName = '';
                    try { clsName = cc.js.getClassName(comp) || ''; } catch (e) { clsName = ''; }
                    if (comp.constructor) ctorName = comp.constructor.name || '';
                    const bare = compSpec.startsWith('cc.') ? compSpec.slice(3) : compSpec;
                    return clsName === compSpec || ctorName === compSpec ||
                        clsName === bare || ctorName === bare;
                }) || null;
            }
            if (!host) {
                const names = (node.components || []).map((comp: any) => {
                    try { return cc.js.getClassName(comp) || comp.name || '?'; } catch (e) { return comp?.name || '?'; }
                });
                return { ok: false, error: `节点 ${node.name} 上找不到组件「${compSpec}」`, nodeComponents: names };
            }
        }

        let value: any;
        try {
            value = host[prop];
        } catch (e: any) {
            return { ok: false, error: `读取属性 ${prop} 失败: ${e?.message ?? String(e)}` };
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
    listRegisteredClasses(): any {
        const cc = getEngine();
        const names: string[] = [];
        try {
            const nameMap = cc.js._nameToClass;
            if (nameMap && typeof nameMap.forEach === 'function') {
                nameMap.forEach((value: any, key: string) => { if (key) names.push(key); });
            }
        } catch (e) {
            return { ok: false, error: String(e) };
        }
        const userClasses = names.filter((n) => !n.startsWith('cc.') && n.indexOf('.') < 0);
        return { ok: true, total: names.length, userClasses, sample: names.slice(0, 40) };
    },

    /**
     * 兼容旧方法名：主进程如果还在调 captureScene，转给 captureCanvas。
     */
    async captureScene(maxW = 768): Promise<any> {
        console.log('[cocos-mcp] captureScene(旧名) -> 转发给 captureCanvas');
        return (methods as any).captureCanvas(maxW, true);
    },

    /**
     * 诊断：不渲染，只报告截图所需的条件是否具备。出问题时先调这个。
     */
    captureDiag(): any {
        console.log('[cocos-mcp] captureDiag called');
        const info: any = { ok: true };
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
                const cams: any[] = [];
                collectComponents(scene, cc.Camera, cams);
                info.cameras = cams.map((c) => ({
                    node: c.node.name,
                    priority: c.priority,
                    visibility: c.visibility,
                    hasTargetTexture: !!c.targetTexture,
                }));
            }
            const cce = (globalThis as any).cce;
            info.hasCce = !!cce;
            info.hasRepaintInEditMode = !!(cce && cce.Engine && typeof cce.Engine.repaintInEditMode === 'function');
            info.hasGameStep = !!(cc.game && typeof cc.game.step === 'function');
            info.hasRenderTexture = typeof cc.RenderTexture === 'function';
            info.hasDocument = typeof document !== 'undefined';
        } catch (e: any) {
            info.ok = false;
            info.error = e?.stack ?? e?.message ?? String(e);
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
    async captureCanvas(maxW = 768, flipY = true): Promise<any> {
        console.log('[cocos-mcp] captureCanvas called', maxW, flipY);
        let stage = 'init';
        let cam: any = null;
        let oldTarget: any = null;
        let rt: any = null;
        let handler: any = null;
        let timer: any = null;
        let cc: any = null;

        try {
            cc = getEngine();

            stage = 'find-scene';
            const scene = cc.director.getScene();
            if (!scene) return { ok: false, stage, error: '当前没有打开的场景' };

            stage = 'find-canvas';
            const canvasComp = findFirstComponent(scene, cc.Canvas);
            if (!canvasComp) return { ok: false, stage, error: '场景里没有 Canvas' };
            const canvasNode = canvasComp.node;
            const ui = canvasNode.getComponent(cc.UITransform);
            if (!ui) return { ok: false, stage, error: 'Canvas 节点没有 UITransform' };
            const W = Math.max(1, Math.round(ui.contentSize.width));
            const H = Math.max(1, Math.round(ui.contentSize.height));

            stage = 'find-camera';
            cam = canvasComp.cameraComponent;
            if (!cam) {
                const cams: any[] = [];
                collectComponents(scene, cc.Camera, cams);
                cam = cams
                    .filter((c) => (c.visibility & canvasNode.layer) !== 0)
                    .sort((a, b) => b.priority - a.priority)[0];
            }
            if (!cam) return { ok: false, stage, error: '找不到渲染 Canvas 的相机' };
            console.log('[cocos-mcp] captureCanvas camera =', cam.node.name, 'size =', W, H);

            stage = 'setup-rt';
            rt = new cc.RenderTexture();
            rt.reset({ width: W, height: H });
            oldTarget = cam.targetTexture;
            cam.targetTexture = rt;

            stage = 'wait-frame';
            let kicked = 'none';
            const pixels: Uint8Array = await new Promise<Uint8Array>((resolve, reject) => {
                let frames = 0;
                handler = () => {
                    frames++;
                    if (frames < 2) return; // 第 1 帧让 targetTexture 生效，第 2 帧才是完整画面
                    cc.director.off(cc.Director.EVENT_AFTER_DRAW, handler);
                    handler = null;
                    try { resolve(rt.readPixels(0, 0, W, H) as Uint8Array); }
                    catch (e) { reject(e); }
                };
                cc.director.on(cc.Director.EVENT_AFTER_DRAW, handler);
                kicked = kickRepaint(cc);
                setTimeout(() => kickRepaint(cc), 150);
                setTimeout(() => kickRepaint(cc), 400);
                timer = setTimeout(
                    () => reject(new Error(`等待渲染帧超时（触发方式: ${kicked}）`)),
                    3000
                );
            });
            if (!pixels || !pixels.length) {
                return { ok: false, stage, error: 'readPixels 返回空数据' };
            }

            stage = 'encode';
            const full = document.createElement('canvas');
            full.width = W;
            full.height = H;
            const ctx = full.getContext('2d')!;
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
            out.getContext('2d')!.drawImage(full, 0, 0, out.width, out.height);

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
        } catch (e: any) {
            console.error('[cocos-mcp] captureCanvas failed at', stage, e);
            return { ok: false, stage, error: e?.stack ?? e?.message ?? String(e) };
        } finally {
            if (timer) clearTimeout(timer);
            if (handler && cc) { try { cc.director.off(cc.Director.EVENT_AFTER_DRAW, handler); } catch { /* ignore */ } }
            // 必须还原，否则场景里该相机会一直渲染到纹理
            if (cam) { try { cam.targetTexture = oldTarget; } catch { /* ignore */ } }
            if (rt) { try { rt.destroy(); } catch { /* ignore */ } }
        }
    },
};
