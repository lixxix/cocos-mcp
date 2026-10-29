"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOperations = listOperations;
exports.runOperation = runOperation;
// @ts-ignore
const package_json_1 = __importDefault(require("../package.json"));
const promises_1 = require("fs/promises");
const path_1 = require("path");
const build_info_1 = require("./build-info");
const mcp_process_1 = require("./mcp-process");
/**
 * 操作层：自研 MCP 服务的全部能力都收敛在这里。
 *
 * 设计要点：
 * 1. 每个操作都是纯函数式的 async，参数与返回值都必须是纯 JSON（IPC 限制）。
 * 2. 扩展主进程、本地 HTTP 桥与 MCP Server 走的是同一套 operations，
 *    MCP Server 只需要把 tool 调用翻译成 { op, params } 即可。
 * 3. 两条通道都保留：
 *    - 编辑器消息通道：Editor.Message.request('scene', ...) / ('asset-db', ...)
 *      走编辑器 undo / dirty 体系，保存最可靠。
 *    - 场景脚本通道：Editor.Message.request('scene', 'execute-scene-script', ...)
 *      进入场景进程，可以直接用引擎 API。
 * 4. 每个操作都带一份 JSON Schema，MCP 侧直接拿它当 tool 的 inputSchema，
 *    这样工具的参数类型是真实声明的，不是猜出来的。
 */
const SCENE = 'scene';
const ASSET_DB = 'asset-db';
// ---------------------------------------------------------------- 工具函数
/** 从 dump 数据里取出真实值：dump 形如 { value: xxx } */
function dumpValue(prop, fallback) {
    if (prop === null || prop === undefined)
        return fallback;
    if (typeof prop === 'object' && 'value' in prop) {
        return prop.value;
    }
    return prop;
}
function pickString(params, key, fallback = '') {
    const value = params === null || params === void 0 ? void 0 : params[key];
    return typeof value === 'string' ? value : fallback;
}
function pickNumber(params, key, fallback = 0) {
    const value = Number(params === null || params === void 0 ? void 0 : params[key]);
    return Number.isFinite(value) ? value : fallback;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 项目根目录（Editor.Project.path，直连模式下从 dist 位置推导） */
function projectRoot() {
    var _a;
    const editor = typeof Editor !== 'undefined' ? Editor : null;
    if ((_a = editor === null || editor === void 0 ? void 0 : editor.Project) === null || _a === void 0 ? void 0 : _a.path)
        return editor.Project.path;
    return (0, path_1.join)(__dirname, '..', '..', '..');
}
/** db://assets/... 路径转磁盘绝对路径 */
function dbUrlToAbs(dbUrl) {
    return (0, path_1.join)(projectRoot(), dbUrl.replace(/^db:\/\//, ''));
}
/** 同一磁盘路径判定（Windows 下大小写与分隔符不敏感） */
function isSamePath(a, b) {
    const ra = (0, path_1.resolve)(a);
    const rb = (0, path_1.resolve)(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
/** 层级管理器里当前选中的节点 uuid 列表 */
function getSelectedNodeUuids() {
    try {
        return Editor.Selection.getSelected('node') || [];
    }
    catch (e) {
        return [];
    }
}
/** 从节点 dump 里取组件列表（3.8.8 的字段是 components，不是 __comps__） */
function readNodeComponents(node) {
    if (!node)
        return [];
    const raw = node.components || node.__comps__ || [];
    return raw.map((comp) => {
        if (comp && typeof comp === 'object' && 'value' in comp && comp.value && typeof comp.value === 'object') {
            // 老格式：{ value: { uuid, name, enabled } }
            const value = comp.value;
            return { uuid: value.uuid || '', name: value.name || '', type: value.type || '', enabled: value.enabled, isCustom: !!comp.isCustom };
        }
        // 3.8.8 格式：{ isCustom, type, value: <组件uuid> }
        return {
            uuid: typeof (comp === null || comp === void 0 ? void 0 : comp.value) === 'string' ? comp.value : ((comp === null || comp === void 0 ? void 0 : comp.uuid) || ''),
            name: (comp === null || comp === void 0 ? void 0 : comp.name) || '',
            type: (comp === null || comp === void 0 ? void 0 : comp.type) || '',
            enabled: comp === null || comp === void 0 ? void 0 : comp.enabled,
            isCustom: !!(comp === null || comp === void 0 ? void 0 : comp.isCustom),
        };
    });
}
/** 在场景树里按 uuid 找节点 */
function findNodeInTree(tree, uuid) {
    if (!tree)
        return null;
    if (dumpValue(tree.uuid, '') === uuid)
        return tree;
    for (const child of (tree.children || [])) {
        const hit = findNodeInTree(child, uuid);
        if (hit)
            return hit;
    }
    return null;
}
/** 读取某节点当前的组件列表（走 query-node-tree，3.8.8 的 query-node 返回 null） */
async function queryNodeComponents(nodeUuid) {
    const tree = await Editor.Message.request(SCENE, 'query-node-tree');
    const found = findNodeInTree(tree, nodeUuid);
    return readNodeComponents(found);
}
/**
 * 把组件标识（cc.Xxx / Xxx / 用户脚本 cid）展开成可与场景树组件列表比对的候选名。
 * 场景树里 3.8.8 的 components[].type：内置组件是 "cc.UITransform"，用户脚本是类名 "ScreenFill"。
 */
async function resolveComponentCandidates(component) {
    const raw = String(component || '').trim();
    if (!raw)
        return [];
    const candidates = [raw];
    let list = [];
    try {
        list = (await Editor.Message.request(SCENE, 'query-components')) || [];
    }
    catch (e) {
        list = [];
    }
    // 用户脚本按 cid 反查类名
    const byCid = list.find((item) => item && item.cid === raw);
    if (byCid && byCid.name)
        candidates.push(String(byCid.name));
    // 按类名反查 cid
    const byName = list.find((item) => item && item.name === raw);
    if (byName) {
        if (byName.name)
            candidates.push(String(byName.name));
        if (byName.cid)
            candidates.push(String(byName.cid));
    }
    if (raw.startsWith('cc.'))
        candidates.push(raw.slice(3));
    else if (!raw.includes('.'))
        candidates.push(`cc.${raw}`);
    return Array.from(new Set(candidates.filter(Boolean)));
}
/**
 * 在组件列表里找已存在的目标组件。
 * Cocos 不允许同一节点挂同类型组件，重复 add 会被编辑器拒绝并打印
 * "[Scene] Can't add component 'cc.UITransform' because X already contains the same component."
 */
function matchExistingComponent(comps, candidates) {
    if (!comps || !comps.length || !candidates || !candidates.length)
        return null;
    return (comps.find((comp) => {
        const type = String((comp === null || comp === void 0 ? void 0 : comp.type) || '');
        const name = String((comp === null || comp === void 0 ? void 0 : comp.name) || '');
        const uuid = String((comp === null || comp === void 0 ? void 0 : comp.uuid) || '');
        return candidates.some((c) => c === type || c === name || c === uuid);
    }) || null);
}
/** 把 query-node-tree 返回的节点树转成可读文本 */
function formatNodeTree(node, depth = 0) {
    var _a, _b, _c;
    if (!node)
        return '';
    const name = dumpValue(node.name, '(未命名)');
    const uuid = dumpValue(node.uuid, '');
    const active = dumpValue(node.active, true);
    const comps = readNodeComponents(node).map((comp) => comp.type || comp.name).filter(Boolean);
    const indent = '  '.repeat(depth);
    let line = `${indent}- ${name}${active ? '' : ' [inactive]'}`;
    if (uuid)
        line += `  <${uuid}>`;
    if (comps.length)
        line += `  [${comps.join(', ')}]`;
    const position = dumpValue(node.position, null);
    if (position && typeof position === 'object') {
        line += `  (${(_a = position.x) !== null && _a !== void 0 ? _a : 0}, ${(_b = position.y) !== null && _b !== void 0 ? _b : 0}, ${(_c = position.z) !== null && _c !== void 0 ? _c : 0})`;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
        const text = formatNodeTree(child, depth + 1);
        if (text)
            line += `\n${text}`;
    }
    return line;
}
/** 统计节点数量（含根） */
function countNodes(node) {
    if (!node)
        return 0;
    const children = Array.isArray(node.children) ? node.children : [];
    return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
}
/**
 * 把 query-node-tree 的子树摊平成结构化数组（父在前），供 batch.run 的 "$N.nodes[i].uuid" 引用，
 * 替代对 subtree 文本树的正则解析。
 */
function collectNodes(node, parentUuid, out = []) {
    if (!node)
        return out;
    const uuid = dumpValue(node.uuid, '');
    out.push({
        name: dumpValue(node.name, '(未命名)'),
        uuid,
        parent: uuid ? parentUuid : null,
        components: readNodeComponents(node)
            .map((comp) => comp.type || comp.name)
            .filter(Boolean),
    });
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children)
        collectNodes(child, uuid || null, out);
    return out;
}
/**
 * 判断当前是否处于预制体编辑模式（3.8.8 实测结构）：
 * 预制体模式下 query-node-tree 的根是包了一层的临时场景「<预制体名>-scene」，
 * 其首个子节点是名为 should_hide_in_hierarchy 的挂载节点，再往下才是预制体真正的根节点；
 * 普通场景的根名就是场景文件名、没有这层包裹。
 * 该模式下还有一连串盲区：query-current-scene 返回场景页签 uuid、query-dirty 恒 false、
 * save-scene 对预制体文档无效（返回 null，还可能被「是否保存」对话框堵住）。
 */
async function detectPrefabMode() {
    let tree = null;
    try {
        tree = await Editor.Message.request(SCENE, 'query-node-tree');
    }
    catch (e) {
        return { inPrefabMode: false, prefabName: '', sceneName: '' };
    }
    const sceneName = dumpValue(tree && tree.name, '');
    const children = Array.isArray(tree && tree.children) ? tree.children : [];
    const firstChildName = dumpValue(children[0] && children[0].name, '');
    const inPrefabMode = /-scene$/.test(sceneName) && firstChildName === 'should_hide_in_hierarchy';
    return {
        inPrefabMode,
        prefabName: inPrefabMode ? sceneName.replace(/-scene$/, '') : '',
        sceneName,
    };
}
/** 预制体编辑模式下拒绝保存/切换的统一报错（fail fast，避免静默堵在编辑器弹框上） */
function prefabModeBlockedError(prefabName, action) {
    return new Error(`当前处于预制体编辑模式（${prefabName}），无法${action}。` +
        '该模式下 query-dirty 恒 false、scene/save-scene 对预制体文档无效，切换文档可能弹「是否保存」对话框且无法自动处理。' +
        '请先在编辑器里保存并关闭预制体页签回到普通场景后重试；确认预制体无未保存修改时可传 assumeClean=true 跳过本检查。');
}
/**
 * 用 asset-db/open-asset 切换编辑文档并轮询确认（等价资源管理器双击）。
 * 这是「普通场景 → 预制体编辑模式」的可靠通道（scene/open-scene 对 prefab uuid 无效）。
 * 成功判定靠 query-node-tree 根 uuid 相对打开前变化（连续两次读到才算稳定）：
 * 包裹场景 uuid 每次打开都会重新生成，不能用「等于某个固定值」判断。
 */
async function openAssetAndPoll(uuid, timeout) {
    const beforeTree = await Editor.Message.request(SCENE, 'query-node-tree');
    const from = dumpValue(beforeTree && beforeTree.uuid, '');
    await Editor.Message.request(ASSET_DB, 'open-asset', uuid);
    const deadline = Date.now() + timeout;
    let current = from;
    let stable = 0;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
            const tree = await Editor.Message.request(SCENE, 'query-node-tree');
            current = dumpValue(tree && tree.uuid, '');
        }
        catch (e) {
            current = '';
        }
        if (current && current !== from) {
            stable += 1;
            if (stable >= 2)
                break;
        }
        else {
            stable = 0;
        }
    }
    return { opened: !!(current && current !== from), from, current };
}
/** 空的参数 schema */
function noParams() {
    return { type: 'object', properties: {}, additionalProperties: false };
}
// ---------------------------------------------------------------- 操作定义
const editorInfo = {
    name: 'editor.info',
    title: '编辑器 / 项目信息',
    description: '打印当前 Creator 版本、项目路径、扩展自身信息',
    params: {},
    schema: noParams(),
    async run() {
        return {
            build: build_info_1.MAIN_BUILD,
            editorName: Editor.App.name,
            editorVersion: Editor.App.version,
            editorPath: Editor.App.path,
            projectPath: Editor.Project.path,
            extensionName: package_json_1.default.name,
            extensionVersion: package_json_1.default.version,
            nodeVersion: process.version,
            platform: `${process.platform} ${process.arch}`,
        };
    },
};
const sceneStatus = {
    name: 'scene.status',
    title: '当前场景状态',
    description: '场景是否就绪 / 是否有未保存改动 / 根节点 / 选中节点',
    params: {},
    schema: noParams(),
    async run() {
        const isReady = await Editor.Message.request(SCENE, 'query-is-ready');
        const isDirty = await Editor.Message.request(SCENE, 'query-dirty');
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        return {
            isReady,
            isDirty,
            sceneName: dumpValue(tree === null || tree === void 0 ? void 0 : tree.name, '(未命名场景)'),
            sceneUuid: dumpValue(tree === null || tree === void 0 ? void 0 : tree.uuid, ''),
            nodeCount: Math.max(0, countNodes(tree) - 1),
            selectedNodes: getSelectedNodeUuids(),
        };
    },
};
const sceneTree = {
    name: 'scene.tree',
    title: '场景节点树',
    description: '读取当前场景的完整节点树（节点名 / uuid / 组件 / 坐标）',
    params: {},
    schema: noParams(),
    async run() {
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        return {
            sceneName: dumpValue(tree === null || tree === void 0 ? void 0 : tree.name, '(未命名场景)'),
            sceneUuid: dumpValue(tree === null || tree === void 0 ? void 0 : tree.uuid, ''),
            nodeCount: Math.max(0, countNodes(tree) - 1),
            tree: formatNodeTree(tree),
        };
    },
};
/**
 * 把 builtin 短名 / prefab 引用统一解析成可实例化的 prefab 资产。
 * - builtin：db://internal/default_prefab/<短名>.prefab，即编辑器「创建」菜单同款内置模板
 * - prefab：db:// url 或 uuid，任意 prefab 资产（含项目自己的预制体）
 * 两者都为空返回 null（= 普通空节点模式）。
 */
async function resolvePrefabAsset(builtin, prefab) {
    if (builtin && prefab) {
        throw new Error('builtin 与 prefab 只能二选一');
    }
    let target = '';
    if (builtin) {
        const short = builtin.trim().replace(/\.prefab$/i, '').replace(/^\/+|\/+$/g, '');
        target = `db://internal/default_prefab/${short}.prefab`;
    }
    else if (prefab) {
        target = prefab.trim();
    }
    else {
        return null;
    }
    let info = null;
    try {
        info = await Editor.Message.request(ASSET_DB, 'query-asset-info', target);
    }
    catch (e) {
        info = null;
    }
    if (!info || !info.uuid) {
        let hint = builtin ? '；可用 asset_list(pattern="db://internal/default_prefab/**/*.prefab") 查看全部内置模板' : '';
        if (builtin) {
            // 3.8 内置模板绝大多数在 ui/、3d/、light/ 子目录下，裸短名基本不存在；探测命中时直接给出正确写法
            const short = builtin.trim().replace(/^ui\//i, '');
            for (const dir of ['ui', '3d', 'light']) {
                try {
                    const alt = await Editor.Message.request(ASSET_DB, 'query-asset-info', `db://internal/default_prefab/${dir}/${short}.prefab`);
                    if (alt && alt.uuid) {
                        hint = `；该模板在 ${dir}/ 子目录下，正确写法是 builtin="${dir}/${short}"`;
                        break;
                    }
                }
                catch (e) {
                    // 探测失败不影响原本的报错
                }
            }
        }
        throw new Error(`找不到 prefab 资产: ${target}${hint}`);
    }
    if (info.type && info.type !== 'cc.Prefab') {
        throw new Error(`目标资产不是 prefab（${info.type}）: ${info.url || target}`);
    }
    const url = info.url || target;
    return { uuid: info.uuid, url, name: (0, path_1.basename)(url).replace(/\.prefab$/i, '') };
}
const nodeCreate = {
    name: 'node.create',
    title: '创建节点',
    description: '通过 scene/create-node 创建节点，走编辑器 undo 体系。三种用法：1) 默认建空节点（编辑器自动附加 cc.UITransform，勿重复 addComponent）；2) builtin=内置模板短名，映射到 db://internal/default_prefab/<短名>.prefab，一步实例化完整模板（含子节点与默认资源引用）；常用模板都带子目录前缀——UI 用 ui/Button、ui/Label、ui/Sprite、ui/Canvas、ui/Layout、ui/ScrollView 等（要求场景已有 Canvas），3D 用 3d/Cube、3d/Sphere，灯光用 light/Point Light；裸短名 Button、Label、Sprite 不存在，会报「找不到 prefab 资产」；全量列表用 asset_list(pattern="db://internal/default_prefab/**/*.prefab") 查询；3) prefab=任意预制体（db:// url 或 uuid），把已有 prefab 实例化进场景。注意：parent 必须是真实节点 uuid（不解析路径），引用无效时节点会被静默建到场景根（不报错），批量搭建后建议审计场景根是否出现孤儿节点。模板模式返回值含 nodes:[{name,uuid,parent,components}] 结构化子树（父在前、components 是类型名），batch.run 里用 "$N.nodes[i].uuid" 引用子节点，无需解析 subtree 文本',
    params: {
        name: '节点名，缺省时空节点用 MCP_Node、模板模式用模板名（并按父节点生成不重名名字）',
        parent: '父节点 uuid（不支持路径，无效时静默建到场景根）；留空则建在场景根下；填 @selection 则建在当前选中节点下',
        builtin: '内置模板短名，映射到 db://internal/default_prefab/<builtin>.prefab；常用模板都带子目录前缀：ui/Button、ui/Label、ui/Sprite、ui/Canvas、ui/Layout、ui/ScrollView、3d/Cube、3d/Sphere、light/Point Light；裸短名 Button、Label、Sprite 不存在（须写 ui/Button 等）；与 prefab 二选一；全集用 asset_list(pattern="db://internal/default_prefab/**/*.prefab") 查',
        prefab: '任意 prefab 资产（db:// url 或 uuid），实例化进场景，与 builtin 二选一',
    },
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '节点名' },
            parent: {
                type: 'string',
                description: '父节点 uuid（不支持路径，无效时静默建到场景根）；留空则建在场景根下；填 @selection 则建在当前选中节点下',
            },
            builtin: {
                type: 'string',
                description: '内置模板短名，映射到 db://internal/default_prefab/<builtin>.prefab，常用模板都带子目录前缀：ui/Button、ui/Label、ui/Sprite、ui/Canvas、ui/Layout、3d/Cube、light/Point Light；裸短名 Button、Label、Sprite 不存在（须写 ui/Button 等）；与 prefab 二选一',
            },
            prefab: {
                type: 'string',
                description: '任意 prefab 资产（db:// url 或 uuid），实例化进场景，与 builtin 二选一',
            },
        },
        additionalProperties: false,
    },
    async run(params) {
        const builtin = pickString(params, 'builtin', '').trim();
        const prefab = pickString(params, 'prefab', '').trim();
        const rawParent = pickString(params, 'parent', '').trim();
        let parent = '';
        let parentSource = 'scene-root';
        if (rawParent === '@selection') {
            const selected = getSelectedNodeUuids();
            if (!selected.length) {
                throw new Error('parent 指定为 @selection，但当前没有选中任何节点');
            }
            parent = selected[0];
            parentSource = 'selection';
        }
        else if (rawParent) {
            parent = rawParent;
            parentSource = 'params';
        }
        const template = await resolvePrefabAsset(builtin, prefab);
        const rawName = pickString(params, 'name', '');
        let name = rawName || (template ? template.name : '') || 'MCP_Node';
        // 与编辑器菜单一致：模板模式下按父节点生成不重名的名字
        if (template && !rawName && parent) {
            try {
                const available = await Editor.Message.request(SCENE, 'generate-available-name', name, parent);
                if (typeof available === 'string' && available)
                    name = available;
            }
            catch (e) {
                // 该消息不可用时保持原名，重名不影响创建
            }
        }
        const options = { name };
        if (parent)
            options.parent = parent;
        if (template) {
            options.assetUuid = template.uuid;
            options.snapshot = true;
            // 与编辑器菜单一致：UI 模板要求场景里有 Canvas（Canvas 模板本身除外）
            if (builtin.toLowerCase().startsWith('ui/') && template.name.toLowerCase() !== 'canvas') {
                options.canvasRequired = true;
            }
        }
        let uuid = '';
        try {
            uuid = await Editor.Message.request(SCENE, 'create-node', options);
        }
        catch (e) {
            const hint = options.canvasRequired
                ? '；ui/* 模板要求场景先有 Canvas，可先 node_create(builtin="Canvas")'
                : '';
            throw new Error(`create-node 失败: ${(e === null || e === void 0 ? void 0 : e.message) || e}${hint}`);
        }
        // 一次 query-node-tree 同时回读组件列表（空节点模式的 cc.UITransform 提示）与模板子树
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        const found = findNodeInTree(tree, uuid);
        const comps = readNodeComponents(found);
        const hasUITransform = comps.some((c) => c.type === 'cc.UITransform');
        const result = { uuid, name, parent: parent || null, parentSource, components: comps, hasUITransform };
        if (template) {
            result.source = builtin ? 'builtin-template' : 'prefab';
            result.template = template.url;
            result.templateUuid = template.uuid;
            result.nodeCount = countNodes(found);
            result.subtree = formatNodeTree(found);
            // 结构化子树（父在前）：batch.run 里用 "$N.nodes[i].uuid" 直接引用子节点，不必正则解析 subtree 文本
            result.nodes = collectNodes(found, parent || null);
        }
        return result;
    },
};
const nodeDelete = {
    name: 'node.delete',
    title: '删除节点',
    description: '通过 scene/remove-node 删除节点，默认删除层级管理器中选中的节点',
    params: {
        uuid: '节点 uuid，留空则删除当前选中节点',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '节点 uuid，留空则删除当前选中节点' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const raw = pickString(params, 'uuid', '');
        let list = raw.split(',').map((item) => item.trim()).filter(Boolean);
        let source = 'params';
        if (!list.length) {
            list = getSelectedNodeUuids();
            source = 'selection';
        }
        if (!list.length) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        await Editor.Message.request(SCENE, 'remove-node', { uuid: list.length === 1 ? list[0] : list });
        return { removed: list, source };
    },
};
const nodeMove = {
    name: 'node.move',
    title: '移动节点（消息通道）',
    description: '通过 scene/set-property 修改节点 position（走编辑器 undo 体系）',
    params: {
        uuid: '节点 uuid，留空则用当前选中节点',
        x: 'x 坐标',
        y: 'y 坐标',
        z: 'z 坐标',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
            x: { type: 'number', description: 'x 坐标' },
            y: { type: 'number', description: 'y 坐标' },
            z: { type: 'number', description: 'z 坐标' },
        },
        additionalProperties: false,
    },
    async run(params) {
        let uuid = pickString(params, 'uuid', '');
        let source = 'params';
        if (!uuid) {
            const selected = getSelectedNodeUuids();
            uuid = selected[0] || '';
            source = 'selection';
        }
        if (!uuid) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const position = {
            x: pickNumber(params, 'x', 0),
            y: pickNumber(params, 'y', 0),
            z: pickNumber(params, 'z', 0),
        };
        const ok = await Editor.Message.request(SCENE, 'set-property', {
            uuid,
            path: 'position',
            dump: { value: position },
        });
        return { uuid, source, path: 'position', position, applied: ok };
    },
};
const nodeMoveEngine = {
    name: 'node.move.engine',
    title: '移动节点（引擎通道）',
    description: '通过场景脚本直接调用引擎 API 设置 position（不进 undo 体系）',
    params: {
        uuid: '节点 uuid，留空则用当前选中节点',
        x: 'x 坐标',
        y: 'y 坐标',
        z: 'z 坐标',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
            x: { type: 'number', description: 'x 坐标' },
            y: { type: 'number', description: 'y 坐标' },
            z: { type: 'number', description: 'z 坐标' },
        },
        additionalProperties: false,
    },
    async run(params) {
        let uuid = pickString(params, 'uuid', '');
        let source = 'params';
        if (!uuid) {
            const selected = getSelectedNodeUuids();
            uuid = selected[0] || '';
            source = 'selection';
        }
        if (!uuid) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const position = {
            x: pickNumber(params, 'x', 0),
            y: pickNumber(params, 'y', 0),
            z: pickNumber(params, 'z', 0),
        };
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'moveNode',
            args: [uuid, position],
        });
        return { uuid, source, position, scriptResult: result };
    },
};
const nodeSetProperty = {
    name: 'node.setProperty',
    title: '设置属性（消息通道）',
    description: '通过 scene/set-property 设置节点或组件属性（走编辑器 undo 体系）。' +
        '注意：uuid 必须是真实节点 uuid，本操作不解析节点路径（传路径会静默无效）；' +
        '多组件节点设 contentSize 在本通道会静默失败，改用 node_set_property_engine（{"__size":[w,h]}，带 applied 回读）。' +
        'path 写法：节点属性直接写名字（position / name / active）；组件属性写 components.<索引>.<属性>，' +
        '索引用 node_list_components 查（如 components.0.string、components.2.contentSize）。' +
        'value 是纯 JSON；结构化值（{x,y,z}/{width,height}/{r,g,b,a}）会自动识别成 cc.Vec3/cc.Size/cc.Color。' +
        '引用类型属性（@property(Label) 之类）传 type=cc.Label、value={"uuid":"目标组件或节点uuid"}；' +
        '引用绑定优先用 node_bind_property（自动定位组件/解析目标/批量/回读验证）。',
    params: {
        uuid: '节点 uuid（不支持路径），留空则用当前选中节点',
        path: '属性路径，如 position、components.0.string',
        value: '属性值（纯 JSON）',
        type: '可选。dump 类型名（cc.Vec3/cc.Size/cc.Color/cc.Label/cc.Node…），不传时按 value 形状自动识别',
        dump: '可选。完整 dump 对象；传入后忽略 value/type，用于兜底特殊格式',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '节点 uuid（不支持路径），留空则用当前选中节点' },
            path: { type: 'string', description: '属性路径，如 position、components.0.string' },
            value: { description: '属性值' },
            type: { type: 'string', description: 'dump 类型名（可选）' },
            dump: { type: 'object', description: '完整 dump 对象（可选，兜底用）' },
        },
        required: ['path'],
        additionalProperties: false,
    },
    async run(params) {
        let uuid = pickString(params, 'uuid', '');
        let source = 'params';
        if (!uuid) {
            const selected = getSelectedNodeUuids();
            uuid = selected[0] || '';
            source = 'selection';
        }
        if (!uuid) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const path = pickString(params, 'path', '').trim();
        if (!path) {
            throw new Error('必须指定 path，如 position 或 components.0.string');
        }
        let dump;
        if ((params === null || params === void 0 ? void 0 : params.dump) && typeof params.dump === 'object') {
            dump = params.dump;
        }
        else {
            const explicitType = pickString(params, 'type', '').trim();
            const value = params === null || params === void 0 ? void 0 : params.value;
            const type = explicitType || guessDumpType(value);
            dump = type ? { type, value } : { value };
        }
        await Editor.Message.request(SCENE, 'set-property', { uuid, path, dump });
        return { uuid, source, path, dump, applied: true };
    },
};
/** 按 value 的形状猜测 dump 类型（只认最典型的三种，识别不了就返回空走裸 {value}） */
function guessDumpType(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return '';
    const keys = Object.keys(value).sort();
    const allNumber = keys.length > 0 && keys.every((key) => typeof value[key] === 'number');
    if (!allNumber)
        return '';
    if (keys.join(',') === 'x,y,z')
        return 'cc.Vec3';
    if (keys.join(',') === 'x,y')
        return 'cc.Vec2';
    if (keys.join(',') === 'height,width')
        return 'cc.Size';
    if (keys.join(',') === 'a,b,g,r')
        return 'cc.Color';
    return '';
}
const nodeSetPropertyEngine = {
    name: 'node.setProperty.engine',
    title: '设置属性（引擎通道）',
    description: '通过场景脚本用引擎 API 直接给节点或组件赋值（不进 undo 体系，保存场景后生效）。' +
        'component 留空表示节点本身；否则传组件类名或 cid。' +
        'value 支持：普通 JSON 值；{"__uuid":"xxx"} 绑定节点/组件引用；' +
        '{"__vec":[x,y,z]} 向量；{"__size":[w,h]} 尺寸；{"__color":[r,g,b,a]} 颜色。',
    params: {
        uuid: '节点 uuid，留空则用当前选中节点',
        component: '组件类名或 cid（如 cc.Label / CardItem），留空表示设置节点属性',
        prop: '属性名（如 string / color / tipLabel / position）',
        value: '属性值，支持 __uuid / __vec / __size / __color 特殊形式',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
            component: { type: 'string', description: '组件类名或 cid，留空表示节点本身' },
            prop: { type: 'string', description: '属性名' },
            value: { description: '属性值' },
        },
        required: ['prop'],
        additionalProperties: false,
    },
    async run(params) {
        let uuid = pickString(params, 'uuid', '');
        let source = 'params';
        if (!uuid) {
            const selected = getSelectedNodeUuids();
            uuid = selected[0] || '';
            source = 'selection';
        }
        if (!uuid) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const component = pickString(params, 'component', '').trim();
        const prop = pickString(params, 'prop', '').trim();
        if (!prop) {
            throw new Error('必须指定 prop');
        }
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'setNodeProperty',
            args: [uuid, component, prop, params === null || params === void 0 ? void 0 : params.value],
        });
        if (!result || result.ok !== true) {
            throw new Error(`引擎设置属性失败：${result && result.error ? result.error : '未知错误'}`);
        }
        return { uuid, source, scriptResult: result };
    },
};
async function queryComponentClassIndex() {
    const list = await Editor.Message.request(SCENE, 'query-components');
    const byCid = {};
    const names = new Set();
    for (const item of list || []) {
        if (item && item.cid)
            byCid[String(item.cid)] = String(item.name || '');
        if (item && item.name)
            names.add(String(item.name));
    }
    return { byCid, names };
}
/** 组件在 dump 里的类型名：内置组件是 cc.Sprite，自定义脚本组件是类名（如 ItemBadge） */
function componentDumpType(comp, classIndex) {
    const raw = String((comp === null || comp === void 0 ? void 0 : comp.type) || '').trim();
    if (comp === null || comp === void 0 ? void 0 : comp.isCustom) {
        return classIndex.byCid[raw] || raw;
    }
    return raw || String((comp === null || comp === void 0 ? void 0 : comp.name) || '').trim();
}
/** 组件名宽松相等：忽略 cc. 前缀与大小写 */
function sameComponentName(a, b) {
    if (!a || !b)
        return false;
    if (a === b)
        return true;
    const strip = (s) => (s.startsWith('cc.') ? s.slice(3) : s);
    return strip(a).toLowerCase() === strip(b).toLowerCase();
}
/** 在组件列表里定位组件：数字索引 / 类名 / cid / 组件 uuid；candidates>1 说明按名匹配有歧义，建议改传索引 */
function matchComponent(comps, spec, classIndex) {
    const s = String(spec !== null && spec !== void 0 ? spec : '').trim();
    if (!s)
        return null;
    if (/^\d+$/.test(s)) {
        const index = parseInt(s, 10);
        return comps[index] ? { index, comp: comps[index], candidates: 1 } : null;
    }
    const hits = [];
    comps.forEach((comp, index) => {
        const typeName = (comp === null || comp === void 0 ? void 0 : comp.isCustom)
            ? (classIndex.byCid[String(comp.type || '')] || comp.type)
            : comp === null || comp === void 0 ? void 0 : comp.type;
        if ((comp === null || comp === void 0 ? void 0 : comp.uuid) === s ||
            (comp === null || comp === void 0 ? void 0 : comp.type) === s ||
            sameComponentName(String(typeName || ''), s) ||
            sameComponentName(String((comp === null || comp === void 0 ? void 0 : comp.name) || ''), s)) {
            hits.push({ index, comp });
        }
    });
    return hits.length ? { index: hits[0].index, comp: hits[0].comp, candidates: hits.length } : null;
}
/** 组件列表的一行摘要（报错时提示现有组件用） */
function describeComponents(comps, classIndex) {
    return comps
        .map((comp, index) => {
        const name = (comp === null || comp === void 0 ? void 0 : comp.isCustom)
            ? (classIndex.byCid[String(comp.type || '')] || comp.type)
            : ((comp === null || comp === void 0 ? void 0 : comp.type) || (comp === null || comp === void 0 ? void 0 : comp.name) || '?');
        return `${index}:${name}`;
    })
        .join(', ') || '(无组件)';
}
function collectTreeNodes(node, parentPath, out) {
    if (!node)
        return;
    const name = dumpValue(node.name, '');
    const uuid = dumpValue(node.uuid, '');
    const path = parentPath ? `${parentPath}/${name}` : name;
    out.push({ uuid, name, path, node });
    for (const child of (node.children || []))
        collectTreeNodes(child, path, out);
}
/** 节点定位：uuid → 完整路径 → 路径后缀 → 节点名（prefab 编辑模式下同样适用，路径以编辑中的根为起点） */
function resolveNodeRef(tree, spec) {
    const s = String(spec || '').trim();
    if (!s)
        return null;
    const all = [];
    collectTreeNodes(tree, '', all);
    const exact = all.find((item) => item.uuid === s);
    if (exact)
        return { ref: exact, how: 'uuid', candidates: 1 };
    const byPath = all.find((item) => item.path === s);
    if (byPath)
        return { ref: byPath, how: 'path', candidates: 1 };
    const bySuffix = all.filter((item) => item.path.endsWith(`/${s}`));
    if (bySuffix.length)
        return { ref: bySuffix[0], how: 'path-suffix', candidates: bySuffix.length };
    const byName = all.filter((item) => item.name === s);
    if (byName.length)
        return { ref: byName[0], how: 'name', candidates: byName.length };
    return null;
}
/** 资产目标：db:// 路径 → uuid + 类型；子资产（xx.png/spriteFrame）返回子资产自己的 uuid 与类型（如 cc.SpriteFrame） */
async function resolveAssetTarget(url, explicitType) {
    const assets = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
    const hit = (assets || []).find((asset) => asset.url === url) || (assets || [])[0];
    if (!hit || !hit.uuid) {
        throw new Error(`找不到资产: ${url}（贴图引用要写到子资产，如 db://assets/.../xx.png/spriteFrame）`);
    }
    return {
        dumpType: explicitType || String(hit.type || ''),
        valueUuid: String(hit.uuid),
        desc: `资产 ${hit.url}`,
    };
}
/** 解析绑定目标 → dump 类型名 + 目标 uuid（null 表示解绑） */
async function resolveBindTarget(tree, classIndex, target, explicitType) {
    if (target === null || target === undefined || target === 'null' || target === '') {
        return { dumpType: explicitType || '', valueUuid: null, desc: '解绑（null）' };
    }
    if (typeof target === 'string') {
        if (target.startsWith('db://'))
            return resolveAssetTarget(target, explicitType);
        return { dumpType: explicitType || '', valueUuid: target, desc: `uuid:${target}` };
    }
    if (typeof target === 'object') {
        const asset = pickString(target, 'asset', '').trim();
        if (asset)
            return resolveAssetTarget(asset, explicitType);
        const rawUuid = pickString(target, 'uuid', '').trim();
        if (rawUuid)
            return { dumpType: explicitType || '', valueUuid: rawUuid, desc: `uuid:${rawUuid}` };
        const nodeSpec = pickString(target, 'node', '').trim();
        if (nodeSpec) {
            const nodeHit = resolveNodeRef(tree, nodeSpec);
            if (!nodeHit) {
                throw new Error(`target.node 找不到节点: ${nodeSpec}（可用 uuid 或 路径，如 Pannel/badge）`);
            }
            const compSpec = target.component;
            const compText = compSpec === undefined || compSpec === null ? '' : String(compSpec).trim();
            if (!compText) {
                return {
                    dumpType: explicitType || 'cc.Node',
                    valueUuid: nodeHit.ref.uuid,
                    desc: `节点 ${nodeHit.ref.path}`,
                };
            }
            const comps = readNodeComponents(nodeHit.ref.node);
            const matched = matchComponent(comps, compText, classIndex);
            if (!matched) {
                throw new Error(`target.component 在节点 ${nodeHit.ref.path} 上找不到「${compText}」，现有: ${describeComponents(comps, classIndex)}`);
            }
            const typeName = componentDumpType(matched.comp, classIndex);
            return {
                dumpType: explicitType || typeName,
                valueUuid: String(matched.comp.uuid || ''),
                desc: `组件 ${typeName || compText} @ ${nodeHit.ref.path}`,
            };
        }
    }
    throw new Error('target 必须是 {node, component} / {node} / {asset} / {uuid} / null');
}
const nodeBindProperty = {
    name: 'node.bindProperty',
    title: '绑定引用属性',
    description: '给组件绑定引用类型属性（@property(Label/Sprite/自定义脚本/Node/SpriteFrame…)），' +
        '走 scene/set-property 消息通道（进 undo 体系、可保存进 prefab/scene），与属性检查器拖拽绑定完全等价，' +
        '支持嵌套 prefab 实例内部的组件（自动生成 targetOverrides 序列化落盘）。' +
        '单条参数：uuid（属性所在节点，uuid 或路径，留空=当前选中节点）、component（索引/类名/cid）、property（属性名）、target —— ' +
        '{"node":"Pannel/badge","component":"ItemBadge"} 组件引用（推荐，自动解析目标 uuid 与 dump 类型，嵌套 prefab 内的组件也能定位）；' +
        '{"node":"路径或uuid"} 节点引用（cc.Node）；{"asset":"db://assets/x.png/spriteFrame"} 资产引用；null 解绑。' +
        'target 也可直接传 uuid 字符串（此时建议显式传 type）。' +
        '批量：bindings=[{uuid,component,property,target},…] 多条逐条提交、全部回读验证；' +
        '绑定后自动回读场景实际引用验证，不一致会报错。',
    params: {
        uuid: '属性所在节点：uuid 或节点路径，留空用当前选中节点',
        component: '组件定位：索引数字 / 类名（cc.Label、ItemBadge）/ cid',
        property: '属性名，如 badge、tipLabel、spriteFrame',
        target: '绑定目标：{node,component} 组件引用 | {node} 节点引用 | {asset:"db://…"} 资产 | uuid 字符串 | null 解绑',
        type: '可选。dump 类型名（默认自动推断：组件→类名、节点→cc.Node、资产→资源类型）',
        path: '可选。原始属性路径（如 __comps__.1.badge），传了就跳过 component/property 拼装',
        bindings: '批量绑定数组，每项 {uuid,component,property,target[,type]}，与单条参数二选一；多条全部生效并逐条回读验证',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '属性所在节点：uuid 或节点路径，留空用当前选中节点' },
            component: { type: 'string', description: '组件定位：索引数字 / 类名（cc.Label、ItemBadge）/ cid' },
            property: { type: 'string', description: '属性名，如 badge、tipLabel、spriteFrame' },
            target: {
                description: '绑定目标：{node,component} 组件引用 | {node} 节点引用 | {asset:"db://…"} 资产 | uuid 字符串 | null 解绑',
            },
            type: { type: 'string', description: '可选。dump 类型名，默认自动推断' },
            path: { type: 'string', description: '可选。原始属性路径（如 __comps__.1.badge），跳过 component/property 拼装' },
            bindings: {
                type: 'array',
                description: '批量绑定：每项 {uuid, component, property, target[, type]}，与单条参数二选一；多条全部生效并逐条回读验证',
                items: { type: 'object' },
            },
        },
        additionalProperties: false,
    },
    async run(params) {
        var _a, _b;
        const specs = Array.isArray(params === null || params === void 0 ? void 0 : params.bindings) ? params.bindings : [params];
        if (!specs.length)
            throw new Error('没有可执行的绑定（bindings 为空）');
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        if (!tree)
            throw new Error('当前没有打开的场景');
        const classIndex = await queryComponentClassIndex();
        const items = [];
        const plans = [];
        for (const spec of specs) {
            // 1) 属性所在节点
            const nodeSpec = pickString(spec, 'uuid', '').trim();
            let nodeHit = null;
            if (!nodeSpec || nodeSpec === '@selection') {
                const selected = getSelectedNodeUuids();
                if (!selected.length)
                    throw new Error('没有指定 uuid，也没有选中任何节点');
                nodeHit = resolveNodeRef(tree, selected[0]);
            }
            else {
                nodeHit = resolveNodeRef(tree, nodeSpec);
            }
            if (!nodeHit)
                throw new Error(`场景树里找不到节点: ${nodeSpec || '(选中节点)'}`);
            // 2) 组件与属性路径（dump 路径统一用 __comps__ 前缀，与属性检查器发出的消息一致）
            const rawPath = pickString(spec, 'path', '').trim();
            let path = rawPath
                ? (rawPath.startsWith('components.') ? `__comps__.${rawPath.slice('components.'.length)}` : rawPath)
                : '';
            let verifyIndex = '';
            let verifyProp = '';
            let matched = null;
            if (!path) {
                const property = pickString(spec, 'property', '').trim();
                if (!property)
                    throw new Error('必须指定 property（或原始 path），如 badge / spriteFrame');
                const compSpec = spec === null || spec === void 0 ? void 0 : spec.component;
                const compText = compSpec === undefined || compSpec === null ? '' : String(compSpec).trim();
                if (compText && compText !== 'node') {
                    const comps = readNodeComponents(nodeHit.ref.node);
                    matched = matchComponent(comps, compText, classIndex);
                    if (!matched) {
                        throw new Error(`节点 ${nodeHit.ref.path} 上找不到组件「${compText}」，现有: ${describeComponents(comps, classIndex)}`);
                    }
                    path = `__comps__.${matched.index}.${property}`;
                    verifyIndex = String(matched.index);
                }
                else {
                    path = property; // 节点级属性（少见）
                }
                verifyProp = property;
            }
            else {
                const m = /^__comps__\.(\d+)\.(.+)$/.exec(path);
                if (m) {
                    verifyIndex = m[1];
                    verifyProp = m[2];
                }
            }
            // 3) 目标 → dump
            const targetInfo = await resolveBindTarget(tree, classIndex, spec === null || spec === void 0 ? void 0 : spec.target, pickString(spec, 'type', '').trim());
            const dump = targetInfo.valueUuid === null
                ? (targetInfo.dumpType ? { type: targetInfo.dumpType, value: null } : { value: null })
                : { type: targetInfo.dumpType, value: { uuid: targetInfo.valueUuid } };
            items.push({ uuid: nodeHit.ref.uuid, path, dump });
            plans.push({
                uuid: nodeHit.ref.uuid,
                nodeName: nodeHit.ref.name,
                nodePath: nodeHit.ref.path,
                path,
                component: matched
                    ? `${componentDumpType(matched.comp, classIndex)}(#${matched.index})`
                    : 'node',
                componentAmbiguous: !!(matched && matched.candidates > 1),
                target: targetInfo.desc,
                expectedUuid: targetInfo.valueUuid,
                typeMissing: targetInfo.valueUuid !== null && !targetInfo.dumpType,
                dump,
                verifyIndex,
                verifyProp,
            });
        }
        // 4) 逐条提交：scene/set-property 每次只应用一条（变参形式第 2+ 条会被编辑器忽略，导致
        //    旧实现「bindings 多条只有第一条生效」），所以这里一次一条；代价是 N 条 undo 记录。
        for (const item of items) {
            await Editor.Message.request(SCENE, 'set-property', item);
        }
        // 5) 回读验证（场景脚本通道；场景进程还没加载新方法时降级为 unavailable，不阻塞绑定本身）
        const results = [];
        for (const plan of plans) {
            let verified = 'skipped';
            let actual = null;
            let note = '';
            if (plan.verifyIndex !== '' && plan.verifyProp) {
                try {
                    const r = await Editor.Message.request(SCENE, 'execute-scene-script', {
                        name: package_json_1.default.name,
                        method: 'readComponentProperty',
                        args: [plan.uuid, plan.verifyIndex, plan.verifyProp],
                    });
                    if (r && r.ok === true) {
                        actual = (_a = r.ref) !== null && _a !== void 0 ? _a : null;
                        const actualUuid = actual && actual.uuid ? actual.uuid : null;
                        verified = actualUuid === plan.expectedUuid;
                    }
                    else {
                        verified = 'unavailable';
                        note = (r && r.error)
                            ? String(r.error)
                            : '场景脚本没有返回结果（编辑器里重载 cocos-mcp 扩展后可验证）';
                    }
                }
                catch (e) {
                    verified = 'unavailable';
                    note = (_b = e === null || e === void 0 ? void 0 : e.message) !== null && _b !== void 0 ? _b : String(e);
                }
            }
            results.push(Object.assign({ uuid: plan.uuid, nodeName: plan.nodeName, nodePath: plan.nodePath, path: plan.path, component: plan.component, componentAmbiguous: plan.componentAmbiguous || undefined, target: plan.target, expectedUuid: plan.expectedUuid, typeMissing: plan.typeMissing || undefined, dump: plan.dump, actual,
                verified }, (note ? { verifyNote: note } : {})));
        }
        const mismatched = results.filter((item) => item.verified === false);
        if (mismatched.length) {
            const lines = mismatched.map((item) => {
                var _a;
                return `${item.nodePath} ${item.path} → 期望 ${(_a = item.expectedUuid) !== null && _a !== void 0 ? _a : 'null'}，实际 ${item.actual && item.actual.uuid ? item.actual.uuid : JSON.stringify(item.actual)}`;
            });
            throw new Error(`绑定已提交但回读不一致（可能没有真正生效，可 Ctrl+Z 撤销后重试）：\n${lines.join('\n')}`);
        }
        return {
            applied: items.length,
            submitted: items,
            verifiedCount: results.filter((item) => item.verified === true).length,
            results,
        };
    },
};
const nodeCreatePrefab = {
    name: 'node.createPrefab',
    title: '保存节点为预制体',
    description: '把场景节点（含整棵子树）保存为 .prefab 资源（scene/create-prefab，自动进 undo），' +
        '节点本身会变成预制体实例。url 留空则存到 db://assets/prefabs/<节点名>.prefab，' +
        '目标目录不存在时自动创建。',
    params: {
        node: '节点 uuid，留空则用当前选中节点',
        url: '目标路径，如 db://assets/prefabs/Cards.prefab',
        overwrite: '同名 .prefab 已存在时是否先删除再创建，默认 false',
    },
    schema: {
        type: 'object',
        properties: {
            node: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
            url: { type: 'string', description: '目标路径 db://assets/....prefab，留空则用 db://assets/prefabs/<节点名>.prefab' },
            overwrite: { type: 'boolean', description: '同名资源已存在时是否先删除再创建' },
        },
        additionalProperties: false,
    },
    async run(params) {
        let nodeUuid = pickString(params, 'node', '').trim();
        let source = 'params';
        if (!nodeUuid) {
            nodeUuid = getSelectedNodeUuids()[0] || '';
            source = 'selection';
        }
        if (!nodeUuid) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        const target = findNodeInTree(tree, nodeUuid);
        if (!target) {
            throw new Error(`场景里找不到节点: ${nodeUuid}`);
        }
        const sceneRootUuid = dumpValue(tree === null || tree === void 0 ? void 0 : tree.uuid, '');
        if (sceneRootUuid && sceneRootUuid === nodeUuid) {
            throw new Error('不能把场景根保存为预制体，请指定它的某个子节点');
        }
        const nodeName = dumpValue(target.name, '');
        let url = pickString(params, 'url', '').trim();
        if (!url) {
            if (!nodeName) {
                throw new Error('节点没有名字，无法推导默认路径，请显式传 url');
            }
            url = `db://assets/prefabs/${nodeName}.prefab`;
        }
        if (!url.startsWith('db://assets/')) {
            throw new Error(`url 必须位于 db://assets/ 下: ${url}`);
        }
        if (!url.endsWith('.prefab')) {
            url = `${url}.prefab`;
        }
        // 逐级确保父目录存在（create-asset 的 source 传 null 即创建目录）
        const folderSegments = url.slice('db://assets/'.length).split('/').slice(0, -1);
        let folderUrl = 'db://assets';
        const createdFolders = [];
        for (const segment of folderSegments) {
            if (!segment)
                continue;
            folderUrl = `${folderUrl}/${segment}`;
            const exists = await Editor.Message.request(ASSET_DB, 'query-asset-info', folderUrl);
            if (!exists) {
                const created = await Editor.Message.request(ASSET_DB, 'create-asset', folderUrl, null);
                if (!created) {
                    throw new Error(`创建目录失败: ${folderUrl}`);
                }
                createdFolders.push(folderUrl);
            }
        }
        if ((params === null || params === void 0 ? void 0 : params.overwrite) === true) {
            const existing = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (existing || []).find((asset) => asset.url === url);
            if (hit) {
                await Editor.Message.request(ASSET_DB, 'delete-asset', hit.uuid);
            }
        }
        const prefabUuid = await Editor.Message.request(SCENE, 'create-prefab', nodeUuid, url);
        if (!prefabUuid) {
            throw new Error(`create-prefab 没有返回资源 uuid（目标已存在？可传 overwrite=true）: ${url}`);
        }
        return { node: nodeUuid, nodeName, url, prefabUuid, createdFolders, source };
    },
};
const prefabOpen = {
    name: 'prefab.open',
    title: '打开预制体',
    description: '进入预制体编辑模式（等价资源管理器里双击 .prefab）。普通场景下先保存当前场景避免弹窗，' +
        '再走 asset-db/open-asset 并轮询确认当前编辑文档切换完成。' +
        '若已处于另一个预制体的编辑模式会直接报错（scene/save-scene 对预制体文档无效、切换可能弹「是否保存」对话框），确认包裹场景无未保存修改时可传 assumeClean=true 跳过检查。' +
        '注意：scene/open-scene 对 prefab uuid 无效（会被忽略）；scene.open 也不要用——它内部先 load-empty-scene，会产生无标题场景进而弹「保存」对话框。',
    params: {
        url: '预制体 db:// 路径或 uuid，如 db://assets/prefabs/Foo.prefab',
        saveCurrent: '进入前是否保存当前场景，默认 true',
        assumeClean: '已处于预制体编辑模式时是否跳过安全检查继续切换（仅限确认当前预制体无未保存修改），默认 false',
        timeout: '等待进入预制体编辑模式的超时毫秒，默认 30000',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '预制体 db:// 路径或 uuid' },
            saveCurrent: { type: 'boolean', description: '默认 true' },
            assumeClean: { type: 'boolean', description: '预制体编辑模式下跳过安全检查，默认 false' },
            timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: '默认 30000' },
        },
        required: ['url'],
        additionalProperties: false,
    },
    async run(params) {
        const url = pickString(params, 'url', '').trim();
        if (!url)
            throw new Error('必须指定 url（db:// 路径或 uuid）');
        let uuid = url;
        if (url.startsWith('db://')) {
            const info = await Editor.Message.request(ASSET_DB, 'query-asset-info', url);
            if (!info || !info.uuid)
                throw new Error(`找不到预制体资产: ${url}`);
            if (info.type && info.type !== 'prefab' && info.type !== 'cc.Prefab') {
                throw new Error(`目标不是预制体（${info.type}）: ${info.url || url}`);
            }
            uuid = String(info.uuid);
        }
        // 已处于预制体编辑模式时直接尝试 open-asset 切换（prefab→prefab 未充分验证，失败走超时提示）
        const mode = await detectPrefabMode();
        if (mode.inPrefabMode) {
            if ((params === null || params === void 0 ? void 0 : params.assumeClean) !== true) {
                throw prefabModeBlockedError(mode.prefabName, `打开预制体 ${url}`);
            }
        }
        if ((params === null || params === void 0 ? void 0 : params.saveCurrent) !== false && !mode.inPrefabMode) {
            try {
                await Editor.Message.request(SCENE, 'save-scene');
            }
            catch (e) {
                // 保存失败不阻断（无标题未保存场景会弹对话框，人工处理后轮询继续）
            }
        }
        // scene/open-scene 对 prefab uuid 无效（实测被忽略、场景不切换）；
        // 打开预制体的正确通道是 asset-db/open-asset（等价资源管理器双击）。
        // 注意 query-current-scene 在预制体模式下仍返回场景页签 uuid，不反映编辑中的文档；
        // 要用 query-node-tree 的根 uuid——预制体模式下文档是包了一层的临时场景
        // （<名字>-scene，根下有 should_hide_in_hierarchy），成功判定 = 根 uuid 相对打开前变化（连续两次读到才算稳定）
        const timeout = pickNumber(params, 'timeout', 30000) || 30000;
        const switched = await openAssetAndPoll(uuid, timeout);
        const result = { opened: switched.opened, prefabUuid: uuid, fromScene: switched.from || null, currentScene: switched.current || null, requested: true };
        if (!result.opened) {
            result.hint = '超时未切换文档：可能当前已处于该预制体的编辑模式，或当前是无标题未保存场景时编辑器弹了保存对话框（处理后重试）';
        }
        return result;
    },
};
const sceneSave = {
    name: 'scene.save',
    title: '保存场景',
    description: '通过 scene/save-scene 保存当前场景，返回保存结果。' +
        '预制体编辑模式下会直接报错拒绝（该模式下保存是盲的：query-dirty 恒 false、save-scene 返回 null，还可能堵在「是否保存」对话框上），请先人工保存/关闭预制体页签',
    params: {},
    schema: noParams(),
    async run() {
        // 预制体编辑模式下保存是盲的：query-dirty 恒 false、save-scene 返回 null，
        // 还可能被「是否保存」对话框堵住（2026-10 建 rps.scene 时实测堵了 24 秒直到人工取消），直接拒绝
        const mode = await detectPrefabMode();
        if (mode.inPrefabMode) {
            throw prefabModeBlockedError(mode.prefabName, '保存当前场景');
        }
        const dirtyBefore = await Editor.Message.request(SCENE, 'query-dirty');
        // 注意：3.8.8 的 save-scene 返回的是场景 uuid，不是 db:// 路径
        const sceneUuid = await Editor.Message.request(SCENE, 'save-scene');
        const dirtyAfter = await Editor.Message.request(SCENE, 'query-dirty');
        let url = null;
        if (sceneUuid) {
            try {
                url = await Editor.Message.request(ASSET_DB, 'query-path', sceneUuid);
            }
            catch (e) {
                url = null;
            }
        }
        return { dirtyBefore, dirtyAfter, sceneUuid: sceneUuid || null, url: url || null };
    },
};
const assetList = {
    name: 'asset.list',
    title: '资源列表',
    description: '通过 asset-db/query-assets 列出项目资源',
    params: {
        pattern: '路径匹配，默认 db://assets/**',
        limit: '最多返回条数，默认 50',
    },
    schema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '路径匹配（globs），默认 db://assets/**' },
            limit: { type: 'number', description: '最多返回条数，默认 50' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const pattern = pickString(params, 'pattern', '') || 'db://assets/**';
        const limit = pickNumber(params, 'limit', 50) || 50;
        const assets = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern });
        const list = (assets || []).slice(0, limit).map((asset) => ({
            url: asset.url,
            uuid: asset.uuid,
            type: asset.type,
            file: asset.file,
        }));
        return { pattern, total: (assets || []).length, listed: list.length, assets: list };
    },
};
const assetDelete = {
    name: 'asset.delete',
    title: '删除资源',
    description: '删除 assets 下的资源（脚本 / 预制体 / 贴图等），传 uuid 或 db:// 路径',
    params: {
        uuid: '资源 uuid',
        url: '资源路径，如 db://assets/scripts/Player.ts',
    },
    schema: {
        type: 'object',
        properties: {
            uuid: { type: 'string', description: '资源 uuid' },
            url: { type: 'string', description: '资源路径 db://...' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const uuid = pickString(params, 'uuid', '').trim();
        const url = pickString(params, 'url', '').trim();
        if (!uuid && !url) {
            throw new Error('必须指定 uuid 或 url');
        }
        let target = uuid;
        if (!target) {
            const assets = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (assets || []).find((asset) => asset.url === url);
            if (!hit) {
                throw new Error(`找不到资源: ${url}`);
            }
            target = hit.uuid;
        }
        try {
            await Editor.Message.request(ASSET_DB, 'delete-asset', target);
        }
        catch (e) {
            // 有些版本认路径不认 uuid，退回按路径再试一次
            if (!url)
                throw e;
            await Editor.Message.request(ASSET_DB, 'delete-asset', url);
            target = url;
        }
        return { target, url: url || null, deleted: true };
    },
};
const assetImport = {
    name: 'asset.import',
    title: '导入资源文件',
    description: '把磁盘上的文件/目录复制进 assets 并触发 asset-db 导入，轮询到 uuid 就绪后返回（含子资源 uuid，如 spriteFrame）。' +
        '外部写盘不会触发编辑器的窗口焦点增量检查，必须走本操作（或手动 refresh-asset），否则 uuid 不会生成。' +
        'src 省略时为纯刷新模式：文件已直接写进 assets（脚本/贴图原地就位），只触发导入不复制，返回 uuid。' +
        'src 为目录时递归复制整个目录（自动跳过 .meta 等隐藏文件，避免带入旧 uuid）；' +
        'dbPath 以 / 结尾或无扩展名时视为目标目录，否则视为精确目标文件路径。',
    params: {
        src: '磁盘源路径（文件或目录，绝对路径或相对项目根）；省略 = 纯刷新模式（dbPath 处文件已就位）',
        dbPath: '目标 db://assets/...，目录或精确文件路径',
        waitTimeout: '轮询导入结果超时（毫秒），默认 15000',
    },
    schema: {
        type: 'object',
        properties: {
            src: { type: 'string', description: '磁盘源路径（文件或目录）；省略 = 纯刷新模式' },
            dbPath: { type: 'string', description: '目标 db://assets/...' },
            waitTimeout: { type: 'number', description: '轮询超时毫秒，默认 15000' },
        },
        required: ['dbPath'],
        additionalProperties: false,
    },
    async run(params) {
        const src = pickString(params, 'src', '').trim();
        let dbPath = pickString(params, 'dbPath', '').trim();
        const waitTimeout = pickNumber(params, 'waitTimeout', 15000) || 15000;
        if (!dbPath.startsWith('db://assets/'))
            throw new Error(`dbPath 必须在 db://assets/ 下: ${dbPath}`);
        // 纯刷新模式：不复制，只对已就位的文件触发 asset-db 导入
        const pureRefresh = !src;
        const srcAbs = pureRefresh
            ? dbUrlToAbs(dbPath)
            : (src.startsWith('db://')
                ? dbUrlToAbs(src)
                : (src.match(/^[A-Za-z]:[\\/]/) ? src : (0, path_1.join)(projectRoot(), src)));
        const srcStat = await (0, promises_1.stat)(srcAbs).catch(() => null);
        if (!srcStat) {
            throw new Error(pureRefresh
                ? `目标文件不在磁盘上，无法刷新: ${srcAbs}（纯刷新模式要求文件已写进 assets）`
                : `源路径不存在: ${srcAbs}`);
        }
        dbPath = dbPath.replace(/\/+$/, '');
        const srcIsDir = srcStat.isDirectory();
        const dbDir = !srcIsDir && (0, path_1.extname)(dbPath) ? (0, path_1.dirname)(dbPath) : dbPath;
        // 计算复制清单：目录递归展开，文件单条
        const items = [];
        if (srcIsDir) {
            const walk = async (dir, rel) => {
                for (const entry of await (0, promises_1.readdir)(dir, { withFileTypes: true })) {
                    const lower = entry.name.toLowerCase();
                    // 跳过点文件与 Cocos 的 xxx.ts.meta（编辑器自生成，导入它只会白等超时/带入旧 uuid）
                    if (lower.startsWith('.') || lower.endsWith('.meta'))
                        continue;
                    const from = (0, path_1.join)(dir, entry.name);
                    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        await walk(from, childRel);
                    }
                    else {
                        items.push({ from, toAbs: dbUrlToAbs(`${dbDir}/${childRel}`), dbUrl: `${dbDir}/${childRel}`, rel: childRel });
                    }
                }
            };
            await walk(srcAbs, '');
        }
        else {
            if ((0, path_1.basename)(srcAbs).toLowerCase().endsWith('.meta')) {
                throw new Error('不要把 .meta 当作导入对象（编辑器自生成文件）；直接导入对应的资源文件即可');
            }
            const fileName = (0, path_1.basename)(srcAbs);
            const dbUrl = (0, path_1.extname)(dbPath) ? dbPath : `${dbDir}/${fileName}`;
            items.push({ from: srcAbs, toAbs: dbUrlToAbs(dbUrl), dbUrl, rel: fileName });
        }
        if (!items.length)
            throw new Error(`源目录里没有可复制的文件: ${srcAbs}`);
        // 复制到磁盘（源与目标同路径 = 文件已就位，跳过复制只触发导入）
        for (const item of items) {
            if (isSamePath(item.from, item.toAbs))
                continue;
            await (0, promises_1.mkdir)((0, path_1.dirname)(item.toAbs), { recursive: true });
            await (0, promises_1.copyFile)(item.from, item.toAbs);
        }
        // 触发导入：从目标目录向上找到 asset-db 已知的最近祖先再刷新（新目录本身可能还未入库）
        let refreshUrl = dbDir;
        for (let guard = 0; guard < 6; guard++) {
            const parent = (0, path_1.dirname)(refreshUrl);
            if (parent === refreshUrl || !parent.startsWith('db://assets'))
                break;
            const known = await Editor.Message.request(ASSET_DB, 'query-asset-info', refreshUrl);
            if (known)
                break;
            refreshUrl = parent;
        }
        try {
            await Editor.Message.request(ASSET_DB, 'refresh-asset', refreshUrl);
        }
        catch (e) {
            // 个别版本不支持目录刷新，退回逐文件刷新
            for (const item of items) {
                await Editor.Message.request(ASSET_DB, 'refresh-asset', item.dbUrl);
            }
        }
        // 轮询导入结果，收集 uuid 与子资源（spriteFrame 等）
        const deadline = Date.now() + waitTimeout;
        const files = [];
        let ready = true;
        for (const item of items) {
            let assetInfo = null;
            while (Date.now() < deadline) {
                assetInfo = await Editor.Message.request(ASSET_DB, 'query-asset-info', item.dbUrl);
                if (assetInfo)
                    break;
                await sleep(300);
            }
            if (!assetInfo) {
                ready = false;
                files.push({ src: item.from, url: item.dbUrl, rel: item.rel, ready: false });
                continue;
            }
            let subAssets = Array.isArray(assetInfo.subAssets)
                ? assetInfo.subAssets.map((sub) => ({ name: sub.name, url: sub.url, uuid: sub.uuid, type: sub.type }))
                : null;
            if (!subAssets) {
                // 兜底：子资源 url 形如 <资源url>/<名字>，用 query-assets 查
                const subs = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: `${item.dbUrl}/*` });
                subAssets = (subs || []).map((sub) => ({
                    name: sub.url.slice(item.dbUrl.length + 1),
                    url: sub.url,
                    uuid: sub.uuid,
                    type: sub.type,
                }));
            }
            files.push({ src: item.from, url: item.dbUrl, rel: item.rel, ready: true, uuid: assetInfo.uuid, type: assetInfo.type, subAssets });
        }
        return { ready, dirUrl: dbDir, refreshUrl, count: items.length, files };
    },
};
const sceneScriptInfo = {
    name: 'scene.script.info',
    title: '场景脚本通道 · 引擎信息',
    description: '通过 scene/execute-scene-script 进入场景进程，读取引擎与场景信息',
    params: {},
    schema: noParams(),
    async run() {
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'engineInfo',
            args: [],
        });
        return { scriptResult: result };
    },
};
const sceneScriptDemo = {
    name: 'scene.script.demo',
    title: '场景脚本通道 · 建节点',
    description: '通过场景脚本用引擎 API 在当前场景创建一个节点',
    params: {
        name: '节点名，默认 MCP_Engine_Node',
        x: 'x 坐标',
        y: 'y 坐标',
        z: 'z 坐标',
    },
    schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '节点名' },
            x: { type: 'number', description: 'x 坐标' },
            y: { type: 'number', description: 'y 坐标' },
            z: { type: 'number', description: 'z 坐标' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const name = pickString(params, 'name', '') || 'MCP_Engine_Node';
        const position = {
            x: pickNumber(params, 'x', 0),
            y: pickNumber(params, 'y', 0),
            z: pickNumber(params, 'z', 0),
        };
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'createNode',
            args: [name, position],
        });
        return { scriptResult: result };
    },
};
// ---------------------------------------------------------------- 脚本 / 组件
/** 等待某个脚本资源被 Creator 编译并注册为 ccclass */
async function waitForScriptCompiled(assetUuid, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const list = await Editor.Message.request(SCENE, 'query-components');
        const found = (list || []).find((item) => item && item.assetUuid === assetUuid);
        if (found)
            return found;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
}
/**
 * 把属性默认值渲染成可编译的源码字面量。
 *
 * 之前是把 default 原样拼进源码，字符串默认值会漏掉引号：
 *   streetName: string = 街上;   → 编译成 `return 街上;`，组件构造时 ReferenceError
 * 这里按类型补齐字面量写法，字符串默认走 JSON.stringify。
 */
function renderDefault(prop, type) {
    if (prop.default === undefined) {
        return type === 'number' ? '0' : type === 'string' ? "''" : 'null';
    }
    const raw = String(prop.default);
    if (type === 'string') {
        // 调用方已经写了字面量（带引号/反引号）就原样保留，否则按字符串字面量输出
        return /^['"`]/.test(raw) ? raw : JSON.stringify(raw);
    }
    return raw;
}
/** 生成源码时需要自动补进 cc import 的常用类型表 */
const CC_TYPE_NAMES = [
    'Node', 'Label', 'Button', 'Sprite', 'SpriteFrame', 'SpriteAtlas', 'Toggle', 'Layout', 'Widget',
    'ScrollView', 'EditBox', 'Slider', 'ProgressBar', 'Graphics', 'Animation', 'AudioSource',
    'Vec2', 'Vec3', 'Color', 'Size', 'Prefab', 'Mask', 'RichText', 'UIOpacity', 'EventHandler',
];
/** 从属性声明与类体里收集用到的 cc 类型，生成 import 列表 */
function collectCcTypes(properties, body) {
    const used = new Set();
    for (const prop of properties || []) {
        const type = String((prop === null || prop === void 0 ? void 0 : prop.type) || '').trim();
        if (CC_TYPE_NAMES.includes(type))
            used.add(type);
    }
    if (body) {
        for (const name of CC_TYPE_NAMES) {
            if (new RegExp(`\\b${name}\\b`).test(body))
                used.add(name);
        }
    }
    return Array.from(used).sort();
}
/** 生成脚本源码 */
function buildScriptSource(className, properties, body, imports = []) {
    const propLines = (properties || [])
        .map((prop) => {
        const type = prop.type || 'number';
        const value = renderDefault(prop, type);
        return `    @property\n    ${prop.name}: ${type} = ${value};`;
    })
        .join('\n');
    const extraTypes = collectCcTypes(properties || [], body);
    const importLine = extraTypes.length
        ? `import { _decorator, Component, ${extraTypes.join(', ')} } from 'cc';`
        : `import { _decorator, Component } from 'cc';`;
    return [
        importLine,
        ...(imports || []).filter((line) => typeof line === 'string' && line.trim()),
        `const { ccclass, property } = _decorator;`,
        ``,
        `@ccclass('${className}')`,
        `export class ${className} extends Component {`,
        propLines,
        propLines ? `` : ``,
        `    start() {`,
        `        console.log('[${className}] start');`,
        `    }`,
        body ? `` : ``,
        body || ``,
        `}`,
        ``,
    ].join('\n');
}
const scriptCreate = {
    name: 'script.create',
    title: '创建脚本',
    description: '在 assets 下创建一个 TypeScript 脚本（自动挂 ccclass），并等待它被 Creator 编译注册，返回 cid',
    params: {
        path: '脚本路径，如 db://assets/scripts/Player.ts；留空则用 db://assets/scripts/<类名>.ts',
        className: '类名，默认取文件名',
        properties: '属性声明数组，形如 [{"name":"speed","type":"number","default":1}]',
        body: '额外的类体代码，直接插入到 class 里',
        imports: '额外的 import 语句数组（引用其他用户脚本时用），逐行插到 cc import 之后',
        overwrite: '同名文件已存在时是否覆盖，默认 false',
    },
    schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '脚本路径，如 db://assets/scripts/Player.ts' },
            className: { type: 'string', description: '类名，默认取文件名' },
            properties: {
                type: 'array',
                description: '属性声明数组',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: { type: 'string' },
                        default: {},
                    },
                },
            },
            body: { type: 'string', description: '额外的类体代码' },
            imports: {
                type: 'array',
                items: { type: 'string' },
                description: '额外的 import 语句，逐行原样插入到 cc import 之后',
            },
            overwrite: { type: 'boolean', description: '同名文件已存在时是否覆盖' },
        },
        additionalProperties: false,
    },
    async run(params) {
        let path = pickString(params, 'path', '').trim();
        const overwrite = (params === null || params === void 0 ? void 0 : params.overwrite) === true;
        if (!path) {
            const className = pickString(params, 'className', '').trim() || 'McpScript';
            path = `db://assets/scripts/${className}.ts`;
        }
        if (!/\.ts$/.test(path)) {
            throw new Error(`脚本路径必须以 .ts 结尾: ${path}`);
        }
        if (!path.startsWith('db://assets/')) {
            throw new Error(`脚本必须创建在 db://assets/ 下: ${path}`);
        }
        const fileName = path.slice(path.lastIndexOf('/') + 1).replace(/\.ts$/, '');
        const className = pickString(params, 'className', '').trim() || fileName;
        const source = buildScriptSource(className, (params === null || params === void 0 ? void 0 : params.properties) || [], pickString(params, 'body', ''), Array.isArray(params === null || params === void 0 ? void 0 : params.imports) ? params.imports : []);
        // overwrite=true：先删除同名旧资源再创建（不然 create-asset 会因文件已存在返回空）
        if (overwrite) {
            const existing = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: path });
            const hit = (existing || []).find((asset) => asset.url === path);
            if (hit) {
                await Editor.Message.request(ASSET_DB, 'delete-asset', hit.uuid);
            }
        }
        const created = await Editor.Message.request(ASSET_DB, 'create-asset', path, source);
        if (!created) {
            throw new Error(`create-asset 没有返回资源信息: ${path}（同名文件已存在？可传 overwrite=true 覆盖）`);
        }
        const uuid = created.uuid;
        const compiled = await waitForScriptCompiled(uuid, 30000);
        if (!compiled) {
            return {
                uuid,
                url: created.url,
                path,
                className,
                compiled: false,
                error: '脚本已写入，但 30 秒内没有在编辑器里完成编译注册（可能语法错误，或编辑器未在编译）',
            };
        }
        return {
            uuid,
            url: created.url,
            path,
            className,
            compiled: true,
            cid: compiled.cid,
            name: compiled.name,
            componentPath: compiled.path,
        };
    },
};
const scriptList = {
    name: 'script.list',
    title: '列出脚本组件',
    description: '列出编辑器里已注册的全部组件（内置 + 用户脚本），带 cid / path / assetUuid',
    params: {},
    schema: noParams(),
    async run() {
        const list = await Editor.Message.request(SCENE, 'query-components');
        const items = (list || []).map((item) => ({
            name: item.name,
            cid: item.cid,
            path: item.path,
            assetUuid: item.assetUuid,
            isScript: !!item.assetUuid,
        }));
        return { total: items.length, components: items };
    },
};
const nodeAddComponent = {
    name: 'node.addComponent',
    title: '挂载组件',
    description: '给节点挂组件：内置组件传 cc.Sprite 之类，用户脚本传 script.list 查到的 cid',
    params: {
        node: '节点 uuid，留空则用当前选中节点',
        component: '组件 cid 或类名，如 cc.Sprite / fcmR3XADNLgJ1ByKhqcC5Z',
    },
    schema: {
        type: 'object',
        properties: {
            node: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
            component: { type: 'string', description: '组件 cid 或类名' },
        },
        required: ['component'],
        additionalProperties: false,
    },
    async run(params) {
        const component = pickString(params, 'component', '').trim();
        if (!component) {
            throw new Error('必须指定 component');
        }
        let node = pickString(params, 'node', '').trim();
        if (!node) {
            const selected = getSelectedNodeUuids();
            node = selected[0] || '';
        }
        if (!node) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        // 幂等：同节点不允许同类型组件重复挂载，先查已有组件，命中就直接返回，
        // 避免编辑器打印 "Can't add component ... already contains the same component" 警告并污染 undo
        const compsBefore = await queryNodeComponents(node);
        const candidates = await resolveComponentCandidates(component);
        const existing = matchExistingComponent(compsBefore, candidates);
        if (existing) {
            return {
                node,
                component,
                channel: 'none',
                attached: true,
                alreadyExists: true,
                existing: { uuid: existing.uuid, type: existing.type, name: existing.name },
                components: compsBefore,
            };
        }
        // 内置组件（cc.Sprite 之类）走编辑器消息通道，能进 undo 体系
        const isBuiltin = component.startsWith('cc.');
        let channel = 'message';
        if (isBuiltin) {
            await Editor.Message.request(SCENE, 'create-component', { uuid: node, component });
        }
        else {
            // 自定义脚本组件必须走引擎：编辑器消息通道挂不上去
            channel = 'engine';
            const scriptResult = await Editor.Message.request(SCENE, 'execute-scene-script', {
                name: package_json_1.default.name,
                method: 'addComponentToNode',
                args: [node, component],
            });
            if (!scriptResult || scriptResult.ok !== true) {
                throw new Error(`挂载自定义组件失败：${scriptResult && scriptResult.error ? scriptResult.error : '未知错误'}` +
                    (scriptResult && scriptResult.registeredUserClasses
                        ? `；引擎里已注册的用户类: ${scriptResult.registeredUserClasses.join(', ') || '(无)'}`
                        : ''));
            }
        }
        // create-component / addComponent 都不返回有效值，必须回读确认
        const comps = await queryNodeComponents(node);
        const attached = matchExistingComponent(comps, candidates);
        if (!attached) {
            const current = comps.map((c) => c.type || c.name).join(', ') || '(无)';
            throw new Error(`组件没有真正挂上：节点 ${node} 上没有出现组件「${component}」（通道：${channel}）；` +
                `当前组件: ${current}`);
        }
        return { node, component, channel, attached: true, components: comps };
    },
};
const nodeRemoveComponent = {
    name: 'node.removeComponent',
    title: '移除组件',
    description: '按组件 uuid 移除节点上的组件',
    params: {
        component: '组件 uuid',
    },
    schema: {
        type: 'object',
        properties: {
            component: { type: 'string', description: '组件 uuid' },
        },
        required: ['component'],
        additionalProperties: false,
    },
    async run(params) {
        const component = pickString(params, 'component', '').trim();
        if (!component) {
            throw new Error('必须指定 component uuid');
        }
        await Editor.Message.request(SCENE, 'remove-component', { uuid: component });
        return { component, removed: true };
    },
};
const nodeListComponents = {
    name: 'node.listComponents',
    title: '列出节点组件',
    description: '列出某个节点上挂的所有组件',
    params: {
        node: '节点 uuid，留空则用当前选中节点',
    },
    schema: {
        type: 'object',
        properties: {
            node: { type: 'string', description: '节点 uuid，留空则用当前选中节点' },
        },
        additionalProperties: false,
    },
    async run(params) {
        let node = pickString(params, 'node', '').trim();
        if (!node) {
            const selected = getSelectedNodeUuids();
            node = selected[0] || '';
        }
        if (!node) {
            throw new Error('没有指定节点，也没有选中任何节点');
        }
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        const found = findNodeInTree(tree, node);
        if (!found) {
            throw new Error(`场景树里找不到节点 ${node}`);
        }
        const comps = readNodeComponents(found);
        return {
            node,
            nodeName: dumpValue(found.name, ''),
            count: comps.length,
            components: comps,
        };
    },
};
const nodeDebug = {
    name: 'node.debug',
    title: '调试：原始节点 dump',
    description: '返回节点在编辑器 dump 里的原始字段，用来摸清 3.8.8 真实的组件字段名',
    params: {
        node: '节点 uuid',
    },
    schema: {
        type: 'object',
        properties: {
            node: { type: 'string', description: '节点 uuid' },
        },
        required: ['node'],
        additionalProperties: false,
    },
    async run(params) {
        const uuid = pickString(params, 'node', '').trim();
        if (!uuid)
            throw new Error('必须指定 node');
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        const find = (node) => {
            if (!node)
                return null;
            if (dumpValue(node.uuid, '') === uuid)
                return node;
            for (const child of (node.children || [])) {
                const hit = find(child);
                if (hit)
                    return hit;
            }
            return null;
        };
        const found = find(tree);
        const direct = await Editor.Message.request(SCENE, 'query-node', uuid);
        return {
            foundInTree: !!found,
            treeNodeKeys: found ? Object.keys(found) : [],
            treeNode: found || null,
            directQueryKeys: direct ? Object.keys(direct) : [],
            directQuery: direct || null,
        };
    },
};
// ---------------------------------------------------------------- 场景截图
const sceneCapture = {
    name: 'scene.capture',
    title: '场景截图',
    description: '截取场景面板视口为 base64 JPEG（含编辑器网格/gizmo，非运行时画面）。仅当场景中存在 Canvas 节点时可用。返回 sourceWidth/Height 为画布物理像素，outputWidth/Height 为缩放后尺寸。传 outPath 可同时把图片写到磁盘（绝对路径）',
    params: {
        maxW: '输出图宽度上限（像素），默认 768',
        outPath: '可选：把 JPEG 写到该绝对路径（目录会自动创建）',
    },
    schema: {
        type: 'object',
        properties: {
            maxW: { type: 'number', description: '输出图宽度上限（像素），默认 768' },
            outPath: { type: 'string', description: '可选：JPEG 落盘的绝对路径' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const maxW = pickNumber(params, 'maxW', 768) || 768;
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'captureScene',
            args: [maxW],
        });
        if (!result || result.ok === false) {
            throw new Error((result && result.error) || '场景截图失败');
        }
        const outPath = pickString(params, 'outPath', '').trim();
        if (outPath && result.base64) {
            const abs = (0, path_1.resolve)(outPath);
            await (0, promises_1.mkdir)((0, path_1.dirname)(abs), { recursive: true });
            await (0, promises_1.writeFile)(abs, Buffer.from(String(result.base64), 'base64'));
            return Object.assign(Object.assign({}, result), { base64: undefined, savedTo: abs });
        }
        return result;
    },
};
const sceneReopen = {
    name: 'scene.reopen',
    title: '重开场景',
    description: '保存当前场景后重新打开它，触发场景进程重新导入用户脚本模块（外部写入的 .ts 编译后需要这一步才能在引擎里挂载）',
    params: {},
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
        const save = await Editor.Message.request(SCENE, 'save-scene');
        const status = await Editor.Message.request(SCENE, 'query-current-scene');
        const uuid = typeof status === 'string' ? status : (status && status.uuid);
        if (!uuid)
            throw new Error('拿不到当前场景 uuid: ' + JSON.stringify(status));
        // 已打开场景的 open-scene 可能被忽略：先切到空场景再切回，强制场景进程重载脚本模块
        let empty = null;
        try {
            empty = await Editor.Message.request(SCENE, 'load-empty-scene');
        }
        catch (e) {
            empty = String(e.message || e);
        }
        const opened = await Editor.Message.request(SCENE, 'open-scene', uuid);
        return { saved: save, sceneUuid: uuid, empty, opened };
    },
};
const sceneCreate = {
    name: 'scene.create',
    title: '新建场景',
    description: '用 asset-db/new-asset 按编辑器内置模板新建场景，与资源管理器右键「新建 → 场景」同一通道' +
        '（handler=scene，template=db://internal/default_file_content/scene/scene-2d.scene）。' +
        '注意：create-asset 传 null 内容在 3.8.8 实测创建的是目录而非场景文件，不要用它建场景。' +
        '父目录不存在会自动逐级创建。open=true 时创建后 open-scene 并轮询确认切换完成；' +
        '当前场景是无标题未保存场景时编辑器会弹保存对话框，人工处理后轮询自动继续，超时返回 opened=false 并给提示。' +
        '预制体编辑模式下 open=true 会先报错拒绝（切换可能弹「是否保存」对话框且无法自动处理），确认包裹场景干净可传 assumeClean=true。',
    params: {
        url: '新场景 db:// 路径，如 db://assets/scenes/helloworld.scene',
        template: "'2d'（默认，含 Canvas+Camera）/ 'empty'（空场景），或完整模板路径 db://internal/default_file_content/scene/xxx.scene",
        open: '创建后是否立即打开该场景，默认 false',
        overwrite: '同名文件已存在时是否覆盖，默认 false',
        openTimeout: 'open=true 时等待场景切换完成的超时毫秒，默认 30000',
        assumeClean: '当前处于预制体编辑模式时是否跳过安全检查继续打开（仅限确认预制体无未保存修改），默认 false',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '新场景 db:// 路径，如 db://assets/scenes/helloworld.scene' },
            template: { type: 'string', description: "'2d'（默认）/ 'empty'，或完整模板 db:// 路径" },
            open: { type: 'boolean', description: '创建后是否立即打开，默认 false' },
            overwrite: { type: 'boolean', description: '同名文件已存在时是否覆盖，默认 false' },
            openTimeout: { type: 'number', description: '等待场景切换超时毫秒，默认 30000' },
            assumeClean: { type: 'boolean', description: '预制体编辑模式下跳过安全检查，默认 false' },
        },
        required: ['url'],
        additionalProperties: false,
    },
    async run(params) {
        const url = pickString(params, 'url', '').trim();
        if (!url.startsWith('db://assets/'))
            throw new Error(`场景必须创建在 db://assets/ 下: ${url}`);
        if (!url.endsWith('.scene'))
            throw new Error(`场景路径必须以 .scene 结尾: ${url}`);
        const overwrite = (params === null || params === void 0 ? void 0 : params.overwrite) === true;
        // 预制体编辑模式下切换文档会弹「是否保存」对话框且无法自动处理（save-scene 对预制体文档无效），
        // 先检测先拒绝；确认包裹场景无未保存修改时可 assumeClean=true 跳过
        let fromPrefabMode = false;
        if ((params === null || params === void 0 ? void 0 : params.open) === true) {
            const mode = await detectPrefabMode();
            if (mode.inPrefabMode) {
                if ((params === null || params === void 0 ? void 0 : params.assumeClean) !== true)
                    throw prefabModeBlockedError(mode.prefabName, `创建并打开新场景 ${url}`);
                // 新场景一定不是「已加载 uuid」，open-scene 可以正常切换（见 scene.open 内注释），
                // 但 query-current-scene 在脱离前是盲的——下面的轮询在脱离后自然拿到正确 uuid
                fromPrefabMode = true;
            }
        }
        // 逐级确保父目录存在（create-asset 的 source 传 null 即创建目录）
        const folderSegments = url.slice('db://assets/'.length).split('/').slice(0, -1);
        let folderUrl = 'db://assets';
        for (const segment of folderSegments) {
            if (!segment)
                continue;
            folderUrl = `${folderUrl}/${segment}`;
            const exists = await Editor.Message.request(ASSET_DB, 'query-asset-info', folderUrl);
            if (!exists) {
                const created = await Editor.Message.request(ASSET_DB, 'create-asset', folderUrl, null);
                if (!created)
                    throw new Error(`创建目录失败: ${folderUrl}`);
            }
        }
        let template = pickString(params, 'template', '').trim() || '2d';
        if (template === '2d')
            template = 'db://internal/default_file_content/scene/scene-2d.scene';
        else if (template === 'empty' || template === '3d')
            template = 'db://internal/default_file_content/scene/default.scene';
        const info = await Editor.Message.request(ASSET_DB, 'new-asset', {
            handler: 'scene',
            target: url,
            template,
            overwrite,
        });
        if (!info || !info.uuid) {
            throw new Error(`new-asset 没有返回资源信息: ${url}（同名文件已存在？可传 overwrite=true）`);
        }
        const result = { uuid: info.uuid, url: info.url || url, file: info.file || null, template };
        if ((params === null || params === void 0 ? void 0 : params.open) === true) {
            // 不做 load-empty-scene：它会产生无标题场景，导致随后的 open-scene 弹「保存当前场景」对话框
            const timeout = pickNumber(params, 'openTimeout', 30000) || 30000;
            try {
                await Editor.Message.request(SCENE, 'open-scene', info.uuid);
            }
            catch (e) {
                // open-scene 可能静默被忽略，交给下面的轮询判断
            }
            const deadline = Date.now() + timeout;
            let current = '';
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                try {
                    const status = await Editor.Message.request(SCENE, 'query-current-scene');
                    current = typeof status === 'string' ? status : (status && status.uuid) || '';
                }
                catch (e) {
                    current = '';
                }
                if (current === String(info.uuid))
                    break;
            }
            result.opened = current === String(info.uuid);
            result.currentScene = current || null;
            if (fromPrefabMode)
                result.fromPrefabMode = true;
            if (!result.opened) {
                result.hint = '超时未切换到新场景：当前场景未保存时 open-scene 会弹保存对话框，在编辑器里处理该对话框后可用 scene.open 重试';
            }
        }
        return result;
    },
};
const sceneOpen = {
    name: 'scene.open',
    title: '打开场景',
    description: '按 db:// 路径或 uuid 打开指定场景（默认先保存当前场景再切换，saveCurrent=false 可跳过保存）。' +
        '预制体编辑模式下会先报错拒绝（save-scene 对预制体文档无效、切换可能弹「是否保存」对话框），' +
        '确认包裹场景干净可传 assumeClean=true，此时跳过保存与 load-empty-scene 直接切换',
    params: {
        url: '场景资产 db:// 路径或 uuid，如 db://assets/lobby.scene',
        saveCurrent: '切换前是否保存当前场景，默认 true',
        assumeClean: '当前处于预制体编辑模式时是否跳过安全检查继续切换（仅限确认预制体无未保存修改），默认 false',
        timeout: 'assumeClean 切换路径（open-asset 通道）的轮询超时毫秒，默认 30000',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '场景资产 db:// 路径或 uuid' },
            saveCurrent: { type: 'boolean', description: '默认 true' },
            assumeClean: { type: 'boolean', description: '预制体编辑模式下跳过安全检查，默认 false' },
            timeout: { type: 'integer', description: '预制体模式切换轮询超时毫秒，默认 30000' },
        },
        required: ['url'],
        additionalProperties: false,
    },
    async run(params) {
        const url = pickString(params, 'url', '').trim();
        if (!url)
            throw new Error('必须指定 url（db:// 路径或 uuid）');
        let uuid = url;
        if (url.startsWith('db://')) {
            const assets = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (assets || []).find((a) => a.url === url) || (assets || [])[0];
            if (!hit || !hit.uuid)
                throw new Error(`找不到场景资产: ${url}`);
            uuid = String(hit.uuid);
        }
        const mode = await detectPrefabMode();
        const fromPrefab = mode.inPrefabMode;
        if (fromPrefab && (params === null || params === void 0 ? void 0 : params.assumeClean) !== true) {
            throw prefabModeBlockedError(mode.prefabName, `打开场景 ${url}`);
        }
        const saveCurrent = (params === null || params === void 0 ? void 0 : params.saveCurrent) === false ? false : true;
        if (saveCurrent && !fromPrefab) {
            try {
                await Editor.Message.request(SCENE, 'save-scene');
            }
            catch (e) {
                // 保存失败不阻断切换
            }
        }
        if (fromPrefab) {
            // 实测（2026-10）：预制体模式下 open-scene 对「已加载的场景 uuid」（背后的场景页签）会被忽略，
            // 对未加载的场景可以正常切换；close-scene 在该模式下无效、不要用。
            // query-current-scene 在该模式下是盲的（返回包裹场景 uuid），所以先用 detectPrefabMode 判断是否脱离
            try {
                await Editor.Message.request(SCENE, 'open-scene', uuid);
            }
            catch (e) {
                // 可能静默被忽略，交给轮询判断
            }
            const deadline = Date.now() + (pickNumber(params, 'timeout', 30000) || 30000);
            let exited = false;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                const now = await detectPrefabMode();
                if (!now.inPrefabMode) {
                    exited = true;
                    break;
                }
            }
            if (!exited) {
                return {
                    opened: false,
                    sceneUuid: uuid,
                    fromPrefabMode: true,
                    hint: 'open-scene 未生效：目标场景可能正是预制体背后的场景页签（已加载的 uuid 会被忽略）。先随便打开另一个未加载的场景脱离预制体模式，再切回目标场景',
                };
            }
            let current = '';
            const confirmDeadline = Date.now() + 10000;
            while (Date.now() < confirmDeadline) {
                try {
                    const st = await Editor.Message.request(SCENE, 'query-current-scene');
                    current = typeof st === 'string' ? st : (st && st.uuid) || '';
                }
                catch (e) {
                    current = '';
                }
                if (current === uuid)
                    break;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            const result = { opened: current === uuid, sceneUuid: uuid, fromPrefabMode: true, currentScene: current || null };
            if (!result.opened) {
                result.hint = '已脱离预制体模式，但目标场景切换未确认（可重试 scene.open）';
            }
            return result;
        }
        // open-scene 可能复用内存里的脏场景（对已加载 uuid 会被忽略）：先切空场景强制干净重载
        await Editor.Message.request(SCENE, 'load-empty-scene');
        const opened = await Editor.Message.request(SCENE, 'open-scene', uuid);
        return { opened, sceneUuid: uuid };
    },
};
const sceneClose = {
    name: 'scene.close',
    title: '关闭当前场景',
    description: '关闭当前场景文档（scene/close-scene）。核心用途：外部直改过 .scene 文件后强制重开——' +
        '场景文档切走后仍驻留内存（页签缓存），scene.open 对已加载文档只会激活不会重新解析文件，' +
        '所以「激活目标场景 → scene.close 驱逐 → 改文件 → asset.import 刷新 → scene.open」才能让外部修改生效。' +
        '有未保存改动时关闭会弹「是否保存」对话框且无法自动处理，本操作先查 query-dirty，脏则直接拒绝' +
        '（先 scene.save，或确认可丢弃时传 force=true）。预制体编辑模式下 close-scene 无效，直接拒绝。',
    params: {
        force: '有未保存改动时是否仍尝试关闭（可能弹保存对话框阻塞），默认 false',
    },
    schema: {
        type: 'object',
        properties: {
            force: { type: 'boolean', description: '默认 false' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const mode = await detectPrefabMode();
        if (mode.inPrefabMode)
            throw prefabModeBlockedError(mode.prefabName, '关闭场景文档');
        let dirty = false;
        try {
            dirty = dumpValue(await Editor.Message.request(SCENE, 'query-dirty'), false) === true;
        }
        catch (e) {
            // query-dirty 不可用时按不脏处理（close-scene 自身对脏场景的行为交由编辑器）
        }
        if (dirty && (params === null || params === void 0 ? void 0 : params.force) !== true) {
            throw new Error('当前场景有未保存改动，关闭会弹「是否保存」对话框。请先 scene.save；确认可丢弃时传 force=true。');
        }
        const closed = dumpValue(await Editor.Message.request(SCENE, 'close-scene'), false);
        let current = '';
        try {
            current = dumpValue(await Editor.Message.request(SCENE, 'query-current-scene'), '') || '';
        }
        catch (e) {
            // 关闭后可能没有活动文档，query 失败属正常
        }
        return { closed, currentScene: current || null };
    },
};
const projectSetDesignResolution = {
    name: 'project.setDesignResolution',
    title: '设置项目设计分辨率',
    description: '设置项目设计分辨率（等价于 项目设置→项目 面板：Editor.Profile.setProject 持久化到 settings/v2/packages/project.json，' +
        '再发 project/change-design-resolution，scene 扩展监听该广播刷新画布）。' +
        'width/height 必填（1~8192 整数），fitWidth/fitHeight 缺省沿用当前值；返回回读值与落盘校验结果。',
    params: {
        width: '设计分辨率宽，如 720',
        height: '设计分辨率高，如 1280',
        fitWidth: '可选。是否适配宽度，缺省沿用当前值',
        fitHeight: '可选。是否适配高度，缺省沿用当前值',
    },
    schema: {
        type: 'object',
        properties: {
            width: { type: 'integer', minimum: 1, maximum: 8192, description: '设计分辨率宽，如 720' },
            height: { type: 'integer', minimum: 1, maximum: 8192, description: '设计分辨率高，如 1280' },
            fitWidth: { type: 'boolean', description: '可选。是否适配宽度，缺省沿用当前值' },
            fitHeight: { type: 'boolean', description: '可选。是否适配高度，缺省沿用当前值' },
        },
        required: ['width', 'height'],
        additionalProperties: false,
    },
    async run(params) {
        var _a, _b;
        const width = Math.round(pickNumber(params, 'width', 0));
        const height = Math.round(pickNumber(params, 'height', 0));
        if (!(width >= 1 && width <= 8192) || !(height >= 1 && height <= 8192)) {
            throw new Error(`width/height 必须是 1~8192 的整数，收到: ${JSON.stringify(params === null || params === void 0 ? void 0 : params.width)} x ${JSON.stringify(params === null || params === void 0 ? void 0 : params.height)}`);
        }
        // 当前值：官方 query-design-resolution 消息优先，取不到退回 Profile
        let current = null;
        try {
            current = await Editor.Message.request('project', 'query-design-resolution');
        }
        catch (e) {
            current = null;
        }
        if (!current || typeof current !== 'object') {
            current = await Editor.Profile.getProject('project', 'general.designResolution');
        }
        const before = {
            width: Math.round(Number(current === null || current === void 0 ? void 0 : current.width)) || 0,
            height: Math.round(Number(current === null || current === void 0 ? void 0 : current.height)) || 0,
            fitWidth: (current === null || current === void 0 ? void 0 : current.fitWidth) === true,
            fitHeight: (current === null || current === void 0 ? void 0 : current.fitHeight) === true,
        };
        const resolution = {
            width,
            height,
            fitWidth: typeof (params === null || params === void 0 ? void 0 : params.fitWidth) === 'boolean' ? params.fitWidth : before.fitWidth,
            fitHeight: typeof (params === null || params === void 0 ? void 0 : params.fitHeight) === 'boolean' ? params.fitHeight : before.fitHeight,
        };
        // 持久化（settings/v2/packages/project.json），官方 Profile API
        await Editor.Profile.setProject('project', 'general.designResolution', resolution);
        // 应用：与设置面板同一条消息，scene 扩展监听后刷新画布
        await Editor.Message.request('project', 'change-design-resolution', resolution);
        // 回读验证
        let queried = null;
        try {
            queried = await Editor.Message.request('project', 'query-design-resolution');
        }
        catch (e) {
            queried = null;
        }
        // 落盘校验（Profile 异步写盘，稍等再读，best effort）
        await sleep(500);
        let file = null;
        try {
            const raw = JSON.parse(await (0, promises_1.readFile)((0, path_1.join)(projectRoot(), 'settings', 'v2', 'packages', 'project.json'), 'utf8'));
            file = (_b = (_a = raw === null || raw === void 0 ? void 0 : raw.general) === null || _a === void 0 ? void 0 : _a.designResolution) !== null && _b !== void 0 ? _b : null;
        }
        catch (e) {
            file = null;
        }
        const persisted = !!(file &&
            Number(file.width) === width &&
            Number(file.height) === height &&
            file.fitWidth === resolution.fitWidth &&
            file.fitHeight === resolution.fitHeight);
        return { before, applied: resolution, queried, file, persisted };
    },
};
const nodeCreateComponentMsg = {
    name: 'node.createComponentMsg',
    title: '挂载组件（消息通道直通）',
    description: '直接走 scene/create-component 消息挂组件，支持自定义脚本 cid（不进引擎通道）',
    params: {
        node: '节点 uuid',
        component: '组件 cid 或类名（可以是用户脚本 cid）',
    },
    schema: {
        type: 'object',
        properties: {
            node: { type: 'string', description: '节点 uuid' },
            component: { type: 'string', description: '组件 cid 或类名' },
        },
        required: ['node', 'component'],
        additionalProperties: false,
    },
    async run(params) {
        const node = pickString(params, 'node', '').trim();
        const component = pickString(params, 'component', '').trim();
        if (!node || !component)
            throw new Error('需要 node 与 component');
        // 幂等：已有同类型组件直接返回，不重复触发 create-component（否则编辑器会打印警告）
        const compsBefore = await queryNodeComponents(node);
        const candidates = await resolveComponentCandidates(component);
        const existing = matchExistingComponent(compsBefore, candidates);
        if (existing) {
            return {
                node,
                component,
                alreadyExists: true,
                existing: { uuid: existing.uuid, type: existing.type, name: existing.name },
                components: compsBefore,
            };
        }
        await Editor.Message.request(SCENE, 'create-component', { uuid: node, component });
        const comps = await queryNodeComponents(node);
        return { node, component, components: comps };
    },
};
// ---------------------------------------------------------------- 通用批量
/**
 * 把参数里的 "$<i>.<a.b.c>" 模板替换成第 i 项执行结果里的对应值（支持对象/数组内嵌套）。
 * 两种路径写法等价：
 *   "$0.data.uuid" —— 从 results[i] 起写全（与文档示例、结果 JSON 的字面结构一致）；
 *   "$0.uuid"      —— 相对 results[i].data 的短写法。
 * 路径段支持数组下标（如 "$0.nodes[1].uuid"，对应 node.create 返回的结构化子树）。
 */
function resolveResultRefs(value, results) {
    var _a;
    if (typeof value === 'string') {
        const m = /^\$(\d+)(?:\.([\w.[\]]+))?$/.exec(value);
        if (!m)
            return value;
        const hit = results[Number(m[1])];
        if (!hit || !hit.ok)
            throw new Error(`引用 $${m[1]} 失败：该项未成功执行`);
        const segs = (m[2] || '').split('.').filter(Boolean);
        let cur = segs[0] === 'data' ? hit : hit.data;
        for (const key of segs) {
            const im = /^(.*?)\[(\d+)\]$/.exec(key);
            cur = im ? (_a = cur === null || cur === void 0 ? void 0 : cur[im[1]]) === null || _a === void 0 ? void 0 : _a[Number(im[2])] : cur === null || cur === void 0 ? void 0 : cur[key];
        }
        return cur;
    }
    if (Array.isArray(value))
        return value.map((v) => resolveResultRefs(v, results));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value))
            out[key] = resolveResultRefs(value[key], results);
        return out;
    }
    return value;
}
const batchRun = {
    name: 'batch.run',
    title: '批量执行操作',
    description: '按顺序执行一组操作，把 N 次往返合并为一次调用。' +
        '每项独立进编辑器 undo 体系（一批 = 多条 undo 记录）；stopOnError=true（默认）时遇错中止，' +
        '返回逐项结果。batch.run 不允许嵌套。' +
        '参数值支持引用前项结果：形如 "$0.data.uuid" 的字符串会替换成第 0 项 results[0].data.uuid 的值，' +
        '也可用等价短写 "$0.uuid"（路径相对 results[i].data 解析）；可嵌套在对象/数组里' +
        '（例如 node.create 之后 node.move 传 {"uuid":"$0.data.uuid"}）；路径段支持数组下标（"$0.nodes[1].uuid" 直达模板子节点）。' +
        '注意："$N" 引用仅在同一次调用内有效，跨批必须先取回真实 uuid 再引用。' +
        'node.bindProperty 的 bindings 批量为多条逐条提交、全部生效。',
    params: {
        items: '操作数组，每项形如 {"op":"node.move","params":{...}}；params 里可用 "$<i>.<路径>" 引用第 i 项结果（仅限本批）',
        stopOnError: '遇错是否中止后续操作，默认 true',
    },
    schema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                description: '操作数组',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', description: '操作名，如 node.create' },
                        params: { type: 'object', description: '该操作的参数，可用 "$i.path" 引用前项结果' },
                    },
                    required: ['op'],
                },
            },
            stopOnError: { type: 'boolean', description: '遇错是否中止，默认 true' },
        },
        required: ['items'],
        additionalProperties: false,
    },
    async run(params) {
        const items = Array.isArray(params === null || params === void 0 ? void 0 : params.items) ? params.items : [];
        if (!items.length)
            throw new Error('items 为空');
        const stopOnError = (params === null || params === void 0 ? void 0 : params.stopOnError) !== false;
        const results = [];
        let aborted = false;
        let okCount = 0;
        let failCount = 0;
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const op = item && typeof item.op === 'string' ? item.op.trim() : '';
            const start = Date.now();
            if (!op || op === 'batch.run') {
                failCount++;
                results.push({ op, ok: false, error: op ? 'batch.run 不允许嵌套' : '缺少 op', cost: 0 });
                if (stopOnError) {
                    aborted = true;
                    break;
                }
                continue;
            }
            try {
                let itemParams = (item === null || item === void 0 ? void 0 : item.params) || {};
                if (results.length && itemParams && typeof itemParams === 'object') {
                    itemParams = resolveResultRefs(itemParams, results);
                }
                const operation = registryMap[op];
                if (!operation)
                    throw new Error(`未知操作: ${op}`);
                const data = await operation.run(itemParams);
                okCount++;
                results.push({ op, ok: true, data, cost: Date.now() - start });
            }
            catch (e) {
                failCount++;
                results.push({ op, ok: false, error: String(e.message || e), cost: Date.now() - start });
                if (stopOnError) {
                    aborted = true;
                    break;
                }
            }
        }
        return { total: items.length, ok: okCount, failed: failCount, aborted, results };
    },
};
// ---------------------------------------------------------------- MCP 服务器自管理
const mcpStatus = {
    name: 'mcp.status',
    title: 'MCP 服务器状态',
    description: '查询 mcp-server 子进程运行状态：端口、pid、是否本编辑器启动、HTTP 探活结果',
    params: {},
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
        return await (0, mcp_process_1.mcpServerStatus)();
    },
};
const mcpRestart = {
    name: 'mcp.restart',
    title: '重启 MCP 服务器',
    description: '重启 mcp-server 子进程（修改 mcp-server/index.js 后让代码生效）；只接管本编辑器启动的实例',
    params: {
        port: '可选。监听端口，默认沿用当前端口（无运行实例时用上次端口，再退回 3002）',
    },
    schema: {
        type: 'object',
        properties: {
            port: { type: 'number', description: '监听端口，默认沿用当前端口' },
        },
        additionalProperties: false,
    },
    async run(params) {
        const before = await (0, mcp_process_1.mcpServerStatus)();
        const port = pickNumber(params, 'port', 0) || before.port || before.lastPort || 3002;
        if (before.running && !before.owned) {
            throw new Error(`端口 ${port} 上的 MCP Server（pid ${before.pid}）不是本编辑器启动的，无法代为重启；` +
                '请先在终端结束该进程，或换端口启动新实例。');
        }
        if (before.running && before.owned) {
            await (0, mcp_process_1.stopMcpServer)();
        }
        const state = await (0, mcp_process_1.startMcpServer)(port);
        if (!state.running) {
            throw new Error(`重启后 mcp-server 未运行，最近输出：${state.recentOutput.slice(-5).join(' | ') || '无'}`);
        }
        return Object.assign(Object.assign({}, state), { restarted: true, previousPid: before.pid });
    },
};
// ---------------------------------------------------------------- 注册表
const registry = [
    editorInfo,
    sceneStatus,
    sceneTree,
    nodeCreate,
    nodeDelete,
    nodeMove,
    nodeMoveEngine,
    nodeSetProperty,
    nodeSetPropertyEngine,
    nodeBindProperty,
    nodeCreatePrefab,
    prefabOpen,
    sceneSave,
    assetList,
    assetDelete,
    assetImport,
    batchRun,
    mcpStatus,
    mcpRestart,
    sceneScriptInfo,
    sceneScriptDemo,
    sceneCapture,
    sceneReopen,
    sceneCreate,
    sceneOpen,
    sceneClose,
    projectSetDesignResolution,
    nodeCreateComponentMsg,
    scriptCreate,
    scriptList,
    nodeAddComponent,
    nodeRemoveComponent,
    nodeListComponents,
    nodeDebug,
];
const registryMap = {};
for (const operation of registry) {
    registryMap[operation.name] = operation;
}
/** 列出所有操作（MCP tools/list 的数据源） */
function listOperations() {
    return registry.map((operation) => ({
        name: operation.name,
        title: operation.title,
        description: operation.description,
        params: operation.params,
        schema: operation.schema,
    }));
}
/** 按名字执行一个操作 */
async function runOperation(name, params = {}) {
    const operation = registryMap[name];
    if (!operation) {
        const known = registry.map((item) => item.name).join(', ');
        throw new Error(`未知操作: ${name}；可用操作: ${known}`);
    }
    return operation.run(params || {});
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlcmF0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9vcGVyYXRpb25zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBNGtGQSx3Q0FRQztBQUdELG9DQU9DO0FBOWxGRCxhQUFhO0FBQ2IsbUVBQTBDO0FBQzFDLDBDQUFrRjtBQUNsRiwrQkFBaUU7QUFFakUsNkNBQTBDO0FBQzFDLCtDQUErRTtBQUUvRTs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUVILE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQztBQUN0QixNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUM7QUFpQjVCLHdFQUF3RTtBQUV4RSw2Q0FBNkM7QUFDN0MsU0FBUyxTQUFTLENBQVUsSUFBUyxFQUFFLFFBQVc7SUFDOUMsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxTQUFTO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDekQsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQzlDLE9BQVEsSUFBcUIsQ0FBQyxLQUFLLENBQUM7SUFDeEMsQ0FBQztJQUNELE9BQU8sSUFBUyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxNQUFXLEVBQUUsR0FBVyxFQUFFLFFBQVEsR0FBRyxFQUFFO0lBQ3ZELE1BQU0sS0FBSyxHQUFHLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENBQUMsQ0FBQztJQUM1QixPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLE1BQVcsRUFBRSxHQUFXLEVBQUUsUUFBUSxHQUFHLENBQUM7SUFDdEQsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENB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UztDQUNaLENBQUM7QUFFRixNQUFNLFdBQVcsR0FBNEMsRUFBRSxDQUFDO0FBQ2hFLEtBQUssTUFBTSxTQUFTLElBQUksUUFBUSxFQUFFLENBQUM7SUFDL0IsV0FBVyxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsR0FBRyxTQUFTLENBQUM7QUFDNUMsQ0FBQztBQUVELGtDQUFrQztBQUNsQyxTQUFnQixjQUFjO0lBQzFCLE9BQU8sUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUNoQyxJQUFJLEVBQUUsU0FBUyxDQUFDLElBQUk7UUFDcEIsS0FBSyxFQUFFLFNBQVMsQ0FBQyxLQUFLO1FBQ3RCLFdBQVcsRUFBRSxTQUFTLENBQUMsV0FBVztRQUNsQyxNQUFNLEVBQUUsU0FBUyxDQUFDLE1BQU07UUFDeEIsTUFBTSxFQUFFLFNBQVMsQ0FBQyxNQUFNO0tBQzNCLENBQUMsQ0FBQyxDQUFDO0FBQ1IsQ0FBQztBQUVELGdCQUFnQjtBQUNULEtBQUssVUFBVSxZQUFZLENBQUMsSUFBWSxFQUFFLFNBQWlDLEVBQUU7SUFDaEYsTUFBTSxTQUFTLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3BDLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUNiLE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDM0QsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLElBQUksVUFBVSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFDRCxPQUFPLFNBQVMsQ0FBQyxHQUFHLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAdHMtaWdub3JlXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcbmltcG9ydCB7IGNvcHlGaWxlLCBta2RpciwgcmVhZEZpbGUsIHJlYWRkaXIsIHN0YXQsIHdyaXRlRmlsZSB9IGZyb20gJ2ZzL3Byb21pc2VzJztcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBleHRuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBKc29uU2NoZW1hLCBPcGVyYXRpb25JbmZvIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBNQUlOX0JVSUxEIH0gZnJvbSAnLi9idWlsZC1pbmZvJztcbmltcG9ydCB7IG1jcFNlcnZlclN0YXR1cywgc3RhcnRNY3BTZXJ2ZXIsIHN0b3BNY3BTZXJ2ZXIgfSBmcm9tICcuL21jcC1wcm9jZXNzJztcblxuLyoqXG4gKiDmk43kvZzlsYLvvJroh6rnoJQgTUNQIOacjeWKoeeahOWFqOmDqOiDveWKm+mDveaUtuaVm+WcqOi/memHjOOAglxuICpcbiAqIOiuvuiuoeimgeeCue+8mlxuICogMS4g5q+P5Liq5pON5L2c6YO95piv57qv5Ye95pWw5byP55qEIGFzeW5j77yM5Y+C5pWw5LiO6L+U5Zue5YC86YO95b+F6aG75piv57qvIEpTT07vvIhJUEMg6ZmQ5Yi277yJ44CCXG4gKiAyLiDmianlsZXkuLvov5vnqIvjgIHmnKzlnLAgSFRUUCDmoaXkuI4gTUNQIFNlcnZlciDotbDnmoTmmK/lkIzkuIDlpZcgb3BlcmF0aW9uc++8jFxuICogICAgTUNQIFNlcnZlciDlj6rpnIDopoHmioogdG9vbCDosIPnlKjnv7vor5HmiJAgeyBvcCwgcGFyYW1zIH0g5Y2z5Y+v44CCXG4gKiAzLiDkuKTmnaHpgJrpgZPpg73kv53nlZnvvJpcbiAqICAgIC0g57yW6L6R5Zmo5raI5oGv6YCa6YGT77yaRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAuLi4pIC8gKCdhc3NldC1kYicsIC4uLilcbiAqICAgICAg6LWw57yW6L6R5ZmoIHVuZG8gLyBkaXJ0eSDkvZPns7vvvIzkv53lrZjmnIDlj6/pnaDjgIJcbiAqICAgIC0g5Zy65pmv6ISa5pys6YCa6YGT77yaRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCAuLi4pXG4gKiAgICAgIOi/m+WFpeWcuuaZr+i/m+eoi++8jOWPr+S7peebtOaOpeeUqOW8leaTjiBBUEnjgIJcbiAqIDQuIOavj+S4quaTjeS9nOmDveW4puS4gOS7vSBKU09OIFNjaGVtYe+8jE1DUCDkvqfnm7TmjqXmi7/lroPlvZMgdG9vbCDnmoQgaW5wdXRTY2hlbWHvvIxcbiAqICAgIOi/meagt+W3peWFt+eahOWPguaVsOexu+Wei+aYr+ecn+WunuWjsOaYjueahO+8jOS4jeaYr+eMnOWHuuadpeeahOOAglxuICovXG5cbmNvbnN0IFNDRU5FID0gJ3NjZW5lJztcbmNvbnN0IEFTU0VUX0RCID0gJ2Fzc2V0LWRiJztcblxuZXhwb3J0IGludGVyZmFjZSBPcGVyYXRpb25EZWZpbml0aW9uIHtcbiAgICAvKiog5pON5L2c5ZCN77yM5b2i5aaCIHNjZW5lLnRyZWUgKi9cbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgLyoqIOS4reaWh+agh+mimCAqL1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgLyoqIOivtOaYjiAqL1xuICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgLyoqIOWPguaVsOivtOaYju+8mmtleSDkuLrlj4LmlbDlkI3vvIx2YWx1ZSDkuLrlkKvkuYkgKi9cbiAgICBwYXJhbXM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH07XG4gICAgLyoqIOWPguaVsCBKU09OIFNjaGVtYSAqL1xuICAgIHNjaGVtYTogSnNvblNjaGVtYTtcbiAgICAvKiog5omn6KGMICovXG4gICAgcnVuKHBhcmFtczogeyBba2V5OiBzdHJpbmddOiBhbnkgfSk6IFByb21pc2U8YW55Pjtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlt6Xlhbflh73mlbBcblxuLyoqIOS7jiBkdW1wIOaVsOaNrumHjOWPluWHuuecn+WunuWAvO+8mmR1bXAg5b2i5aaCIHsgdmFsdWU6IHh4eCB9ICovXG5mdW5jdGlvbiBkdW1wVmFsdWU8VCA9IGFueT4ocHJvcDogYW55LCBmYWxsYmFjazogVCk6IFQge1xuICAgIGlmIChwcm9wID09PSBudWxsIHx8IHByb3AgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xuICAgIGlmICh0eXBlb2YgcHJvcCA9PT0gJ29iamVjdCcgJiYgJ3ZhbHVlJyBpbiBwcm9wKSB7XG4gICAgICAgIHJldHVybiAocHJvcCBhcyB7IHZhbHVlOiBUIH0pLnZhbHVlO1xuICAgIH1cbiAgICByZXR1cm4gcHJvcCBhcyBUO1xufVxuXG5mdW5jdGlvbiBwaWNrU3RyaW5nKHBhcmFtczogYW55LCBrZXk6IHN0cmluZywgZmFsbGJhY2sgPSAnJyk6IHN0cmluZyB7XG4gICAgY29uc3QgdmFsdWUgPSBwYXJhbXM/LltrZXldO1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gcGlja051bWJlcihwYXJhbXM6IGFueSwga2V5OiBzdHJpbmcsIGZhbGxiYWNrID0gMCk6IG51bWJlciB7XG4gICAgY29uc3QgdmFsdWUgPSBOdW1iZXIocGFyYW1zPy5ba2V5XSk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IGZhbGxiYWNrO1xufVxuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xuXG4vKiog6aG555uu5qC555uu5b2V77yIRWRpdG9yLlByb2plY3QucGF0aO+8jOebtOi/nuaooeW8j+S4i+S7jiBkaXN0IOS9jee9ruaOqOWvvO+8iSAqL1xuZnVuY3Rpb24gcHJvamVjdFJvb3QoKTogc3RyaW5nIHtcbiAgICBjb25zdCBlZGl0b3IgPSB0eXBlb2YgRWRpdG9yICE9PSAndW5kZWZpbmVkJyA/IChFZGl0b3IgYXMgYW55KSA6IG51bGw7XG4gICAgaWYgKGVkaXRvcj8uUHJvamVjdD8ucGF0aCkgcmV0dXJuIGVkaXRvci5Qcm9qZWN0LnBhdGg7XG4gICAgcmV0dXJuIGpvaW4oX19kaXJuYW1lLCAnLi4nLCAnLi4nLCAnLi4nKTtcbn1cblxuLyoqIGRiOi8vYXNzZXRzLy4uLiDot6/lvoTovazno4Hnm5jnu53lr7not6/lvoQgKi9cbmZ1bmN0aW9uIGRiVXJsVG9BYnMoZGJVcmw6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4ocHJvamVjdFJvb3QoKSwgZGJVcmwucmVwbGFjZSgvXmRiOlxcL1xcLy8sICcnKSk7XG59XG5cbi8qKiDlkIzkuIDno4Hnm5jot6/lvoTliKTlrprvvIhXaW5kb3dzIOS4i+Wkp+Wwj+WGmeS4juWIhumalOespuS4jeaVj+aEn++8iSAqL1xuZnVuY3Rpb24gaXNTYW1lUGF0aChhOiBzdHJpbmcsIGI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHJhID0gcmVzb2x2ZShhKTtcbiAgICBjb25zdCByYiA9IHJlc29sdmUoYik7XG4gICAgcmV0dXJuIHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicgPyByYS50b0xvd2VyQ2FzZSgpID09PSByYi50b0xvd2VyQ2FzZSgpIDogcmEgPT09IHJiO1xufVxuXG4vKiog5bGC57qn566h55CG5Zmo6YeM5b2T5YmN6YCJ5Lit55qE6IqC54K5IHV1aWQg5YiX6KGoICovXG5mdW5jdGlvbiBnZXRTZWxlY3RlZE5vZGVVdWlkcygpOiBzdHJpbmdbXSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIEVkaXRvci5TZWxlY3Rpb24uZ2V0U2VsZWN0ZWQoJ25vZGUnKSB8fCBbXTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9XG59XG5cbi8qKiDku47oioLngrkgZHVtcCDph4zlj5bnu4Tku7bliJfooajvvIgzLjguOCDnmoTlrZfmrrXmmK8gY29tcG9uZW50c++8jOS4jeaYryBfX2NvbXBzX1/vvIkgKi9cbmZ1bmN0aW9uIHJlYWROb2RlQ29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gW107XG4gICAgY29uc3QgcmF3ID0gbm9kZS5jb21wb25lbnRzIHx8IG5vZGUuX19jb21wc19fIHx8IFtdO1xuICAgIHJldHVybiByYXcubWFwKChjb21wOiBhbnkpID0+IHtcbiAgICAgICAgaWYgKGNvbXAgJiYgdHlwZW9mIGNvbXAgPT09ICdvYmplY3QnICYmICd2YWx1ZScgaW4gY29tcCAmJiBjb21wLnZhbHVlICYmIHR5cGVvZiBjb21wLnZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgLy8g6ICB5qC85byP77yaeyB2YWx1ZTogeyB1dWlkLCBuYW1lLCBlbmFibGVkIH0gfVxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBjb21wLnZhbHVlO1xuICAgICAgICAgICAgcmV0dXJuIHsgdXVpZDogdmFsdWUudXVpZCB8fCAnJywgbmFtZTogdmFsdWUubmFtZSB8fCAnJywgdHlwZTogdmFsdWUudHlwZSB8fCAnJywgZW5hYmxlZDogdmFsdWUuZW5hYmxlZCwgaXNDdXN0b206ICEhY29tcC5pc0N1c3RvbSB9O1xuICAgICAgICB9XG4gICAgICAgIC8vIDMuOC44IOagvOW8j++8mnsgaXNDdXN0b20sIHR5cGUsIHZhbHVlOiA857uE5Lu2dXVpZD4gfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdXVpZDogdHlwZW9mIGNvbXA/LnZhbHVlID09PSAnc3RyaW5nJyA/IGNvbXAudmFsdWUgOiAoY29tcD8udXVpZCB8fCAnJyksXG4gICAgICAgICAgICBuYW1lOiBjb21wPy5uYW1lIHx8ICcnLFxuICAgICAgICAgICAgdHlwZTogY29tcD8udHlwZSB8fCAnJyxcbiAgICAgICAgICAgIGVuYWJsZWQ6IGNvbXA/LmVuYWJsZWQsXG4gICAgICAgICAgICBpc0N1c3RvbTogISFjb21wPy5pc0N1c3RvbSxcbiAgICAgICAgfTtcbiAgICB9KTtcbn1cblxuLyoqIOWcqOWcuuaZr+agkemHjOaMiSB1dWlkIOaJvuiKgueCuSAqL1xuZnVuY3Rpb24gZmluZE5vZGVJblRyZWUodHJlZTogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkge1xuICAgIGlmICghdHJlZSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWUudXVpZCwgJycpID09PSB1dWlkKSByZXR1cm4gdHJlZTtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mICh0cmVlLmNoaWxkcmVuIHx8IFtdKSkge1xuICAgICAgICBjb25zdCBoaXQgPSBmaW5kTm9kZUluVHJlZShjaGlsZCwgdXVpZCk7XG4gICAgICAgIGlmIChoaXQpIHJldHVybiBoaXQ7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG4vKiog6K+75Y+W5p+Q6IqC54K55b2T5YmN55qE57uE5Lu25YiX6KGo77yI6LWwIHF1ZXJ5LW5vZGUtdHJlZe+8jDMuOC44IOeahCBxdWVyeS1ub2RlIOi/lOWbniBudWxs77yJICovXG5hc3luYyBmdW5jdGlvbiBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGVVdWlkOiBzdHJpbmcpOiBQcm9taXNlPGFueVtdPiB7XG4gICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xuICAgIGNvbnN0IGZvdW5kID0gZmluZE5vZGVJblRyZWUodHJlZSwgbm9kZVV1aWQpO1xuICAgIHJldHVybiByZWFkTm9kZUNvbXBvbmVudHMoZm91bmQpO1xufVxuXG4vKipcbiAqIOaKiue7hOS7tuagh+ivhu+8iGNjLlh4eCAvIFh4eCAvIOeUqOaIt+iEmuacrCBjaWTvvInlsZXlvIDmiJDlj6/kuI7lnLrmma/moJHnu4Tku7bliJfooajmr5Tlr7nnmoTlgJnpgInlkI3jgIJcbiAqIOWcuuaZr+agkemHjCAzLjguOCDnmoQgY29tcG9uZW50c1tdLnR5cGXvvJrlhoXnva7nu4Tku7bmmK8gXCJjYy5VSVRyYW5zZm9ybVwi77yM55So5oi36ISa5pys5piv57G75ZCNIFwiU2NyZWVuRmlsbFwi44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDb21wb25lbnRDYW5kaWRhdGVzKGNvbXBvbmVudDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgIGNvbnN0IHJhdyA9IFN0cmluZyhjb21wb25lbnQgfHwgJycpLnRyaW0oKTtcbiAgICBpZiAoIXJhdykgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW3Jhd107XG5cbiAgICBsZXQgbGlzdDogYW55W10gPSBbXTtcbiAgICB0cnkge1xuICAgICAgICBsaXN0ID0gKGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1jb21wb25lbnRzJykpIHx8IFtdO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbGlzdCA9IFtdO1xuICAgIH1cbiAgICAvLyDnlKjmiLfohJrmnKzmjIkgY2lkIOWPjeafpeexu+WQjVxuICAgIGNvbnN0IGJ5Q2lkID0gbGlzdC5maW5kKChpdGVtOiBhbnkpID0+IGl0ZW0gJiYgaXRlbS5jaWQgPT09IHJhdyk7XG4gICAgaWYgKGJ5Q2lkICYmIGJ5Q2lkLm5hbWUpIGNhbmRpZGF0ZXMucHVzaChTdHJpbmcoYnlDaWQubmFtZSkpO1xuICAgIC8vIOaMieexu+WQjeWPjeafpSBjaWRcbiAgICBjb25zdCBieU5hbWUgPSBsaXN0LmZpbmQoKGl0ZW06IGFueSkgPT4gaXRlbSAmJiBpdGVtLm5hbWUgPT09IHJhdyk7XG4gICAgaWYgKGJ5TmFtZSkge1xuICAgICAgICBpZiAoYnlOYW1lLm5hbWUpIGNhbmRpZGF0ZXMucHVzaChTdHJpbmcoYnlOYW1lLm5hbWUpKTtcbiAgICAgICAgaWYgKGJ5TmFtZS5jaWQpIGNhbmRpZGF0ZXMucHVzaChTdHJpbmcoYnlOYW1lLmNpZCkpO1xuICAgIH1cblxuICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnY2MuJykpIGNhbmRpZGF0ZXMucHVzaChyYXcuc2xpY2UoMykpO1xuICAgIGVsc2UgaWYgKCFyYXcuaW5jbHVkZXMoJy4nKSkgY2FuZGlkYXRlcy5wdXNoKGBjYy4ke3Jhd31gKTtcblxuICAgIHJldHVybiBBcnJheS5mcm9tKG5ldyBTZXQoY2FuZGlkYXRlcy5maWx0ZXIoQm9vbGVhbikpKTtcbn1cblxuLyoqXG4gKiDlnKjnu4Tku7bliJfooajph4zmib7lt7LlrZjlnKjnmoTnm67moIfnu4Tku7bjgIJcbiAqIENvY29zIOS4jeWFgeiuuOWQjOS4gOiKgueCueaMguWQjOexu+Wei+e7hOS7tu+8jOmHjeWkjSBhZGQg5Lya6KKr57yW6L6R5Zmo5ouS57ud5bm25omT5Y2wXG4gKiBcIltTY2VuZV0gQ2FuJ3QgYWRkIGNvbXBvbmVudCAnY2MuVUlUcmFuc2Zvcm0nIGJlY2F1c2UgWCBhbHJlYWR5IGNvbnRhaW5zIHRoZSBzYW1lIGNvbXBvbmVudC5cIlxuICovXG5mdW5jdGlvbiBtYXRjaEV4aXN0aW5nQ29tcG9uZW50KGNvbXBzOiBhbnlbXSwgY2FuZGlkYXRlczogc3RyaW5nW10pOiBhbnkgfCBudWxsIHtcbiAgICBpZiAoIWNvbXBzIHx8ICFjb21wcy5sZW5ndGggfHwgIWNhbmRpZGF0ZXMgfHwgIWNhbmRpZGF0ZXMubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gKFxuICAgICAgICBjb21wcy5maW5kKChjb21wOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBTdHJpbmcoY29tcD8udHlwZSB8fCAnJyk7XG4gICAgICAgICAgICBjb25zdCBuYW1lID0gU3RyaW5nKGNvbXA/Lm5hbWUgfHwgJycpO1xuICAgICAgICAgICAgY29uc3QgdXVpZCA9IFN0cmluZyhjb21wPy51dWlkIHx8ICcnKTtcbiAgICAgICAgICAgIHJldHVybiBjYW5kaWRhdGVzLnNvbWUoKGMpID0+IGMgPT09IHR5cGUgfHwgYyA9PT0gbmFtZSB8fCBjID09PSB1dWlkKTtcbiAgICAgICAgfSkgfHwgbnVsbFxuICAgICk7XG59XG5cbi8qKiDmioogcXVlcnktbm9kZS10cmVlIOi/lOWbnueahOiKgueCueagkei9rOaIkOWPr+ivu+aWh+acrCAqL1xuZnVuY3Rpb24gZm9ybWF0Tm9kZVRyZWUobm9kZTogYW55LCBkZXB0aCA9IDApOiBzdHJpbmcge1xuICAgIGlmICghbm9kZSkgcmV0dXJuICcnO1xuICAgIGNvbnN0IG5hbWUgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLm5hbWUsICco5pyq5ZG95ZCNKScpO1xuICAgIGNvbnN0IHV1aWQgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLnV1aWQsICcnKTtcbiAgICBjb25zdCBhY3RpdmUgPSBkdW1wVmFsdWU8Ym9vbGVhbj4obm9kZS5hY3RpdmUsIHRydWUpO1xuICAgIGNvbnN0IGNvbXBzOiBzdHJpbmdbXSA9IHJlYWROb2RlQ29tcG9uZW50cyhub2RlKS5tYXAoKGNvbXA6IGFueSkgPT4gY29tcC50eXBlIHx8IGNvbXAubmFtZSkuZmlsdGVyKEJvb2xlYW4pO1xuXG4gICAgY29uc3QgaW5kZW50ID0gJyAgJy5yZXBlYXQoZGVwdGgpO1xuICAgIGxldCBsaW5lID0gYCR7aW5kZW50fS0gJHtuYW1lfSR7YWN0aXZlID8gJycgOiAnIFtpbmFjdGl2ZV0nfWA7XG4gICAgaWYgKHV1aWQpIGxpbmUgKz0gYCAgPCR7dXVpZH0+YDtcbiAgICBpZiAoY29tcHMubGVuZ3RoKSBsaW5lICs9IGAgIFske2NvbXBzLmpvaW4oJywgJyl9XWA7XG4gICAgY29uc3QgcG9zaXRpb24gPSBkdW1wVmFsdWU8YW55Pihub2RlLnBvc2l0aW9uLCBudWxsKTtcbiAgICBpZiAocG9zaXRpb24gJiYgdHlwZW9mIHBvc2l0aW9uID09PSAnb2JqZWN0Jykge1xuICAgICAgICBsaW5lICs9IGAgICgke3Bvc2l0aW9uLnggPz8gMH0sICR7cG9zaXRpb24ueSA/PyAwfSwgJHtwb3NpdGlvbi56ID8/IDB9KWA7XG4gICAgfVxuXG4gICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gQXJyYXkuaXNBcnJheShub2RlLmNoaWxkcmVuKSA/IG5vZGUuY2hpbGRyZW4gOiBbXTtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBmb3JtYXROb2RlVHJlZShjaGlsZCwgZGVwdGggKyAxKTtcbiAgICAgICAgaWYgKHRleHQpIGxpbmUgKz0gYFxcbiR7dGV4dH1gO1xuICAgIH1cbiAgICByZXR1cm4gbGluZTtcbn1cblxuLyoqIOe7n+iuoeiKgueCueaVsOmHj++8iOWQq+ague+8iSAqL1xuZnVuY3Rpb24gY291bnROb2Rlcyhub2RlOiBhbnkpOiBudW1iZXIge1xuICAgIGlmICghbm9kZSkgcmV0dXJuIDA7XG4gICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gQXJyYXkuaXNBcnJheShub2RlLmNoaWxkcmVuKSA/IG5vZGUuY2hpbGRyZW4gOiBbXTtcbiAgICByZXR1cm4gMSArIGNoaWxkcmVuLnJlZHVjZSgoc3VtOiBudW1iZXIsIGNoaWxkOiBhbnkpID0+IHN1bSArIGNvdW50Tm9kZXMoY2hpbGQpLCAwKTtcbn1cblxuLyoqXG4gKiDmioogcXVlcnktbm9kZS10cmVlIOeahOWtkOagkeaRiuW5s+aIkOe7k+aehOWMluaVsOe7hO+8iOeItuWcqOWJje+8ie+8jOS+myBiYXRjaC5ydW4g55qEIFwiJE4ubm9kZXNbaV0udXVpZFwiIOW8leeUqO+8jFxuICog5pu/5Luj5a+5IHN1YnRyZWUg5paH5pys5qCR55qE5q2j5YiZ6Kej5p6Q44CCXG4gKi9cbmZ1bmN0aW9uIGNvbGxlY3ROb2Rlcyhub2RlOiBhbnksIHBhcmVudFV1aWQ6IHN0cmluZyB8IG51bGwsIG91dDogYW55W10gPSBbXSk6IGFueVtdIHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBvdXQ7XG4gICAgY29uc3QgdXVpZCA9IGR1bXBWYWx1ZTxzdHJpbmc+KG5vZGUudXVpZCwgJycpO1xuICAgIG91dC5wdXNoKHtcbiAgICAgICAgbmFtZTogZHVtcFZhbHVlPHN0cmluZz4obm9kZS5uYW1lLCAnKOacquWRveWQjSknKSxcbiAgICAgICAgdXVpZCxcbiAgICAgICAgcGFyZW50OiB1dWlkID8gcGFyZW50VXVpZCA6IG51bGwsXG4gICAgICAgIGNvbXBvbmVudHM6IHJlYWROb2RlQ29tcG9uZW50cyhub2RlKVxuICAgICAgICAgICAgLm1hcCgoY29tcDogYW55KSA9PiBjb21wLnR5cGUgfHwgY29tcC5uYW1lKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICB9KTtcbiAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSBBcnJheS5pc0FycmF5KG5vZGUuY2hpbGRyZW4pID8gbm9kZS5jaGlsZHJlbiA6IFtdO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIGNvbGxlY3ROb2RlcyhjaGlsZCwgdXVpZCB8fCBudWxsLCBvdXQpO1xuICAgIHJldHVybiBvdXQ7XG59XG5cbi8qKlxuICog5Yik5pat5b2T5YmN5piv5ZCm5aSE5LqO6aKE5Yi25L2T57yW6L6R5qih5byP77yIMy44Ljgg5a6e5rWL57uT5p6E77yJ77yaXG4gKiDpooTliLbkvZPmqKHlvI/kuIsgcXVlcnktbm9kZS10cmVlIOeahOagueaYr+WMheS6huS4gOWxgueahOS4tOaXtuWcuuaZr+OAjDzpooTliLbkvZPlkI0+LXNjZW5l44CN77yMXG4gKiDlhbbpppbkuKrlrZDoioLngrnmmK/lkI3kuLogc2hvdWxkX2hpZGVfaW5faGllcmFyY2h5IOeahOaMgui9veiKgueCue+8jOWGjeW+gOS4i+aJjeaYr+mihOWItuS9k+ecn+ato+eahOagueiKgueCue+8m1xuICog5pmu6YCa5Zy65pmv55qE5qC55ZCN5bCx5piv5Zy65pmv5paH5Lu25ZCN44CB5rKh5pyJ6L+Z5bGC5YyF6KO544CCXG4gKiDor6XmqKHlvI/kuIvov5jmnInkuIDov57kuLLnm7LljLrvvJpxdWVyeS1jdXJyZW50LXNjZW5lIOi/lOWbnuWcuuaZr+mhteetviB1dWlk44CBcXVlcnktZGlydHkg5oGSIGZhbHNl44CBXG4gKiBzYXZlLXNjZW5lIOWvuemihOWItuS9k+aWh+aho+aXoOaViO+8iOi/lOWbniBudWxs77yM6L+Y5Y+v6IO96KKr44CM5piv5ZCm5L+d5a2Y44CN5a+56K+d5qGG5aC15L2P77yJ44CCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRldGVjdFByZWZhYk1vZGUoKTogUHJvbWlzZTx7IGluUHJlZmFiTW9kZTogYm9vbGVhbjsgcHJlZmFiTmFtZTogc3RyaW5nOyBzY2VuZU5hbWU6IHN0cmluZyB9PiB7XG4gICAgbGV0IHRyZWU6IGFueSA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgdHJlZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiB7IGluUHJlZmFiTW9kZTogZmFsc2UsIHByZWZhYk5hbWU6ICcnLCBzY2VuZU5hbWU6ICcnIH07XG4gICAgfVxuICAgIGNvbnN0IHNjZW5lTmFtZSA9IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWUgJiYgdHJlZS5uYW1lLCAnJyk7XG4gICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gQXJyYXkuaXNBcnJheSh0cmVlICYmIHRyZWUuY2hpbGRyZW4pID8gdHJlZS5jaGlsZHJlbiA6IFtdO1xuICAgIGNvbnN0IGZpcnN0Q2hpbGROYW1lID0gZHVtcFZhbHVlPHN0cmluZz4oY2hpbGRyZW5bMF0gJiYgY2hpbGRyZW5bMF0ubmFtZSwgJycpO1xuICAgIGNvbnN0IGluUHJlZmFiTW9kZSA9IC8tc2NlbmUkLy50ZXN0KHNjZW5lTmFtZSkgJiYgZmlyc3RDaGlsZE5hbWUgPT09ICdzaG91bGRfaGlkZV9pbl9oaWVyYXJjaHknO1xuICAgIHJldHVybiB7XG4gICAgICAgIGluUHJlZmFiTW9kZSxcbiAgICAgICAgcHJlZmFiTmFtZTogaW5QcmVmYWJNb2RlID8gc2NlbmVOYW1lLnJlcGxhY2UoLy1zY2VuZSQvLCAnJykgOiAnJyxcbiAgICAgICAgc2NlbmVOYW1lLFxuICAgIH07XG59XG5cbi8qKiDpooTliLbkvZPnvJbovpHmqKHlvI/kuIvmi5Lnu53kv53lrZgv5YiH5o2i55qE57uf5LiA5oql6ZSZ77yIZmFpbCBmYXN077yM6YG/5YWN6Z2Z6buY5aC15Zyo57yW6L6R5Zmo5by55qGG5LiK77yJICovXG5mdW5jdGlvbiBwcmVmYWJNb2RlQmxvY2tlZEVycm9yKHByZWZhYk5hbWU6IHN0cmluZywgYWN0aW9uOiBzdHJpbmcpOiBFcnJvciB7XG4gICAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICAgICAgYOW9k+WJjeWkhOS6jumihOWItuS9k+e8lui+keaooeW8j++8iCR7cHJlZmFiTmFtZX3vvInvvIzml6Dms5Uke2FjdGlvbn3jgIJgICtcbiAgICAgICAgJ+ivpeaooeW8j+S4iyBxdWVyeS1kaXJ0eSDmgZIgZmFsc2XjgIFzY2VuZS9zYXZlLXNjZW5lIOWvuemihOWItuS9k+aWh+aho+aXoOaViO+8jOWIh+aNouaWh+aho+WPr+iDveW8ueOAjOaYr+WQpuS/neWtmOOAjeWvueivneahhuS4lOaXoOazleiHquWKqOWkhOeQhuOAgicgK1xuICAgICAgICAn6K+35YWI5Zyo57yW6L6R5Zmo6YeM5L+d5a2Y5bm25YWz6Zet6aKE5Yi25L2T6aG1562+5Zue5Yiw5pmu6YCa5Zy65pmv5ZCO6YeN6K+V77yb56Gu6K6k6aKE5Yi25L2T5peg5pyq5L+d5a2Y5L+u5pS55pe25Y+v5LygIGFzc3VtZUNsZWFuPXRydWUg6Lez6L+H5pys5qOA5p+l44CCJ1xuICAgICk7XG59XG5cbi8qKlxuICog55SoIGFzc2V0LWRiL29wZW4tYXNzZXQg5YiH5o2i57yW6L6R5paH5qGj5bm26L2u6K+i56Gu6K6k77yI562J5Lu36LWE5rqQ566h55CG5Zmo5Y+M5Ye777yJ44CCXG4gKiDov5nmmK/jgIzmma7pgJrlnLrmma8g4oaSIOmihOWItuS9k+e8lui+keaooeW8j+OAjeeahOWPr+mdoOmAmumBk++8iHNjZW5lL29wZW4tc2NlbmUg5a+5IHByZWZhYiB1dWlkIOaXoOaViO+8ieOAglxuICog5oiQ5Yqf5Yik5a6a6Z2gIHF1ZXJ5LW5vZGUtdHJlZSDmoLkgdXVpZCDnm7jlr7nmiZPlvIDliY3lj5jljJbvvIjov57nu63kuKTmrKHor7vliLDmiY3nrpfnqLPlrprvvInvvJpcbiAqIOWMheijueWcuuaZryB1dWlkIOavj+asoeaJk+W8gOmDveS8mumHjeaWsOeUn+aIkO+8jOS4jeiDveeUqOOAjOetieS6juafkOS4quWbuuWumuWAvOOAjeWIpOaWreOAglxuICovXG5hc3luYyBmdW5jdGlvbiBvcGVuQXNzZXRBbmRQb2xsKFxuICAgIHV1aWQ6IHN0cmluZyxcbiAgICB0aW1lb3V0OiBudW1iZXJcbik6IFByb21pc2U8eyBvcGVuZWQ6IGJvb2xlYW47IGZyb206IHN0cmluZzsgY3VycmVudDogc3RyaW5nIH0+IHtcbiAgICBjb25zdCBiZWZvcmVUcmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgY29uc3QgZnJvbSA9IGR1bXBWYWx1ZTxzdHJpbmc+KGJlZm9yZVRyZWUgJiYgYmVmb3JlVHJlZS51dWlkLCAnJyk7XG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ29wZW4tYXNzZXQnLCB1dWlkKTtcbiAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB0aW1lb3V0O1xuICAgIGxldCBjdXJyZW50ID0gZnJvbTtcbiAgICBsZXQgc3RhYmxlID0gMDtcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xuICAgICAgICAgICAgY3VycmVudCA9IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWUgJiYgdHJlZS51dWlkLCAnJyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnQgPSAnJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCAmJiBjdXJyZW50ICE9PSBmcm9tKSB7XG4gICAgICAgICAgICBzdGFibGUgKz0gMTtcbiAgICAgICAgICAgIGlmIChzdGFibGUgPj0gMikgYnJlYWs7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzdGFibGUgPSAwO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IG9wZW5lZDogISEoY3VycmVudCAmJiBjdXJyZW50ICE9PSBmcm9tKSwgZnJvbSwgY3VycmVudCB9O1xufVxuXG4vKiog56m655qE5Y+C5pWwIHNjaGVtYSAqL1xuZnVuY3Rpb24gbm9QYXJhbXMoKTogSnNvblNjaGVtYSB7XG4gICAgcmV0dXJuIHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDmk43kvZzlrprkuYlcblxuY29uc3QgZWRpdG9ySW5mbzogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnZWRpdG9yLmluZm8nLFxuICAgIHRpdGxlOiAn57yW6L6R5ZmoIC8g6aG555uu5L+h5oGvJyxcbiAgICBkZXNjcmlwdGlvbjogJ+aJk+WNsOW9k+WJjSBDcmVhdG9yIOeJiOacrOOAgemhueebrui3r+W+hOOAgeaJqeWxleiHqui6q+S/oeaBrycsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IG5vUGFyYW1zKCksXG4gICAgYXN5bmMgcnVuKCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYnVpbGQ6IE1BSU5fQlVJTEQsXG4gICAgICAgICAgICBlZGl0b3JOYW1lOiBFZGl0b3IuQXBwLm5hbWUsXG4gICAgICAgICAgICBlZGl0b3JWZXJzaW9uOiBFZGl0b3IuQXBwLnZlcnNpb24sXG4gICAgICAgICAgICBlZGl0b3JQYXRoOiBFZGl0b3IuQXBwLnBhdGgsXG4gICAgICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgICAgIGV4dGVuc2lvbk5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICBleHRlbnNpb25WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxuICAgICAgICAgICAgbm9kZVZlcnNpb246IHByb2Nlc3MudmVyc2lvbixcbiAgICAgICAgICAgIHBsYXRmb3JtOiBgJHtwcm9jZXNzLnBsYXRmb3JtfSAke3Byb2Nlc3MuYXJjaH1gLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVN0YXR1czogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuc3RhdHVzJyxcbiAgICB0aXRsZTogJ+W9k+WJjeWcuuaZr+eKtuaAgScsXG4gICAgZGVzY3JpcHRpb246ICflnLrmma/mmK/lkKblsLHnu6ogLyDmmK/lkKbmnInmnKrkv53lrZjmlLnliqggLyDmoLnoioLngrkgLyDpgInkuK3oioLngrknLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgY29uc3QgaXNSZWFkeSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1pcy1yZWFkeScpO1xuICAgICAgICBjb25zdCBpc0RpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWRpcnR5Jyk7XG4gICAgICAgIGNvbnN0IHRyZWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpc1JlYWR5LFxuICAgICAgICAgICAgaXNEaXJ0eSxcbiAgICAgICAgICAgIHNjZW5lTmFtZTogZHVtcFZhbHVlPHN0cmluZz4odHJlZT8ubmFtZSwgJyjmnKrlkb3lkI3lnLrmma8pJyksXG4gICAgICAgICAgICBzY2VuZVV1aWQ6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/LnV1aWQsICcnKSxcbiAgICAgICAgICAgIG5vZGVDb3VudDogTWF0aC5tYXgoMCwgY291bnROb2Rlcyh0cmVlKSAtIDEpLFxuICAgICAgICAgICAgc2VsZWN0ZWROb2RlczogZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKSxcbiAgICAgICAgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVUcmVlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY2VuZS50cmVlJyxcbiAgICB0aXRsZTogJ+WcuuaZr+iKgueCueagkScsXG4gICAgZGVzY3JpcHRpb246ICfor7vlj5blvZPliY3lnLrmma/nmoTlrozmlbToioLngrnmoJHvvIjoioLngrnlkI0gLyB1dWlkIC8g57uE5Lu2IC8g5Z2Q5qCH77yJJyxcbiAgICBwYXJhbXM6IHt9LFxuICAgIHNjaGVtYTogbm9QYXJhbXMoKSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIGNvbnN0IHRyZWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzY2VuZU5hbWU6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/Lm5hbWUsICco5pyq5ZG95ZCN5Zy65pmvKScpLFxuICAgICAgICAgICAgc2NlbmVVdWlkOiBkdW1wVmFsdWU8c3RyaW5nPih0cmVlPy51dWlkLCAnJyksXG4gICAgICAgICAgICBub2RlQ291bnQ6IE1hdGgubWF4KDAsIGNvdW50Tm9kZXModHJlZSkgLSAxKSxcbiAgICAgICAgICAgIHRyZWU6IGZvcm1hdE5vZGVUcmVlKHRyZWUpLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG4vKipcbiAqIOaKiiBidWlsdGluIOefreWQjSAvIHByZWZhYiDlvJXnlKjnu5/kuIDop6PmnpDmiJDlj6/lrp7kvovljJbnmoQgcHJlZmFiIOi1hOS6p+OAglxuICogLSBidWlsdGlu77yaZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8855+t5ZCNPi5wcmVmYWLvvIzljbPnvJbovpHlmajjgIzliJvlu7rjgI3oj5zljZXlkIzmrL7lhoXnva7mqKHmnb9cbiAqIC0gcHJlZmFi77yaZGI6Ly8gdXJsIOaIliB1dWlk77yM5Lu75oSPIHByZWZhYiDotYTkuqfvvIjlkKvpobnnm67oh6rlt7HnmoTpooTliLbkvZPvvIlcbiAqIOS4pOiAhemDveS4uuepuui/lOWbniBudWxs77yIPSDmma7pgJrnqbroioLngrnmqKHlvI/vvInjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVByZWZhYkFzc2V0KGJ1aWx0aW46IHN0cmluZywgcHJlZmFiOiBzdHJpbmcpOiBQcm9taXNlPHsgdXVpZDogc3RyaW5nOyB1cmw6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0gfCBudWxsPiB7XG4gICAgaWYgKGJ1aWx0aW4gJiYgcHJlZmFiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignYnVpbHRpbiDkuI4gcHJlZmFiIOWPquiDveS6jOmAieS4gCcpO1xuICAgIH1cbiAgICBsZXQgdGFyZ2V0ID0gJyc7XG4gICAgaWYgKGJ1aWx0aW4pIHtcbiAgICAgICAgY29uc3Qgc2hvcnQgPSBidWlsdGluLnRyaW0oKS5yZXBsYWNlKC9cXC5wcmVmYWIkL2ksICcnKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCAnJyk7XG4gICAgICAgIHRhcmdldCA9IGBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyR7c2hvcnR9LnByZWZhYmA7XG4gICAgfSBlbHNlIGlmIChwcmVmYWIpIHtcbiAgICAgICAgdGFyZ2V0ID0gcHJlZmFiLnRyaW0oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgbGV0IGluZm86IGFueSA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgdGFyZ2V0KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGluZm8gPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIWluZm8gfHwgIWluZm8udXVpZCkge1xuICAgICAgICBsZXQgaGludCA9IGJ1aWx0aW4gPyAn77yb5Y+v55SoIGFzc2V0X2xpc3QocGF0dGVybj1cImRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvKiovKi5wcmVmYWJcIikg5p+l55yL5YWo6YOo5YaF572u5qih5p2/JyA6ICcnO1xuICAgICAgICBpZiAoYnVpbHRpbikge1xuICAgICAgICAgICAgLy8gMy44IOWGhee9ruaooeadv+e7neWkp+WkmuaVsOWcqCB1aS/jgIEzZC/jgIFsaWdodC8g5a2Q55uu5b2V5LiL77yM6KO455+t5ZCN5Z+65pys5LiN5a2Y5Zyo77yb5o6i5rWL5ZG95Lit5pe255u05o6l57uZ5Ye65q2j56Gu5YaZ5rOVXG4gICAgICAgICAgICBjb25zdCBzaG9ydCA9IGJ1aWx0aW4udHJpbSgpLnJlcGxhY2UoL151aVxcLy9pLCAnJyk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGRpciBvZiBbJ3VpJywgJzNkJywgJ2xpZ2h0J10pIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyR7ZGlyfS8ke3Nob3J0fS5wcmVmYWJgKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFsdCAmJiBhbHQudXVpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaGludCA9IGDvvJvor6XmqKHmnb/lnKggJHtkaXJ9LyDlrZDnm67lvZXkuIvvvIzmraPnoa7lhpnms5XmmK8gYnVpbHRpbj1cIiR7ZGlyfS8ke3Nob3J0fVwiYDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyDmjqLmtYvlpLHotKXkuI3lvbHlk43ljp/mnKznmoTmiqXplJlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLAgcHJlZmFiIOi1hOS6pzogJHt0YXJnZXR9JHtoaW50fWApO1xuICAgIH1cbiAgICBpZiAoaW5mby50eXBlICYmIGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfotYTkuqfkuI3mmK8gcHJlZmFi77yIJHtpbmZvLnR5cGV977yJOiAke2luZm8udXJsIHx8IHRhcmdldH1gKTtcbiAgICB9XG4gICAgY29uc3QgdXJsOiBzdHJpbmcgPSBpbmZvLnVybCB8fCB0YXJnZXQ7XG4gICAgcmV0dXJuIHsgdXVpZDogaW5mby51dWlkLCB1cmwsIG5hbWU6IGJhc2VuYW1lKHVybCkucmVwbGFjZSgvXFwucHJlZmFiJC9pLCAnJykgfTtcbn1cblxuY29uc3Qgbm9kZUNyZWF0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5jcmVhdGUnLFxuICAgIHRpdGxlOiAn5Yib5bu66IqC54K5JyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9jcmVhdGUtbm9kZSDliJvlu7roioLngrnvvIzotbDnvJbovpHlmaggdW5kbyDkvZPns7vjgILkuInnp43nlKjms5XvvJoxKSDpu5jorqTlu7rnqbroioLngrnvvIjnvJbovpHlmajoh6rliqjpmYTliqAgY2MuVUlUcmFuc2Zvcm3vvIzli7/ph43lpI0gYWRkQ29tcG9uZW5077yJ77ybMikgYnVpbHRpbj3lhoXnva7mqKHmnb/nn63lkI3vvIzmmKDlsITliLAgZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8855+t5ZCNPi5wcmVmYWLvvIzkuIDmraXlrp7kvovljJblrozmlbTmqKHmnb/vvIjlkKvlrZDoioLngrnkuI7pu5jorqTotYTmupDlvJXnlKjvvInvvJvluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDigJTigJRVSSDnlKggdWkvQnV0dG9u44CBdWkvTGFiZWzjgIF1aS9TcHJpdGXjgIF1aS9DYW52YXPjgIF1aS9MYXlvdXTjgIF1aS9TY3JvbGxWaWV3IOetie+8iOimgeaxguWcuuaZr+W3suaciSBDYW52YXPvvInvvIwzRCDnlKggM2QvQ3ViZeOAgTNkL1NwaGVyZe+8jOeBr+WFieeUqCBsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIzkvJrmiqXjgIzmib7kuI3liLAgcHJlZmFiIOi1hOS6p+OAje+8m+WFqOmHj+WIl+ihqOeUqCBhc3NldF9saXN0KHBhdHRlcm49XCJkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyoqLyoucHJlZmFiXCIpIOafpeivou+8mzMpIHByZWZhYj3ku7vmhI/pooTliLbkvZPvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzmiorlt7LmnIkgcHJlZmFiIOWunuS+i+WMlui/m+WcuuaZr+OAguazqOaEj++8mnBhcmVudCDlv4XpobvmmK/nnJ/lrp7oioLngrkgdXVpZO+8iOS4jeino+aekOi3r+W+hO+8ie+8jOW8leeUqOaXoOaViOaXtuiKgueCueS8muiiq+mdmem7mOW7uuWIsOWcuuaZr+ague+8iOS4jeaKpemUme+8ie+8jOaJuemHj+aQreW7uuWQjuW7uuiuruWuoeiuoeWcuuaZr+agueaYr+WQpuWHuueOsOWtpOWEv+iKgueCueOAguaooeadv+aooeW8j+i/lOWbnuWAvOWQqyBub2Rlczpbe25hbWUsdXVpZCxwYXJlbnQsY29tcG9uZW50c31dIOe7k+aehOWMluWtkOagke+8iOeItuWcqOWJjeOAgWNvbXBvbmVudHMg5piv57G75Z6L5ZCN77yJ77yMYmF0Y2gucnVuIOmHjOeUqCBcIiROLm5vZGVzW2ldLnV1aWRcIiDlvJXnlKjlrZDoioLngrnvvIzml6DpnIDop6PmnpAgc3VidHJlZSDmlofmnKwnLFxuICAgIHBhcmFtczoge1xuICAgICAgICBuYW1lOiAn6IqC54K55ZCN77yM57y655yB5pe256m66IqC54K555SoIE1DUF9Ob2Rl44CB5qih5p2/5qih5byP55So5qih5p2/5ZCN77yI5bm25oyJ54i26IqC54K555Sf5oiQ5LiN6YeN5ZCN5ZCN5a2X77yJJyxcbiAgICAgICAgcGFyZW50OiAn54i26IqC54K5IHV1aWTvvIjkuI3mlK/mjIHot6/lvoTvvIzml6DmlYjml7bpnZnpu5jlu7rliLDlnLrmma/moLnvvInvvJvnlZnnqbrliJnlu7rlnKjlnLrmma/moLnkuIvvvJvloasgQHNlbGVjdGlvbiDliJnlu7rlnKjlvZPliY3pgInkuK3oioLngrnkuIsnLFxuICAgICAgICBidWlsdGluOiAn5YaF572u5qih5p2/55+t5ZCN77yM5pig5bCE5YiwIGRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvPGJ1aWx0aW4+LnByZWZhYu+8m+W4uOeUqOaooeadv+mDveW4puWtkOebruW9leWJjee8gO+8mnVpL0J1dHRvbuOAgXVpL0xhYmVs44CBdWkvU3ByaXRl44CBdWkvQ2FudmFz44CBdWkvTGF5b3V044CBdWkvU2Nyb2xsVmlld+OAgTNkL0N1YmXjgIEzZC9TcGhlcmXjgIFsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIjpobvlhpkgdWkvQnV0dG9uIOetie+8ie+8m+S4jiBwcmVmYWIg5LqM6YCJ5LiA77yb5YWo6ZuG55SoIGFzc2V0X2xpc3QocGF0dGVybj1cImRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvKiovKi5wcmVmYWJcIikg5p+lJyxcbiAgICAgICAgcHJlZmFiOiAn5Lu75oSPIHByZWZhYiDotYTkuqfvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzlrp7kvovljJbov5vlnLrmma/vvIzkuI4gYnVpbHRpbiDkuozpgInkuIAnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueWQjScgfSxcbiAgICAgICAgICAgIHBhcmVudDoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn54i26IqC54K5IHV1aWTvvIjkuI3mlK/mjIHot6/lvoTvvIzml6DmlYjml7bpnZnpu5jlu7rliLDlnLrmma/moLnvvInvvJvnlZnnqbrliJnlu7rlnKjlnLrmma/moLnkuIvvvJvloasgQHNlbGVjdGlvbiDliJnlu7rlnKjlvZPliY3pgInkuK3oioLngrnkuIsnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGJ1aWx0aW46IHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+WGhee9ruaooeadv+efreWQje+8jOaYoOWwhOWIsCBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLzxidWlsdGluPi5wcmVmYWLvvIzluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDvvJp1aS9CdXR0b27jgIF1aS9MYWJlbOOAgXVpL1Nwcml0ZeOAgXVpL0NhbnZhc+OAgXVpL0xheW91dOOAgTNkL0N1YmXjgIFsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIjpobvlhpkgdWkvQnV0dG9uIOetie+8ie+8m+S4jiBwcmVmYWIg5LqM6YCJ5LiAJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBwcmVmYWI6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+S7u+aEjyBwcmVmYWIg6LWE5Lqn77yIZGI6Ly8gdXJsIOaIliB1dWlk77yJ77yM5a6e5L6L5YyW6L+b5Zy65pmv77yM5LiOIGJ1aWx0aW4g5LqM6YCJ5LiAJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgYnVpbHRpbiA9IHBpY2tTdHJpbmcocGFyYW1zLCAnYnVpbHRpbicsICcnKS50cmltKCk7XG4gICAgICAgIGNvbnN0IHByZWZhYiA9IHBpY2tTdHJpbmcocGFyYW1zLCAncHJlZmFiJywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3QgcmF3UGFyZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdwYXJlbnQnLCAnJykudHJpbSgpO1xuICAgICAgICBsZXQgcGFyZW50ID0gJyc7XG4gICAgICAgIGxldCBwYXJlbnRTb3VyY2UgPSAnc2NlbmUtcm9vdCc7XG5cbiAgICAgICAgaWYgKHJhd1BhcmVudCA9PT0gJ0BzZWxlY3Rpb24nKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncGFyZW50IOaMh+WumuS4uiBAc2VsZWN0aW9u77yM5L2G5b2T5YmN5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBwYXJlbnQgPSBzZWxlY3RlZFswXTtcbiAgICAgICAgICAgIHBhcmVudFNvdXJjZSA9ICdzZWxlY3Rpb24nO1xuICAgICAgICB9IGVsc2UgaWYgKHJhd1BhcmVudCkge1xuICAgICAgICAgICAgcGFyZW50ID0gcmF3UGFyZW50O1xuICAgICAgICAgICAgcGFyZW50U291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0ZW1wbGF0ZSA9IGF3YWl0IHJlc29sdmVQcmVmYWJBc3NldChidWlsdGluLCBwcmVmYWIpO1xuXG4gICAgICAgIGNvbnN0IHJhd05hbWUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25hbWUnLCAnJyk7XG4gICAgICAgIGxldCBuYW1lID0gcmF3TmFtZSB8fCAodGVtcGxhdGUgPyB0ZW1wbGF0ZS5uYW1lIDogJycpIHx8ICdNQ1BfTm9kZSc7XG4gICAgICAgIC8vIOS4jue8lui+keWZqOiPnOWNleS4gOiHtO+8muaooeadv+aooeW8j+S4i+aMieeItuiKgueCueeUn+aIkOS4jemHjeWQjeeahOWQjeWtl1xuICAgICAgICBpZiAodGVtcGxhdGUgJiYgIXJhd05hbWUgJiYgcGFyZW50KSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdnZW5lcmF0ZS1hdmFpbGFibGUtbmFtZScsIG5hbWUsIHBhcmVudCk7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBhdmFpbGFibGUgPT09ICdzdHJpbmcnICYmIGF2YWlsYWJsZSkgbmFtZSA9IGF2YWlsYWJsZTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyDor6Xmtojmga/kuI3lj6/nlKjml7bkv53mjIHljp/lkI3vvIzph43lkI3kuI3lvbHlk43liJvlu7pcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wdGlvbnM6IGFueSA9IHsgbmFtZSB9O1xuICAgICAgICBpZiAocGFyZW50KSBvcHRpb25zLnBhcmVudCA9IHBhcmVudDtcbiAgICAgICAgaWYgKHRlbXBsYXRlKSB7XG4gICAgICAgICAgICBvcHRpb25zLmFzc2V0VXVpZCA9IHRlbXBsYXRlLnV1aWQ7XG4gICAgICAgICAgICBvcHRpb25zLnNuYXBzaG90ID0gdHJ1ZTtcbiAgICAgICAgICAgIC8vIOS4jue8lui+keWZqOiPnOWNleS4gOiHtO+8mlVJIOaooeadv+imgeaxguWcuuaZr+mHjOaciSBDYW52YXPvvIhDYW52YXMg5qih5p2/5pys6Lqr6Zmk5aSW77yJXG4gICAgICAgICAgICBpZiAoYnVpbHRpbi50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ3VpLycpICYmIHRlbXBsYXRlLm5hbWUudG9Mb3dlckNhc2UoKSAhPT0gJ2NhbnZhcycpIHtcbiAgICAgICAgICAgICAgICBvcHRpb25zLmNhbnZhc1JlcXVpcmVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB1dWlkID0gJyc7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICB1dWlkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2NyZWF0ZS1ub2RlJywgb3B0aW9ucyk7XG4gICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgY29uc3QgaGludCA9IG9wdGlvbnMuY2FudmFzUmVxdWlyZWRcbiAgICAgICAgICAgICAgICA/ICfvvJt1aS8qIOaooeadv+imgeaxguWcuuaZr+WFiOaciSBDYW52YXPvvIzlj6/lhYggbm9kZV9jcmVhdGUoYnVpbHRpbj1cIkNhbnZhc1wiKSdcbiAgICAgICAgICAgICAgICA6ICcnO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtbm9kZSDlpLHotKU6ICR7ZT8ubWVzc2FnZSB8fCBlfSR7aGludH1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOS4gOasoSBxdWVyeS1ub2RlLXRyZWUg5ZCM5pe25Zue6K+757uE5Lu25YiX6KGo77yI56m66IqC54K55qih5byP55qEIGNjLlVJVHJhbnNmb3JtIOaPkOekuu+8ieS4juaooeadv+WtkOagkVxuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZE5vZGVJblRyZWUodHJlZSwgdXVpZCk7XG4gICAgICAgIGNvbnN0IGNvbXBzID0gcmVhZE5vZGVDb21wb25lbnRzKGZvdW5kKTtcbiAgICAgICAgY29uc3QgaGFzVUlUcmFuc2Zvcm0gPSBjb21wcy5zb21lKChjOiBhbnkpID0+IGMudHlwZSA9PT0gJ2NjLlVJVHJhbnNmb3JtJyk7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0geyB1dWlkLCBuYW1lLCBwYXJlbnQ6IHBhcmVudCB8fCBudWxsLCBwYXJlbnRTb3VyY2UsIGNvbXBvbmVudHM6IGNvbXBzLCBoYXNVSVRyYW5zZm9ybSB9O1xuICAgICAgICBpZiAodGVtcGxhdGUpIHtcbiAgICAgICAgICAgIHJlc3VsdC5zb3VyY2UgPSBidWlsdGluID8gJ2J1aWx0aW4tdGVtcGxhdGUnIDogJ3ByZWZhYic7XG4gICAgICAgICAgICByZXN1bHQudGVtcGxhdGUgPSB0ZW1wbGF0ZS51cmw7XG4gICAgICAgICAgICByZXN1bHQudGVtcGxhdGVVdWlkID0gdGVtcGxhdGUudXVpZDtcbiAgICAgICAgICAgIHJlc3VsdC5ub2RlQ291bnQgPSBjb3VudE5vZGVzKGZvdW5kKTtcbiAgICAgICAgICAgIHJlc3VsdC5zdWJ0cmVlID0gZm9ybWF0Tm9kZVRyZWUoZm91bmQpO1xuICAgICAgICAgICAgLy8g57uT5p6E5YyW5a2Q5qCR77yI54i25Zyo5YmN77yJ77yaYmF0Y2gucnVuIOmHjOeUqCBcIiROLm5vZGVzW2ldLnV1aWRcIiDnm7TmjqXlvJXnlKjlrZDoioLngrnvvIzkuI3lv4XmraPliJnop6PmnpAgc3VidHJlZSDmlofmnKxcbiAgICAgICAgICAgIHJlc3VsdC5ub2RlcyA9IGNvbGxlY3ROb2Rlcyhmb3VuZCwgcGFyZW50IHx8IG51bGwpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVEZWxldGU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUuZGVsZXRlJyxcbiAgICB0aXRsZTogJ+WIoOmZpOiKgueCuScsXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4cgc2NlbmUvcmVtb3ZlLW5vZGUg5Yig6Zmk6IqC54K577yM6buY6K6k5Yig6Zmk5bGC57qn566h55CG5Zmo5Lit6YCJ5Lit55qE6IqC54K5JyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgdXVpZDogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ5Yig6Zmk5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeWIoOmZpOW9k+WJjemAieS4reiKgueCuScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCByYXcgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XG4gICAgICAgIGxldCBsaXN0OiBzdHJpbmdbXSA9IHJhdy5zcGxpdCgnLCcpLm1hcCgoaXRlbSkgPT4gaXRlbS50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgbGV0IHNvdXJjZSA9ICdwYXJhbXMnO1xuICAgICAgICBpZiAoIWxpc3QubGVuZ3RoKSB7XG4gICAgICAgICAgICBsaXN0ID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcbiAgICAgICAgICAgIHNvdXJjZSA9ICdzZWxlY3Rpb24nO1xuICAgICAgICB9XG4gICAgICAgIGlmICghbGlzdC5sZW5ndGgpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3JlbW92ZS1ub2RlJywgeyB1dWlkOiBsaXN0Lmxlbmd0aCA9PT0gMSA/IGxpc3RbMF0gOiBsaXN0IH0pO1xuICAgICAgICByZXR1cm4geyByZW1vdmVkOiBsaXN0LCBzb3VyY2UgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZU1vdmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUubW92ZScsXG4gICAgdGl0bGU6ICfnp7vliqjoioLngrnvvIjmtojmga/pgJrpgZPvvIknLFxuICAgIGRlc2NyaXB0aW9uOiAn6YCa6L+HIHNjZW5lL3NldC1wcm9wZXJ0eSDkv67mlLnoioLngrkgcG9zaXRpb27vvIjotbDnvJbovpHlmaggdW5kbyDkvZPns7vvvIknLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICB4OiAneCDlnZDmoIcnLFxuICAgICAgICB5OiAneSDlnZDmoIcnLFxuICAgICAgICB6OiAneiDlnZDmoIcnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgeDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd4IOWdkOaghycgfSxcbiAgICAgICAgICAgIHk6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneSDlnZDmoIcnIH0sXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGxldCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpO1xuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIGlmICghdXVpZCkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xuICAgICAgICAgICAgeDogcGlja051bWJlcihwYXJhbXMsICd4JywgMCksXG4gICAgICAgICAgICB5OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3knLCAwKSxcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCBvayA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdzZXQtcHJvcGVydHknLCB7XG4gICAgICAgICAgICB1dWlkLFxuICAgICAgICAgICAgcGF0aDogJ3Bvc2l0aW9uJyxcbiAgICAgICAgICAgIGR1bXA6IHsgdmFsdWU6IHBvc2l0aW9uIH0sXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyB1dWlkLCBzb3VyY2UsIHBhdGg6ICdwb3NpdGlvbicsIHBvc2l0aW9uLCBhcHBsaWVkOiBvayB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlTW92ZUVuZ2luZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5tb3ZlLmVuZ2luZScsXG4gICAgdGl0bGU6ICfnp7vliqjoioLngrnvvIjlvJXmk47pgJrpgZPvvIknLFxuICAgIGRlc2NyaXB0aW9uOiAn6YCa6L+H5Zy65pmv6ISa5pys55u05o6l6LCD55So5byV5pOOIEFQSSDorr7nva4gcG9zaXRpb27vvIjkuI3ov5sgdW5kbyDkvZPns7vvvIknLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICB4OiAneCDlnZDmoIcnLFxuICAgICAgICB5OiAneSDlnZDmoIcnLFxuICAgICAgICB6OiAneiDlnZDmoIcnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgeDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd4IOWdkOaghycgfSxcbiAgICAgICAgICAgIHk6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneSDlnZDmoIcnIH0sXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGxldCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpO1xuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIGlmICghdXVpZCkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xuICAgICAgICAgICAgeDogcGlja051bWJlcihwYXJhbXMsICd4JywgMCksXG4gICAgICAgICAgICB5OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3knLCAwKSxcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgbWV0aG9kOiAnbW92ZU5vZGUnLFxuICAgICAgICAgICAgYXJnczogW3V1aWQsIHBvc2l0aW9uXSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgcG9zaXRpb24sIHNjcmlwdFJlc3VsdDogcmVzdWx0IH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVTZXRQcm9wZXJ0eTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5zZXRQcm9wZXJ0eScsXG4gICAgdGl0bGU6ICforr7nva7lsZ7mgKfvvIjmtojmga/pgJrpgZPvvIknLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn6YCa6L+HIHNjZW5lL3NldC1wcm9wZXJ0eSDorr7nva7oioLngrnmiJbnu4Tku7blsZ7mgKfvvIjotbDnvJbovpHlmaggdW5kbyDkvZPns7vvvInjgIInICtcbiAgICAgICAgJ+azqOaEj++8mnV1aWQg5b+F6aG75piv55yf5a6e6IqC54K5IHV1aWTvvIzmnKzmk43kvZzkuI3op6PmnpDoioLngrnot6/lvoTvvIjkvKDot6/lvoTkvJrpnZnpu5jml6DmlYjvvInvvJsnICtcbiAgICAgICAgJ+Wkmue7hOS7tuiKgueCueiuviBjb250ZW50U2l6ZSDlnKjmnKzpgJrpgZPkvJrpnZnpu5jlpLHotKXvvIzmlLnnlKggbm9kZV9zZXRfcHJvcGVydHlfZW5naW5l77yIe1wiX19zaXplXCI6W3csaF1977yM5bimIGFwcGxpZWQg5Zue6K+777yJ44CCJyArXG4gICAgICAgICdwYXRoIOWGmeazle+8muiKgueCueWxnuaAp+ebtOaOpeWGmeWQjeWtl++8iHBvc2l0aW9uIC8gbmFtZSAvIGFjdGl2Ze+8ie+8m+e7hOS7tuWxnuaAp+WGmSBjb21wb25lbnRzLjzntKLlvJU+LjzlsZ7mgKc+77yMJyArXG4gICAgICAgICfntKLlvJXnlKggbm9kZV9saXN0X2NvbXBvbmVudHMg5p+l77yI5aaCIGNvbXBvbmVudHMuMC5zdHJpbmfjgIFjb21wb25lbnRzLjIuY29udGVudFNpemXvvInjgIInICtcbiAgICAgICAgJ3ZhbHVlIOaYr+e6ryBKU09O77yb57uT5p6E5YyW5YC877yIe3gseSx6fS97d2lkdGgsaGVpZ2h0fS97cixnLGIsYX3vvInkvJroh6rliqjor4bliKvmiJAgY2MuVmVjMy9jYy5TaXplL2NjLkNvbG9y44CCJyArXG4gICAgICAgICflvJXnlKjnsbvlnovlsZ7mgKfvvIhAcHJvcGVydHkoTGFiZWwpIOS5i+exu++8ieS8oCB0eXBlPWNjLkxhYmVs44CBdmFsdWU9e1widXVpZFwiOlwi55uu5qCH57uE5Lu25oiW6IqC54K5dXVpZFwife+8mycgK1xuICAgICAgICAn5byV55So57uR5a6a5LyY5YWI55SoIG5vZGVfYmluZF9wcm9wZXJ0ee+8iOiHquWKqOWumuS9jee7hOS7ti/op6PmnpDnm67moIcv5om56YePL+Wbnuivu+mqjOivge+8ieOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8ie+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXG4gICAgICAgIHBhdGg6ICflsZ7mgKfot6/lvoTvvIzlpoIgcG9zaXRpb27jgIFjb21wb25lbnRzLjAuc3RyaW5nJyxcbiAgICAgICAgdmFsdWU6ICflsZ7mgKflgLzvvIjnuq8gSlNPTu+8iScsXG4gICAgICAgIHR5cGU6ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8iGNjLlZlYzMvY2MuU2l6ZS9jYy5Db2xvci9jYy5MYWJlbC9jYy5Ob2Rl4oCm77yJ77yM5LiN5Lyg5pe25oyJIHZhbHVlIOW9oueKtuiHquWKqOivhuWIqycsXG4gICAgICAgIGR1bXA6ICflj6/pgInjgILlrozmlbQgZHVtcCDlr7nosaHvvJvkvKDlhaXlkI7lv73nlaUgdmFsdWUvdHlwZe+8jOeUqOS6juWFnOW6leeJueauiuagvOW8jycsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIjkuI3mlK/mjIHot6/lvoTvvInvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXG4gICAgICAgICAgICBwYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+i3r+W+hO+8jOWmgiBwb3NpdGlvbuOAgWNvbXBvbmVudHMuMC5zdHJpbmcnIH0sXG4gICAgICAgICAgICB2YWx1ZTogeyBkZXNjcmlwdGlvbjogJ+WxnuaAp+WAvCcgfSxcbiAgICAgICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnZHVtcCDnsbvlnovlkI3vvIjlj6/pgInvvIknIH0sXG4gICAgICAgICAgICBkdW1wOiB7IHR5cGU6ICdvYmplY3QnLCBkZXNjcmlwdGlvbjogJ+WujOaVtCBkdW1wIOWvueixoe+8iOWPr+mAie+8jOWFnOW6leeUqO+8iScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsncGF0aCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGxldCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpO1xuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIGlmICghdXVpZCkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBhdGggPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3BhdGgnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIHBhdGjvvIzlpoIgcG9zaXRpb24g5oiWIGNvbXBvbmVudHMuMC5zdHJpbmcnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkdW1wOiBhbnk7XG4gICAgICAgIGlmIChwYXJhbXM/LmR1bXAgJiYgdHlwZW9mIHBhcmFtcy5kdW1wID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgZHVtcCA9IHBhcmFtcy5kdW1wO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgZXhwbGljaXRUeXBlID0gcGlja1N0cmluZyhwYXJhbXMsICd0eXBlJywgJycpLnRyaW0oKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gcGFyYW1zPy52YWx1ZTtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBleHBsaWNpdFR5cGUgfHwgZ3Vlc3NEdW1wVHlwZSh2YWx1ZSk7XG4gICAgICAgICAgICBkdW1wID0gdHlwZSA/IHsgdHlwZSwgdmFsdWUgfSA6IHsgdmFsdWUgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdzZXQtcHJvcGVydHknLCB7IHV1aWQsIHBhdGgsIGR1bXAgfSk7XG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgcGF0aCwgZHVtcCwgYXBwbGllZDogdHJ1ZSB9O1xuICAgIH0sXG59O1xuXG4vKiog5oyJIHZhbHVlIOeahOW9oueKtueMnOa1iyBkdW1wIOexu+Wei++8iOWPquiupOacgOWFuOWei+eahOS4ieenje+8jOivhuWIq+S4jeS6huWwsei/lOWbnuepuui1sOijuCB7dmFsdWV977yJICovXG5mdW5jdGlvbiBndWVzc0R1bXBUeXBlKHZhbHVlOiBhbnkpOiBzdHJpbmcge1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuICcnO1xuICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSkuc29ydCgpO1xuICAgIGNvbnN0IGFsbE51bWJlciA9IGtleXMubGVuZ3RoID4gMCAmJiBrZXlzLmV2ZXJ5KChrZXkpID0+IHR5cGVvZiAodmFsdWUgYXMgYW55KVtrZXldID09PSAnbnVtYmVyJyk7XG4gICAgaWYgKCFhbGxOdW1iZXIpIHJldHVybiAnJztcbiAgICBpZiAoa2V5cy5qb2luKCcsJykgPT09ICd4LHkseicpIHJldHVybiAnY2MuVmVjMyc7XG4gICAgaWYgKGtleXMuam9pbignLCcpID09PSAneCx5JykgcmV0dXJuICdjYy5WZWMyJztcbiAgICBpZiAoa2V5cy5qb2luKCcsJykgPT09ICdoZWlnaHQsd2lkdGgnKSByZXR1cm4gJ2NjLlNpemUnO1xuICAgIGlmIChrZXlzLmpvaW4oJywnKSA9PT0gJ2EsYixnLHInKSByZXR1cm4gJ2NjLkNvbG9yJztcbiAgICByZXR1cm4gJyc7XG59XG5cbmNvbnN0IG5vZGVTZXRQcm9wZXJ0eUVuZ2luZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5zZXRQcm9wZXJ0eS5lbmdpbmUnLFxuICAgIHRpdGxlOiAn6K6+572u5bGe5oCn77yI5byV5pOO6YCa6YGT77yJJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+mAmui/h+WcuuaZr+iEmuacrOeUqOW8leaTjiBBUEkg55u05o6l57uZ6IqC54K55oiW57uE5Lu26LWL5YC877yI5LiN6L+bIHVuZG8g5L2T57O777yM5L+d5a2Y5Zy65pmv5ZCO55Sf5pWI77yJ44CCJyArXG4gICAgICAgICdjb21wb25lbnQg55WZ56m66KGo56S66IqC54K55pys6Lqr77yb5ZCm5YiZ5Lyg57uE5Lu257G75ZCN5oiWIGNpZOOAgicgK1xuICAgICAgICAndmFsdWUg5pSv5oyB77ya5pmu6YCaIEpTT04g5YC877ybe1wiX191dWlkXCI6XCJ4eHhcIn0g57uR5a6a6IqC54K5L+e7hOS7tuW8leeUqO+8mycgK1xuICAgICAgICAne1wiX192ZWNcIjpbeCx5LHpdfSDlkJHph4/vvJt7XCJfX3NpemVcIjpbdyxoXX0g5bC65a+477ybe1wiX19jb2xvclwiOltyLGcsYixhXX0g6aKc6Imy44CCJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgdXVpZDogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu257G75ZCN5oiWIGNpZO+8iOWmgiBjYy5MYWJlbCAvIENhcmRJdGVt77yJ77yM55WZ56m66KGo56S66K6+572u6IqC54K55bGe5oCnJyxcbiAgICAgICAgcHJvcDogJ+WxnuaAp+WQje+8iOWmgiBzdHJpbmcgLyBjb2xvciAvIHRpcExhYmVsIC8gcG9zaXRpb27vvIknLFxuICAgICAgICB2YWx1ZTogJ+WxnuaAp+WAvO+8jOaUr+aMgSBfX3V1aWQgLyBfX3ZlYyAvIF9fc2l6ZSAvIF9fY29sb3Ig54m55q6K5b2i5byPJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScgfSxcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7bnsbvlkI3miJYgY2lk77yM55WZ56m66KGo56S66IqC54K55pys6LqrJyB9LFxuICAgICAgICAgICAgcHJvcDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflkI0nIH0sXG4gICAgICAgICAgICB2YWx1ZTogeyBkZXNjcmlwdGlvbjogJ+WxnuaAp+WAvCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsncHJvcCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGxldCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpO1xuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIGlmICghdXVpZCkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnY29tcG9uZW50JywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3QgcHJvcCA9IHBpY2tTdHJpbmcocGFyYW1zLCAncHJvcCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghcHJvcCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogcHJvcCcpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIG1ldGhvZDogJ3NldE5vZGVQcm9wZXJ0eScsXG4gICAgICAgICAgICBhcmdzOiBbdXVpZCwgY29tcG9uZW50LCBwcm9wLCBwYXJhbXM/LnZhbHVlXSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5vayAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIGDlvJXmk47orr7nva7lsZ7mgKflpLHotKXvvJoke3Jlc3VsdCAmJiByZXN1bHQuZXJyb3IgPyByZXN1bHQuZXJyb3IgOiAn5pyq55+l6ZSZ6K+vJ31gXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgc2NyaXB0UmVzdWx0OiByZXN1bHQgfTtcbiAgICB9LFxufTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlvJXnlKjnu5HlrppcblxuLyoqXG4gKiBxdWVyeS1jb21wb25lbnRzIOW7uueahCBjaWQg4oaUIOexu+WQjee0ouW8leOAglxuICog6IqC54K55qCR6YeM6Ieq5a6a5LmJ6ISa5pys57uE5Lu255qEIHR5cGUg5a2Y55qE5pivIGNpZO+8jOiAjCBzZXQtcHJvcGVydHkg55qEIGR1bXAudHlwZSDopoHnsbvlkI3vvIjlpoIgSXRlbUJhZGdl77yJ77yMXG4gKiDmiYDku6XopoHpnaDov5nlvKDooajnv7vor5HjgIJcbiAqL1xuaW50ZXJmYWNlIENvbXBvbmVudENsYXNzSW5kZXgge1xuICAgIGJ5Q2lkOiB7IFtjaWQ6IHN0cmluZ106IHN0cmluZyB9O1xuICAgIG5hbWVzOiBTZXQ8c3RyaW5nPjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcXVlcnlDb21wb25lbnRDbGFzc0luZGV4KCk6IFByb21pc2U8Q29tcG9uZW50Q2xhc3NJbmRleD4ge1xuICAgIGNvbnN0IGxpc3Q6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKTtcbiAgICBjb25zdCBieUNpZDogeyBbY2lkOiBzdHJpbmddOiBzdHJpbmcgfSA9IHt9O1xuICAgIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGxpc3QgfHwgW10pIHtcbiAgICAgICAgaWYgKGl0ZW0gJiYgaXRlbS5jaWQpIGJ5Q2lkW1N0cmluZyhpdGVtLmNpZCldID0gU3RyaW5nKGl0ZW0ubmFtZSB8fCAnJyk7XG4gICAgICAgIGlmIChpdGVtICYmIGl0ZW0ubmFtZSkgbmFtZXMuYWRkKFN0cmluZyhpdGVtLm5hbWUpKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgYnlDaWQsIG5hbWVzIH07XG59XG5cbi8qKiDnu4Tku7blnKggZHVtcCDph4znmoTnsbvlnovlkI3vvJrlhoXnva7nu4Tku7bmmK8gY2MuU3ByaXRl77yM6Ieq5a6a5LmJ6ISa5pys57uE5Lu25piv57G75ZCN77yI5aaCIEl0ZW1CYWRnZe+8iSAqL1xuZnVuY3Rpb24gY29tcG9uZW50RHVtcFR5cGUoY29tcDogYW55LCBjbGFzc0luZGV4OiBDb21wb25lbnRDbGFzc0luZGV4KTogc3RyaW5nIHtcbiAgICBjb25zdCByYXcgPSBTdHJpbmcoY29tcD8udHlwZSB8fCAnJykudHJpbSgpO1xuICAgIGlmIChjb21wPy5pc0N1c3RvbSkge1xuICAgICAgICByZXR1cm4gY2xhc3NJbmRleC5ieUNpZFtyYXddIHx8IHJhdztcbiAgICB9XG4gICAgcmV0dXJuIHJhdyB8fCBTdHJpbmcoY29tcD8ubmFtZSB8fCAnJykudHJpbSgpO1xufVxuXG4vKiog57uE5Lu25ZCN5a695p2+55u4562J77ya5b+955WlIGNjLiDliY3nvIDkuI7lpKflsI/lhpkgKi9cbmZ1bmN0aW9uIHNhbWVDb21wb25lbnROYW1lKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGEgPT09IGIpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHN0cmlwID0gKHM6IHN0cmluZykgPT4gKHMuc3RhcnRzV2l0aCgnY2MuJykgPyBzLnNsaWNlKDMpIDogcyk7XG4gICAgcmV0dXJuIHN0cmlwKGEpLnRvTG93ZXJDYXNlKCkgPT09IHN0cmlwKGIpLnRvTG93ZXJDYXNlKCk7XG59XG5cbi8qKiDlnKjnu4Tku7bliJfooajph4zlrprkvY3nu4Tku7bvvJrmlbDlrZfntKLlvJUgLyDnsbvlkI0gLyBjaWQgLyDnu4Tku7YgdXVpZO+8m2NhbmRpZGF0ZXM+MSDor7TmmI7mjInlkI3ljLnphY3mnInmrafkuYnvvIzlu7rorq7mlLnkvKDntKLlvJUgKi9cbmZ1bmN0aW9uIG1hdGNoQ29tcG9uZW50KFxuICAgIGNvbXBzOiBhbnlbXSxcbiAgICBzcGVjOiBzdHJpbmcsXG4gICAgY2xhc3NJbmRleDogQ29tcG9uZW50Q2xhc3NJbmRleFxuKTogeyBpbmRleDogbnVtYmVyOyBjb21wOiBhbnk7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCB7XG4gICAgY29uc3QgcyA9IFN0cmluZyhzcGVjID8/ICcnKS50cmltKCk7XG4gICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoL15cXGQrJC8udGVzdChzKSkge1xuICAgICAgICBjb25zdCBpbmRleCA9IHBhcnNlSW50KHMsIDEwKTtcbiAgICAgICAgcmV0dXJuIGNvbXBzW2luZGV4XSA/IHsgaW5kZXgsIGNvbXA6IGNvbXBzW2luZGV4XSwgY2FuZGlkYXRlczogMSB9IDogbnVsbDtcbiAgICB9XG4gICAgY29uc3QgaGl0czogeyBpbmRleDogbnVtYmVyOyBjb21wOiBhbnkgfVtdID0gW107XG4gICAgY29tcHMuZm9yRWFjaCgoY29tcDogYW55LCBpbmRleDogbnVtYmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IHR5cGVOYW1lID0gY29tcD8uaXNDdXN0b21cbiAgICAgICAgICAgID8gKGNsYXNzSW5kZXguYnlDaWRbU3RyaW5nKGNvbXAudHlwZSB8fCAnJyldIHx8IGNvbXAudHlwZSlcbiAgICAgICAgICAgIDogY29tcD8udHlwZTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgY29tcD8udXVpZCA9PT0gcyB8fFxuICAgICAgICAgICAgY29tcD8udHlwZSA9PT0gcyB8fFxuICAgICAgICAgICAgc2FtZUNvbXBvbmVudE5hbWUoU3RyaW5nKHR5cGVOYW1lIHx8ICcnKSwgcykgfHxcbiAgICAgICAgICAgIHNhbWVDb21wb25lbnROYW1lKFN0cmluZyhjb21wPy5uYW1lIHx8ICcnKSwgcylcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBoaXRzLnB1c2goeyBpbmRleCwgY29tcCB9KTtcbiAgICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiBoaXRzLmxlbmd0aCA/IHsgaW5kZXg6IGhpdHNbMF0uaW5kZXgsIGNvbXA6IGhpdHNbMF0uY29tcCwgY2FuZGlkYXRlczogaGl0cy5sZW5ndGggfSA6IG51bGw7XG59XG5cbi8qKiDnu4Tku7bliJfooajnmoTkuIDooYzmkZjopoHvvIjmiqXplJnml7bmj5DnpLrnjrDmnInnu4Tku7bnlKjvvIkgKi9cbmZ1bmN0aW9uIGRlc2NyaWJlQ29tcG9uZW50cyhjb21wczogYW55W10sIGNsYXNzSW5kZXg6IENvbXBvbmVudENsYXNzSW5kZXgpOiBzdHJpbmcge1xuICAgIHJldHVybiBjb21wc1xuICAgICAgICAubWFwKChjb21wOiBhbnksIGluZGV4OiBudW1iZXIpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBjb21wPy5pc0N1c3RvbVxuICAgICAgICAgICAgICAgID8gKGNsYXNzSW5kZXguYnlDaWRbU3RyaW5nKGNvbXAudHlwZSB8fCAnJyldIHx8IGNvbXAudHlwZSlcbiAgICAgICAgICAgICAgICA6IChjb21wPy50eXBlIHx8IGNvbXA/Lm5hbWUgfHwgJz8nKTtcbiAgICAgICAgICAgIHJldHVybiBgJHtpbmRleH06JHtuYW1lfWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCcsICcpIHx8ICco5peg57uE5Lu2KSc7XG59XG5cbmludGVyZmFjZSBUcmVlTm9kZVJlZiB7IHV1aWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IG5vZGU6IGFueTsgfVxuXG5mdW5jdGlvbiBjb2xsZWN0VHJlZU5vZGVzKG5vZGU6IGFueSwgcGFyZW50UGF0aDogc3RyaW5nLCBvdXQ6IFRyZWVOb2RlUmVmW10pOiB2b2lkIHtcbiAgICBpZiAoIW5vZGUpIHJldHVybjtcbiAgICBjb25zdCBuYW1lID0gZHVtcFZhbHVlPHN0cmluZz4obm9kZS5uYW1lLCAnJyk7XG4gICAgY29uc3QgdXVpZCA9IGR1bXBWYWx1ZTxzdHJpbmc+KG5vZGUudXVpZCwgJycpO1xuICAgIGNvbnN0IHBhdGggPSBwYXJlbnRQYXRoID8gYCR7cGFyZW50UGF0aH0vJHtuYW1lfWAgOiBuYW1lO1xuICAgIG91dC5wdXNoKHsgdXVpZCwgbmFtZSwgcGF0aCwgbm9kZSB9KTtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIChub2RlLmNoaWxkcmVuIHx8IFtdKSkgY29sbGVjdFRyZWVOb2RlcyhjaGlsZCwgcGF0aCwgb3V0KTtcbn1cblxuLyoqIOiKgueCueWumuS9je+8mnV1aWQg4oaSIOWujOaVtOi3r+W+hCDihpIg6Lev5b6E5ZCO57yAIOKGkiDoioLngrnlkI3vvIhwcmVmYWIg57yW6L6R5qih5byP5LiL5ZCM5qC36YCC55So77yM6Lev5b6E5Lul57yW6L6R5Lit55qE5qC55Li66LW354K577yJICovXG5mdW5jdGlvbiByZXNvbHZlTm9kZVJlZih0cmVlOiBhbnksIHNwZWM6IHN0cmluZyk6IHsgcmVmOiBUcmVlTm9kZVJlZjsgaG93OiBzdHJpbmc7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCB7XG4gICAgY29uc3QgcyA9IFN0cmluZyhzcGVjIHx8ICcnKS50cmltKCk7XG4gICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBhbGw6IFRyZWVOb2RlUmVmW10gPSBbXTtcbiAgICBjb2xsZWN0VHJlZU5vZGVzKHRyZWUsICcnLCBhbGwpO1xuICAgIGNvbnN0IGV4YWN0ID0gYWxsLmZpbmQoKGl0ZW0pID0+IGl0ZW0udXVpZCA9PT0gcyk7XG4gICAgaWYgKGV4YWN0KSByZXR1cm4geyByZWY6IGV4YWN0LCBob3c6ICd1dWlkJywgY2FuZGlkYXRlczogMSB9O1xuICAgIGNvbnN0IGJ5UGF0aCA9IGFsbC5maW5kKChpdGVtKSA9PiBpdGVtLnBhdGggPT09IHMpO1xuICAgIGlmIChieVBhdGgpIHJldHVybiB7IHJlZjogYnlQYXRoLCBob3c6ICdwYXRoJywgY2FuZGlkYXRlczogMSB9O1xuICAgIGNvbnN0IGJ5U3VmZml4ID0gYWxsLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5wYXRoLmVuZHNXaXRoKGAvJHtzfWApKTtcbiAgICBpZiAoYnlTdWZmaXgubGVuZ3RoKSByZXR1cm4geyByZWY6IGJ5U3VmZml4WzBdLCBob3c6ICdwYXRoLXN1ZmZpeCcsIGNhbmRpZGF0ZXM6IGJ5U3VmZml4Lmxlbmd0aCB9O1xuICAgIGNvbnN0IGJ5TmFtZSA9IGFsbC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0ubmFtZSA9PT0gcyk7XG4gICAgaWYgKGJ5TmFtZS5sZW5ndGgpIHJldHVybiB7IHJlZjogYnlOYW1lWzBdLCBob3c6ICduYW1lJywgY2FuZGlkYXRlczogYnlOYW1lLmxlbmd0aCB9O1xuICAgIHJldHVybiBudWxsO1xufVxuXG4vKiog6LWE5Lqn55uu5qCH77yaZGI6Ly8g6Lev5b6EIOKGkiB1dWlkICsg57G75Z6L77yb5a2Q6LWE5Lqn77yIeHgucG5nL3Nwcml0ZUZyYW1l77yJ6L+U5Zue5a2Q6LWE5Lqn6Ieq5bex55qEIHV1aWQg5LiO57G75Z6L77yI5aaCIGNjLlNwcml0ZUZyYW1l77yJICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQXNzZXRUYXJnZXQoXG4gICAgdXJsOiBzdHJpbmcsXG4gICAgZXhwbGljaXRUeXBlOiBzdHJpbmdcbik6IFByb21pc2U8eyBkdW1wVHlwZTogc3RyaW5nOyB2YWx1ZVV1aWQ6IHN0cmluZyB8IG51bGw7IGRlc2M6IHN0cmluZyB9PiB7XG4gICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IHVybCB9KTtcbiAgICBjb25zdCBoaXQgPSAoYXNzZXRzIHx8IFtdKS5maW5kKChhc3NldDogYW55KSA9PiBhc3NldC51cmwgPT09IHVybCkgfHwgKGFzc2V0cyB8fCBbXSlbMF07XG4gICAgaWYgKCFoaXQgfHwgIWhpdC51dWlkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5om+5LiN5Yiw6LWE5LqnOiAke3VybH3vvIjotLTlm77lvJXnlKjopoHlhpnliLDlrZDotYTkuqfvvIzlpoIgZGI6Ly9hc3NldHMvLi4uL3h4LnBuZy9zcHJpdGVGcmFtZe+8iWApO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgICBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8IFN0cmluZyhoaXQudHlwZSB8fCAnJyksXG4gICAgICAgIHZhbHVlVXVpZDogU3RyaW5nKGhpdC51dWlkKSxcbiAgICAgICAgZGVzYzogYOi1hOS6pyAke2hpdC51cmx9YCxcbiAgICB9O1xufVxuXG4vKiog6Kej5p6Q57uR5a6a55uu5qCHIOKGkiBkdW1wIOexu+Wei+WQjSArIOebruaghyB1dWlk77yIbnVsbCDooajnpLrop6Pnu5HvvIkgKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCaW5kVGFyZ2V0KFxuICAgIHRyZWU6IGFueSxcbiAgICBjbGFzc0luZGV4OiBDb21wb25lbnRDbGFzc0luZGV4LFxuICAgIHRhcmdldDogYW55LFxuICAgIGV4cGxpY2l0VHlwZTogc3RyaW5nXG4pOiBQcm9taXNlPHsgZHVtcFR5cGU6IHN0cmluZzsgdmFsdWVVdWlkOiBzdHJpbmcgfCBudWxsOyBkZXNjOiBzdHJpbmcgfT4ge1xuICAgIGlmICh0YXJnZXQgPT09IG51bGwgfHwgdGFyZ2V0ID09PSB1bmRlZmluZWQgfHwgdGFyZ2V0ID09PSAnbnVsbCcgfHwgdGFyZ2V0ID09PSAnJykge1xuICAgICAgICByZXR1cm4geyBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8ICcnLCB2YWx1ZVV1aWQ6IG51bGwsIGRlc2M6ICfop6Pnu5HvvIhudWxs77yJJyB9O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHRhcmdldCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKHRhcmdldC5zdGFydHNXaXRoKCdkYjovLycpKSByZXR1cm4gcmVzb2x2ZUFzc2V0VGFyZ2V0KHRhcmdldCwgZXhwbGljaXRUeXBlKTtcbiAgICAgICAgcmV0dXJuIHsgZHVtcFR5cGU6IGV4cGxpY2l0VHlwZSB8fCAnJywgdmFsdWVVdWlkOiB0YXJnZXQsIGRlc2M6IGB1dWlkOiR7dGFyZ2V0fWAgfTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0YXJnZXQgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gcGlja1N0cmluZyh0YXJnZXQsICdhc3NldCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmIChhc3NldCkgcmV0dXJuIHJlc29sdmVBc3NldFRhcmdldChhc3NldCwgZXhwbGljaXRUeXBlKTtcbiAgICAgICAgY29uc3QgcmF3VXVpZCA9IHBpY2tTdHJpbmcodGFyZ2V0LCAndXVpZCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmIChyYXdVdWlkKSByZXR1cm4geyBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8ICcnLCB2YWx1ZVV1aWQ6IHJhd1V1aWQsIGRlc2M6IGB1dWlkOiR7cmF3VXVpZH1gIH07XG4gICAgICAgIGNvbnN0IG5vZGVTcGVjID0gcGlja1N0cmluZyh0YXJnZXQsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKG5vZGVTcGVjKSB7XG4gICAgICAgICAgICBjb25zdCBub2RlSGl0ID0gcmVzb2x2ZU5vZGVSZWYodHJlZSwgbm9kZVNwZWMpO1xuICAgICAgICAgICAgaWYgKCFub2RlSGl0KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGB0YXJnZXQubm9kZSDmib7kuI3liLDoioLngrk6ICR7bm9kZVNwZWN977yI5Y+v55SoIHV1aWQg5oiWIOi3r+W+hO+8jOWmgiBQYW5uZWwvYmFkZ2XvvIlgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGNvbXBTcGVjID0gdGFyZ2V0LmNvbXBvbmVudDtcbiAgICAgICAgICAgIGNvbnN0IGNvbXBUZXh0ID0gY29tcFNwZWMgPT09IHVuZGVmaW5lZCB8fCBjb21wU3BlYyA9PT0gbnVsbCA/ICcnIDogU3RyaW5nKGNvbXBTcGVjKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIWNvbXBUZXh0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgZHVtcFR5cGU6IGV4cGxpY2l0VHlwZSB8fCAnY2MuTm9kZScsXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlVXVpZDogbm9kZUhpdC5yZWYudXVpZCxcbiAgICAgICAgICAgICAgICAgICAgZGVzYzogYOiKgueCuSAke25vZGVIaXQucmVmLnBhdGh9YCxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgY29tcHMgPSByZWFkTm9kZUNvbXBvbmVudHMobm9kZUhpdC5yZWYubm9kZSk7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVkID0gbWF0Y2hDb21wb25lbnQoY29tcHMsIGNvbXBUZXh0LCBjbGFzc0luZGV4KTtcbiAgICAgICAgICAgIGlmICghbWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYHRhcmdldC5jb21wb25lbnQg5Zyo6IqC54K5ICR7bm9kZUhpdC5yZWYucGF0aH0g5LiK5om+5LiN5Yiw44CMJHtjb21wVGV4dH3jgI3vvIznjrDmnIk6ICR7ZGVzY3JpYmVDb21wb25lbnRzKGNvbXBzLCBjbGFzc0luZGV4KX1gXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHR5cGVOYW1lID0gY29tcG9uZW50RHVtcFR5cGUobWF0Y2hlZC5jb21wLCBjbGFzc0luZGV4KTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgZHVtcFR5cGU6IGV4cGxpY2l0VHlwZSB8fCB0eXBlTmFtZSxcbiAgICAgICAgICAgICAgICB2YWx1ZVV1aWQ6IFN0cmluZyhtYXRjaGVkLmNvbXAudXVpZCB8fCAnJyksXG4gICAgICAgICAgICAgICAgZGVzYzogYOe7hOS7tiAke3R5cGVOYW1lIHx8IGNvbXBUZXh0fSBAICR7bm9kZUhpdC5yZWYucGF0aH1gLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3RhcmdldCDlv4XpobvmmK8ge25vZGUsIGNvbXBvbmVudH0gLyB7bm9kZX0gLyB7YXNzZXR9IC8ge3V1aWR9IC8gbnVsbCcpO1xufVxuXG5jb25zdCBub2RlQmluZFByb3BlcnR5OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmJpbmRQcm9wZXJ0eScsXG4gICAgdGl0bGU6ICfnu5HlrprlvJXnlKjlsZ7mgKcnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn57uZ57uE5Lu257uR5a6a5byV55So57G75Z6L5bGe5oCn77yIQHByb3BlcnR5KExhYmVsL1Nwcml0ZS/oh6rlrprkuYnohJrmnKwvTm9kZS9TcHJpdGVGcmFtZeKApinvvInvvIwnICtcbiAgICAgICAgJ+i1sCBzY2VuZS9zZXQtcHJvcGVydHkg5raI5oGv6YCa6YGT77yI6L+bIHVuZG8g5L2T57O744CB5Y+v5L+d5a2Y6L+bIHByZWZhYi9zY2VuZe+8ie+8jOS4juWxnuaAp+ajgOafpeWZqOaLluaLvee7keWumuWujOWFqOetieS7t++8jCcgK1xuICAgICAgICAn5pSv5oyB5bWM5aWXIHByZWZhYiDlrp7kvovlhoXpg6jnmoTnu4Tku7bvvIjoh6rliqjnlJ/miJAgdGFyZ2V0T3ZlcnJpZGVzIOW6j+WIl+WMluiQveebmO+8ieOAgicgK1xuICAgICAgICAn5Y2V5p2h5Y+C5pWw77yadXVpZO+8iOWxnuaAp+aJgOWcqOiKgueCue+8jHV1aWQg5oiW6Lev5b6E77yM55WZ56m6PeW9k+WJjemAieS4reiKgueCue+8ieOAgWNvbXBvbmVudO+8iOe0ouW8lS/nsbvlkI0vY2lk77yJ44CBcHJvcGVydHnvvIjlsZ7mgKflkI3vvInjgIF0YXJnZXQg4oCU4oCUICcgK1xuICAgICAgICAne1wibm9kZVwiOlwiUGFubmVsL2JhZGdlXCIsXCJjb21wb25lbnRcIjpcIkl0ZW1CYWRnZVwifSDnu4Tku7blvJXnlKjvvIjmjqjojZDvvIzoh6rliqjop6PmnpDnm67moIcgdXVpZCDkuI4gZHVtcCDnsbvlnovvvIzltYzlpZcgcHJlZmFiIOWGheeahOe7hOS7tuS5n+iDveWumuS9je+8ie+8mycgK1xuICAgICAgICAne1wibm9kZVwiOlwi6Lev5b6E5oiWdXVpZFwifSDoioLngrnlvJXnlKjvvIhjYy5Ob2Rl77yJ77ybe1wiYXNzZXRcIjpcImRiOi8vYXNzZXRzL3gucG5nL3Nwcml0ZUZyYW1lXCJ9IOi1hOS6p+W8leeUqO+8m251bGwg6Kej57uR44CCJyArXG4gICAgICAgICd0YXJnZXQg5Lmf5Y+v55u05o6l5LygIHV1aWQg5a2X56ym5Liy77yI5q2k5pe25bu66K6u5pi+5byP5LygIHR5cGXvvInjgIInICtcbiAgICAgICAgJ+aJuemHj++8mmJpbmRpbmdzPVt7dXVpZCxjb21wb25lbnQscHJvcGVydHksdGFyZ2V0fSzigKZdIOWkmuadoemAkOadoeaPkOS6pOOAgeWFqOmDqOWbnuivu+mqjOivge+8mycgK1xuICAgICAgICAn57uR5a6a5ZCO6Ieq5Yqo5Zue6K+75Zy65pmv5a6e6ZmF5byV55So6aqM6K+B77yM5LiN5LiA6Ie05Lya5oql6ZSZ44CCJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgdXVpZDogJ+WxnuaAp+aJgOWcqOiKgueCue+8mnV1aWQg5oiW6IqC54K56Lev5b6E77yM55WZ56m655So5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu25a6a5L2N77ya57Si5byV5pWw5a2XIC8g57G75ZCN77yIY2MuTGFiZWzjgIFJdGVtQmFkZ2XvvIkvIGNpZCcsXG4gICAgICAgIHByb3BlcnR5OiAn5bGe5oCn5ZCN77yM5aaCIGJhZGdl44CBdGlwTGFiZWzjgIFzcHJpdGVGcmFtZScsXG4gICAgICAgIHRhcmdldDogJ+e7keWumuebruagh++8mntub2RlLGNvbXBvbmVudH0g57uE5Lu25byV55SoIHwge25vZGV9IOiKgueCueW8leeUqCB8IHthc3NldDpcImRiOi8v4oCmXCJ9IOi1hOS6pyB8IHV1aWQg5a2X56ym5LiyIHwgbnVsbCDop6Pnu5EnLFxuICAgICAgICB0eXBlOiAn5Y+v6YCJ44CCZHVtcCDnsbvlnovlkI3vvIjpu5jorqToh6rliqjmjqjmlq3vvJrnu4Tku7bihpLnsbvlkI3jgIHoioLngrnihpJjYy5Ob2Rl44CB6LWE5Lqn4oaS6LWE5rqQ57G75Z6L77yJJyxcbiAgICAgICAgcGF0aDogJ+WPr+mAieOAguWOn+Wni+WxnuaAp+i3r+W+hO+8iOWmgiBfX2NvbXBzX18uMS5iYWRnZe+8ie+8jOS8oOS6huWwsei3s+i/hyBjb21wb25lbnQvcHJvcGVydHkg5ou86KOFJyxcbiAgICAgICAgYmluZGluZ3M6ICfmibnph4/nu5HlrprmlbDnu4TvvIzmr4/pobkge3V1aWQsY29tcG9uZW50LHByb3BlcnR5LHRhcmdldFssdHlwZV1977yM5LiO5Y2V5p2h5Y+C5pWw5LqM6YCJ5LiA77yb5aSa5p2h5YWo6YOo55Sf5pWI5bm26YCQ5p2h5Zue6K+76aqM6K+BJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKfmiYDlnKjoioLngrnvvJp1dWlkIOaIluiKgueCuei3r+W+hO+8jOeVmeepuueUqOW9k+WJjemAieS4reiKgueCuScgfSxcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7blrprkvY3vvJrntKLlvJXmlbDlrZcgLyDnsbvlkI3vvIhjYy5MYWJlbOOAgUl0ZW1CYWRnZe+8iS8gY2lkJyB9LFxuICAgICAgICAgICAgcHJvcGVydHk6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn5ZCN77yM5aaCIGJhZGdl44CBdGlwTGFiZWzjgIFzcHJpdGVGcmFtZScgfSxcbiAgICAgICAgICAgIHRhcmdldDoge1xuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICAgICAgICAgICAn57uR5a6a55uu5qCH77yae25vZGUsY29tcG9uZW50fSDnu4Tku7blvJXnlKggfCB7bm9kZX0g6IqC54K55byV55SoIHwge2Fzc2V0OlwiZGI6Ly/igKZcIn0g6LWE5LqnIHwgdXVpZCDlrZfnrKbkuLIgfCBudWxsIOino+e7kScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgdHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8jOm7mOiupOiHquWKqOaOqOaWrScgfSxcbiAgICAgICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Y+v6YCJ44CC5Y6f5aeL5bGe5oCn6Lev5b6E77yI5aaCIF9fY29tcHNfXy4xLmJhZGdl77yJ77yM6Lez6L+HIGNvbXBvbmVudC9wcm9wZXJ0eSDmi7zoo4UnIH0sXG4gICAgICAgICAgICBiaW5kaW5nczoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdhcnJheScsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICfmibnph4/nu5HlrprvvJrmr4/pobkge3V1aWQsIGNvbXBvbmVudCwgcHJvcGVydHksIHRhcmdldFssIHR5cGVdfe+8jOS4juWNleadoeWPguaVsOS6jOmAieS4gO+8m+WkmuadoeWFqOmDqOeUn+aViOW5tumAkOadoeWbnuivu+mqjOivgScsXG4gICAgICAgICAgICAgICAgaXRlbXM6IHsgdHlwZTogJ29iamVjdCcgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3Qgc3BlY3M6IGFueVtdID0gQXJyYXkuaXNBcnJheShwYXJhbXM/LmJpbmRpbmdzKSA/IHBhcmFtcy5iaW5kaW5ncyA6IFtwYXJhbXNdO1xuICAgICAgICBpZiAoIXNwZWNzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInlj6/miafooYznmoTnu5HlrprvvIhiaW5kaW5ncyDkuLrnqbrvvIknKTtcblxuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIGlmICghdHJlZSkgdGhyb3cgbmV3IEVycm9yKCflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma8nKTtcbiAgICAgICAgY29uc3QgY2xhc3NJbmRleCA9IGF3YWl0IHF1ZXJ5Q29tcG9uZW50Q2xhc3NJbmRleCgpO1xuXG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IFtdO1xuICAgICAgICBjb25zdCBwbGFuczogYW55W10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBzcGVjIG9mIHNwZWNzKSB7XG4gICAgICAgICAgICAvLyAxKSDlsZ7mgKfmiYDlnKjoioLngrlcbiAgICAgICAgICAgIGNvbnN0IG5vZGVTcGVjID0gcGlja1N0cmluZyhzcGVjLCAndXVpZCcsICcnKS50cmltKCk7XG4gICAgICAgICAgICBsZXQgbm9kZUhpdDogeyByZWY6IFRyZWVOb2RlUmVmOyBob3c6IHN0cmluZzsgY2FuZGlkYXRlczogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgICAgICAgICAgIGlmICghbm9kZVNwZWMgfHwgbm9kZVNwZWMgPT09ICdAc2VsZWN0aW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcbiAgICAgICAgICAgICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrpogdXVpZO+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICAgICAgICAgIG5vZGVIaXQgPSByZXNvbHZlTm9kZVJlZih0cmVlLCBzZWxlY3RlZFswXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5vZGVIaXQgPSByZXNvbHZlTm9kZVJlZih0cmVlLCBub2RlU3BlYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIW5vZGVIaXQpIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5qCR6YeM5om+5LiN5Yiw6IqC54K5OiAke25vZGVTcGVjIHx8ICco6YCJ5Lit6IqC54K5KSd9YCk7XG5cbiAgICAgICAgICAgIC8vIDIpIOe7hOS7tuS4juWxnuaAp+i3r+W+hO+8iGR1bXAg6Lev5b6E57uf5LiA55SoIF9fY29tcHNfXyDliY3nvIDvvIzkuI7lsZ7mgKfmo4Dmn6Xlmajlj5Hlh7rnmoTmtojmga/kuIDoh7TvvIlcbiAgICAgICAgICAgIGNvbnN0IHJhd1BhdGggPSBwaWNrU3RyaW5nKHNwZWMsICdwYXRoJywgJycpLnRyaW0oKTtcbiAgICAgICAgICAgIGxldCBwYXRoID0gcmF3UGF0aFxuICAgICAgICAgICAgICAgID8gKHJhd1BhdGguc3RhcnRzV2l0aCgnY29tcG9uZW50cy4nKSA/IGBfX2NvbXBzX18uJHtyYXdQYXRoLnNsaWNlKCdjb21wb25lbnRzLicubGVuZ3RoKX1gIDogcmF3UGF0aClcbiAgICAgICAgICAgICAgICA6ICcnO1xuICAgICAgICAgICAgbGV0IHZlcmlmeUluZGV4ID0gJyc7XG4gICAgICAgICAgICBsZXQgdmVyaWZ5UHJvcCA9ICcnO1xuICAgICAgICAgICAgbGV0IG1hdGNoZWQ6IHsgaW5kZXg6IG51bWJlcjsgY29tcDogYW55OyBjYW5kaWRhdGVzOiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgaWYgKCFwYXRoKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvcGVydHkgPSBwaWNrU3RyaW5nKHNwZWMsICdwcm9wZXJ0eScsICcnKS50cmltKCk7XG4gICAgICAgICAgICAgICAgaWYgKCFwcm9wZXJ0eSkgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogcHJvcGVydHnvvIjmiJbljp/lp4sgcGF0aO+8ie+8jOWmgiBiYWRnZSAvIHNwcml0ZUZyYW1lJyk7XG4gICAgICAgICAgICAgICAgY29uc3QgY29tcFNwZWMgPSBzcGVjPy5jb21wb25lbnQ7XG4gICAgICAgICAgICAgICAgY29uc3QgY29tcFRleHQgPSBjb21wU3BlYyA9PT0gdW5kZWZpbmVkIHx8IGNvbXBTcGVjID09PSBudWxsID8gJycgOiBTdHJpbmcoY29tcFNwZWMpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICBpZiAoY29tcFRleHQgJiYgY29tcFRleHQgIT09ICdub2RlJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb21wcyA9IHJlYWROb2RlQ29tcG9uZW50cyhub2RlSGl0LnJlZi5ub2RlKTtcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2hlZCA9IG1hdGNoQ29tcG9uZW50KGNvbXBzLCBjb21wVGV4dCwgY2xhc3NJbmRleCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrkgJHtub2RlSGl0LnJlZi5wYXRofSDkuIrmib7kuI3liLDnu4Tku7bjgIwke2NvbXBUZXh0feOAje+8jOeOsOaciTogJHtkZXNjcmliZUNvbXBvbmVudHMoY29tcHMsIGNsYXNzSW5kZXgpfWBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcGF0aCA9IGBfX2NvbXBzX18uJHttYXRjaGVkLmluZGV4fS4ke3Byb3BlcnR5fWA7XG4gICAgICAgICAgICAgICAgICAgIHZlcmlmeUluZGV4ID0gU3RyaW5nKG1hdGNoZWQuaW5kZXgpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHBhdGggPSBwcm9wZXJ0eTsgLy8g6IqC54K557qn5bGe5oCn77yI5bCR6KeB77yJXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZlcmlmeVByb3AgPSBwcm9wZXJ0eTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbSA9IC9eX19jb21wc19fXFwuKFxcZCspXFwuKC4rKSQvLmV4ZWMocGF0aCk7XG4gICAgICAgICAgICAgICAgaWYgKG0pIHtcbiAgICAgICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXggPSBtWzFdO1xuICAgICAgICAgICAgICAgICAgICB2ZXJpZnlQcm9wID0gbVsyXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIDMpIOebruaghyDihpIgZHVtcFxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0SW5mbyA9IGF3YWl0IHJlc29sdmVCaW5kVGFyZ2V0KFxuICAgICAgICAgICAgICAgIHRyZWUsXG4gICAgICAgICAgICAgICAgY2xhc3NJbmRleCxcbiAgICAgICAgICAgICAgICBzcGVjPy50YXJnZXQsXG4gICAgICAgICAgICAgICAgcGlja1N0cmluZyhzcGVjLCAndHlwZScsICcnKS50cmltKClcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjb25zdCBkdW1wID0gdGFyZ2V0SW5mby52YWx1ZVV1aWQgPT09IG51bGxcbiAgICAgICAgICAgICAgICA/ICh0YXJnZXRJbmZvLmR1bXBUeXBlID8geyB0eXBlOiB0YXJnZXRJbmZvLmR1bXBUeXBlLCB2YWx1ZTogbnVsbCB9IDogeyB2YWx1ZTogbnVsbCB9KVxuICAgICAgICAgICAgICAgIDogeyB0eXBlOiB0YXJnZXRJbmZvLmR1bXBUeXBlLCB2YWx1ZTogeyB1dWlkOiB0YXJnZXRJbmZvLnZhbHVlVXVpZCB9IH07XG5cbiAgICAgICAgICAgIGl0ZW1zLnB1c2goeyB1dWlkOiBub2RlSGl0LnJlZi51dWlkLCBwYXRoLCBkdW1wIH0pO1xuICAgICAgICAgICAgcGxhbnMucHVzaCh7XG4gICAgICAgICAgICAgICAgdXVpZDogbm9kZUhpdC5yZWYudXVpZCxcbiAgICAgICAgICAgICAgICBub2RlTmFtZTogbm9kZUhpdC5yZWYubmFtZSxcbiAgICAgICAgICAgICAgICBub2RlUGF0aDogbm9kZUhpdC5yZWYucGF0aCxcbiAgICAgICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgICAgIGNvbXBvbmVudDogbWF0Y2hlZFxuICAgICAgICAgICAgICAgICAgICA/IGAke2NvbXBvbmVudER1bXBUeXBlKG1hdGNoZWQuY29tcCwgY2xhc3NJbmRleCl9KCMke21hdGNoZWQuaW5kZXh9KWBcbiAgICAgICAgICAgICAgICAgICAgOiAnbm9kZScsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50QW1iaWd1b3VzOiAhIShtYXRjaGVkICYmIG1hdGNoZWQuY2FuZGlkYXRlcyA+IDEpLFxuICAgICAgICAgICAgICAgIHRhcmdldDogdGFyZ2V0SW5mby5kZXNjLFxuICAgICAgICAgICAgICAgIGV4cGVjdGVkVXVpZDogdGFyZ2V0SW5mby52YWx1ZVV1aWQsXG4gICAgICAgICAgICAgICAgdHlwZU1pc3Npbmc6IHRhcmdldEluZm8udmFsdWVVdWlkICE9PSBudWxsICYmICF0YXJnZXRJbmZvLmR1bXBUeXBlLFxuICAgICAgICAgICAgICAgIGR1bXAsXG4gICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXgsXG4gICAgICAgICAgICAgICAgdmVyaWZ5UHJvcCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gNCkg6YCQ5p2h5o+Q5Lqk77yac2NlbmUvc2V0LXByb3BlcnR5IOavj+asoeWPquW6lOeUqOS4gOadoe+8iOWPmOWPguW9ouW8j+esrCAyKyDmnaHkvJrooqvnvJbovpHlmajlv73nlaXvvIzlr7zoh7RcbiAgICAgICAgLy8gICAg5pen5a6e546w44CMYmluZGluZ3Mg5aSa5p2h5Y+q5pyJ56ys5LiA5p2h55Sf5pWI44CN77yJ77yM5omA5Lul6L+Z6YeM5LiA5qyh5LiA5p2h77yb5Luj5Lu35pivIE4g5p2hIHVuZG8g6K6w5b2V44CCXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgICAgICAgYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KShTQ0VORSwgJ3NldC1wcm9wZXJ0eScsIGl0ZW0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gNSkg5Zue6K+76aqM6K+B77yI5Zy65pmv6ISa5pys6YCa6YGT77yb5Zy65pmv6L+b56iL6L+Y5rKh5Yqg6L295paw5pa55rOV5pe26ZmN57qn5Li6IHVuYXZhaWxhYmxl77yM5LiN6Zi75aGe57uR5a6a5pys6Lqr77yJXG4gICAgICAgIGNvbnN0IHJlc3VsdHM6IGFueVtdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgcGxhbiBvZiBwbGFucykge1xuICAgICAgICAgICAgbGV0IHZlcmlmaWVkOiBhbnkgPSAnc2tpcHBlZCc7XG4gICAgICAgICAgICBsZXQgYWN0dWFsOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgbGV0IG5vdGUgPSAnJztcbiAgICAgICAgICAgIGlmIChwbGFuLnZlcmlmeUluZGV4ICE9PSAnJyAmJiBwbGFuLnZlcmlmeVByb3ApIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCByOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiAncmVhZENvbXBvbmVudFByb3BlcnR5JyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3M6IFtwbGFuLnV1aWQsIHBsYW4udmVyaWZ5SW5kZXgsIHBsYW4udmVyaWZ5UHJvcF0sXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAociAmJiByLm9rID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWwgPSByLnJlZiA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYWN0dWFsVXVpZCA9IGFjdHVhbCAmJiBhY3R1YWwudXVpZCA/IGFjdHVhbC51dWlkIDogbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcmlmaWVkID0gYWN0dWFsVXVpZCA9PT0gcGxhbi5leHBlY3RlZFV1aWQ7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJpZmllZCA9ICd1bmF2YWlsYWJsZSc7XG4gICAgICAgICAgICAgICAgICAgICAgICBub3RlID0gKHIgJiYgci5lcnJvcilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFN0cmluZyhyLmVycm9yKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogJ+WcuuaZr+iEmuacrOayoeaciei/lOWbnue7k+aenO+8iOe8lui+keWZqOmHjOmHjei9vSBjb2Nvcy1tY3Ag5omp5bGV5ZCO5Y+v6aqM6K+B77yJJztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgICAgICAgICB2ZXJpZmllZCA9ICd1bmF2YWlsYWJsZSc7XG4gICAgICAgICAgICAgICAgICAgIG5vdGUgPSBlPy5tZXNzYWdlID8/IFN0cmluZyhlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgICAgICAgIHV1aWQ6IHBsYW4udXVpZCxcbiAgICAgICAgICAgICAgICBub2RlTmFtZTogcGxhbi5ub2RlTmFtZSxcbiAgICAgICAgICAgICAgICBub2RlUGF0aDogcGxhbi5ub2RlUGF0aCxcbiAgICAgICAgICAgICAgICBwYXRoOiBwbGFuLnBhdGgsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50OiBwbGFuLmNvbXBvbmVudCxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRBbWJpZ3VvdXM6IHBsYW4uY29tcG9uZW50QW1iaWd1b3VzIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHBsYW4udGFyZ2V0LFxuICAgICAgICAgICAgICAgIGV4cGVjdGVkVXVpZDogcGxhbi5leHBlY3RlZFV1aWQsXG4gICAgICAgICAgICAgICAgdHlwZU1pc3Npbmc6IHBsYW4udHlwZU1pc3NpbmcgfHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIGR1bXA6IHBsYW4uZHVtcCxcbiAgICAgICAgICAgICAgICBhY3R1YWwsXG4gICAgICAgICAgICAgICAgdmVyaWZpZWQsXG4gICAgICAgICAgICAgICAgLi4uKG5vdGUgPyB7IHZlcmlmeU5vdGU6IG5vdGUgfSA6IHt9KSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbWlzbWF0Y2hlZCA9IHJlc3VsdHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnZlcmlmaWVkID09PSBmYWxzZSk7XG4gICAgICAgIGlmIChtaXNtYXRjaGVkLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3QgbGluZXMgPSBtaXNtYXRjaGVkLm1hcCgoaXRlbTogYW55KSA9PlxuICAgICAgICAgICAgICAgIGAke2l0ZW0ubm9kZVBhdGh9ICR7aXRlbS5wYXRofSDihpIg5pyf5pybICR7aXRlbS5leHBlY3RlZFV1aWQgPz8gJ251bGwnfe+8jOWunumZhSAke1xuICAgICAgICAgICAgICAgICAgICBpdGVtLmFjdHVhbCAmJiBpdGVtLmFjdHVhbC51dWlkID8gaXRlbS5hY3R1YWwudXVpZCA6IEpTT04uc3RyaW5naWZ5KGl0ZW0uYWN0dWFsKVxuICAgICAgICAgICAgICAgIH1gXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnu5Hlrprlt7Lmj5DkuqTkvYblm57or7vkuI3kuIDoh7TvvIjlj6/og73msqHmnInnnJ/mraPnlJ/mlYjvvIzlj68gQ3RybCtaIOaSpOmUgOWQjumHjeivle+8ie+8mlxcbiR7bGluZXMuam9pbignXFxuJyl9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYXBwbGllZDogaXRlbXMubGVuZ3RoLFxuICAgICAgICAgICAgc3VibWl0dGVkOiBpdGVtcyxcbiAgICAgICAgICAgIHZlcmlmaWVkQ291bnQ6IHJlc3VsdHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnZlcmlmaWVkID09PSB0cnVlKS5sZW5ndGgsXG4gICAgICAgICAgICByZXN1bHRzLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlQ3JlYXRlUHJlZmFiOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmNyZWF0ZVByZWZhYicsXG4gICAgdGl0bGU6ICfkv53lrZjoioLngrnkuLrpooTliLbkvZMnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn5oqK5Zy65pmv6IqC54K577yI5ZCr5pW05qO15a2Q5qCR77yJ5L+d5a2Y5Li6IC5wcmVmYWIg6LWE5rqQ77yIc2NlbmUvY3JlYXRlLXByZWZhYu+8jOiHquWKqOi/myB1bmRv77yJ77yMJyArXG4gICAgICAgICfoioLngrnmnKzouqvkvJrlj5jmiJDpooTliLbkvZPlrp7kvovjgIJ1cmwg55WZ56m65YiZ5a2Y5YiwIGRiOi8vYXNzZXRzL3ByZWZhYnMvPOiKgueCueWQjT4ucHJlZmFi77yMJyArXG4gICAgICAgICfnm67moIfnm67lvZXkuI3lrZjlnKjml7boh6rliqjliJvlu7rjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICBub2RlOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICB1cmw6ICfnm67moIfot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvcHJlZmFicy9DYXJkcy5wcmVmYWInLFxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI0gLnByZWZhYiDlt7LlrZjlnKjml7bmmK/lkKblhYjliKDpmaTlho3liJvlu7rvvIzpu5jorqQgZmFsc2UnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+i3r+W+hCBkYjovL2Fzc2V0cy8uLi4ucHJlZmFi77yM55WZ56m65YiZ55SoIGRiOi8vYXNzZXRzL3ByZWZhYnMvPOiKgueCueWQjT4ucHJlZmFiJyB9LFxuICAgICAgICAgICAgb3ZlcndyaXRlOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICflkIzlkI3otYTmupDlt7LlrZjlnKjml7bmmK/lkKblhYjliKDpmaTlho3liJvlu7onIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IG5vZGVVdWlkID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgbGV0IHNvdXJjZSA9ICdwYXJhbXMnO1xuICAgICAgICBpZiAoIW5vZGVVdWlkKSB7XG4gICAgICAgICAgICBub2RlVXVpZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKClbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW5vZGVVdWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlVXVpZCk7XG4gICAgICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+mHjOaJvuS4jeWIsOiKgueCuTogJHtub2RlVXVpZH1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzY2VuZVJvb3RVdWlkID0gZHVtcFZhbHVlPHN0cmluZz4odHJlZT8udXVpZCwgJycpO1xuICAgICAgICBpZiAoc2NlbmVSb290VXVpZCAmJiBzY2VuZVJvb3RVdWlkID09PSBub2RlVXVpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkuI3og73miorlnLrmma/moLnkv53lrZjkuLrpooTliLbkvZPvvIzor7fmjIflrprlroPnmoTmn5DkuKrlrZDoioLngrknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub2RlTmFtZSA9IGR1bXBWYWx1ZTxzdHJpbmc+KHRhcmdldC5uYW1lLCAnJyk7XG5cbiAgICAgICAgbGV0IHVybCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXJsJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmwpIHtcbiAgICAgICAgICAgIGlmICghbm9kZU5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+iKgueCueayoeacieWQjeWtl++8jOaXoOazleaOqOWvvOm7mOiupOi3r+W+hO+8jOivt+aYvuW8j+S8oCB1cmwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVybCA9IGBkYjovL2Fzc2V0cy9wcmVmYWJzLyR7bm9kZU5hbWV9LnByZWZhYmA7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly9hc3NldHMvJykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgdXJsIOW/hemhu+S9jeS6jiBkYjovL2Fzc2V0cy8g5LiLOiAke3VybH1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXVybC5lbmRzV2l0aCgnLnByZWZhYicpKSB7XG4gICAgICAgICAgICB1cmwgPSBgJHt1cmx9LnByZWZhYmA7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDpgJDnuqfnoa7kv53niLbnm67lvZXlrZjlnKjvvIhjcmVhdGUtYXNzZXQg55qEIHNvdXJjZSDkvKAgbnVsbCDljbPliJvlu7rnm67lvZXvvIlcbiAgICAgICAgY29uc3QgZm9sZGVyU2VnbWVudHMgPSB1cmwuc2xpY2UoJ2RiOi8vYXNzZXRzLycubGVuZ3RoKS5zcGxpdCgnLycpLnNsaWNlKDAsIC0xKTtcbiAgICAgICAgbGV0IGZvbGRlclVybCA9ICdkYjovL2Fzc2V0cyc7XG4gICAgICAgIGNvbnN0IGNyZWF0ZWRGb2xkZXJzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgZm9sZGVyU2VnbWVudHMpIHtcbiAgICAgICAgICAgIGlmICghc2VnbWVudCkgY29udGludWU7XG4gICAgICAgICAgICBmb2xkZXJVcmwgPSBgJHtmb2xkZXJVcmx9LyR7c2VnbWVudH1gO1xuICAgICAgICAgICAgY29uc3QgZXhpc3RzID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0LWluZm8nLCBmb2xkZXJVcmwpO1xuICAgICAgICAgICAgaWYgKCFleGlzdHMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2NyZWF0ZS1hc3NldCcsIGZvbGRlclVybCwgbnVsbCk7XG4gICAgICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5Yib5bu655uu5b2V5aSx6LSlOiAke2ZvbGRlclVybH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY3JlYXRlZEZvbGRlcnMucHVzaChmb2xkZXJVcmwpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlKSB7XG4gICAgICAgICAgICBjb25zdCBleGlzdGluZzogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiB1cmwgfSk7XG4gICAgICAgICAgICBjb25zdCBoaXQgPSAoZXhpc3RpbmcgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gdXJsKTtcbiAgICAgICAgICAgIGlmIChoaXQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgaGl0LnV1aWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcHJlZmFiVXVpZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdjcmVhdGUtcHJlZmFiJywgbm9kZVV1aWQsIHVybCk7XG4gICAgICAgIGlmICghcHJlZmFiVXVpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtcHJlZmFiIOayoeaciei/lOWbnui1hOa6kCB1dWlk77yI55uu5qCH5bey5a2Y5Zyo77yf5Y+v5LygIG92ZXJ3cml0ZT10cnVl77yJOiAke3VybH1gKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBub2RlOiBub2RlVXVpZCwgbm9kZU5hbWUsIHVybCwgcHJlZmFiVXVpZCwgY3JlYXRlZEZvbGRlcnMsIHNvdXJjZSB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBwcmVmYWJPcGVuOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdwcmVmYWIub3BlbicsXG4gICAgdGl0bGU6ICfmiZPlvIDpooTliLbkvZMnLFxuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAgICfov5vlhaXpooTliLbkvZPnvJbovpHmqKHlvI/vvIjnrYnku7fotYTmupDnrqHnkIblmajph4zlj4zlh7sgLnByZWZhYu+8ieOAguaZrumAmuWcuuaZr+S4i+WFiOS/neWtmOW9k+WJjeWcuuaZr+mBv+WFjeW8ueeql++8jCcgK1xuICAgICAgICAgICAgJ+WGjei1sCBhc3NldC1kYi9vcGVuLWFzc2V0IOW5tui9ruivouehruiupOW9k+WJjee8lui+keaWh+aho+WIh+aNouWujOaIkOOAgicgK1xuICAgICAgICAgICAgJ+iLpeW3suWkhOS6juWPpuS4gOS4qumihOWItuS9k+eahOe8lui+keaooeW8j+S8muebtOaOpeaKpemUme+8iHNjZW5lL3NhdmUtc2NlbmUg5a+56aKE5Yi25L2T5paH5qGj5peg5pWI44CB5YiH5o2i5Y+v6IO95by544CM5piv5ZCm5L+d5a2Y44CN5a+56K+d5qGG77yJ77yM56Gu6K6k5YyF6KO55Zy65pmv5peg5pyq5L+d5a2Y5L+u5pS55pe25Y+v5LygIGFzc3VtZUNsZWFuPXRydWUg6Lez6L+H5qOA5p+l44CCJyArXG4gICAgICAgICAgICAn5rOo5oSP77yac2NlbmUvb3Blbi1zY2VuZSDlr7kgcHJlZmFiIHV1aWQg5peg5pWI77yI5Lya6KKr5b+955Wl77yJ77ybc2NlbmUub3BlbiDkuZ/kuI3opoHnlKjigJTigJTlroPlhoXpg6jlhYggbG9hZC1lbXB0eS1zY2VuZe+8jOS8muS6p+eUn+aXoOagh+mimOWcuuaZr+i/m+iAjOW8ueOAjOS/neWtmOOAjeWvueivneahhuOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHVybDogJ+mihOWItuS9kyBkYjovLyDot6/lvoTmiJYgdXVpZO+8jOWmgiBkYjovL2Fzc2V0cy9wcmVmYWJzL0Zvby5wcmVmYWInLFxuICAgICAgICBzYXZlQ3VycmVudDogJ+i/m+WFpeWJjeaYr+WQpuS/neWtmOW9k+WJjeWcuuaZr++8jOm7mOiupCB0cnVlJyxcbiAgICAgICAgYXNzdW1lQ2xlYW46ICflt7LlpITkuo7pooTliLbkvZPnvJbovpHmqKHlvI/ml7bmmK/lkKbot7Pov4flronlhajmo4Dmn6Xnu6fnu63liIfmjaLvvIjku4XpmZDnoa7orqTlvZPliY3pooTliLbkvZPml6DmnKrkv53lrZjkv67mlLnvvInvvIzpu5jorqQgZmFsc2UnLFxuICAgICAgICB0aW1lb3V0OiAn562J5b6F6L+b5YWl6aKE5Yi25L2T57yW6L6R5qih5byP55qE6LaF5pe25q+r56eS77yM6buY6K6kIDMwMDAwJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mihOWItuS9kyBkYjovLyDot6/lvoTmiJYgdXVpZCcgfSxcbiAgICAgICAgICAgIHNhdmVDdXJyZW50OiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICfpu5jorqQgdHJ1ZScgfSxcbiAgICAgICAgICAgIGFzc3VtZUNsZWFuOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICfpooTliLbkvZPnvJbovpHmqKHlvI/kuIvot7Pov4flronlhajmo4Dmn6XvvIzpu5jorqQgZmFsc2UnIH0sXG4gICAgICAgICAgICB0aW1lb3V0OiB7IHR5cGU6ICdpbnRlZ2VyJywgbWluaW11bTogMTAwMCwgbWF4aW11bTogMTIwMDAwLCBkZXNjcmlwdGlvbjogJ+m7mOiupCAzMDAwMCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsndXJsJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXVybCkgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogdXJs77yIZGI6Ly8g6Lev5b6E5oiWIHV1aWTvvIknKTtcbiAgICAgICAgbGV0IHV1aWQgPSB1cmw7XG4gICAgICAgIGlmICh1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xuICAgICAgICAgICAgY29uc3QgaW5mbzogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmwpO1xuICAgICAgICAgICAgaWYgKCFpbmZvIHx8ICFpbmZvLnV1aWQpIHRocm93IG5ldyBFcnJvcihg5om+5LiN5Yiw6aKE5Yi25L2T6LWE5LqnOiAke3VybH1gKTtcbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgJiYgaW5mby50eXBlICE9PSAncHJlZmFiJyAmJiBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfkuI3mmK/pooTliLbkvZPvvIgke2luZm8udHlwZX3vvIk6ICR7aW5mby51cmwgfHwgdXJsfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXVpZCA9IFN0cmluZyhpbmZvLnV1aWQpO1xuICAgICAgICB9XG4gICAgICAgIC8vIOW3suWkhOS6jumihOWItuS9k+e8lui+keaooeW8j+aXtuebtOaOpeWwneivlSBvcGVuLWFzc2V0IOWIh+aNou+8iHByZWZhYuKGknByZWZhYiDmnKrlhYXliIbpqozor4HvvIzlpLHotKXotbDotoXml7bmj5DnpLrvvIlcbiAgICAgICAgY29uc3QgbW9kZSA9IGF3YWl0IGRldGVjdFByZWZhYk1vZGUoKTtcbiAgICAgICAgaWYgKG1vZGUuaW5QcmVmYWJNb2RlKSB7XG4gICAgICAgICAgICBpZiAocGFyYW1zPy5hc3N1bWVDbGVhbiAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIHRocm93IHByZWZhYk1vZGVCbG9ja2VkRXJyb3IobW9kZS5wcmVmYWJOYW1lLCBg5omT5byA6aKE5Yi25L2TICR7dXJsfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJhbXM/LnNhdmVDdXJyZW50ICE9PSBmYWxzZSAmJiAhbW9kZS5pblByZWZhYk1vZGUpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyDkv53lrZjlpLHotKXkuI3pmLvmlq3vvIjml6DmoIfpopjmnKrkv53lrZjlnLrmma/kvJrlvLnlr7nor53moYbvvIzkurrlt6XlpITnkIblkI7ova7or6Lnu6fnu63vvIlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyBzY2VuZS9vcGVuLXNjZW5lIOWvuSBwcmVmYWIgdXVpZCDml6DmlYjvvIjlrp7mtYvooqvlv73nlaXjgIHlnLrmma/kuI3liIfmjaLvvInvvJtcbiAgICAgICAgLy8g5omT5byA6aKE5Yi25L2T55qE5q2j56Gu6YCa6YGT5pivIGFzc2V0LWRiL29wZW4tYXNzZXTvvIjnrYnku7fotYTmupDnrqHnkIblmajlj4zlh7vvvInjgIJcbiAgICAgICAgLy8g5rOo5oSPIHF1ZXJ5LWN1cnJlbnQtc2NlbmUg5Zyo6aKE5Yi25L2T5qih5byP5LiL5LuN6L+U5Zue5Zy65pmv6aG1562+IHV1aWTvvIzkuI3lj43mmKDnvJbovpHkuK3nmoTmlofmoaPvvJtcbiAgICAgICAgLy8g6KaB55SoIHF1ZXJ5LW5vZGUtdHJlZSDnmoTmoLkgdXVpZOKAlOKAlOmihOWItuS9k+aooeW8j+S4i+aWh+aho+aYr+WMheS6huS4gOWxgueahOS4tOaXtuWcuuaZr1xuICAgICAgICAvLyDvvIg85ZCN5a2XPi1zY2VuZe+8jOagueS4i+aciSBzaG91bGRfaGlkZV9pbl9oaWVyYXJjaHnvvInvvIzmiJDlip/liKTlrpogPSDmoLkgdXVpZCDnm7jlr7nmiZPlvIDliY3lj5jljJbvvIjov57nu63kuKTmrKHor7vliLDmiY3nrpfnqLPlrprvvIlcbiAgICAgICAgY29uc3QgdGltZW91dCA9IHBpY2tOdW1iZXIocGFyYW1zLCAndGltZW91dCcsIDMwMDAwKSB8fCAzMDAwMDtcbiAgICAgICAgY29uc3Qgc3dpdGNoZWQgPSBhd2FpdCBvcGVuQXNzZXRBbmRQb2xsKHV1aWQsIHRpbWVvdXQpO1xuICAgICAgICBjb25zdCByZXN1bHQ6IGFueSA9IHsgb3BlbmVkOiBzd2l0Y2hlZC5vcGVuZWQsIHByZWZhYlV1aWQ6IHV1aWQsIGZyb21TY2VuZTogc3dpdGNoZWQuZnJvbSB8fCBudWxsLCBjdXJyZW50U2NlbmU6IHN3aXRjaGVkLmN1cnJlbnQgfHwgbnVsbCwgcmVxdWVzdGVkOiB0cnVlIH07XG4gICAgICAgIGlmICghcmVzdWx0Lm9wZW5lZCkge1xuICAgICAgICAgICAgcmVzdWx0LmhpbnQgPSAn6LaF5pe25pyq5YiH5o2i5paH5qGj77ya5Y+v6IO95b2T5YmN5bey5aSE5LqO6K+l6aKE5Yi25L2T55qE57yW6L6R5qih5byP77yM5oiW5b2T5YmN5piv5peg5qCH6aKY5pyq5L+d5a2Y5Zy65pmv5pe257yW6L6R5Zmo5by55LqG5L+d5a2Y5a+56K+d5qGG77yI5aSE55CG5ZCO6YeN6K+V77yJJztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVNhdmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLnNhdmUnLFxuICAgIHRpdGxlOiAn5L+d5a2Y5Zy65pmvJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+mAmui/hyBzY2VuZS9zYXZlLXNjZW5lIOS/neWtmOW9k+WJjeWcuuaZr++8jOi/lOWbnuS/neWtmOe7k+aenOOAgicgK1xuICAgICAgICAn6aKE5Yi25L2T57yW6L6R5qih5byP5LiL5Lya55u05o6l5oql6ZSZ5ouS57ud77yI6K+l5qih5byP5LiL5L+d5a2Y5piv55uy55qE77yacXVlcnktZGlydHkg5oGSIGZhbHNl44CBc2F2ZS1zY2VuZSDov5Tlm54gbnVsbO+8jOi/mOWPr+iDveWgteWcqOOAjOaYr+WQpuS/neWtmOOAjeWvueivneahhuS4iu+8ie+8jOivt+WFiOS6uuW3peS/neWtmC/lhbPpl63pooTliLbkvZPpobXnrb4nLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgLy8g6aKE5Yi25L2T57yW6L6R5qih5byP5LiL5L+d5a2Y5piv55uy55qE77yacXVlcnktZGlydHkg5oGSIGZhbHNl44CBc2F2ZS1zY2VuZSDov5Tlm54gbnVsbO+8jFxuICAgICAgICAvLyDov5jlj6/og73ooqvjgIzmmK/lkKbkv53lrZjjgI3lr7nor53moYbloLXkvY/vvIgyMDI2LTEwIOW7uiBycHMuc2NlbmUg5pe25a6e5rWL5aC15LqGIDI0IOenkuebtOWIsOS6uuW3peWPlua2iO+8ie+8jOebtOaOpeaLkue7nVxuICAgICAgICBjb25zdCBtb2RlID0gYXdhaXQgZGV0ZWN0UHJlZmFiTW9kZSgpO1xuICAgICAgICBpZiAobW9kZS5pblByZWZhYk1vZGUpIHtcbiAgICAgICAgICAgIHRocm93IHByZWZhYk1vZGVCbG9ja2VkRXJyb3IobW9kZS5wcmVmYWJOYW1lLCAn5L+d5a2Y5b2T5YmN5Zy65pmvJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZGlydHlCZWZvcmUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktZGlydHknKTtcbiAgICAgICAgLy8g5rOo5oSP77yaMy44Ljgg55qEIHNhdmUtc2NlbmUg6L+U5Zue55qE5piv5Zy65pmvIHV1aWTvvIzkuI3mmK8gZGI6Ly8g6Lev5b6EXG4gICAgICAgIGNvbnN0IHNjZW5lVXVpZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdzYXZlLXNjZW5lJyk7XG4gICAgICAgIGNvbnN0IGRpcnR5QWZ0ZXIgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktZGlydHknKTtcbiAgICAgICAgbGV0IHVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICAgIGlmIChzY2VuZVV1aWQpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgdXJsID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LXBhdGgnLCBzY2VuZVV1aWQpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIHVybCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgZGlydHlCZWZvcmUsIGRpcnR5QWZ0ZXIsIHNjZW5lVXVpZDogc2NlbmVVdWlkIHx8IG51bGwsIHVybDogdXJsIHx8IG51bGwgfTtcbiAgICB9LFxufTtcblxuY29uc3QgYXNzZXRMaXN0OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdhc3NldC5saXN0JyxcbiAgICB0aXRsZTogJ+i1hOa6kOWIl+ihqCcsXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4cgYXNzZXQtZGIvcXVlcnktYXNzZXRzIOWIl+WHuumhueebrui1hOa6kCcsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHBhdHRlcm46ICfot6/lvoTljLnphY3vvIzpu5jorqQgZGI6Ly9hc3NldHMvKionLFxuICAgICAgICBsaW1pdDogJ+acgOWkmui/lOWbnuadoeaVsO+8jOm7mOiupCA1MCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHBhdHRlcm46IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6Lev5b6E5Yy56YWN77yIZ2xvYnPvvInvvIzpu5jorqQgZGI6Ly9hc3NldHMvKionIH0sXG4gICAgICAgICAgICBsaW1pdDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfmnIDlpJrov5Tlm57mnaHmlbDvvIzpu5jorqQgNTAnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgcGF0dGVybiA9IHBpY2tTdHJpbmcocGFyYW1zLCAncGF0dGVybicsICcnKSB8fCAnZGI6Ly9hc3NldHMvKionO1xuICAgICAgICBjb25zdCBsaW1pdCA9IHBpY2tOdW1iZXIocGFyYW1zLCAnbGltaXQnLCA1MCkgfHwgNTA7XG4gICAgICAgIGNvbnN0IGFzc2V0czogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuIH0pO1xuICAgICAgICBjb25zdCBsaXN0ID0gKGFzc2V0cyB8fCBbXSkuc2xpY2UoMCwgbGltaXQpLm1hcCgoYXNzZXQ6IGFueSkgPT4gKHtcbiAgICAgICAgICAgIHVybDogYXNzZXQudXJsLFxuICAgICAgICAgICAgdXVpZDogYXNzZXQudXVpZCxcbiAgICAgICAgICAgIHR5cGU6IGFzc2V0LnR5cGUsXG4gICAgICAgICAgICBmaWxlOiBhc3NldC5maWxlLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybiB7IHBhdHRlcm4sIHRvdGFsOiAoYXNzZXRzIHx8IFtdKS5sZW5ndGgsIGxpc3RlZDogbGlzdC5sZW5ndGgsIGFzc2V0czogbGlzdCB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBhc3NldERlbGV0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnYXNzZXQuZGVsZXRlJyxcbiAgICB0aXRsZTogJ+WIoOmZpOi1hOa6kCcsXG4gICAgZGVzY3JpcHRpb246ICfliKDpmaQgYXNzZXRzIOS4i+eahOi1hOa6kO+8iOiEmuacrCAvIOmihOWItuS9kyAvIOi0tOWbvuetie+8ie+8jOS8oCB1dWlkIOaIliBkYjovLyDot6/lvoQnLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn6LWE5rqQIHV1aWQnLFxuICAgICAgICB1cmw6ICfotYTmupDot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvc2NyaXB0cy9QbGF5ZXIudHMnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOa6kCB1dWlkJyB9LFxuICAgICAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOa6kOi3r+W+hCBkYjovLy4uLicgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXV1aWQgJiYgIXVybCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogdXVpZCDmiJYgdXJsJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFyZ2V0ID0gdXVpZDtcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0czogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiB1cmwgfSk7XG4gICAgICAgICAgICBjb25zdCBoaXQgPSAoYXNzZXRzIHx8IFtdKS5maW5kKChhc3NldDogYW55KSA9PiBhc3NldC51cmwgPT09IHVybCk7XG4gICAgICAgICAgICBpZiAoIWhpdCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5om+5LiN5Yiw6LWE5rqQOiAke3VybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRhcmdldCA9IGhpdC51dWlkO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdkZWxldGUtYXNzZXQnLCB0YXJnZXQpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyDmnInkupvniYjmnKzorqTot6/lvoTkuI3orqQgdXVpZO+8jOmAgOWbnuaMiei3r+W+hOWGjeivleS4gOasoVxuICAgICAgICAgICAgaWYgKCF1cmwpIHRocm93IGU7XG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgdXJsKTtcbiAgICAgICAgICAgIHRhcmdldCA9IHVybDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyB0YXJnZXQsIHVybDogdXJsIHx8IG51bGwsIGRlbGV0ZWQ6IHRydWUgfTtcbiAgICB9LFxufTtcblxuY29uc3QgYXNzZXRJbXBvcnQ6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ2Fzc2V0LmltcG9ydCcsXG4gICAgdGl0bGU6ICflr7zlhaXotYTmupDmlofku7YnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn5oqK56OB55uY5LiK55qE5paH5Lu2L+ebruW9leWkjeWItui/myBhc3NldHMg5bm26Kem5Y+RIGFzc2V0LWRiIOWvvOWFpe+8jOi9ruivouWIsCB1dWlkIOWwsee7quWQjui/lOWbnu+8iOWQq+WtkOi1hOa6kCB1dWlk77yM5aaCIHNwcml0ZUZyYW1l77yJ44CCJyArXG4gICAgICAgICflpJbpg6jlhpnnm5jkuI3kvJrop6blj5HnvJbovpHlmajnmoTnqpflj6PnhKbngrnlop7ph4/mo4Dmn6XvvIzlv4XpobvotbDmnKzmk43kvZzvvIjmiJbmiYvliqggcmVmcmVzaC1hc3NldO+8ie+8jOWQpuWImSB1dWlkIOS4jeS8mueUn+aIkOOAgicgK1xuICAgICAgICAnc3JjIOecgeeVpeaXtuS4uue6r+WIt+aWsOaooeW8j++8muaWh+S7tuW3suebtOaOpeWGmei/myBhc3NldHPvvIjohJrmnKwv6LS05Zu+5Y6f5Zyw5bCx5L2N77yJ77yM5Y+q6Kem5Y+R5a+85YWl5LiN5aSN5Yi277yM6L+U5ZueIHV1aWTjgIInICtcbiAgICAgICAgJ3NyYyDkuLrnm67lvZXml7bpgJLlvZLlpI3liLbmlbTkuKrnm67lvZXvvIjoh6rliqjot7Pov4cgLm1ldGEg562J6ZqQ6JeP5paH5Lu277yM6YG/5YWN5bim5YWl5penIHV1aWTvvInvvJsnICtcbiAgICAgICAgJ2RiUGF0aCDku6UgLyDnu5PlsL7miJbml6DmianlsZXlkI3ml7bop4bkuLrnm67moIfnm67lvZXvvIzlkKbliJnop4bkuLrnsr7noa7nm67moIfmlofku7bot6/lvoTjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICBzcmM6ICfno4Hnm5jmupDot6/lvoTvvIjmlofku7bmiJbnm67lvZXvvIznu53lr7not6/lvoTmiJbnm7jlr7npobnnm67moLnvvInvvJvnnIHnlaUgPSDnuq/liLfmlrDmqKHlvI/vvIhkYlBhdGgg5aSE5paH5Lu25bey5bCx5L2N77yJJyxcbiAgICAgICAgZGJQYXRoOiAn55uu5qCHIGRiOi8vYXNzZXRzLy4uLu+8jOebruW9leaIlueyvuehruaWh+S7tui3r+W+hCcsXG4gICAgICAgIHdhaXRUaW1lb3V0OiAn6L2u6K+i5a+85YWl57uT5p6c6LaF5pe277yI5q+r56eS77yJ77yM6buY6K6kIDE1MDAwJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgc3JjOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ejgeebmOa6kOi3r+W+hO+8iOaWh+S7tuaIluebruW9le+8ie+8m+ecgeeVpSA9IOe6r+WIt+aWsOaooeW8jycgfSxcbiAgICAgICAgICAgIGRiUGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnm67moIcgZGI6Ly9hc3NldHMvLi4uJyB9LFxuICAgICAgICAgICAgd2FpdFRpbWVvdXQ6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAn6L2u6K+i6LaF5pe25q+r56eS77yM6buY6K6kIDE1MDAwJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydkYlBhdGgnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBzcmMgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3NyYycsICcnKS50cmltKCk7XG4gICAgICAgIGxldCBkYlBhdGggPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2RiUGF0aCcsICcnKS50cmltKCk7XG4gICAgICAgIGNvbnN0IHdhaXRUaW1lb3V0ID0gcGlja051bWJlcihwYXJhbXMsICd3YWl0VGltZW91dCcsIDE1MDAwKSB8fCAxNTAwMDtcbiAgICAgICAgaWYgKCFkYlBhdGguc3RhcnRzV2l0aCgnZGI6Ly9hc3NldHMvJykpIHRocm93IG5ldyBFcnJvcihgZGJQYXRoIOW/hemhu+WcqCBkYjovL2Fzc2V0cy8g5LiLOiAke2RiUGF0aH1gKTtcblxuICAgICAgICAvLyDnuq/liLfmlrDmqKHlvI/vvJrkuI3lpI3liLbvvIzlj6rlr7nlt7LlsLHkvY3nmoTmlofku7bop6blj5EgYXNzZXQtZGIg5a+85YWlXG4gICAgICAgIGNvbnN0IHB1cmVSZWZyZXNoID0gIXNyYztcbiAgICAgICAgY29uc3Qgc3JjQWJzID0gcHVyZVJlZnJlc2hcbiAgICAgICAgICAgID8gZGJVcmxUb0FicyhkYlBhdGgpXG4gICAgICAgICAgICA6IChzcmMuc3RhcnRzV2l0aCgnZGI6Ly8nKVxuICAgICAgICAgICAgICAgID8gZGJVcmxUb0FicyhzcmMpXG4gICAgICAgICAgICAgICAgOiAoc3JjLm1hdGNoKC9eW0EtWmEtel06W1xcXFwvXS8pID8gc3JjIDogam9pbihwcm9qZWN0Um9vdCgpLCBzcmMpKSk7XG4gICAgICAgIGNvbnN0IHNyY1N0YXQgPSBhd2FpdCBzdGF0KHNyY0FicykuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgIGlmICghc3JjU3RhdCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKHB1cmVSZWZyZXNoXG4gICAgICAgICAgICAgICAgPyBg55uu5qCH5paH5Lu25LiN5Zyo56OB55uY5LiK77yM5peg5rOV5Yi35pawOiAke3NyY0Fic33vvIjnuq/liLfmlrDmqKHlvI/opoHmsYLmlofku7blt7Llhpnov5sgYXNzZXRz77yJYFxuICAgICAgICAgICAgICAgIDogYOa6kOi3r+W+hOS4jeWtmOWcqDogJHtzcmNBYnN9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBkYlBhdGggPSBkYlBhdGgucmVwbGFjZSgvXFwvKyQvLCAnJyk7XG4gICAgICAgIGNvbnN0IHNyY0lzRGlyID0gc3JjU3RhdC5pc0RpcmVjdG9yeSgpO1xuICAgICAgICBjb25zdCBkYkRpciA9ICFzcmNJc0RpciAmJiBleHRuYW1lKGRiUGF0aCkgPyBkaXJuYW1lKGRiUGF0aCkgOiBkYlBhdGg7XG5cbiAgICAgICAgLy8g6K6h566X5aSN5Yi25riF5Y2V77ya55uu5b2V6YCS5b2S5bGV5byA77yM5paH5Lu25Y2V5p2hXG4gICAgICAgIGNvbnN0IGl0ZW1zOiBBcnJheTx7IGZyb206IHN0cmluZzsgdG9BYnM6IHN0cmluZzsgZGJVcmw6IHN0cmluZzsgcmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgICAgaWYgKHNyY0lzRGlyKSB7XG4gICAgICAgICAgICBjb25zdCB3YWxrID0gYXN5bmMgKGRpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgYXdhaXQgcmVhZGRpcihkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBsb3dlciA9IGVudHJ5Lm5hbWUudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgICAgICAgLy8g6Lez6L+H54K55paH5Lu25LiOIENvY29zIOeahCB4eHgudHMubWV0Ye+8iOe8lui+keWZqOiHqueUn+aIkO+8jOWvvOWFpeWug+WPquS8mueZveetiei2heaXti/luKblhaXml6cgdXVpZO+8iVxuICAgICAgICAgICAgICAgICAgICBpZiAobG93ZXIuc3RhcnRzV2l0aCgnLicpIHx8IGxvd2VyLmVuZHNXaXRoKCcubWV0YScpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZnJvbSA9IGpvaW4oZGlyLCBlbnRyeS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2hpbGRSZWwgPSByZWwgPyBgJHtyZWx9LyR7ZW50cnkubmFtZX1gIDogZW50cnkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHdhbGsoZnJvbSwgY2hpbGRSZWwpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgaXRlbXMucHVzaCh7IGZyb20sIHRvQWJzOiBkYlVybFRvQWJzKGAke2RiRGlyfS8ke2NoaWxkUmVsfWApLCBkYlVybDogYCR7ZGJEaXJ9LyR7Y2hpbGRSZWx9YCwgcmVsOiBjaGlsZFJlbCB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhd2FpdCB3YWxrKHNyY0FicywgJycpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGJhc2VuYW1lKHNyY0FicykudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCgnLm1ldGEnKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5LiN6KaB5oqKIC5tZXRhIOW9k+S9nOWvvOWFpeWvueixoe+8iOe8lui+keWZqOiHqueUn+aIkOaWh+S7tu+8ie+8m+ebtOaOpeWvvOWFpeWvueW6lOeahOi1hOa6kOaWh+S7tuWNs+WPrycpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZmlsZU5hbWUgPSBiYXNlbmFtZShzcmNBYnMpO1xuICAgICAgICAgICAgY29uc3QgZGJVcmwgPSBleHRuYW1lKGRiUGF0aCkgPyBkYlBhdGggOiBgJHtkYkRpcn0vJHtmaWxlTmFtZX1gO1xuICAgICAgICAgICAgaXRlbXMucHVzaCh7IGZyb206IHNyY0FicywgdG9BYnM6IGRiVXJsVG9BYnMoZGJVcmwpLCBkYlVybCwgcmVsOiBmaWxlTmFtZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWl0ZW1zLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKGDmupDnm67lvZXph4zmsqHmnInlj6/lpI3liLbnmoTmlofku7Y6ICR7c3JjQWJzfWApO1xuXG4gICAgICAgIC8vIOWkjeWItuWIsOejgeebmO+8iOa6kOS4juebruagh+WQjOi3r+W+hCA9IOaWh+S7tuW3suWwseS9je+8jOi3s+i/h+WkjeWItuWPquinpuWPkeWvvOWFpe+8iVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgICAgICAgIGlmIChpc1NhbWVQYXRoKGl0ZW0uZnJvbSwgaXRlbS50b0FicykpIGNvbnRpbnVlO1xuICAgICAgICAgICAgYXdhaXQgbWtkaXIoZGlybmFtZShpdGVtLnRvQWJzKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgICBhd2FpdCBjb3B5RmlsZShpdGVtLmZyb20sIGl0ZW0udG9BYnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g6Kem5Y+R5a+85YWl77ya5LuO55uu5qCH55uu5b2V5ZCR5LiK5om+5YiwIGFzc2V0LWRiIOW3suefpeeahOacgOi/keelluWFiOWGjeWIt+aWsO+8iOaWsOebruW9leacrOi6q+WPr+iDvei/mOacquWFpeW6k++8iVxuICAgICAgICBsZXQgcmVmcmVzaFVybCA9IGRiRGlyO1xuICAgICAgICBmb3IgKGxldCBndWFyZCA9IDA7IGd1YXJkIDwgNjsgZ3VhcmQrKykge1xuICAgICAgICAgICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShyZWZyZXNoVXJsKTtcbiAgICAgICAgICAgIGlmIChwYXJlbnQgPT09IHJlZnJlc2hVcmwgfHwgIXBhcmVudC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cycpKSBicmVhaztcbiAgICAgICAgICAgIGNvbnN0IGtub3duOiBhbnkgPSBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIHJlZnJlc2hVcmwpO1xuICAgICAgICAgICAgaWYgKGtub3duKSBicmVhaztcbiAgICAgICAgICAgIHJlZnJlc2hVcmwgPSBwYXJlbnQ7XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoQVNTRVRfREIsICdyZWZyZXNoLWFzc2V0JywgcmVmcmVzaFVybCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIOS4quWIq+eJiOacrOS4jeaUr+aMgeebruW9leWIt+aWsO+8jOmAgOWbnumAkOaWh+S7tuWIt+aWsFxuICAgICAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KShBU1NFVF9EQiwgJ3JlZnJlc2gtYXNzZXQnLCBpdGVtLmRiVXJsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOi9ruivouWvvOWFpee7k+aenO+8jOaUtumbhiB1dWlkIOS4juWtkOi1hOa6kO+8iHNwcml0ZUZyYW1lIOetie+8iVxuICAgICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB3YWl0VGltZW91dDtcbiAgICAgICAgY29uc3QgZmlsZXM6IGFueVtdID0gW107XG4gICAgICAgIGxldCByZWFkeSA9IHRydWU7XG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgICAgICAgbGV0IGFzc2V0SW5mbzogYW55ID0gbnVsbDtcbiAgICAgICAgICAgIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgICBhc3NldEluZm8gPSBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGl0ZW0uZGJVcmwpO1xuICAgICAgICAgICAgICAgIGlmIChhc3NldEluZm8pIGJyZWFrO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWFzc2V0SW5mbykge1xuICAgICAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgZmlsZXMucHVzaCh7IHNyYzogaXRlbS5mcm9tLCB1cmw6IGl0ZW0uZGJVcmwsIHJlbDogaXRlbS5yZWwsIHJlYWR5OiBmYWxzZSB9KTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCBzdWJBc3NldHM6IGFueVtdID0gQXJyYXkuaXNBcnJheShhc3NldEluZm8uc3ViQXNzZXRzKVxuICAgICAgICAgICAgICAgID8gYXNzZXRJbmZvLnN1YkFzc2V0cy5tYXAoKHN1YjogYW55KSA9PiAoeyBuYW1lOiBzdWIubmFtZSwgdXJsOiBzdWIudXJsLCB1dWlkOiBzdWIudXVpZCwgdHlwZTogc3ViLnR5cGUgfSkpXG4gICAgICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgICAgaWYgKCFzdWJBc3NldHMpIHtcbiAgICAgICAgICAgICAgICAvLyDlhZzlupXvvJrlrZDotYTmupAgdXJsIOW9ouWmgiA86LWE5rqQdXJsPi885ZCN5a2XPu+8jOeUqCBxdWVyeS1hc3NldHMg5p+lXG4gICAgICAgICAgICAgICAgY29uc3Qgc3ViczogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiBgJHtpdGVtLmRiVXJsfS8qYCB9KTtcbiAgICAgICAgICAgICAgICBzdWJBc3NldHMgPSAoc3VicyB8fCBbXSkubWFwKChzdWI6IGFueSkgPT4gKHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogc3ViLnVybC5zbGljZShpdGVtLmRiVXJsLmxlbmd0aCArIDEpLFxuICAgICAgICAgICAgICAgICAgICB1cmw6IHN1Yi51cmwsXG4gICAgICAgICAgICAgICAgICAgIHV1aWQ6IHN1Yi51dWlkLFxuICAgICAgICAgICAgICAgICAgICB0eXBlOiBzdWIudHlwZSxcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmaWxlcy5wdXNoKHsgc3JjOiBpdGVtLmZyb20sIHVybDogaXRlbS5kYlVybCwgcmVsOiBpdGVtLnJlbCwgcmVhZHk6IHRydWUsIHV1aWQ6IGFzc2V0SW5mby51dWlkLCB0eXBlOiBhc3NldEluZm8udHlwZSwgc3ViQXNzZXRzIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgcmVhZHksIGRpclVybDogZGJEaXIsIHJlZnJlc2hVcmwsIGNvdW50OiBpdGVtcy5sZW5ndGgsIGZpbGVzIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IHNjZW5lU2NyaXB0SW5mbzogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuc2NyaXB0LmluZm8nLFxuICAgIHRpdGxlOiAn5Zy65pmv6ISa5pys6YCa6YGTIMK3IOW8leaTjuS/oeaBrycsXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4cgc2NlbmUvZXhlY3V0ZS1zY2VuZS1zY3JpcHQg6L+b5YWl5Zy65pmv6L+b56iL77yM6K+75Y+W5byV5pOO5LiO5Zy65pmv5L+h5oGvJyxcbiAgICBwYXJhbXM6IHt9LFxuICAgIHNjaGVtYTogbm9QYXJhbXMoKSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICBtZXRob2Q6ICdlbmdpbmVJbmZvJyxcbiAgICAgICAgICAgIGFyZ3M6IFtdLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgc2NyaXB0UmVzdWx0OiByZXN1bHQgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVTY3JpcHREZW1vOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY2VuZS5zY3JpcHQuZGVtbycsXG4gICAgdGl0bGU6ICflnLrmma/ohJrmnKzpgJrpgZMgwrcg5bu66IqC54K5JyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/h+WcuuaZr+iEmuacrOeUqOW8leaTjiBBUEkg5Zyo5b2T5YmN5Zy65pmv5Yib5bu65LiA5Liq6IqC54K5JyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgbmFtZTogJ+iKgueCueWQje+8jOm7mOiupCBNQ1BfRW5naW5lX05vZGUnLFxuICAgICAgICB4OiAneCDlnZDmoIcnLFxuICAgICAgICB5OiAneSDlnZDmoIcnLFxuICAgICAgICB6OiAneiDlnZDmoIcnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBuYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCueWQjScgfSxcbiAgICAgICAgICAgIHg6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneCDlnZDmoIcnIH0sXG4gICAgICAgICAgICB5OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3kg5Z2Q5qCHJyB9LFxuICAgICAgICAgICAgejogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd6IOWdkOaghycgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBuYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICduYW1lJywgJycpIHx8ICdNQ1BfRW5naW5lX05vZGUnO1xuICAgICAgICBjb25zdCBwb3NpdGlvbiA9IHtcbiAgICAgICAgICAgIHg6IHBpY2tOdW1iZXIocGFyYW1zLCAneCcsIDApLFxuICAgICAgICAgICAgeTogcGlja051bWJlcihwYXJhbXMsICd5JywgMCksXG4gICAgICAgICAgICB6OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3onLCAwKSxcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIG1ldGhvZDogJ2NyZWF0ZU5vZGUnLFxuICAgICAgICAgICAgYXJnczogW25hbWUsIHBvc2l0aW9uXSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IHNjcmlwdFJlc3VsdDogcmVzdWx0IH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6ISa5pysIC8g57uE5Lu2XG5cbi8qKiDnrYnlvoXmn5DkuKrohJrmnKzotYTmupDooqsgQ3JlYXRvciDnvJbor5Hlubbms6jlhozkuLogY2NjbGFzcyAqL1xuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjcmlwdENvbXBpbGVkKGFzc2V0VXVpZDogc3RyaW5nLCB0aW1lb3V0TXMgPSAzMDAwMCk6IFByb21pc2U8YW55IHwgbnVsbD4ge1xuICAgIGNvbnN0IHN0YXJ0ID0gRGF0ZS5ub3coKTtcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0IDwgdGltZW91dE1zKSB7XG4gICAgICAgIGNvbnN0IGxpc3Q6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKTtcbiAgICAgICAgY29uc3QgZm91bmQgPSAobGlzdCB8fCBbXSkuZmluZCgoaXRlbSkgPT4gaXRlbSAmJiBpdGVtLmFzc2V0VXVpZCA9PT0gYXNzZXRVdWlkKTtcbiAgICAgICAgaWYgKGZvdW5kKSByZXR1cm4gZm91bmQ7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiDmiorlsZ7mgKfpu5jorqTlgLzmuLLmn5PmiJDlj6/nvJbor5HnmoTmupDnoIHlrZfpnaLph4/jgIJcbiAqXG4gKiDkuYvliY3mmK/mioogZGVmYXVsdCDljp/moLfmi7zov5vmupDnoIHvvIzlrZfnrKbkuLLpu5jorqTlgLzkvJrmvI/mjonlvJXlj7fvvJpcbiAqICAgc3RyZWV0TmFtZTogc3RyaW5nID0g6KGX5LiKOyAgIOKGkiDnvJbor5HmiJAgYHJldHVybiDooZfkuIo7YO+8jOe7hOS7tuaehOmAoOaXtiBSZWZlcmVuY2VFcnJvclxuICog6L+Z6YeM5oyJ57G75Z6L6KGl6b2Q5a2X6Z2i6YeP5YaZ5rOV77yM5a2X56ym5Liy6buY6K6k6LWwIEpTT04uc3RyaW5naWZ544CCXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckRlZmF1bHQocHJvcDogYW55LCB0eXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmIChwcm9wLmRlZmF1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gdHlwZSA9PT0gJ251bWJlcicgPyAnMCcgOiB0eXBlID09PSAnc3RyaW5nJyA/IFwiJydcIiA6ICdudWxsJztcbiAgICB9XG4gICAgY29uc3QgcmF3ID0gU3RyaW5nKHByb3AuZGVmYXVsdCk7XG4gICAgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIC8vIOiwg+eUqOaWueW3sue7j+WGmeS6huWtl+mdoumHj++8iOW4puW8leWPty/lj43lvJXlj7fvvInlsLHljp/moLfkv53nlZnvvIzlkKbliJnmjInlrZfnrKbkuLLlrZfpnaLph4/ovpPlh7pcbiAgICAgICAgcmV0dXJuIC9eWydcImBdLy50ZXN0KHJhdykgPyByYXcgOiBKU09OLnN0cmluZ2lmeShyYXcpO1xuICAgIH1cbiAgICByZXR1cm4gcmF3O1xufVxuXG4vKiog55Sf5oiQ5rqQ56CB5pe26ZyA6KaB6Ieq5Yqo6KGl6L+bIGNjIGltcG9ydCDnmoTluLjnlKjnsbvlnovooaggKi9cbmNvbnN0IENDX1RZUEVfTkFNRVM6IHN0cmluZ1tdID0gW1xuICAgICdOb2RlJywgJ0xhYmVsJywgJ0J1dHRvbicsICdTcHJpdGUnLCAnU3ByaXRlRnJhbWUnLCAnU3ByaXRlQXRsYXMnLCAnVG9nZ2xlJywgJ0xheW91dCcsICdXaWRnZXQnLFxuICAgICdTY3JvbGxWaWV3JywgJ0VkaXRCb3gnLCAnU2xpZGVyJywgJ1Byb2dyZXNzQmFyJywgJ0dyYXBoaWNzJywgJ0FuaW1hdGlvbicsICdBdWRpb1NvdXJjZScsXG4gICAgJ1ZlYzInLCAnVmVjMycsICdDb2xvcicsICdTaXplJywgJ1ByZWZhYicsICdNYXNrJywgJ1JpY2hUZXh0JywgJ1VJT3BhY2l0eScsICdFdmVudEhhbmRsZXInLFxuXTtcblxuLyoqIOS7juWxnuaAp+WjsOaYjuS4juexu+S9k+mHjOaUtumbhueUqOWIsOeahCBjYyDnsbvlnovvvIznlJ/miJAgaW1wb3J0IOWIl+ihqCAqL1xuZnVuY3Rpb24gY29sbGVjdENjVHlwZXMocHJvcGVydGllczogYW55W10sIGJvZHk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCB1c2VkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBwcm9wIG9mIHByb3BlcnRpZXMgfHwgW10pIHtcbiAgICAgICAgY29uc3QgdHlwZSA9IFN0cmluZyhwcm9wPy50eXBlIHx8ICcnKS50cmltKCk7XG4gICAgICAgIGlmIChDQ19UWVBFX05BTUVTLmluY2x1ZGVzKHR5cGUpKSB1c2VkLmFkZCh0eXBlKTtcbiAgICB9XG4gICAgaWYgKGJvZHkpIHtcbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIENDX1RZUEVfTkFNRVMpIHtcbiAgICAgICAgICAgIGlmIChuZXcgUmVnRXhwKGBcXFxcYiR7bmFtZX1cXFxcYmApLnRlc3QoYm9keSkpIHVzZWQuYWRkKG5hbWUpO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBBcnJheS5mcm9tKHVzZWQpLnNvcnQoKTtcbn1cblxuLyoqIOeUn+aIkOiEmuacrOa6kOeggSAqL1xuZnVuY3Rpb24gYnVpbGRTY3JpcHRTb3VyY2UoY2xhc3NOYW1lOiBzdHJpbmcsIHByb3BlcnRpZXM6IGFueVtdLCBib2R5OiBzdHJpbmcsIGltcG9ydHM6IHN0cmluZ1tdID0gW10pOiBzdHJpbmcge1xuICAgIGNvbnN0IHByb3BMaW5lcyA9IChwcm9wZXJ0aWVzIHx8IFtdKVxuICAgICAgICAubWFwKChwcm9wKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gcHJvcC50eXBlIHx8ICdudW1iZXInO1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSByZW5kZXJEZWZhdWx0KHByb3AsIHR5cGUpO1xuICAgICAgICAgICAgcmV0dXJuIGAgICAgQHByb3BlcnR5XFxuICAgICR7cHJvcC5uYW1lfTogJHt0eXBlfSA9ICR7dmFsdWV9O2A7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCdcXG4nKTtcblxuICAgIGNvbnN0IGV4dHJhVHlwZXMgPSBjb2xsZWN0Q2NUeXBlcyhwcm9wZXJ0aWVzIHx8IFtdLCBib2R5KTtcbiAgICBjb25zdCBpbXBvcnRMaW5lID0gZXh0cmFUeXBlcy5sZW5ndGhcbiAgICAgICAgPyBgaW1wb3J0IHsgX2RlY29yYXRvciwgQ29tcG9uZW50LCAke2V4dHJhVHlwZXMuam9pbignLCAnKX0gfSBmcm9tICdjYyc7YFxuICAgICAgICA6IGBpbXBvcnQgeyBfZGVjb3JhdG9yLCBDb21wb25lbnQgfSBmcm9tICdjYyc7YDtcblxuICAgIHJldHVybiBbXG4gICAgICAgIGltcG9ydExpbmUsXG4gICAgICAgIC4uLihpbXBvcnRzIHx8IFtdKS5maWx0ZXIoKGxpbmUpID0+IHR5cGVvZiBsaW5lID09PSAnc3RyaW5nJyAmJiBsaW5lLnRyaW0oKSksXG4gICAgICAgIGBjb25zdCB7IGNjY2xhc3MsIHByb3BlcnR5IH0gPSBfZGVjb3JhdG9yO2AsXG4gICAgICAgIGBgLFxuICAgICAgICBgQGNjY2xhc3MoJyR7Y2xhc3NOYW1lfScpYCxcbiAgICAgICAgYGV4cG9ydCBjbGFzcyAke2NsYXNzTmFtZX0gZXh0ZW5kcyBDb21wb25lbnQge2AsXG4gICAgICAgIHByb3BMaW5lcyxcbiAgICAgICAgcHJvcExpbmVzID8gYGAgOiBgYCxcbiAgICAgICAgYCAgICBzdGFydCgpIHtgLFxuICAgICAgICBgICAgICAgICBjb25zb2xlLmxvZygnWyR7Y2xhc3NOYW1lfV0gc3RhcnQnKTtgLFxuICAgICAgICBgICAgIH1gLFxuICAgICAgICBib2R5ID8gYGAgOiBgYCxcbiAgICAgICAgYm9keSB8fCBgYCxcbiAgICAgICAgYH1gLFxuICAgICAgICBgYCxcbiAgICBdLmpvaW4oJ1xcbicpO1xufVxuXG5jb25zdCBzY3JpcHRDcmVhdGU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjcmlwdC5jcmVhdGUnLFxuICAgIHRpdGxlOiAn5Yib5bu66ISa5pysJyxcbiAgICBkZXNjcmlwdGlvbjogJ+WcqCBhc3NldHMg5LiL5Yib5bu65LiA5LiqIFR5cGVTY3JpcHQg6ISa5pys77yI6Ieq5Yqo5oyCIGNjY2xhc3PvvInvvIzlubbnrYnlvoXlroPooqsgQ3JlYXRvciDnvJbor5Hms6jlhozvvIzov5Tlm54gY2lkJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgcGF0aDogJ+iEmuacrOi3r+W+hO+8jOWmgiBkYjovL2Fzc2V0cy9zY3JpcHRzL1BsYXllci50c++8m+eVmeepuuWImeeUqCBkYjovL2Fzc2V0cy9zY3JpcHRzLzznsbvlkI0+LnRzJyxcbiAgICAgICAgY2xhc3NOYW1lOiAn57G75ZCN77yM6buY6K6k5Y+W5paH5Lu25ZCNJyxcbiAgICAgICAgcHJvcGVydGllczogJ+WxnuaAp+WjsOaYjuaVsOe7hO+8jOW9ouWmgiBbe1wibmFtZVwiOlwic3BlZWRcIixcInR5cGVcIjpcIm51bWJlclwiLFwiZGVmYXVsdFwiOjF9XScsXG4gICAgICAgIGJvZHk6ICfpop3lpJbnmoTnsbvkvZPku6PnoIHvvIznm7TmjqXmj5LlhaXliLAgY2xhc3Mg6YeMJyxcbiAgICAgICAgaW1wb3J0czogJ+mineWklueahCBpbXBvcnQg6K+t5Y+l5pWw57uE77yI5byV55So5YW25LuW55So5oi36ISa5pys5pe255So77yJ77yM6YCQ6KGM5o+S5YiwIGNjIGltcG9ydCDkuYvlkI4nLFxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI3mlofku7blt7LlrZjlnKjml7bmmK/lkKbopobnm5bvvIzpu5jorqQgZmFsc2UnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBwYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iEmuacrOi3r+W+hO+8jOWmgiBkYjovL2Fzc2V0cy9zY3JpcHRzL1BsYXllci50cycgfSxcbiAgICAgICAgICAgIGNsYXNzTmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnsbvlkI3vvIzpu5jorqTlj5bmlofku7blkI0nIH0sXG4gICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+WxnuaAp+WjsOaYjuaVsOe7hCcsXG4gICAgICAgICAgICAgICAgaXRlbXM6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6IHt9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYm9keTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfpop3lpJbnmoTnsbvkvZPku6PnoIEnIH0sXG4gICAgICAgICAgICBpbXBvcnRzOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgICAgICAgICBpdGVtczogeyB0eXBlOiAnc3RyaW5nJyB9LFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn6aKd5aSW55qEIGltcG9ydCDor63lj6XvvIzpgJDooYzljp/moLfmj5LlhaXliLAgY2MgaW1wb3J0IOS5i+WQjicsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb3ZlcndyaXRlOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICflkIzlkI3mlofku7blt7LlrZjlnKjml7bmmK/lkKbopobnm5YnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IHBhdGggPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3BhdGgnLCAnJykudHJpbSgpO1xuICAgICAgICBjb25zdCBvdmVyd3JpdGUgPSBwYXJhbXM/Lm92ZXJ3cml0ZSA9PT0gdHJ1ZTtcblxuICAgICAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgICAgIGNvbnN0IGNsYXNzTmFtZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAnY2xhc3NOYW1lJywgJycpLnRyaW0oKSB8fCAnTWNwU2NyaXB0JztcbiAgICAgICAgICAgIHBhdGggPSBgZGI6Ly9hc3NldHMvc2NyaXB0cy8ke2NsYXNzTmFtZX0udHNgO1xuICAgICAgICB9XG4gICAgICAgIGlmICghL1xcLnRzJC8udGVzdChwYXRoKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDohJrmnKzot6/lvoTlv4Xpobvku6UgLnRzIOe7k+WwvjogJHtwYXRofWApO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcGF0aC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDohJrmnKzlv4XpobvliJvlu7rlnKggZGI6Ly9hc3NldHMvIOS4izogJHtwYXRofWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSBwYXRoLnNsaWNlKHBhdGgubGFzdEluZGV4T2YoJy8nKSArIDEpLnJlcGxhY2UoL1xcLnRzJC8sICcnKTtcbiAgICAgICAgY29uc3QgY2xhc3NOYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICdjbGFzc05hbWUnLCAnJykudHJpbSgpIHx8IGZpbGVOYW1lO1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBidWlsZFNjcmlwdFNvdXJjZShcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcmFtcz8ucHJvcGVydGllcyB8fCBbXSxcbiAgICAgICAgICAgIHBpY2tTdHJpbmcocGFyYW1zLCAnYm9keScsICcnKSxcbiAgICAgICAgICAgIEFycmF5LmlzQXJyYXkocGFyYW1zPy5pbXBvcnRzKSA/IHBhcmFtcy5pbXBvcnRzIDogW11cbiAgICAgICAgKTtcblxuICAgICAgICAvLyBvdmVyd3JpdGU9dHJ1Ze+8muWFiOWIoOmZpOWQjOWQjeaXp+i1hOa6kOWGjeWIm+W7uu+8iOS4jeeEtiBjcmVhdGUtYXNzZXQg5Lya5Zug5paH5Lu25bey5a2Y5Zyo6L+U5Zue56m677yJXG4gICAgICAgIGlmIChvdmVyd3JpdGUpIHtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IHBhdGggfSk7XG4gICAgICAgICAgICBjb25zdCBoaXQgPSAoZXhpc3RpbmcgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gcGF0aCk7XG4gICAgICAgICAgICBpZiAoaGl0KSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2RlbGV0ZS1hc3NldCcsIGhpdC51dWlkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQ6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdjcmVhdGUtYXNzZXQnLCBwYXRoLCBzb3VyY2UpO1xuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgY3JlYXRlLWFzc2V0IOayoeaciei/lOWbnui1hOa6kOS/oeaBrzogJHtwYXRofe+8iOWQjOWQjeaWh+S7tuW3suWtmOWcqO+8n+WPr+S8oCBvdmVyd3JpdGU9dHJ1ZSDopobnm5bvvIlgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHV1aWQgPSBjcmVhdGVkLnV1aWQ7XG4gICAgICAgIGNvbnN0IGNvbXBpbGVkID0gYXdhaXQgd2FpdEZvclNjcmlwdENvbXBpbGVkKHV1aWQsIDMwMDAwKTtcbiAgICAgICAgaWYgKCFjb21waWxlZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICB1dWlkLFxuICAgICAgICAgICAgICAgIHVybDogY3JlYXRlZC51cmwsXG4gICAgICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgY29tcGlsZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGVycm9yOiAn6ISa5pys5bey5YaZ5YWl77yM5L2GIDMwIOenkuWGheayoeacieWcqOe8lui+keWZqOmHjOWujOaIkOe8luivkeazqOWGjO+8iOWPr+iDveivreazlemUmeivr++8jOaIlue8lui+keWZqOacquWcqOe8luivke+8iScsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHV1aWQsXG4gICAgICAgICAgICB1cmw6IGNyZWF0ZWQudXJsLFxuICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIGNvbXBpbGVkOiB0cnVlLFxuICAgICAgICAgICAgY2lkOiBjb21waWxlZC5jaWQsXG4gICAgICAgICAgICBuYW1lOiBjb21waWxlZC5uYW1lLFxuICAgICAgICAgICAgY29tcG9uZW50UGF0aDogY29tcGlsZWQucGF0aCxcbiAgICAgICAgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NyaXB0TGlzdDogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NyaXB0Lmxpc3QnLFxuICAgIHRpdGxlOiAn5YiX5Ye66ISa5pys57uE5Lu2JyxcbiAgICBkZXNjcmlwdGlvbjogJ+WIl+WHuue8lui+keWZqOmHjOW3suazqOWGjOeahOWFqOmDqOe7hOS7tu+8iOWGhee9riArIOeUqOaIt+iEmuacrO+8ie+8jOW4piBjaWQgLyBwYXRoIC8gYXNzZXRVdWlkJyxcbiAgICBwYXJhbXM6IHt9LFxuICAgIHNjaGVtYTogbm9QYXJhbXMoKSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIGNvbnN0IGxpc3Q6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKTtcbiAgICAgICAgY29uc3QgaXRlbXMgPSAobGlzdCB8fCBbXSkubWFwKChpdGVtKSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lLFxuICAgICAgICAgICAgY2lkOiBpdGVtLmNpZCxcbiAgICAgICAgICAgIHBhdGg6IGl0ZW0ucGF0aCxcbiAgICAgICAgICAgIGFzc2V0VXVpZDogaXRlbS5hc3NldFV1aWQsXG4gICAgICAgICAgICBpc1NjcmlwdDogISFpdGVtLmFzc2V0VXVpZCxcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4geyB0b3RhbDogaXRlbXMubGVuZ3RoLCBjb21wb25lbnRzOiBpdGVtcyB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlQWRkQ29tcG9uZW50OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmFkZENvbXBvbmVudCcsXG4gICAgdGl0bGU6ICfmjILovb3nu4Tku7YnLFxuICAgIGRlc2NyaXB0aW9uOiAn57uZ6IqC54K55oyC57uE5Lu277ya5YaF572u57uE5Lu25LygIGNjLlNwcml0ZSDkuYvnsbvvvIznlKjmiLfohJrmnKzkvKAgc2NyaXB0Lmxpc3Qg5p+l5Yiw55qEIGNpZCcsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIG5vZGU6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXG4gICAgICAgIGNvbXBvbmVudDogJ+e7hOS7tiBjaWQg5oiW57G75ZCN77yM5aaCIGNjLlNwcml0ZSAvIGZjbVIzWEFETkxnSjFCeUtocWNDNVonLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgY29tcG9uZW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tiBjaWQg5oiW57G75ZCNJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydjb21wb25lbnQnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2NvbXBvbmVudCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghY29tcG9uZW50KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBjb21wb25lbnQnKTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgbm9kZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAnbm9kZScsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgbm9kZSA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICB9XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrproioLngrnvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOW5guetie+8muWQjOiKgueCueS4jeWFgeiuuOWQjOexu+Wei+e7hOS7tumHjeWkjeaMgui9ve+8jOWFiOafpeW3suaciee7hOS7tu+8jOWRveS4reWwseebtOaOpei/lOWbnu+8jFxuICAgICAgICAvLyDpgb/lhY3nvJbovpHlmajmiZPljbAgXCJDYW4ndCBhZGQgY29tcG9uZW50IC4uLiBhbHJlYWR5IGNvbnRhaW5zIHRoZSBzYW1lIGNvbXBvbmVudFwiIOitpuWRiuW5tuaxoeafkyB1bmRvXG4gICAgICAgIGNvbnN0IGNvbXBzQmVmb3JlID0gYXdhaXQgcXVlcnlOb2RlQ29tcG9uZW50cyhub2RlKTtcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGF3YWl0IHJlc29sdmVDb21wb25lbnRDYW5kaWRhdGVzKGNvbXBvbmVudCk7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWF0Y2hFeGlzdGluZ0NvbXBvbmVudChjb21wc0JlZm9yZSwgY2FuZGlkYXRlcyk7XG4gICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICAgIGNvbXBvbmVudCxcbiAgICAgICAgICAgICAgICBjaGFubmVsOiAnbm9uZScsXG4gICAgICAgICAgICAgICAgYXR0YWNoZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgYWxyZWFkeUV4aXN0czogdHJ1ZSxcbiAgICAgICAgICAgICAgICBleGlzdGluZzogeyB1dWlkOiBleGlzdGluZy51dWlkLCB0eXBlOiBleGlzdGluZy50eXBlLCBuYW1lOiBleGlzdGluZy5uYW1lIH0sXG4gICAgICAgICAgICAgICAgY29tcG9uZW50czogY29tcHNCZWZvcmUsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5YaF572u57uE5Lu277yIY2MuU3ByaXRlIOS5i+exu++8iei1sOe8lui+keWZqOa2iOaBr+mAmumBk++8jOiDvei/myB1bmRvIOS9k+ezu1xuICAgICAgICBjb25zdCBpc0J1aWx0aW4gPSBjb21wb25lbnQuc3RhcnRzV2l0aCgnY2MuJyk7XG4gICAgICAgIGxldCBjaGFubmVsID0gJ21lc3NhZ2UnO1xuXG4gICAgICAgIGlmIChpc0J1aWx0aW4pIHtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdjcmVhdGUtY29tcG9uZW50JywgeyB1dWlkOiBub2RlLCBjb21wb25lbnQgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyDoh6rlrprkuYnohJrmnKznu4Tku7blv4XpobvotbDlvJXmk47vvJrnvJbovpHlmajmtojmga/pgJrpgZPmjILkuI3kuIrljrtcbiAgICAgICAgICAgIGNoYW5uZWwgPSAnZW5naW5lJztcbiAgICAgICAgICAgIGNvbnN0IHNjcmlwdFJlc3VsdDogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnYWRkQ29tcG9uZW50VG9Ob2RlJyxcbiAgICAgICAgICAgICAgICBhcmdzOiBbbm9kZSwgY29tcG9uZW50XSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKCFzY3JpcHRSZXN1bHQgfHwgc2NyaXB0UmVzdWx0Lm9rICE9PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBg5oyC6L296Ieq5a6a5LmJ57uE5Lu25aSx6LSl77yaJHtzY3JpcHRSZXN1bHQgJiYgc2NyaXB0UmVzdWx0LmVycm9yID8gc2NyaXB0UmVzdWx0LmVycm9yIDogJ+acquefpemUmeivryd9YCArXG4gICAgICAgICAgICAgICAgICAgIChzY3JpcHRSZXN1bHQgJiYgc2NyaXB0UmVzdWx0LnJlZ2lzdGVyZWRVc2VyQ2xhc3Nlc1xuICAgICAgICAgICAgICAgICAgICAgICAgPyBg77yb5byV5pOO6YeM5bey5rOo5YaM55qE55So5oi357G7OiAke3NjcmlwdFJlc3VsdC5yZWdpc3RlcmVkVXNlckNsYXNzZXMuam9pbignLCAnKSB8fCAnKOaXoCknfWBcbiAgICAgICAgICAgICAgICAgICAgICAgIDogJycpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGNyZWF0ZS1jb21wb25lbnQgLyBhZGRDb21wb25lbnQg6YO95LiN6L+U5Zue5pyJ5pWI5YC877yM5b+F6aG75Zue6K+756Gu6K6kXG4gICAgICAgIGNvbnN0IGNvbXBzID0gYXdhaXQgcXVlcnlOb2RlQ29tcG9uZW50cyhub2RlKTtcbiAgICAgICAgY29uc3QgYXR0YWNoZWQgPSBtYXRjaEV4aXN0aW5nQ29tcG9uZW50KGNvbXBzLCBjYW5kaWRhdGVzKTtcbiAgICAgICAgaWYgKCFhdHRhY2hlZCkge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGNvbXBzLm1hcCgoYzogYW55KSA9PiBjLnR5cGUgfHwgYy5uYW1lKS5qb2luKCcsICcpIHx8ICco5pegKSc7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgYOe7hOS7tuayoeacieecn+ato+aMguS4iu+8muiKgueCuSAke25vZGV9IOS4iuayoeacieWHuueOsOe7hOS7tuOAjCR7Y29tcG9uZW50feOAje+8iOmAmumBk++8miR7Y2hhbm5lbH3vvInvvJtgICtcbiAgICAgICAgICAgICAgICBg5b2T5YmN57uE5Lu2OiAke2N1cnJlbnR9YFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBub2RlLCBjb21wb25lbnQsIGNoYW5uZWwsIGF0dGFjaGVkOiB0cnVlLCBjb21wb25lbnRzOiBjb21wcyB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlUmVtb3ZlQ29tcG9uZW50OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLnJlbW92ZUNvbXBvbmVudCcsXG4gICAgdGl0bGU6ICfnp7vpmaTnu4Tku7YnLFxuICAgIGRlc2NyaXB0aW9uOiAn5oyJ57uE5Lu2IHV1aWQg56e76Zmk6IqC54K55LiK55qE57uE5Lu2JyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu2IHV1aWQnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBjb21wb25lbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn57uE5Lu2IHV1aWQnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ2NvbXBvbmVudCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnY29tcG9uZW50JywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFjb21wb25lbnQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIGNvbXBvbmVudCB1dWlkJyk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3JlbW92ZS1jb21wb25lbnQnLCB7IHV1aWQ6IGNvbXBvbmVudCB9KTtcbiAgICAgICAgcmV0dXJuIHsgY29tcG9uZW50LCByZW1vdmVkOiB0cnVlIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVMaXN0Q29tcG9uZW50czogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5saXN0Q29tcG9uZW50cycsXG4gICAgdGl0bGU6ICfliJflh7roioLngrnnu4Tku7YnLFxuICAgIGRlc2NyaXB0aW9uOiAn5YiX5Ye65p+Q5Liq6IqC54K55LiK5oyC55qE5omA5pyJ57uE5Lu2JyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgbm9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBsZXQgbm9kZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAnbm9kZScsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgbm9kZSA9IHNlbGVjdGVkWzBdIHx8ICcnO1xuICAgICAgICB9XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrproioLngrnvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZE5vZGVJblRyZWUodHJlZSwgbm9kZSk7XG4gICAgICAgIGlmICghZm91bmQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5qCR6YeM5om+5LiN5Yiw6IqC54K5ICR7bm9kZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjb21wcyA9IHJlYWROb2RlQ29tcG9uZW50cyhmb3VuZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgbm9kZU5hbWU6IGR1bXBWYWx1ZTxzdHJpbmc+KGZvdW5kLm5hbWUsICcnKSxcbiAgICAgICAgICAgIGNvdW50OiBjb21wcy5sZW5ndGgsXG4gICAgICAgICAgICBjb21wb25lbnRzOiBjb21wcyxcbiAgICAgICAgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZURlYnVnOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmRlYnVnJyxcbiAgICB0aXRsZTogJ+iwg+ivle+8muWOn+Wni+iKgueCuSBkdW1wJyxcbiAgICBkZXNjcmlwdGlvbjogJ+i/lOWbnuiKgueCueWcqOe8lui+keWZqCBkdW1wIOmHjOeahOWOn+Wni+Wtl+aute+8jOeUqOadpeaRuOa4hSAzLjguOCDnnJ/lrp7nmoTnu4Tku7blrZfmrrXlkI0nLFxuICAgIHBhcmFtczoge1xuICAgICAgICBub2RlOiAn6IqC54K5IHV1aWQnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlkJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydub2RlJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgdXVpZCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnbm9kZScsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghdXVpZCkgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogbm9kZScpO1xuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIGNvbnN0IGZpbmQgPSAobm9kZTogYW55KTogYW55ID0+IHtcbiAgICAgICAgICAgIGlmICghbm9kZSkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAoZHVtcFZhbHVlPHN0cmluZz4obm9kZS51dWlkLCAnJykgPT09IHV1aWQpIHJldHVybiBub2RlO1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiAobm9kZS5jaGlsZHJlbiB8fCBbXSkpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBoaXQgPSBmaW5kKGNoaWxkKTtcbiAgICAgICAgICAgICAgICBpZiAoaGl0KSByZXR1cm4gaGl0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZCh0cmVlKTtcbiAgICAgICAgY29uc3QgZGlyZWN0OiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZScsIHV1aWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZm91bmRJblRyZWU6ICEhZm91bmQsXG4gICAgICAgICAgICB0cmVlTm9kZUtleXM6IGZvdW5kID8gT2JqZWN0LmtleXMoZm91bmQpIDogW10sXG4gICAgICAgICAgICB0cmVlTm9kZTogZm91bmQgfHwgbnVsbCxcbiAgICAgICAgICAgIGRpcmVjdFF1ZXJ5S2V5czogZGlyZWN0ID8gT2JqZWN0LmtleXMoZGlyZWN0KSA6IFtdLFxuICAgICAgICAgICAgZGlyZWN0UXVlcnk6IGRpcmVjdCB8fCBudWxsLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOWcuuaZr+aIquWbvlxuXG5jb25zdCBzY2VuZUNhcHR1cmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLmNhcHR1cmUnLFxuICAgIHRpdGxlOiAn5Zy65pmv5oiq5Zu+JyxcbiAgICBkZXNjcmlwdGlvbjogJ+aIquWPluWcuuaZr+mdouadv+inhuWPo+S4uiBiYXNlNjQgSlBFR++8iOWQq+e8lui+keWZqOe9keagvC9naXptb++8jOmdnui/kOihjOaXtueUu+mdou+8ieOAguS7heW9k+WcuuaZr+S4reWtmOWcqCBDYW52YXMg6IqC54K55pe25Y+v55So44CC6L+U5ZueIHNvdXJjZVdpZHRoL0hlaWdodCDkuLrnlLvluIPniannkIblg4/ntKDvvIxvdXRwdXRXaWR0aC9IZWlnaHQg5Li657yp5pS+5ZCO5bC65a+444CC5LygIG91dFBhdGgg5Y+v5ZCM5pe25oqK5Zu+54mH5YaZ5Yiw56OB55uY77yI57ud5a+56Lev5b6E77yJJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgbWF4VzogJ+i+k+WHuuWbvuWuveW6puS4iumZkO+8iOWDj+e0oO+8ie+8jOm7mOiupCA3NjgnLFxuICAgICAgICBvdXRQYXRoOiAn5Y+v6YCJ77ya5oqKIEpQRUcg5YaZ5Yiw6K+l57ud5a+56Lev5b6E77yI55uu5b2V5Lya6Ieq5Yqo5Yib5bu677yJJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgbWF4VzogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfovpPlh7rlm77lrr3luqbkuIrpmZDvvIjlg4/ntKDvvInvvIzpu5jorqQgNzY4JyB9LFxuICAgICAgICAgICAgb3V0UGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInvvJpKUEVHIOiQveebmOeahOe7neWvuei3r+W+hCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBtYXhXID0gcGlja051bWJlcihwYXJhbXMsICdtYXhXJywgNzY4KSB8fCA3Njg7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICBtZXRob2Q6ICdjYXB0dXJlU2NlbmUnLFxuICAgICAgICAgICAgYXJnczogW21heFddLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyZXN1bHQgfHwgcmVzdWx0Lm9rID09PSBmYWxzZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKChyZXN1bHQgJiYgcmVzdWx0LmVycm9yKSB8fCAn5Zy65pmv5oiq5Zu+5aSx6LSlJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb3V0UGF0aCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnb3V0UGF0aCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmIChvdXRQYXRoICYmIHJlc3VsdC5iYXNlNjQpIHtcbiAgICAgICAgICAgIGNvbnN0IGFicyA9IHJlc29sdmUob3V0UGF0aCk7XG4gICAgICAgICAgICBhd2FpdCBta2RpcihkaXJuYW1lKGFicyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgYXdhaXQgd3JpdGVGaWxlKGFicywgQnVmZmVyLmZyb20oU3RyaW5nKHJlc3VsdC5iYXNlNjQpLCAnYmFzZTY0JykpO1xuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmVzdWx0LCBiYXNlNjQ6IHVuZGVmaW5lZCwgc2F2ZWRUbzogYWJzIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVSZW9wZW46IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLnJlb3BlbicsXG4gICAgdGl0bGU6ICfph43lvIDlnLrmma8nLFxuICAgIGRlc2NyaXB0aW9uOiAn5L+d5a2Y5b2T5YmN5Zy65pmv5ZCO6YeN5paw5omT5byA5a6D77yM6Kem5Y+R5Zy65pmv6L+b56iL6YeN5paw5a+85YWl55So5oi36ISa5pys5qih5Z2X77yI5aSW6YOo5YaZ5YWl55qEIC50cyDnvJbor5HlkI7pnIDopoHov5nkuIDmraXmiY3og73lnKjlvJXmk47ph4zmjILovb3vvIknLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSwgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH0sXG4gICAgYXN5bmMgcnVuKCkge1xuICAgICAgICBjb25zdCBzYXZlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnc2F2ZS1zY2VuZScpO1xuICAgICAgICBjb25zdCBzdGF0dXM6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1jdXJyZW50LXNjZW5lJyk7XG4gICAgICAgIGNvbnN0IHV1aWQgPSB0eXBlb2Ygc3RhdHVzID09PSAnc3RyaW5nJyA/IHN0YXR1cyA6IChzdGF0dXMgJiYgc3RhdHVzLnV1aWQpO1xuICAgICAgICBpZiAoIXV1aWQpIHRocm93IG5ldyBFcnJvcign5ou/5LiN5Yiw5b2T5YmN5Zy65pmvIHV1aWQ6ICcgKyBKU09OLnN0cmluZ2lmeShzdGF0dXMpKTtcbiAgICAgICAgLy8g5bey5omT5byA5Zy65pmv55qEIG9wZW4tc2NlbmUg5Y+v6IO96KKr5b+955Wl77ya5YWI5YiH5Yiw56m65Zy65pmv5YaN5YiH5Zue77yM5by65Yi25Zy65pmv6L+b56iL6YeN6L296ISa5pys5qih5Z2XXG4gICAgICAgIGxldCBlbXB0eTogYW55ID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGVtcHR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2xvYWQtZW1wdHktc2NlbmUnKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgZW1wdHkgPSBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfHwgZSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ29wZW4tc2NlbmUnLCB1dWlkKTtcbiAgICAgICAgcmV0dXJuIHsgc2F2ZWQ6IHNhdmUsIHNjZW5lVXVpZDogdXVpZCwgZW1wdHksIG9wZW5lZCB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZUNyZWF0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuY3JlYXRlJyxcbiAgICB0aXRsZTogJ+aWsOW7uuWcuuaZrycsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfnlKggYXNzZXQtZGIvbmV3LWFzc2V0IOaMiee8lui+keWZqOWGhee9ruaooeadv+aWsOW7uuWcuuaZr++8jOS4jui1hOa6kOeuoeeQhuWZqOWPs+mUruOAjOaWsOW7uiDihpIg5Zy65pmv44CN5ZCM5LiA6YCa6YGTJyArXG4gICAgICAgICfvvIhoYW5kbGVyPXNjZW5l77yMdGVtcGxhdGU9ZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X2ZpbGVfY29udGVudC9zY2VuZS9zY2VuZS0yZC5zY2VuZe+8ieOAgicgK1xuICAgICAgICAn5rOo5oSP77yaY3JlYXRlLWFzc2V0IOS8oCBudWxsIOWGheWuueWcqCAzLjguOCDlrp7mtYvliJvlu7rnmoTmmK/nm67lvZXogIzpnZ7lnLrmma/mlofku7bvvIzkuI3opoHnlKjlroPlu7rlnLrmma/jgIInICtcbiAgICAgICAgJ+eItuebruW9leS4jeWtmOWcqOS8muiHquWKqOmAkOe6p+WIm+W7uuOAgm9wZW49dHJ1ZSDml7bliJvlu7rlkI4gb3Blbi1zY2VuZSDlubbova7or6Lnoa7orqTliIfmjaLlrozmiJDvvJsnICtcbiAgICAgICAgICAgICflvZPliY3lnLrmma/mmK/ml6DmoIfpopjmnKrkv53lrZjlnLrmma/ml7bnvJbovpHlmajkvJrlvLnkv53lrZjlr7nor53moYbvvIzkurrlt6XlpITnkIblkI7ova7or6Loh6rliqjnu6fnu63vvIzotoXml7bov5Tlm54gb3BlbmVkPWZhbHNlIOW5tue7meaPkOekuuOAgicgK1xuICAgICAgICAgICAgJ+mihOWItuS9k+e8lui+keaooeW8j+S4iyBvcGVuPXRydWUg5Lya5YWI5oql6ZSZ5ouS57ud77yI5YiH5o2i5Y+v6IO95by544CM5piv5ZCm5L+d5a2Y44CN5a+56K+d5qGG5LiU5peg5rOV6Ieq5Yqo5aSE55CG77yJ77yM56Gu6K6k5YyF6KO55Zy65pmv5bmy5YeA5Y+v5LygIGFzc3VtZUNsZWFuPXRydWXjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1cmw6ICfmlrDlnLrmma8gZGI6Ly8g6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjZW5lcy9oZWxsb3dvcmxkLnNjZW5lJyxcbiAgICAgICAgdGVtcGxhdGU6IFwiJzJkJ++8iOm7mOiupO+8jOWQqyBDYW52YXMrQ2FtZXJh77yJLyAnZW1wdHkn77yI56m65Zy65pmv77yJ77yM5oiW5a6M5pW05qih5p2/6Lev5b6EIGRiOi8vaW50ZXJuYWwvZGVmYXVsdF9maWxlX2NvbnRlbnQvc2NlbmUveHh4LnNjZW5lXCIsXG4gICAgICAgIG9wZW46ICfliJvlu7rlkI7mmK/lkKbnq4vljbPmiZPlvIDor6XlnLrmma/vvIzpu5jorqQgZmFsc2UnLFxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI3mlofku7blt7LlrZjlnKjml7bmmK/lkKbopobnm5bvvIzpu5jorqQgZmFsc2UnLFxuICAgICAgICBvcGVuVGltZW91dDogJ29wZW49dHJ1ZSDml7bnrYnlvoXlnLrmma/liIfmjaLlrozmiJDnmoTotoXml7bmr6vnp5LvvIzpu5jorqQgMzAwMDAnLFxuICAgICAgICBhc3N1bWVDbGVhbjogJ+W9k+WJjeWkhOS6jumihOWItuS9k+e8lui+keaooeW8j+aXtuaYr+WQpui3s+i/h+WuieWFqOajgOafpee7p+e7reaJk+W8gO+8iOS7hemZkOehruiupOmihOWItuS9k+aXoOacquS/neWtmOS/ruaUue+8ie+8jOm7mOiupCBmYWxzZScsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHVybDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfmlrDlnLrmma8gZGI6Ly8g6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjZW5lcy9oZWxsb3dvcmxkLnNjZW5lJyB9LFxuICAgICAgICAgICAgdGVtcGxhdGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiBcIicyZCfvvIjpu5jorqTvvIkvICdlbXB0eSfvvIzmiJblrozmlbTmqKHmnb8gZGI6Ly8g6Lev5b6EXCIgfSxcbiAgICAgICAgICAgIG9wZW46IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WIm+W7uuWQjuaYr+WQpueri+WNs+aJk+W8gO+8jOm7mOiupCBmYWxzZScgfSxcbiAgICAgICAgICAgIG92ZXJ3cml0ZTogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5ZCM5ZCN5paH5Lu25bey5a2Y5Zyo5pe25piv5ZCm6KaG55uW77yM6buY6K6kIGZhbHNlJyB9LFxuICAgICAgICAgICAgb3BlblRpbWVvdXQ6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAn562J5b6F5Zy65pmv5YiH5o2i6LaF5pe25q+r56eS77yM6buY6K6kIDMwMDAwJyB9LFxuICAgICAgICAgICAgYXNzdW1lQ2xlYW46IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+mihOWItuS9k+e8lui+keaooeW8j+S4i+i3s+i/h+WuieWFqOajgOafpe+8jOm7mOiupCBmYWxzZScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsndXJsJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/lv4XpobvliJvlu7rlnKggZGI6Ly9hc3NldHMvIOS4izogJHt1cmx9YCk7XG4gICAgICAgIGlmICghdXJsLmVuZHNXaXRoKCcuc2NlbmUnKSkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/ot6/lvoTlv4Xpobvku6UgLnNjZW5lIOe7k+WwvjogJHt1cmx9YCk7XG4gICAgICAgIGNvbnN0IG92ZXJ3cml0ZSA9IHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlO1xuXG4gICAgICAgIC8vIOmihOWItuS9k+e8lui+keaooeW8j+S4i+WIh+aNouaWh+aho+S8muW8ueOAjOaYr+WQpuS/neWtmOOAjeWvueivneahhuS4lOaXoOazleiHquWKqOWkhOeQhu+8iHNhdmUtc2NlbmUg5a+56aKE5Yi25L2T5paH5qGj5peg5pWI77yJ77yMXG4gICAgICAgIC8vIOWFiOajgOa1i+WFiOaLkue7ne+8m+ehruiupOWMheijueWcuuaZr+aXoOacquS/neWtmOS/ruaUueaXtuWPryBhc3N1bWVDbGVhbj10cnVlIOi3s+i/h1xuICAgICAgICBsZXQgZnJvbVByZWZhYk1vZGUgPSBmYWxzZTtcbiAgICAgICAgaWYgKHBhcmFtcz8ub3BlbiA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgY29uc3QgbW9kZSA9IGF3YWl0IGRldGVjdFByZWZhYk1vZGUoKTtcbiAgICAgICAgICAgIGlmIChtb2RlLmluUHJlZmFiTW9kZSkge1xuICAgICAgICAgICAgICAgIGlmIChwYXJhbXM/LmFzc3VtZUNsZWFuICE9PSB0cnVlKSB0aHJvdyBwcmVmYWJNb2RlQmxvY2tlZEVycm9yKG1vZGUucHJlZmFiTmFtZSwgYOWIm+W7uuW5tuaJk+W8gOaWsOWcuuaZryAke3VybH1gKTtcbiAgICAgICAgICAgICAgICAvLyDmlrDlnLrmma/kuIDlrprkuI3mmK/jgIzlt7LliqDovb0gdXVpZOOAje+8jG9wZW4tc2NlbmUg5Y+v5Lul5q2j5bi45YiH5o2i77yI6KeBIHNjZW5lLm9wZW4g5YaF5rOo6YeK77yJ77yMXG4gICAgICAgICAgICAgICAgLy8g5L2GIHF1ZXJ5LWN1cnJlbnQtc2NlbmUg5Zyo6ISx56a75YmN5piv55uy55qE4oCU4oCU5LiL6Z2i55qE6L2u6K+i5Zyo6ISx56a75ZCO6Ieq54S25ou/5Yiw5q2j56GuIHV1aWRcbiAgICAgICAgICAgICAgICBmcm9tUHJlZmFiTW9kZSA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyDpgJDnuqfnoa7kv53niLbnm67lvZXlrZjlnKjvvIhjcmVhdGUtYXNzZXQg55qEIHNvdXJjZSDkvKAgbnVsbCDljbPliJvlu7rnm67lvZXvvIlcbiAgICAgICAgY29uc3QgZm9sZGVyU2VnbWVudHMgPSB1cmwuc2xpY2UoJ2RiOi8vYXNzZXRzLycubGVuZ3RoKS5zcGxpdCgnLycpLnNsaWNlKDAsIC0xKTtcbiAgICAgICAgbGV0IGZvbGRlclVybCA9ICdkYjovL2Fzc2V0cyc7XG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiBmb2xkZXJTZWdtZW50cykge1xuICAgICAgICAgICAgaWYgKCFzZWdtZW50KSBjb250aW51ZTtcbiAgICAgICAgICAgIGZvbGRlclVybCA9IGAke2ZvbGRlclVybH0vJHtzZWdtZW50fWA7XG4gICAgICAgICAgICBjb25zdCBleGlzdHMgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGZvbGRlclVybCk7XG4gICAgICAgICAgICBpZiAoIWV4aXN0cykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnY3JlYXRlLWFzc2V0JywgZm9sZGVyVXJsLCBudWxsKTtcbiAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHRocm93IG5ldyBFcnJvcihg5Yib5bu655uu5b2V5aSx6LSlOiAke2ZvbGRlclVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0ZW1wbGF0ZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAndGVtcGxhdGUnLCAnJykudHJpbSgpIHx8ICcyZCc7XG4gICAgICAgIGlmICh0ZW1wbGF0ZSA9PT0gJzJkJykgdGVtcGxhdGUgPSAnZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X2ZpbGVfY29udGVudC9zY2VuZS9zY2VuZS0yZC5zY2VuZSc7XG4gICAgICAgIGVsc2UgaWYgKHRlbXBsYXRlID09PSAnZW1wdHknIHx8IHRlbXBsYXRlID09PSAnM2QnKSB0ZW1wbGF0ZSA9ICdkYjovL2ludGVybmFsL2RlZmF1bHRfZmlsZV9jb250ZW50L3NjZW5lL2RlZmF1bHQuc2NlbmUnO1xuICAgICAgICBjb25zdCBpbmZvOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnbmV3LWFzc2V0Jywge1xuICAgICAgICAgICAgaGFuZGxlcjogJ3NjZW5lJyxcbiAgICAgICAgICAgIHRhcmdldDogdXJsLFxuICAgICAgICAgICAgdGVtcGxhdGUsXG4gICAgICAgICAgICBvdmVyd3JpdGUsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIWluZm8gfHwgIWluZm8udXVpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBuZXctYXNzZXQg5rKh5pyJ6L+U5Zue6LWE5rqQ5L+h5oGvOiAke3VybH3vvIjlkIzlkI3mlofku7blt7LlrZjlnKjvvJ/lj6/kvKAgb3ZlcndyaXRlPXRydWXvvIlgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXN1bHQ6IGFueSA9IHsgdXVpZDogaW5mby51dWlkLCB1cmw6IGluZm8udXJsIHx8IHVybCwgZmlsZTogaW5mby5maWxlIHx8IG51bGwsIHRlbXBsYXRlIH07XG5cbiAgICAgICAgaWYgKHBhcmFtcz8ub3BlbiA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgLy8g5LiN5YGaIGxvYWQtZW1wdHktc2NlbmXvvJrlroPkvJrkuqfnlJ/ml6DmoIfpopjlnLrmma/vvIzlr7zoh7Tpmo/lkI7nmoQgb3Blbi1zY2VuZSDlvLnjgIzkv53lrZjlvZPliY3lnLrmma/jgI3lr7nor53moYZcbiAgICAgICAgICAgIGNvbnN0IHRpbWVvdXQgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ29wZW5UaW1lb3V0JywgMzAwMDApIHx8IDMwMDAwO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnb3Blbi1zY2VuZScsIGluZm8udXVpZCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgLy8gb3Blbi1zY2VuZSDlj6/og73pnZnpu5jooqvlv73nlaXvvIzkuqTnu5nkuIvpnaLnmoTova7or6LliKTmlq1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXQ7XG4gICAgICAgICAgICBsZXQgY3VycmVudCA9ICcnO1xuICAgICAgICAgICAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXR1czogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKTtcbiAgICAgICAgICAgICAgICAgICAgY3VycmVudCA9IHR5cGVvZiBzdGF0dXMgPT09ICdzdHJpbmcnID8gc3RhdHVzIDogKHN0YXR1cyAmJiBzdGF0dXMudXVpZCkgfHwgJyc7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gJyc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50ID09PSBTdHJpbmcoaW5mby51dWlkKSkgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXN1bHQub3BlbmVkID0gY3VycmVudCA9PT0gU3RyaW5nKGluZm8udXVpZCk7XG4gICAgICAgICAgICByZXN1bHQuY3VycmVudFNjZW5lID0gY3VycmVudCB8fCBudWxsO1xuICAgICAgICAgICAgaWYgKGZyb21QcmVmYWJNb2RlKSByZXN1bHQuZnJvbVByZWZhYk1vZGUgPSB0cnVlO1xuICAgICAgICAgICAgaWYgKCFyZXN1bHQub3BlbmVkKSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0LmhpbnQgPSAn6LaF5pe25pyq5YiH5o2i5Yiw5paw5Zy65pmv77ya5b2T5YmN5Zy65pmv5pyq5L+d5a2Y5pe2IG9wZW4tc2NlbmUg5Lya5by55L+d5a2Y5a+56K+d5qGG77yM5Zyo57yW6L6R5Zmo6YeM5aSE55CG6K+l5a+56K+d5qGG5ZCO5Y+v55SoIHNjZW5lLm9wZW4g6YeN6K+VJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZU9wZW46IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLm9wZW4nLFxuICAgIHRpdGxlOiAn5omT5byA5Zy65pmvJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+aMiSBkYjovLyDot6/lvoTmiJYgdXVpZCDmiZPlvIDmjIflrprlnLrmma/vvIjpu5jorqTlhYjkv53lrZjlvZPliY3lnLrmma/lho3liIfmjaLvvIxzYXZlQ3VycmVudD1mYWxzZSDlj6/ot7Pov4fkv53lrZjvvInjgIInICtcbiAgICAgICAgJ+mihOWItuS9k+e8lui+keaooeW8j+S4i+S8muWFiOaKpemUmeaLkue7ne+8iHNhdmUtc2NlbmUg5a+56aKE5Yi25L2T5paH5qGj5peg5pWI44CB5YiH5o2i5Y+v6IO95by544CM5piv5ZCm5L+d5a2Y44CN5a+56K+d5qGG77yJ77yMJyArXG4gICAgICAgICfnoa7orqTljIXoo7nlnLrmma/lubLlh4Dlj6/kvKAgYXNzdW1lQ2xlYW49dHJ1Ze+8jOatpOaXtui3s+i/h+S/neWtmOS4jiBsb2FkLWVtcHR5LXNjZW5lIOebtOaOpeWIh+aNoicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHVybDogJ+WcuuaZr+i1hOS6pyBkYjovLyDot6/lvoTmiJYgdXVpZO+8jOWmgiBkYjovL2Fzc2V0cy9sb2JieS5zY2VuZScsXG4gICAgICAgIHNhdmVDdXJyZW50OiAn5YiH5o2i5YmN5piv5ZCm5L+d5a2Y5b2T5YmN5Zy65pmv77yM6buY6K6kIHRydWUnLFxuICAgICAgICBhc3N1bWVDbGVhbjogJ+W9k+WJjeWkhOS6jumihOWItuS9k+e8lui+keaooeW8j+aXtuaYr+WQpui3s+i/h+WuieWFqOajgOafpee7p+e7reWIh+aNou+8iOS7hemZkOehruiupOmihOWItuS9k+aXoOacquS/neWtmOS/ruaUue+8ie+8jOm7mOiupCBmYWxzZScsXG4gICAgICAgIHRpbWVvdXQ6ICdhc3N1bWVDbGVhbiDliIfmjaLot6/lvoTvvIhvcGVuLWFzc2V0IOmAmumBk++8ieeahOi9ruivoui2heaXtuavq+enku+8jOm7mOiupCAzMDAwMCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHVybDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflnLrmma/otYTkuqcgZGI6Ly8g6Lev5b6E5oiWIHV1aWQnIH0sXG4gICAgICAgICAgICBzYXZlQ3VycmVudDogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6buY6K6kIHRydWUnIH0sXG4gICAgICAgICAgICBhc3N1bWVDbGVhbjogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6aKE5Yi25L2T57yW6L6R5qih5byP5LiL6Lez6L+H5a6J5YWo5qOA5p+l77yM6buY6K6kIGZhbHNlJyB9LFxuICAgICAgICAgICAgdGltZW91dDogeyB0eXBlOiAnaW50ZWdlcicsIGRlc2NyaXB0aW9uOiAn6aKE5Yi25L2T5qih5byP5YiH5o2i6L2u6K+i6LaF5pe25q+r56eS77yM6buY6K6kIDMwMDAwJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWyd1cmwnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCB1cmwgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3VybCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghdXJsKSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiB1cmzvvIhkYjovLyDot6/lvoTmiJYgdXVpZO+8iScpO1xuICAgICAgICBsZXQgdXVpZCA9IHVybDtcbiAgICAgICAgaWYgKHVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XG4gICAgICAgICAgICBjb25zdCBhc3NldHM6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogdXJsIH0pO1xuICAgICAgICAgICAgY29uc3QgaGl0ID0gKGFzc2V0cyB8fCBbXSkuZmluZCgoYTogYW55KSA9PiBhLnVybCA9PT0gdXJsKSB8fCAoYXNzZXRzIHx8IFtdKVswXTtcbiAgICAgICAgICAgIGlmICghaGl0IHx8ICFoaXQudXVpZCkgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLDlnLrmma/otYTkuqc6ICR7dXJsfWApO1xuICAgICAgICAgICAgdXVpZCA9IFN0cmluZyhoaXQudXVpZCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbW9kZSA9IGF3YWl0IGRldGVjdFByZWZhYk1vZGUoKTtcbiAgICAgICAgY29uc3QgZnJvbVByZWZhYiA9IG1vZGUuaW5QcmVmYWJNb2RlO1xuICAgICAgICBpZiAoZnJvbVByZWZhYiAmJiBwYXJhbXM/LmFzc3VtZUNsZWFuICE9PSB0cnVlKSB7XG4gICAgICAgICAgICB0aHJvdyBwcmVmYWJNb2RlQmxvY2tlZEVycm9yKG1vZGUucHJlZmFiTmFtZSwgYOaJk+W8gOWcuuaZryAke3VybH1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzYXZlQ3VycmVudCA9IHBhcmFtcz8uc2F2ZUN1cnJlbnQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xuICAgICAgICBpZiAoc2F2ZUN1cnJlbnQgJiYgIWZyb21QcmVmYWIpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyDkv53lrZjlpLHotKXkuI3pmLvmlq3liIfmjaJcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoZnJvbVByZWZhYikge1xuICAgICAgICAgICAgLy8g5a6e5rWL77yIMjAyNi0xMO+8ie+8mumihOWItuS9k+aooeW8j+S4iyBvcGVuLXNjZW5lIOWvueOAjOW3suWKoOi9veeahOWcuuaZryB1dWlk44CN77yI6IOM5ZCO55qE5Zy65pmv6aG1562+77yJ5Lya6KKr5b+955Wl77yMXG4gICAgICAgICAgICAvLyDlr7nmnKrliqDovb3nmoTlnLrmma/lj6/ku6XmraPluLjliIfmjaLvvJtjbG9zZS1zY2VuZSDlnKjor6XmqKHlvI/kuIvml6DmlYjjgIHkuI3opoHnlKjjgIJcbiAgICAgICAgICAgIC8vIHF1ZXJ5LWN1cnJlbnQtc2NlbmUg5Zyo6K+l5qih5byP5LiL5piv55uy55qE77yI6L+U5Zue5YyF6KO55Zy65pmvIHV1aWTvvInvvIzmiYDku6XlhYjnlKggZGV0ZWN0UHJlZmFiTW9kZSDliKTmlq3mmK/lkKbohLHnprtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ29wZW4tc2NlbmUnLCB1dWlkKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyDlj6/og73pnZnpu5jooqvlv73nlaXvvIzkuqTnu5nova7or6LliKTmlq1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIChwaWNrTnVtYmVyKHBhcmFtcywgJ3RpbWVvdXQnLCAzMDAwMCkgfHwgMzAwMDApO1xuICAgICAgICAgICAgbGV0IGV4aXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5vdyA9IGF3YWl0IGRldGVjdFByZWZhYk1vZGUoKTtcbiAgICAgICAgICAgICAgICBpZiAoIW5vdy5pblByZWZhYk1vZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhpdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFleGl0ZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBvcGVuZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBzY2VuZVV1aWQ6IHV1aWQsXG4gICAgICAgICAgICAgICAgICAgIGZyb21QcmVmYWJNb2RlOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBoaW50OiAnb3Blbi1zY2VuZSDmnKrnlJ/mlYjvvJrnm67moIflnLrmma/lj6/og73mraPmmK/pooTliLbkvZPog4zlkI7nmoTlnLrmma/pobXnrb7vvIjlt7LliqDovb3nmoQgdXVpZCDkvJrooqvlv73nlaXvvInjgILlhYjpmo/kvr/miZPlvIDlj6bkuIDkuKrmnKrliqDovb3nmoTlnLrmma/ohLHnprvpooTliLbkvZPmqKHlvI/vvIzlho3liIflm57nm67moIflnLrmma8nLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgY3VycmVudCA9ICcnO1xuICAgICAgICAgICAgY29uc3QgY29uZmlybURlYWRsaW5lID0gRGF0ZS5ub3coKSArIDEwMDAwO1xuICAgICAgICAgICAgd2hpbGUgKERhdGUubm93KCkgPCBjb25maXJtRGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBzdDogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKTtcbiAgICAgICAgICAgICAgICAgICAgY3VycmVudCA9IHR5cGVvZiBzdCA9PT0gJ3N0cmluZycgPyBzdCA6IChzdCAmJiBzdC51dWlkKSB8fCAnJztcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnQgPSAnJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnQgPT09IHV1aWQpIGJyZWFrO1xuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSB7IG9wZW5lZDogY3VycmVudCA9PT0gdXVpZCwgc2NlbmVVdWlkOiB1dWlkLCBmcm9tUHJlZmFiTW9kZTogdHJ1ZSwgY3VycmVudFNjZW5lOiBjdXJyZW50IHx8IG51bGwgfTtcbiAgICAgICAgICAgIGlmICghcmVzdWx0Lm9wZW5lZCkge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5oaW50ID0gJ+W3suiEseemu+mihOWItuS9k+aooeW8j++8jOS9huebruagh+WcuuaZr+WIh+aNouacquehruiupO+8iOWPr+mHjeivlSBzY2VuZS5vcGVu77yJJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgLy8gb3Blbi1zY2VuZSDlj6/og73lpI3nlKjlhoXlrZjph4znmoTohI/lnLrmma/vvIjlr7nlt7LliqDovb0gdXVpZCDkvJrooqvlv73nlaXvvInvvJrlhYjliIfnqbrlnLrmma/lvLrliLblubLlh4Dph43ovb1cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2xvYWQtZW1wdHktc2NlbmUnKTtcbiAgICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ29wZW4tc2NlbmUnLCB1dWlkKTtcbiAgICAgICAgcmV0dXJuIHsgb3BlbmVkLCBzY2VuZVV1aWQ6IHV1aWQgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVDbG9zZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuY2xvc2UnLFxuICAgIHRpdGxlOiAn5YWz6Zet5b2T5YmN5Zy65pmvJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+WFs+mXreW9k+WJjeWcuuaZr+aWh+aho++8iHNjZW5lL2Nsb3NlLXNjZW5l77yJ44CC5qC45b+D55So6YCU77ya5aSW6YOo55u05pS56L+HIC5zY2VuZSDmlofku7blkI7lvLrliLbph43lvIDigJTigJQnICtcbiAgICAgICAgJ+WcuuaZr+aWh+aho+WIh+i1sOWQjuS7jempu+eVmeWGheWtmO+8iOmhteetvue8k+WtmO+8ie+8jHNjZW5lLm9wZW4g5a+55bey5Yqg6L295paH5qGj5Y+q5Lya5r+A5rS75LiN5Lya6YeN5paw6Kej5p6Q5paH5Lu277yMJyArXG4gICAgICAgICfmiYDku6XjgIzmv4DmtLvnm67moIflnLrmma8g4oaSIHNjZW5lLmNsb3NlIOmpsemAkCDihpIg5pS55paH5Lu2IOKGkiBhc3NldC5pbXBvcnQg5Yi35pawIOKGkiBzY2VuZS5vcGVu44CN5omN6IO96K6p5aSW6YOo5L+u5pS555Sf5pWI44CCJyArXG4gICAgICAgICfmnInmnKrkv53lrZjmlLnliqjml7blhbPpl63kvJrlvLnjgIzmmK/lkKbkv53lrZjjgI3lr7nor53moYbkuJTml6Dms5Xoh6rliqjlpITnkIbvvIzmnKzmk43kvZzlhYjmn6UgcXVlcnktZGlydHnvvIzohI/liJnnm7TmjqXmi5Lnu50nICtcbiAgICAgICAgJ++8iOWFiCBzY2VuZS5zYXZl77yM5oiW56Gu6K6k5Y+v5Lii5byD5pe25LygIGZvcmNlPXRydWXvvInjgILpooTliLbkvZPnvJbovpHmqKHlvI/kuIsgY2xvc2Utc2NlbmUg5peg5pWI77yM55u05o6l5ouS57ud44CCJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgZm9yY2U6ICfmnInmnKrkv53lrZjmlLnliqjml7bmmK/lkKbku43lsJ3or5XlhbPpl63vvIjlj6/og73lvLnkv53lrZjlr7nor53moYbpmLvloZ7vvInvvIzpu5jorqQgZmFsc2UnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBmb3JjZTogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6buY6K6kIGZhbHNlJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IG1vZGUgPSBhd2FpdCBkZXRlY3RQcmVmYWJNb2RlKCk7XG4gICAgICAgIGlmIChtb2RlLmluUHJlZmFiTW9kZSkgdGhyb3cgcHJlZmFiTW9kZUJsb2NrZWRFcnJvcihtb2RlLnByZWZhYk5hbWUsICflhbPpl63lnLrmma/mlofmoaMnKTtcbiAgICAgICAgbGV0IGRpcnR5ID0gZmFsc2U7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBkaXJ0eSA9IGR1bXBWYWx1ZTxib29sZWFuPihhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktZGlydHknKSwgZmFsc2UpID09PSB0cnVlO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBxdWVyeS1kaXJ0eSDkuI3lj6/nlKjml7bmjInkuI3ohI/lpITnkIbvvIhjbG9zZS1zY2VuZSDoh6rouqvlr7nohI/lnLrmma/nmoTooYzkuLrkuqTnlLHnvJbovpHlmajvvIlcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGlydHkgJiYgcGFyYW1zPy5mb3JjZSAhPT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lnLrmma/mnInmnKrkv53lrZjmlLnliqjvvIzlhbPpl63kvJrlvLnjgIzmmK/lkKbkv53lrZjjgI3lr7nor53moYbjgILor7flhYggc2NlbmUuc2F2Ze+8m+ehruiupOWPr+S4ouW8g+aXtuS8oCBmb3JjZT10cnVl44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY2xvc2VkID0gZHVtcFZhbHVlPGJvb2xlYW4+KGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdjbG9zZS1zY2VuZScpLCBmYWxzZSk7XG4gICAgICAgIGxldCBjdXJyZW50ID0gJyc7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjdXJyZW50ID0gZHVtcFZhbHVlPHN0cmluZz4oYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKSwgJycpIHx8ICcnO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyDlhbPpl63lkI7lj6/og73msqHmnInmtLvliqjmlofmoaPvvIxxdWVyeSDlpLHotKXlsZ7mraPluLhcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBjbG9zZWQsIGN1cnJlbnRTY2VuZTogY3VycmVudCB8fCBudWxsIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IHByb2plY3RTZXREZXNpZ25SZXNvbHV0aW9uOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdwcm9qZWN0LnNldERlc2lnblJlc29sdXRpb24nLFxuICAgIHRpdGxlOiAn6K6+572u6aG555uu6K6+6K6h5YiG6L6o546HJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+iuvue9rumhueebruiuvuiuoeWIhui+qOeOh++8iOetieS7t+S6jiDpobnnm67orr7nva7ihpLpobnnm64g6Z2i5p2/77yaRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdCDmjIHkuYXljJbliLAgc2V0dGluZ3MvdjIvcGFja2FnZXMvcHJvamVjdC5qc29u77yMJyArXG4gICAgICAgICflho3lj5EgcHJvamVjdC9jaGFuZ2UtZGVzaWduLXJlc29sdXRpb27vvIxzY2VuZSDmianlsZXnm5HlkKzor6Xlub/mkq3liLfmlrDnlLvluIPvvInjgIInICtcbiAgICAgICAgJ3dpZHRoL2hlaWdodCDlv4XloavvvIgxfjgxOTIg5pW05pWw77yJ77yMZml0V2lkdGgvZml0SGVpZ2h0IOe8uuecgeayv+eUqOW9k+WJjeWAvO+8m+i/lOWbnuWbnuivu+WAvOS4juiQveebmOagoemqjOe7k+aenOOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHdpZHRoOiAn6K6+6K6h5YiG6L6o546H5a6977yM5aaCIDcyMCcsXG4gICAgICAgIGhlaWdodDogJ+iuvuiuoeWIhui+qOeOh+mrmO+8jOWmgiAxMjgwJyxcbiAgICAgICAgZml0V2lkdGg6ICflj6/pgInjgILmmK/lkKbpgILphY3lrr3luqbvvIznvLrnnIHmsr/nlKjlvZPliY3lgLwnLFxuICAgICAgICBmaXRIZWlnaHQ6ICflj6/pgInjgILmmK/lkKbpgILphY3pq5jluqbvvIznvLrnnIHmsr/nlKjlvZPliY3lgLwnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB3aWR0aDogeyB0eXBlOiAnaW50ZWdlcicsIG1pbmltdW06IDEsIG1heGltdW06IDgxOTIsIGRlc2NyaXB0aW9uOiAn6K6+6K6h5YiG6L6o546H5a6977yM5aaCIDcyMCcgfSxcbiAgICAgICAgICAgIGhlaWdodDogeyB0eXBlOiAnaW50ZWdlcicsIG1pbmltdW06IDEsIG1heGltdW06IDgxOTIsIGRlc2NyaXB0aW9uOiAn6K6+6K6h5YiG6L6o546H6auY77yM5aaCIDEyODAnIH0sXG4gICAgICAgICAgICBmaXRXaWR0aDogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Y+v6YCJ44CC5piv5ZCm6YCC6YWN5a695bqm77yM57y655yB5rK/55So5b2T5YmN5YC8JyB9LFxuICAgICAgICAgICAgZml0SGVpZ2h0OiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICflj6/pgInjgILmmK/lkKbpgILphY3pq5jluqbvvIznvLrnnIHmsr/nlKjlvZPliY3lgLwnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ3dpZHRoJywgJ2hlaWdodCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IHdpZHRoID0gTWF0aC5yb3VuZChwaWNrTnVtYmVyKHBhcmFtcywgJ3dpZHRoJywgMCkpO1xuICAgICAgICBjb25zdCBoZWlnaHQgPSBNYXRoLnJvdW5kKHBpY2tOdW1iZXIocGFyYW1zLCAnaGVpZ2h0JywgMCkpO1xuICAgICAgICBpZiAoISh3aWR0aCA+PSAxICYmIHdpZHRoIDw9IDgxOTIpIHx8ICEoaGVpZ2h0ID49IDEgJiYgaGVpZ2h0IDw9IDgxOTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHdpZHRoL2hlaWdodCDlv4XpobvmmK8gMX44MTkyIOeahOaVtOaVsO+8jOaUtuWIsDogJHtKU09OLnN0cmluZ2lmeShwYXJhbXM/LndpZHRoKX0geCAke0pTT04uc3RyaW5naWZ5KHBhcmFtcz8uaGVpZ2h0KX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOW9k+WJjeWAvO+8muWumOaWuSBxdWVyeS1kZXNpZ24tcmVzb2x1dGlvbiDmtojmga/kvJjlhYjvvIzlj5bkuI3liLDpgIDlm54gUHJvZmlsZVxuICAgICAgICBsZXQgY3VycmVudDogYW55ID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKCdwcm9qZWN0JywgJ3F1ZXJ5LWRlc2lnbi1yZXNvbHV0aW9uJyk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGlmICghY3VycmVudCB8fCB0eXBlb2YgY3VycmVudCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGN1cnJlbnQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KCdwcm9qZWN0JywgJ2dlbmVyYWwuZGVzaWduUmVzb2x1dGlvbicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJlZm9yZSA9IHtcbiAgICAgICAgICAgIHdpZHRoOiBNYXRoLnJvdW5kKE51bWJlcihjdXJyZW50Py53aWR0aCkpIHx8IDAsXG4gICAgICAgICAgICBoZWlnaHQ6IE1hdGgucm91bmQoTnVtYmVyKGN1cnJlbnQ/LmhlaWdodCkpIHx8IDAsXG4gICAgICAgICAgICBmaXRXaWR0aDogY3VycmVudD8uZml0V2lkdGggPT09IHRydWUsXG4gICAgICAgICAgICBmaXRIZWlnaHQ6IGN1cnJlbnQ/LmZpdEhlaWdodCA9PT0gdHJ1ZSxcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCByZXNvbHV0aW9uID0ge1xuICAgICAgICAgICAgd2lkdGgsXG4gICAgICAgICAgICBoZWlnaHQsXG4gICAgICAgICAgICBmaXRXaWR0aDogdHlwZW9mIHBhcmFtcz8uZml0V2lkdGggPT09ICdib29sZWFuJyA/IHBhcmFtcy5maXRXaWR0aCA6IGJlZm9yZS5maXRXaWR0aCxcbiAgICAgICAgICAgIGZpdEhlaWdodDogdHlwZW9mIHBhcmFtcz8uZml0SGVpZ2h0ID09PSAnYm9vbGVhbicgPyBwYXJhbXMuZml0SGVpZ2h0IDogYmVmb3JlLmZpdEhlaWdodCxcbiAgICAgICAgfTtcblxuICAgICAgICAvLyDmjIHkuYXljJbvvIhzZXR0aW5ncy92Mi9wYWNrYWdlcy9wcm9qZWN0Lmpzb27vvInvvIzlrpjmlrkgUHJvZmlsZSBBUElcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdCgncHJvamVjdCcsICdnZW5lcmFsLmRlc2lnblJlc29sdXRpb24nLCByZXNvbHV0aW9uKTtcbiAgICAgICAgLy8g5bqU55So77ya5LiO6K6+572u6Z2i5p2/5ZCM5LiA5p2h5raI5oGv77yMc2NlbmUg5omp5bGV55uR5ZCs5ZCO5Yi35paw55S75biDXG4gICAgICAgIGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoJ3Byb2plY3QnLCAnY2hhbmdlLWRlc2lnbi1yZXNvbHV0aW9uJywgcmVzb2x1dGlvbik7XG5cbiAgICAgICAgLy8g5Zue6K+76aqM6K+BXG4gICAgICAgIGxldCBxdWVyaWVkOiBhbnkgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcXVlcmllZCA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoJ3Byb2plY3QnLCAncXVlcnktZGVzaWduLXJlc29sdXRpb24nKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcXVlcmllZCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgLy8g6JC955uY5qCh6aqM77yIUHJvZmlsZSDlvILmraXlhpnnm5jvvIznqI3nrYnlho3or7vvvIxiZXN0IGVmZm9ydO+8iVxuICAgICAgICBhd2FpdCBzbGVlcCg1MDApO1xuICAgICAgICBsZXQgZmlsZTogYW55ID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUoam9pbihwcm9qZWN0Um9vdCgpLCAnc2V0dGluZ3MnLCAndjInLCAncGFja2FnZXMnLCAncHJvamVjdC5qc29uJyksICd1dGY4JykpO1xuICAgICAgICAgICAgZmlsZSA9IHJhdz8uZ2VuZXJhbD8uZGVzaWduUmVzb2x1dGlvbiA/PyBudWxsO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBmaWxlID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSAhIShcbiAgICAgICAgICAgIGZpbGUgJiZcbiAgICAgICAgICAgIE51bWJlcihmaWxlLndpZHRoKSA9PT0gd2lkdGggJiZcbiAgICAgICAgICAgIE51bWJlcihmaWxlLmhlaWdodCkgPT09IGhlaWdodCAmJlxuICAgICAgICAgICAgZmlsZS5maXRXaWR0aCA9PT0gcmVzb2x1dGlvbi5maXRXaWR0aCAmJlxuICAgICAgICAgICAgZmlsZS5maXRIZWlnaHQgPT09IHJlc29sdXRpb24uZml0SGVpZ2h0XG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7IGJlZm9yZSwgYXBwbGllZDogcmVzb2x1dGlvbiwgcXVlcmllZCwgZmlsZSwgcGVyc2lzdGVkIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVDcmVhdGVDb21wb25lbnRNc2c6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUuY3JlYXRlQ29tcG9uZW50TXNnJyxcbiAgICB0aXRsZTogJ+aMgui9vee7hOS7tu+8iOa2iOaBr+mAmumBk+ebtOmAmu+8iScsXG4gICAgZGVzY3JpcHRpb246ICfnm7TmjqXotbAgc2NlbmUvY3JlYXRlLWNvbXBvbmVudCDmtojmga/mjILnu4Tku7bvvIzmlK/mjIHoh6rlrprkuYnohJrmnKwgY2lk77yI5LiN6L+b5byV5pOO6YCa6YGT77yJJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlkJyxcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu2IGNpZCDmiJbnsbvlkI3vvIjlj6/ku6XmmK/nlKjmiLfohJrmnKwgY2lk77yJJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgbm9kZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZCcgfSxcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7YgY2lkIOaIluexu+WQjScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsnbm9kZScsICdjb21wb25lbnQnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBub2RlID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdjb21wb25lbnQnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIW5vZGUgfHwgIWNvbXBvbmVudCkgdGhyb3cgbmV3IEVycm9yKCfpnIDopoEgbm9kZSDkuI4gY29tcG9uZW50Jyk7XG4gICAgICAgIC8vIOW5guetie+8muW3suacieWQjOexu+Wei+e7hOS7tuebtOaOpei/lOWbnu+8jOS4jemHjeWkjeinpuWPkSBjcmVhdGUtY29tcG9uZW5077yI5ZCm5YiZ57yW6L6R5Zmo5Lya5omT5Y2w6K2m5ZGK77yJXG4gICAgICAgIGNvbnN0IGNvbXBzQmVmb3JlID0gYXdhaXQgcXVlcnlOb2RlQ29tcG9uZW50cyhub2RlKTtcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGF3YWl0IHJlc29sdmVDb21wb25lbnRDYW5kaWRhdGVzKGNvbXBvbmVudCk7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWF0Y2hFeGlzdGluZ0NvbXBvbmVudChjb21wc0JlZm9yZSwgY2FuZGlkYXRlcyk7XG4gICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICAgIGNvbXBvbmVudCxcbiAgICAgICAgICAgICAgICBhbHJlYWR5RXhpc3RzOiB0cnVlLFxuICAgICAgICAgICAgICAgIGV4aXN0aW5nOiB7IHV1aWQ6IGV4aXN0aW5nLnV1aWQsIHR5cGU6IGV4aXN0aW5nLnR5cGUsIG5hbWU6IGV4aXN0aW5nLm5hbWUgfSxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBjb21wc0JlZm9yZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2NyZWF0ZS1jb21wb25lbnQnLCB7IHV1aWQ6IG5vZGUsIGNvbXBvbmVudCB9KTtcbiAgICAgICAgY29uc3QgY29tcHM6IGFueVtdID0gYXdhaXQgcXVlcnlOb2RlQ29tcG9uZW50cyhub2RlKTtcbiAgICAgICAgcmV0dXJuIHsgbm9kZSwgY29tcG9uZW50LCBjb21wb25lbnRzOiBjb21wcyB9O1xuICAgIH0sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOmAmueUqOaJuemHj1xuXG4vKipcbiAqIOaKiuWPguaVsOmHjOeahCBcIiQ8aT4uPGEuYi5jPlwiIOaooeadv+abv+aNouaIkOesrCBpIOmhueaJp+ihjOe7k+aenOmHjOeahOWvueW6lOWAvO+8iOaUr+aMgeWvueixoS/mlbDnu4TlhoXltYzlpZfvvInjgIJcbiAqIOS4pOenjei3r+W+hOWGmeazleetieS7t++8mlxuICogICBcIiQwLmRhdGEudXVpZFwiIOKAlOKAlCDku44gcmVzdWx0c1tpXSDotbflhpnlhajvvIjkuI7mlofmoaPnpLrkvovjgIHnu5PmnpwgSlNPTiDnmoTlrZfpnaLnu5PmnoTkuIDoh7TvvInvvJtcbiAqICAgXCIkMC51dWlkXCIgICAgICDigJTigJQg55u45a+5IHJlc3VsdHNbaV0uZGF0YSDnmoTnn63lhpnms5XjgIJcbiAqIOi3r+W+hOauteaUr+aMgeaVsOe7hOS4i+agh++8iOWmgiBcIiQwLm5vZGVzWzFdLnV1aWRcIu+8jOWvueW6lCBub2RlLmNyZWF0ZSDov5Tlm57nmoTnu5PmnoTljJblrZDmoJHvvInjgIJcbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVJlc3VsdFJlZnModmFsdWU6IGFueSwgcmVzdWx0czogYW55W10pOiBhbnkge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGNvbnN0IG0gPSAvXlxcJChcXGQrKSg/OlxcLihbXFx3LltcXF1dKykpPyQvLmV4ZWModmFsdWUpO1xuICAgICAgICBpZiAoIW0pIHJldHVybiB2YWx1ZTtcbiAgICAgICAgY29uc3QgaGl0ID0gcmVzdWx0c1tOdW1iZXIobVsxXSldO1xuICAgICAgICBpZiAoIWhpdCB8fCAhaGl0Lm9rKSB0aHJvdyBuZXcgRXJyb3IoYOW8leeUqCAkJHttWzFdfSDlpLHotKXvvJror6XpobnmnKrmiJDlip/miafooYxgKTtcbiAgICAgICAgY29uc3Qgc2VncyA9IChtWzJdIHx8ICcnKS5zcGxpdCgnLicpLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgbGV0IGN1cjogYW55ID0gc2Vnc1swXSA9PT0gJ2RhdGEnID8gaGl0IDogaGl0LmRhdGE7XG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIHNlZ3MpIHtcbiAgICAgICAgICAgIGNvbnN0IGltID0gL14oLio/KVxcWyhcXGQrKVxcXSQvLmV4ZWMoa2V5KTtcbiAgICAgICAgICAgIGN1ciA9IGltID8gY3VyPy5baW1bMV1dPy5bTnVtYmVyKGltWzJdKV0gOiBjdXI/LltrZXldO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXI7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcCgodikgPT4gcmVzb2x2ZVJlc3VsdFJlZnModiwgcmVzdWx0cykpO1xuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogYW55ID0ge307XG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkgb3V0W2tleV0gPSByZXNvbHZlUmVzdWx0UmVmcyh2YWx1ZVtrZXldLCByZXN1bHRzKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG5jb25zdCBiYXRjaFJ1bjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnYmF0Y2gucnVuJyxcbiAgICB0aXRsZTogJ+aJuemHj+aJp+ihjOaTjeS9nCcsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfmjInpobrluo/miafooYzkuIDnu4Tmk43kvZzvvIzmioogTiDmrKHlvoDov5TlkIjlubbkuLrkuIDmrKHosIPnlKjjgIInICtcbiAgICAgICAgJ+avj+mhueeLrOeri+i/m+e8lui+keWZqCB1bmRvIOS9k+ezu++8iOS4gOaJuSA9IOWkmuadoSB1bmRvIOiusOW9le+8ie+8m3N0b3BPbkVycm9yPXRydWXvvIjpu5jorqTvvInml7bpgYfplJnkuK3mraLvvIwnICtcbiAgICAgICAgJ+i/lOWbnumAkOmhuee7k+aenOOAgmJhdGNoLnJ1biDkuI3lhYHorrjltYzlpZfjgIInICtcbiAgICAgICAgJ+WPguaVsOWAvOaUr+aMgeW8leeUqOWJjemhuee7k+aenO+8muW9ouWmgiBcIiQwLmRhdGEudXVpZFwiIOeahOWtl+espuS4suS8muabv+aNouaIkOesrCAwIOmhuSByZXN1bHRzWzBdLmRhdGEudXVpZCDnmoTlgLzvvIwnICtcbiAgICAgICAgJ+S5n+WPr+eUqOetieS7t+efreWGmSBcIiQwLnV1aWRcIu+8iOi3r+W+hOebuOWvuSByZXN1bHRzW2ldLmRhdGEg6Kej5p6Q77yJ77yb5Y+v5bWM5aWX5Zyo5a+56LGhL+aVsOe7hOmHjCcgK1xuICAgICAgICAn77yI5L6L5aaCIG5vZGUuY3JlYXRlIOS5i+WQjiBub2RlLm1vdmUg5LygIHtcInV1aWRcIjpcIiQwLmRhdGEudXVpZFwife+8ie+8m+i3r+W+hOauteaUr+aMgeaVsOe7hOS4i+agh++8iFwiJDAubm9kZXNbMV0udXVpZFwiIOebtOi+vuaooeadv+WtkOiKgueCue+8ieOAgicgK1xuICAgICAgICAn5rOo5oSP77yaXCIkTlwiIOW8leeUqOS7heWcqOWQjOS4gOasoeiwg+eUqOWGheacieaViO+8jOi3qOaJueW/hemhu+WFiOWPluWbnuecn+WuniB1dWlkIOWGjeW8leeUqOOAgicgK1xuICAgICAgICAnbm9kZS5iaW5kUHJvcGVydHkg55qEIGJpbmRpbmdzIOaJuemHj+S4uuWkmuadoemAkOadoeaPkOS6pOOAgeWFqOmDqOeUn+aViOOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIGl0ZW1zOiAn5pON5L2c5pWw57uE77yM5q+P6aG55b2i5aaCIHtcIm9wXCI6XCJub2RlLm1vdmVcIixcInBhcmFtc1wiOnsuLi59fe+8m3BhcmFtcyDph4zlj6/nlKggXCIkPGk+Ljzot6/lvoQ+XCIg5byV55So56ysIGkg6aG557uT5p6c77yI5LuF6ZmQ5pys5om577yJJyxcbiAgICAgICAgc3RvcE9uRXJyb3I6ICfpgYfplJnmmK/lkKbkuK3mraLlkI7nu63mk43kvZzvvIzpu5jorqQgdHJ1ZScsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIGl0ZW1zOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aTjeS9nOaVsOe7hCcsXG4gICAgICAgICAgICAgICAgaXRlbXM6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aTjeS9nOWQje+8jOWmgiBub2RlLmNyZWF0ZScgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtczogeyB0eXBlOiAnb2JqZWN0JywgZGVzY3JpcHRpb246ICfor6Xmk43kvZznmoTlj4LmlbDvvIzlj6/nlKggXCIkaS5wYXRoXCIg5byV55So5YmN6aG557uT5p6cJyB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICByZXF1aXJlZDogWydvcCddLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RvcE9uRXJyb3I6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+mBh+mUmeaYr+WQpuS4reatou+8jOm7mOiupCB0cnVlJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydpdGVtcyddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocGFyYW1zPy5pdGVtcykgPyBwYXJhbXMuaXRlbXMgOiBbXTtcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignaXRlbXMg5Li656m6Jyk7XG4gICAgICAgIGNvbnN0IHN0b3BPbkVycm9yID0gcGFyYW1zPy5zdG9wT25FcnJvciAhPT0gZmFsc2U7XG5cbiAgICAgICAgY29uc3QgcmVzdWx0czogYW55W10gPSBbXTtcbiAgICAgICAgbGV0IGFib3J0ZWQgPSBmYWxzZTtcbiAgICAgICAgbGV0IG9rQ291bnQgPSAwO1xuICAgICAgICBsZXQgZmFpbENvdW50ID0gMDtcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGl0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IGl0ZW1zW2luZGV4XTtcbiAgICAgICAgICAgIGNvbnN0IG9wID0gaXRlbSAmJiB0eXBlb2YgaXRlbS5vcCA9PT0gJ3N0cmluZycgPyBpdGVtLm9wLnRyaW0oKSA6ICcnO1xuICAgICAgICAgICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgICAgICAgICAgaWYgKCFvcCB8fCBvcCA9PT0gJ2JhdGNoLnJ1bicpIHtcbiAgICAgICAgICAgICAgICBmYWlsQ291bnQrKztcbiAgICAgICAgICAgICAgICByZXN1bHRzLnB1c2goeyBvcCwgb2s6IGZhbHNlLCBlcnJvcjogb3AgPyAnYmF0Y2gucnVuIOS4jeWFgeiuuOW1jOWllycgOiAn57y65bCRIG9wJywgY29zdDogMCB9KTtcbiAgICAgICAgICAgICAgICBpZiAoc3RvcE9uRXJyb3IpIHsgYWJvcnRlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGxldCBpdGVtUGFyYW1zID0gaXRlbT8ucGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAmJiBpdGVtUGFyYW1zICYmIHR5cGVvZiBpdGVtUGFyYW1zID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICBpdGVtUGFyYW1zID0gcmVzb2x2ZVJlc3VsdFJlZnMoaXRlbVBhcmFtcywgcmVzdWx0cyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9wZXJhdGlvbiA9IHJlZ2lzdHJ5TWFwW29wXTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wZXJhdGlvbikgdGhyb3cgbmV3IEVycm9yKGDmnKrnn6Xmk43kvZw6ICR7b3B9YCk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG9wZXJhdGlvbi5ydW4oaXRlbVBhcmFtcyk7XG4gICAgICAgICAgICAgICAgb2tDb3VudCsrO1xuICAgICAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7IG9wLCBvazogdHJ1ZSwgZGF0YSwgY29zdDogRGF0ZS5ub3coKSAtIHN0YXJ0IH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIGZhaWxDb3VudCsrO1xuICAgICAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7IG9wLCBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfHwgZSksIGNvc3Q6IERhdGUubm93KCkgLSBzdGFydCB9KTtcbiAgICAgICAgICAgICAgICBpZiAoc3RvcE9uRXJyb3IpIHsgYWJvcnRlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdG90YWw6IGl0ZW1zLmxlbmd0aCwgb2s6IG9rQ291bnQsIGZhaWxlZDogZmFpbENvdW50LCBhYm9ydGVkLCByZXN1bHRzIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gTUNQIOacjeWKoeWZqOiHqueuoeeQhlxuXG5jb25zdCBtY3BTdGF0dXM6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ21jcC5zdGF0dXMnLFxuICAgIHRpdGxlOiAnTUNQIOacjeWKoeWZqOeKtuaAgScsXG4gICAgZGVzY3JpcHRpb246ICfmn6Xor6IgbWNwLXNlcnZlciDlrZDov5vnqIvov5DooYznirbmgIHvvJrnq6/lj6PjgIFwaWTjgIHmmK/lkKbmnKznvJbovpHlmajlkK/liqjjgIFIVFRQIOaOoua0u+e7k+aenCcsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBtY3BTZXJ2ZXJTdGF0dXMoKTtcbiAgICB9LFxufTtcblxuY29uc3QgbWNwUmVzdGFydDogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbWNwLnJlc3RhcnQnLFxuICAgIHRpdGxlOiAn6YeN5ZCvIE1DUCDmnI3liqHlmagnLFxuICAgIGRlc2NyaXB0aW9uOiAn6YeN5ZCvIG1jcC1zZXJ2ZXIg5a2Q6L+b56iL77yI5L+u5pS5IG1jcC1zZXJ2ZXIvaW5kZXguanMg5ZCO6K6p5Luj56CB55Sf5pWI77yJ77yb5Y+q5o6l566h5pys57yW6L6R5Zmo5ZCv5Yqo55qE5a6e5L6LJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgcG9ydDogJ+WPr+mAieOAguebkeWQrOerr+WPo++8jOm7mOiupOayv+eUqOW9k+WJjeerr+WPo++8iOaXoOi/kOihjOWunuS+i+aXtueUqOS4iuasoeerr+WPo++8jOWGjemAgOWbniAzMDAy77yJJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgcG9ydDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfnm5HlkKznq6/lj6PvvIzpu5jorqTmsr/nlKjlvZPliY3nq6/lj6MnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgYmVmb3JlID0gYXdhaXQgbWNwU2VydmVyU3RhdHVzKCk7XG4gICAgICAgIGNvbnN0IHBvcnQgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ3BvcnQnLCAwKSB8fCBiZWZvcmUucG9ydCB8fCBiZWZvcmUubGFzdFBvcnQgfHwgMzAwMjtcbiAgICAgICAgaWYgKGJlZm9yZS5ydW5uaW5nICYmICFiZWZvcmUub3duZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBg56uv5Y+jICR7cG9ydH0g5LiK55qEIE1DUCBTZXJ2ZXLvvIhwaWQgJHtiZWZvcmUucGlkfe+8ieS4jeaYr+acrOe8lui+keWZqOWQr+WKqOeahO+8jOaXoOazleS7o+S4uumHjeWQr++8m2AgK1xuICAgICAgICAgICAgICAgICfor7flhYjlnKjnu4jnq6/nu5PmnZ/or6Xov5vnqIvvvIzmiJbmjaLnq6/lj6PlkK/liqjmlrDlrp7kvovjgIInXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChiZWZvcmUucnVubmluZyAmJiBiZWZvcmUub3duZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHN0b3BNY3BTZXJ2ZXIoKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IHN0YXJ0TWNwU2VydmVyKHBvcnQpO1xuICAgICAgICBpZiAoIXN0YXRlLnJ1bm5pbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg6YeN5ZCv5ZCOIG1jcC1zZXJ2ZXIg5pyq6L+Q6KGM77yM5pyA6L+R6L6T5Ye677yaJHtzdGF0ZS5yZWNlbnRPdXRwdXQuc2xpY2UoLTUpLmpvaW4oJyB8ICcpIHx8ICfml6AnfWApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IC4uLnN0YXRlLCByZXN0YXJ0ZWQ6IHRydWUsIHByZXZpb3VzUGlkOiBiZWZvcmUucGlkIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5rOo5YaM6KGoXG5cbmNvbnN0IHJlZ2lzdHJ5OiBPcGVyYXRpb25EZWZpbml0aW9uW10gPSBbXG4gICAgZWRpdG9ySW5mbyxcbiAgICBzY2VuZVN0YXR1cyxcbiAgICBzY2VuZVRyZWUsXG4gICAgbm9kZUNyZWF0ZSxcbiAgICBub2RlRGVsZXRlLFxuICAgIG5vZGVNb3ZlLFxuICAgIG5vZGVNb3ZlRW5naW5lLFxuICAgIG5vZGVTZXRQcm9wZXJ0eSxcbiAgICBub2RlU2V0UHJvcGVydHlFbmdpbmUsXG4gICAgbm9kZUJpbmRQcm9wZXJ0eSxcbiAgICBub2RlQ3JlYXRlUHJlZmFiLFxuICAgIHByZWZhYk9wZW4sXG4gICAgc2NlbmVTYXZlLFxuICAgIGFzc2V0TGlzdCxcbiAgICBhc3NldERlbGV0ZSxcbiAgICBhc3NldEltcG9ydCxcbiAgICBiYXRjaFJ1bixcbiAgICBtY3BTdGF0dXMsXG4gICAgbWNwUmVzdGFydCxcbiAgICBzY2VuZVNjcmlwdEluZm8sXG4gICAgc2NlbmVTY3JpcHREZW1vLFxuICAgIHNjZW5lQ2FwdHVyZSxcbiAgICBzY2VuZVJlb3BlbixcbiAgICBzY2VuZUNyZWF0ZSxcbiAgICBzY2VuZU9wZW4sXG4gICAgc2NlbmVDbG9zZSxcbiAgICBwcm9qZWN0U2V0RGVzaWduUmVzb2x1dGlvbixcbiAgICBub2RlQ3JlYXRlQ29tcG9uZW50TXNnLFxuICAgIHNjcmlwdENyZWF0ZSxcbiAgICBzY3JpcHRMaXN0LFxuICAgIG5vZGVBZGRDb21wb25lbnQsXG4gICAgbm9kZVJlbW92ZUNvbXBvbmVudCxcbiAgICBub2RlTGlzdENvbXBvbmVudHMsXG4gICAgbm9kZURlYnVnLFxuXTtcblxuY29uc3QgcmVnaXN0cnlNYXA6IHsgW25hbWU6IHN0cmluZ106IE9wZXJhdGlvbkRlZmluaXRpb24gfSA9IHt9O1xuZm9yIChjb25zdCBvcGVyYXRpb24gb2YgcmVnaXN0cnkpIHtcbiAgICByZWdpc3RyeU1hcFtvcGVyYXRpb24ubmFtZV0gPSBvcGVyYXRpb247XG59XG5cbi8qKiDliJflh7rmiYDmnInmk43kvZzvvIhNQ1AgdG9vbHMvbGlzdCDnmoTmlbDmja7mupDvvIkgKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0T3BlcmF0aW9ucygpOiBPcGVyYXRpb25JbmZvW10ge1xuICAgIHJldHVybiByZWdpc3RyeS5tYXAoKG9wZXJhdGlvbikgPT4gKHtcbiAgICAgICAgbmFtZTogb3BlcmF0aW9uLm5hbWUsXG4gICAgICAgIHRpdGxlOiBvcGVyYXRpb24udGl0bGUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBvcGVyYXRpb24uZGVzY3JpcHRpb24sXG4gICAgICAgIHBhcmFtczogb3BlcmF0aW9uLnBhcmFtcyxcbiAgICAgICAgc2NoZW1hOiBvcGVyYXRpb24uc2NoZW1hLFxuICAgIH0pKTtcbn1cblxuLyoqIOaMieWQjeWtl+aJp+ihjOS4gOS4quaTjeS9nCAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk9wZXJhdGlvbihuYW1lOiBzdHJpbmcsIHBhcmFtczogeyBba2V5OiBzdHJpbmddOiBhbnkgfSA9IHt9KTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSByZWdpc3RyeU1hcFtuYW1lXTtcbiAgICBpZiAoIW9wZXJhdGlvbikge1xuICAgICAgICBjb25zdCBrbm93biA9IHJlZ2lzdHJ5Lm1hcCgoaXRlbSkgPT4gaXRlbS5uYW1lKS5qb2luKCcsICcpO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOacquefpeaTjeS9nDogJHtuYW1lfe+8m+WPr+eUqOaTjeS9nDogJHtrbm93bn1gKTtcbiAgICB9XG4gICAgcmV0dXJuIG9wZXJhdGlvbi5ydW4ocGFyYW1zIHx8IHt9KTtcbn1cbiJdfQ==