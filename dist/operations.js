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
    description: '通过 scene/create-node 创建节点，走编辑器 undo 体系。三种用法：1) 默认建空节点（编辑器自动附加 cc.UITransform，勿重复 addComponent）；2) builtin=内置模板短名，映射到 db://internal/default_prefab/<短名>.prefab，一步实例化完整模板（含子节点与默认资源引用）；常用模板都带子目录前缀——UI 用 ui/Button、ui/Label、ui/Sprite、ui/Canvas、ui/Layout、ui/ScrollView 等（要求场景已有 Canvas），3D 用 3d/Cube、3d/Sphere，灯光用 light/Point Light；裸短名 Button、Label、Sprite 不存在，会报「找不到 prefab 资产」；全量列表用 asset_list(pattern="db://internal/default_prefab/**/*.prefab") 查询；3) prefab=任意预制体（db:// url 或 uuid），把已有 prefab 实例化进场景。注意：parent 必须是真实节点 uuid（不解析路径），引用无效时节点会被静默建到场景根（不报错），批量搭建后建议审计场景根是否出现孤儿节点',
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
        '批量：bindings=[{uuid,component,property,target},…] 形式上支持，但当前实现多条只有第一条真正生效（已知问题），请一条一个调用（可并行发）。' +
        '绑定后自动回读场景实际引用验证，不一致会报错。',
    params: {
        uuid: '属性所在节点：uuid 或节点路径，留空用当前选中节点',
        component: '组件定位：索引数字 / 类名（cc.Label、ItemBadge）/ cid',
        property: '属性名，如 badge、tipLabel、spriteFrame',
        target: '绑定目标：{node,component} 组件引用 | {node} 节点引用 | {asset:"db://…"} 资产 | uuid 字符串 | null 解绑',
        type: '可选。dump 类型名（默认自动推断：组件→类名、节点→cc.Node、资产→资源类型）',
        path: '可选。原始属性路径（如 __comps__.1.badge），传了就跳过 component/property 拼装',
        bindings: '批量绑定数组（当前多条只有第一条生效，建议逐条调用），每项 {uuid,component,property,target[,type]}，与单条参数二选一',
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
                description: '批量绑定：每项 {uuid, component, property, target[, type]}，与单条参数二选一；当前多条只有第一条生效，建议逐条调用',
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
        // 4) 一次性提交：多个 {uuid,path,dump} 作为变参（与属性检查器批量写入同构，一条 undo）。
        //    Editor.Message.request 的类型签名不是 rest 参数，这里按变参调用需要 cast。
        await Editor.Message.request(SCENE, 'set-property', ...items);
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
    description: '进入预制体编辑模式（等价资源管理器里双击 .prefab）。先保存当前场景避免弹窗，' +
        '再走 asset-db/open-asset 并轮询确认当前编辑文档切换完成。' +
        '注意：scene/open-scene 对 prefab uuid 无效（会被忽略）；scene.open 也不要用——它内部先 load-empty-scene，会产生无标题场景进而弹「保存」对话框。',
    params: {
        url: '预制体 db:// 路径或 uuid，如 db://assets/prefabs/Foo.prefab',
        saveCurrent: '进入前是否保存当前场景，默认 true',
        timeout: '等待进入预制体编辑模式的超时毫秒，默认 30000',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '预制体 db:// 路径或 uuid' },
            saveCurrent: { type: 'boolean', description: '默认 true' },
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
        if ((params === null || params === void 0 ? void 0 : params.saveCurrent) !== false) {
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
        const beforeTree = await Editor.Message.request(SCENE, 'query-node-tree');
        const before = dumpValue(beforeTree === null || beforeTree === void 0 ? void 0 : beforeTree.uuid, '');
        const requested = await Editor.Message.request(ASSET_DB, 'open-asset', uuid);
        const timeout = pickNumber(params, 'timeout', 30000) || 30000;
        const deadline = Date.now() + timeout;
        let current = before;
        let stable = 0;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            try {
                const tree = await Editor.Message.request(SCENE, 'query-node-tree');
                current = dumpValue(tree === null || tree === void 0 ? void 0 : tree.uuid, '');
            }
            catch (e) {
                current = '';
            }
            if (current && current !== before) {
                stable += 1;
                if (stable >= 2)
                    break;
            }
            else {
                stable = 0;
            }
        }
        const result = { opened: !!(current && current !== before), prefabUuid: uuid, fromScene: before || null, currentScene: current || null, requested };
        if (!result.opened) {
            result.hint = '超时未切换文档：可能当前已处于该预制体的编辑模式，或当前是无标题未保存场景时编辑器弹了保存对话框（处理后重试）';
        }
        return result;
    },
};
const sceneSave = {
    name: 'scene.save',
    title: '保存场景',
    description: '通过 scene/save-scene 保存当前场景，返回保存结果',
    params: {},
    schema: noParams(),
    async run() {
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
        '当前场景是无标题未保存场景时编辑器会弹保存对话框，人工处理后轮询自动继续，超时返回 opened=false 并给提示。',
    params: {
        url: '新场景 db:// 路径，如 db://assets/scenes/helloworld.scene',
        template: "'2d'（默认，含 Canvas+Camera）/ 'empty'（空场景），或完整模板路径 db://internal/default_file_content/scene/xxx.scene",
        open: '创建后是否立即打开该场景，默认 false',
        overwrite: '同名文件已存在时是否覆盖，默认 false',
        openTimeout: 'open=true 时等待场景切换完成的超时毫秒，默认 30000',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '新场景 db:// 路径，如 db://assets/scenes/helloworld.scene' },
            template: { type: 'string', description: "'2d'（默认）/ 'empty'，或完整模板 db:// 路径" },
            open: { type: 'boolean', description: '创建后是否立即打开，默认 false' },
            overwrite: { type: 'boolean', description: '同名文件已存在时是否覆盖，默认 false' },
            openTimeout: { type: 'number', description: '等待场景切换超时毫秒，默认 30000' },
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
    description: '按 db:// 路径或 uuid 打开指定场景（默认先保存当前场景再切换，saveCurrent=false 可跳过保存）',
    params: {
        url: '场景资产 db:// 路径或 uuid，如 db://assets/lobby.scene',
        saveCurrent: '切换前是否保存当前场景，默认 true',
    },
    schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '场景资产 db:// 路径或 uuid' },
            saveCurrent: { type: 'boolean', description: '默认 true' },
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
        const saveCurrent = (params === null || params === void 0 ? void 0 : params.saveCurrent) === false ? false : true;
        if (saveCurrent) {
            try {
                await Editor.Message.request(SCENE, 'save-scene');
            }
            catch (e) {
                // 保存失败不阻断切换
            }
        }
        // open-scene 可能复用内存里的脏场景（对已加载 uuid 会被忽略）：先切空场景强制干净重载
        await Editor.Message.request(SCENE, 'load-empty-scene');
        const opened = await Editor.Message.request(SCENE, 'open-scene', uuid);
        return { opened, sceneUuid: uuid };
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
 */
function resolveResultRefs(value, results) {
    if (typeof value === 'string') {
        const m = /^\$(\d+)(?:\.([\w.]+))?$/.exec(value);
        if (!m)
            return value;
        const hit = results[Number(m[1])];
        if (!hit || !hit.ok)
            throw new Error(`引用 $${m[1]} 失败：该项未成功执行`);
        const segs = (m[2] || '').split('.').filter(Boolean);
        let cur = segs[0] === 'data' ? hit : hit.data;
        for (const key of segs) {
            cur = cur === null || cur === void 0 ? void 0 : cur[key];
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
        '（例如 node.create 之后 node.move 传 {"uuid":"$0.data.uuid"}）。' +
        '注意："$N" 引用仅在同一次调用内有效，跨批必须先取回真实 uuid 再引用。' +
        'node.bindProperty 的 bindings 批量当前只有第一条生效，混用时逐条调用。',
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlcmF0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9vcGVyYXRpb25zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBMDNFQSx3Q0FRQztBQUdELG9DQU9DO0FBNTRFRCxhQUFhO0FBQ2IsbUVBQTBDO0FBQzFDLDBDQUFrRjtBQUNsRiwrQkFBaUU7QUFFakUsNkNBQTBDO0FBQzFDLCtDQUErRTtBQUUvRTs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUVILE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQztBQUN0QixNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUM7QUFpQjVCLHdFQUF3RTtBQUV4RSw2Q0FBNkM7QUFDN0MsU0FBUyxTQUFTLENBQVUsSUFBUyxFQUFFLFFBQVc7SUFDOUMsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxTQUFTO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDekQsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQzlDLE9BQVEsSUFBcUIsQ0FBQyxLQUFLLENBQUM7SUFDeEMsQ0FBQztJQUNELE9BQU8sSUFBUyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxNQUFXLEVBQUUsR0FBVyxFQUFFLFFBQVEsR0FBRyxFQUFFO0lBQ3ZELE1BQU0sS0FBSyxHQUFHLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENBQUMsQ0FBQztJQUM1QixPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLE1BQVcsRUFBRSxHQUFXLEVBQUUsUUFBUSxHQUFHLENBQUM7SUFDdEQsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENB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QUN4QixNQUFNLEVBQUUsU0FBUyxDQUFDLE1BQU07S0FDM0IsQ0FBQyxDQUFDLENBQUM7QUFDUixDQUFDO0FBRUQsZ0JBQWdCO0FBQ1QsS0FBSyxVQUFVLFlBQVksQ0FBQyxJQUFZLEVBQUUsU0FBaUMsRUFBRTtJQUNoRixNQUFNLFNBQVMsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDcEMsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1FBQ2IsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUMzRCxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsSUFBSSxVQUFVLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDLEdBQUcsQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLENBQUM7QUFDdkMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIEB0cy1pZ25vcmVcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xuaW1wb3J0IHsgY29weUZpbGUsIG1rZGlyLCByZWFkRmlsZSwgcmVhZGRpciwgc3RhdCwgd3JpdGVGaWxlIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGV4dG5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tICdwYXRoJztcbmltcG9ydCB7IEpzb25TY2hlbWEsIE9wZXJhdGlvbkluZm8gfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IE1BSU5fQlVJTEQgfSBmcm9tICcuL2J1aWxkLWluZm8nO1xuaW1wb3J0IHsgbWNwU2VydmVyU3RhdHVzLCBzdGFydE1jcFNlcnZlciwgc3RvcE1jcFNlcnZlciB9IGZyb20gJy4vbWNwLXByb2Nlc3MnO1xuXG4vKipcbiAqIOaTjeS9nOWxgu+8muiHqueglCBNQ1Ag5pyN5Yqh55qE5YWo6YOo6IO95Yqb6YO95pS25pWb5Zyo6L+Z6YeM44CCXG4gKlxuICog6K6+6K6h6KaB54K577yaXG4gKiAxLiDmr4/kuKrmk43kvZzpg73mmK/nuq/lh73mlbDlvI/nmoQgYXN5bmPvvIzlj4LmlbDkuI7ov5Tlm57lgLzpg73lv4XpobvmmK/nuq8gSlNPTu+8iElQQyDpmZDliLbvvInjgIJcbiAqIDIuIOaJqeWxleS4u+i/m+eoi+OAgeacrOWcsCBIVFRQIOahpeS4jiBNQ1AgU2VydmVyIOi1sOeahOaYr+WQjOS4gOWllyBvcGVyYXRpb25z77yMXG4gKiAgICBNQ1AgU2VydmVyIOWPqumcgOimgeaKiiB0b29sIOiwg+eUqOe/u+ivkeaIkCB7IG9wLCBwYXJhbXMgfSDljbPlj6/jgIJcbiAqIDMuIOS4pOadoemAmumBk+mDveS/neeVme+8mlxuICogICAgLSDnvJbovpHlmajmtojmga/pgJrpgZPvvJpFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsIC4uLikgLyAoJ2Fzc2V0LWRiJywgLi4uKVxuICogICAgICDotbDnvJbovpHlmaggdW5kbyAvIGRpcnR5IOS9k+ezu++8jOS/neWtmOacgOWPr+mdoOOAglxuICogICAgLSDlnLrmma/ohJrmnKzpgJrpgZPvvJpFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIC4uLilcbiAqICAgICAg6L+b5YWl5Zy65pmv6L+b56iL77yM5Y+v5Lul55u05o6l55So5byV5pOOIEFQSeOAglxuICogNC4g5q+P5Liq5pON5L2c6YO95bim5LiA5Lu9IEpTT04gU2NoZW1h77yMTUNQIOS+p+ebtOaOpeaLv+Wug+W9kyB0b29sIOeahCBpbnB1dFNjaGVtYe+8jFxuICogICAg6L+Z5qC35bel5YW355qE5Y+C5pWw57G75Z6L5piv55yf5a6e5aOw5piO55qE77yM5LiN5piv54yc5Ye65p2l55qE44CCXG4gKi9cblxuY29uc3QgU0NFTkUgPSAnc2NlbmUnO1xuY29uc3QgQVNTRVRfREIgPSAnYXNzZXQtZGInO1xuXG5leHBvcnQgaW50ZXJmYWNlIE9wZXJhdGlvbkRlZmluaXRpb24ge1xuICAgIC8qKiDmk43kvZzlkI3vvIzlvaLlpoIgc2NlbmUudHJlZSAqL1xuICAgIG5hbWU6IHN0cmluZztcbiAgICAvKiog5Lit5paH5qCH6aKYICovXG4gICAgdGl0bGU6IHN0cmluZztcbiAgICAvKiog6K+05piOICovXG4gICAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgICAvKiog5Y+C5pWw6K+05piO77yaa2V5IOS4uuWPguaVsOWQje+8jHZhbHVlIOS4uuWQq+S5iSAqL1xuICAgIHBhcmFtczogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgICAvKiog5Y+C5pWwIEpTT04gU2NoZW1hICovXG4gICAgc2NoZW1hOiBKc29uU2NoZW1hO1xuICAgIC8qKiDmiafooYwgKi9cbiAgICBydW4ocGFyYW1zOiB7IFtrZXk6IHN0cmluZ106IGFueSB9KTogUHJvbWlzZTxhbnk+O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOW3peWFt+WHveaVsFxuXG4vKiog5LuOIGR1bXAg5pWw5o2u6YeM5Y+W5Ye655yf5a6e5YC877yaZHVtcCDlvaLlpoIgeyB2YWx1ZTogeHh4IH0gKi9cbmZ1bmN0aW9uIGR1bXBWYWx1ZTxUID0gYW55Pihwcm9wOiBhbnksIGZhbGxiYWNrOiBUKTogVCB7XG4gICAgaWYgKHByb3AgPT09IG51bGwgfHwgcHJvcCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gICAgaWYgKHR5cGVvZiBwcm9wID09PSAnb2JqZWN0JyAmJiAndmFsdWUnIGluIHByb3ApIHtcbiAgICAgICAgcmV0dXJuIChwcm9wIGFzIHsgdmFsdWU6IFQgfSkudmFsdWU7XG4gICAgfVxuICAgIHJldHVybiBwcm9wIGFzIFQ7XG59XG5cbmZ1bmN0aW9uIHBpY2tTdHJpbmcocGFyYW1zOiBhbnksIGtleTogc3RyaW5nLCBmYWxsYmFjayA9ICcnKTogc3RyaW5nIHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtcz8uW2tleV07XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZSA6IGZhbGxiYWNrO1xufVxuXG5mdW5jdGlvbiBwaWNrTnVtYmVyKHBhcmFtczogYW55LCBrZXk6IHN0cmluZywgZmFsbGJhY2sgPSAwKTogbnVtYmVyIHtcbiAgICBjb25zdCB2YWx1ZSA9IE51bWJlcihwYXJhbXM/LltrZXldKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogZmFsbGJhY2s7XG59XG5cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpID0+IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG5cbi8qKiDpobnnm67moLnnm67lvZXvvIhFZGl0b3IuUHJvamVjdC5wYXRo77yM55u06L+e5qih5byP5LiL5LuOIGRpc3Qg5L2N572u5o6o5a+877yJICovXG5mdW5jdGlvbiBwcm9qZWN0Um9vdCgpOiBzdHJpbmcge1xuICAgIGNvbnN0IGVkaXRvciA9IHR5cGVvZiBFZGl0b3IgIT09ICd1bmRlZmluZWQnID8gKEVkaXRvciBhcyBhbnkpIDogbnVsbDtcbiAgICBpZiAoZWRpdG9yPy5Qcm9qZWN0Py5wYXRoKSByZXR1cm4gZWRpdG9yLlByb2plY3QucGF0aDtcbiAgICByZXR1cm4gam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICcuLicpO1xufVxuXG4vKiogZGI6Ly9hc3NldHMvLi4uIOi3r+W+hOi9rOejgeebmOe7neWvuei3r+W+hCAqL1xuZnVuY3Rpb24gZGJVcmxUb0FicyhkYlVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbihwcm9qZWN0Um9vdCgpLCBkYlVybC5yZXBsYWNlKC9eZGI6XFwvXFwvLywgJycpKTtcbn1cblxuLyoqIOWQjOS4gOejgeebmOi3r+W+hOWIpOWumu+8iFdpbmRvd3Mg5LiL5aSn5bCP5YaZ5LiO5YiG6ZqU56ym5LiN5pWP5oSf77yJICovXG5mdW5jdGlvbiBpc1NhbWVQYXRoKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgY29uc3QgcmEgPSByZXNvbHZlKGEpO1xuICAgIGNvbnN0IHJiID0gcmVzb2x2ZShiKTtcbiAgICByZXR1cm4gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJyA/IHJhLnRvTG93ZXJDYXNlKCkgPT09IHJiLnRvTG93ZXJDYXNlKCkgOiByYSA9PT0gcmI7XG59XG5cbi8qKiDlsYLnuqfnrqHnkIblmajph4zlvZPliY3pgInkuK3nmoToioLngrkgdXVpZCDliJfooaggKi9cbmZ1bmN0aW9uIGdldFNlbGVjdGVkTm9kZVV1aWRzKCk6IHN0cmluZ1tdIHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gRWRpdG9yLlNlbGVjdGlvbi5nZXRTZWxlY3RlZCgnbm9kZScpIHx8IFtdO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbn1cblxuLyoqIOS7juiKgueCuSBkdW1wIOmHjOWPlue7hOS7tuWIl+ihqO+8iDMuOC44IOeahOWtl+auteaYryBjb21wb25lbnRz77yM5LiN5pivIF9fY29tcHNfX++8iSAqL1xuZnVuY3Rpb24gcmVhZE5vZGVDb21wb25lbnRzKG5vZGU6IGFueSk6IGFueVtdIHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBbXTtcbiAgICBjb25zdCByYXcgPSBub2RlLmNvbXBvbmVudHMgfHwgbm9kZS5fX2NvbXBzX18gfHwgW107XG4gICAgcmV0dXJuIHJhdy5tYXAoKGNvbXA6IGFueSkgPT4ge1xuICAgICAgICBpZiAoY29tcCAmJiB0eXBlb2YgY29tcCA9PT0gJ29iamVjdCcgJiYgJ3ZhbHVlJyBpbiBjb21wICYmIGNvbXAudmFsdWUgJiYgdHlwZW9mIGNvbXAudmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAvLyDogIHmoLzlvI/vvJp7IHZhbHVlOiB7IHV1aWQsIG5hbWUsIGVuYWJsZWQgfSB9XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGNvbXAudmFsdWU7XG4gICAgICAgICAgICByZXR1cm4geyB1dWlkOiB2YWx1ZS51dWlkIHx8ICcnLCBuYW1lOiB2YWx1ZS5uYW1lIHx8ICcnLCB0eXBlOiB2YWx1ZS50eXBlIHx8ICcnLCBlbmFibGVkOiB2YWx1ZS5lbmFibGVkLCBpc0N1c3RvbTogISFjb21wLmlzQ3VzdG9tIH07XG4gICAgICAgIH1cbiAgICAgICAgLy8gMy44Ljgg5qC85byP77yaeyBpc0N1c3RvbSwgdHlwZSwgdmFsdWU6IDznu4Tku7Z1dWlkPiB9XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB1dWlkOiB0eXBlb2YgY29tcD8udmFsdWUgPT09ICdzdHJpbmcnID8gY29tcC52YWx1ZSA6IChjb21wPy51dWlkIHx8ICcnKSxcbiAgICAgICAgICAgIG5hbWU6IGNvbXA/Lm5hbWUgfHwgJycsXG4gICAgICAgICAgICB0eXBlOiBjb21wPy50eXBlIHx8ICcnLFxuICAgICAgICAgICAgZW5hYmxlZDogY29tcD8uZW5hYmxlZCxcbiAgICAgICAgICAgIGlzQ3VzdG9tOiAhIWNvbXA/LmlzQ3VzdG9tLFxuICAgICAgICB9O1xuICAgIH0pO1xufVxuXG4vKiog5Zyo5Zy65pmv5qCR6YeM5oyJIHV1aWQg5om+6IqC54K5ICovXG5mdW5jdGlvbiBmaW5kTm9kZUluVHJlZSh0cmVlOiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB7XG4gICAgaWYgKCF0cmVlKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoZHVtcFZhbHVlPHN0cmluZz4odHJlZS51dWlkLCAnJykgPT09IHV1aWQpIHJldHVybiB0cmVlO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgKHRyZWUuY2hpbGRyZW4gfHwgW10pKSB7XG4gICAgICAgIGNvbnN0IGhpdCA9IGZpbmROb2RlSW5UcmVlKGNoaWxkLCB1dWlkKTtcbiAgICAgICAgaWYgKGhpdCkgcmV0dXJuIGhpdDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiDor7vlj5bmn5DoioLngrnlvZPliY3nmoTnu4Tku7bliJfooajvvIjotbAgcXVlcnktbm9kZS10cmVl77yMMy44Ljgg55qEIHF1ZXJ5LW5vZGUg6L+U5ZueIG51bGzvvIkgKi9cbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5Tm9kZUNvbXBvbmVudHMobm9kZVV1aWQ6IHN0cmluZyk6IFByb21pc2U8YW55W10+IHtcbiAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgY29uc3QgZm91bmQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlVXVpZCk7XG4gICAgcmV0dXJuIHJlYWROb2RlQ29tcG9uZW50cyhmb3VuZCk7XG59XG5cbi8qKlxuICog5oqK57uE5Lu25qCH6K+G77yIY2MuWHh4IC8gWHh4IC8g55So5oi36ISa5pysIGNpZO+8ieWxleW8gOaIkOWPr+S4juWcuuaZr+agkee7hOS7tuWIl+ihqOavlOWvueeahOWAmemAieWQjeOAglxuICog5Zy65pmv5qCR6YeMIDMuOC44IOeahCBjb21wb25lbnRzW10udHlwZe+8muWGhee9rue7hOS7tuaYryBcImNjLlVJVHJhbnNmb3JtXCLvvIznlKjmiLfohJrmnKzmmK/nsbvlkI0gXCJTY3JlZW5GaWxsXCLjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNvbXBvbmVudENhbmRpZGF0ZXMoY29tcG9uZW50OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgY29uc3QgcmF3ID0gU3RyaW5nKGNvbXBvbmVudCB8fCAnJykudHJpbSgpO1xuICAgIGlmICghcmF3KSByZXR1cm4gW107XG4gICAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbcmF3XTtcblxuICAgIGxldCBsaXN0OiBhbnlbXSA9IFtdO1xuICAgIHRyeSB7XG4gICAgICAgIGxpc3QgPSAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKSkgfHwgW107XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsaXN0ID0gW107XG4gICAgfVxuICAgIC8vIOeUqOaIt+iEmuacrOaMiSBjaWQg5Y+N5p+l57G75ZCNXG4gICAgY29uc3QgYnlDaWQgPSBsaXN0LmZpbmQoKGl0ZW06IGFueSkgPT4gaXRlbSAmJiBpdGVtLmNpZCA9PT0gcmF3KTtcbiAgICBpZiAoYnlDaWQgJiYgYnlDaWQubmFtZSkgY2FuZGlkYXRlcy5wdXNoKFN0cmluZyhieUNpZC5uYW1lKSk7XG4gICAgLy8g5oyJ57G75ZCN5Y+N5p+lIGNpZFxuICAgIGNvbnN0IGJ5TmFtZSA9IGxpc3QuZmluZCgoaXRlbTogYW55KSA9PiBpdGVtICYmIGl0ZW0ubmFtZSA9PT0gcmF3KTtcbiAgICBpZiAoYnlOYW1lKSB7XG4gICAgICAgIGlmIChieU5hbWUubmFtZSkgY2FuZGlkYXRlcy5wdXNoKFN0cmluZyhieU5hbWUubmFtZSkpO1xuICAgICAgICBpZiAoYnlOYW1lLmNpZCkgY2FuZGlkYXRlcy5wdXNoKFN0cmluZyhieU5hbWUuY2lkKSk7XG4gICAgfVxuXG4gICAgaWYgKHJhdy5zdGFydHNXaXRoKCdjYy4nKSkgY2FuZGlkYXRlcy5wdXNoKHJhdy5zbGljZSgzKSk7XG4gICAgZWxzZSBpZiAoIXJhdy5pbmNsdWRlcygnLicpKSBjYW5kaWRhdGVzLnB1c2goYGNjLiR7cmF3fWApO1xuXG4gICAgcmV0dXJuIEFycmF5LmZyb20obmV3IFNldChjYW5kaWRhdGVzLmZpbHRlcihCb29sZWFuKSkpO1xufVxuXG4vKipcbiAqIOWcqOe7hOS7tuWIl+ihqOmHjOaJvuW3suWtmOWcqOeahOebruagh+e7hOS7tuOAglxuICogQ29jb3Mg5LiN5YWB6K645ZCM5LiA6IqC54K55oyC5ZCM57G75Z6L57uE5Lu277yM6YeN5aSNIGFkZCDkvJrooqvnvJbovpHlmajmi5Lnu53lubbmiZPljbBcbiAqIFwiW1NjZW5lXSBDYW4ndCBhZGQgY29tcG9uZW50ICdjYy5VSVRyYW5zZm9ybScgYmVjYXVzZSBYIGFscmVhZHkgY29udGFpbnMgdGhlIHNhbWUgY29tcG9uZW50LlwiXG4gKi9cbmZ1bmN0aW9uIG1hdGNoRXhpc3RpbmdDb21wb25lbnQoY29tcHM6IGFueVtdLCBjYW5kaWRhdGVzOiBzdHJpbmdbXSk6IGFueSB8IG51bGwge1xuICAgIGlmICghY29tcHMgfHwgIWNvbXBzLmxlbmd0aCB8fCAhY2FuZGlkYXRlcyB8fCAhY2FuZGlkYXRlcy5sZW5ndGgpIHJldHVybiBudWxsO1xuICAgIHJldHVybiAoXG4gICAgICAgIGNvbXBzLmZpbmQoKGNvbXA6IGFueSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IFN0cmluZyhjb21wPy50eXBlIHx8ICcnKTtcbiAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBTdHJpbmcoY29tcD8ubmFtZSB8fCAnJyk7XG4gICAgICAgICAgICBjb25zdCB1dWlkID0gU3RyaW5nKGNvbXA/LnV1aWQgfHwgJycpO1xuICAgICAgICAgICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgoYykgPT4gYyA9PT0gdHlwZSB8fCBjID09PSBuYW1lIHx8IGMgPT09IHV1aWQpO1xuICAgICAgICB9KSB8fCBudWxsXG4gICAgKTtcbn1cblxuLyoqIOaKiiBxdWVyeS1ub2RlLXRyZWUg6L+U5Zue55qE6IqC54K55qCR6L2s5oiQ5Y+v6K+75paH5pysICovXG5mdW5jdGlvbiBmb3JtYXROb2RlVHJlZShub2RlOiBhbnksIGRlcHRoID0gMCk6IHN0cmluZyB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gJyc7XG4gICAgY29uc3QgbmFtZSA9IGR1bXBWYWx1ZTxzdHJpbmc+KG5vZGUubmFtZSwgJyjmnKrlkb3lkI0pJyk7XG4gICAgY29uc3QgdXVpZCA9IGR1bXBWYWx1ZTxzdHJpbmc+KG5vZGUudXVpZCwgJycpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IGR1bXBWYWx1ZTxib29sZWFuPihub2RlLmFjdGl2ZSwgdHJ1ZSk7XG4gICAgY29uc3QgY29tcHM6IHN0cmluZ1tdID0gcmVhZE5vZGVDb21wb25lbnRzKG5vZGUpLm1hcCgoY29tcDogYW55KSA9PiBjb21wLnR5cGUgfHwgY29tcC5uYW1lKS5maWx0ZXIoQm9vbGVhbik7XG5cbiAgICBjb25zdCBpbmRlbnQgPSAnICAnLnJlcGVhdChkZXB0aCk7XG4gICAgbGV0IGxpbmUgPSBgJHtpbmRlbnR9LSAke25hbWV9JHthY3RpdmUgPyAnJyA6ICcgW2luYWN0aXZlXSd9YDtcbiAgICBpZiAodXVpZCkgbGluZSArPSBgICA8JHt1dWlkfT5gO1xuICAgIGlmIChjb21wcy5sZW5ndGgpIGxpbmUgKz0gYCAgWyR7Y29tcHMuam9pbignLCAnKX1dYDtcbiAgICBjb25zdCBwb3NpdGlvbiA9IGR1bXBWYWx1ZTxhbnk+KG5vZGUucG9zaXRpb24sIG51bGwpO1xuICAgIGlmIChwb3NpdGlvbiAmJiB0eXBlb2YgcG9zaXRpb24gPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGxpbmUgKz0gYCAgKCR7cG9zaXRpb24ueCA/PyAwfSwgJHtwb3NpdGlvbi55ID8/IDB9LCAke3Bvc2l0aW9uLnogPz8gMH0pYDtcbiAgICB9XG5cbiAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSBBcnJheS5pc0FycmF5KG5vZGUuY2hpbGRyZW4pID8gbm9kZS5jaGlsZHJlbiA6IFtdO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGZvcm1hdE5vZGVUcmVlKGNoaWxkLCBkZXB0aCArIDEpO1xuICAgICAgICBpZiAodGV4dCkgbGluZSArPSBgXFxuJHt0ZXh0fWA7XG4gICAgfVxuICAgIHJldHVybiBsaW5lO1xufVxuXG4vKiog57uf6K6h6IqC54K55pWw6YeP77yI5ZCr5qC577yJICovXG5mdW5jdGlvbiBjb3VudE5vZGVzKG5vZGU6IGFueSk6IG51bWJlciB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gMDtcbiAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSBBcnJheS5pc0FycmF5KG5vZGUuY2hpbGRyZW4pID8gbm9kZS5jaGlsZHJlbiA6IFtdO1xuICAgIHJldHVybiAxICsgY2hpbGRyZW4ucmVkdWNlKChzdW06IG51bWJlciwgY2hpbGQ6IGFueSkgPT4gc3VtICsgY291bnROb2RlcyhjaGlsZCksIDApO1xufVxuXG4vKiog56m655qE5Y+C5pWwIHNjaGVtYSAqL1xuZnVuY3Rpb24gbm9QYXJhbXMoKTogSnNvblNjaGVtYSB7XG4gICAgcmV0dXJuIHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDmk43kvZzlrprkuYlcblxuY29uc3QgZWRpdG9ySW5mbzogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnZWRpdG9yLmluZm8nLFxuICAgIHRpdGxlOiAn57yW6L6R5ZmoIC8g6aG555uu5L+h5oGvJyxcbiAgICBkZXNjcmlwdGlvbjogJ+aJk+WNsOW9k+WJjSBDcmVhdG9yIOeJiOacrOOAgemhueebrui3r+W+hOOAgeaJqeWxleiHqui6q+S/oeaBrycsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IG5vUGFyYW1zKCksXG4gICAgYXN5bmMgcnVuKCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYnVpbGQ6IE1BSU5fQlVJTEQsXG4gICAgICAgICAgICBlZGl0b3JOYW1lOiBFZGl0b3IuQXBwLm5hbWUsXG4gICAgICAgICAgICBlZGl0b3JWZXJzaW9uOiBFZGl0b3IuQXBwLnZlcnNpb24sXG4gICAgICAgICAgICBlZGl0b3JQYXRoOiBFZGl0b3IuQXBwLnBhdGgsXG4gICAgICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgICAgIGV4dGVuc2lvbk5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICBleHRlbnNpb25WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxuICAgICAgICAgICAgbm9kZVZlcnNpb246IHByb2Nlc3MudmVyc2lvbixcbiAgICAgICAgICAgIHBsYXRmb3JtOiBgJHtwcm9jZXNzLnBsYXRmb3JtfSAke3Byb2Nlc3MuYXJjaH1gLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVN0YXR1czogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuc3RhdHVzJyxcbiAgICB0aXRsZTogJ+W9k+WJjeWcuuaZr+eKtuaAgScsXG4gICAgZGVzY3JpcHRpb246ICflnLrmma/mmK/lkKblsLHnu6ogLyDmmK/lkKbmnInmnKrkv53lrZjmlLnliqggLyDmoLnoioLngrkgLyDpgInkuK3oioLngrknLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgY29uc3QgaXNSZWFkeSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1pcy1yZWFkeScpO1xuICAgICAgICBjb25zdCBpc0RpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWRpcnR5Jyk7XG4gICAgICAgIGNvbnN0IHRyZWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpc1JlYWR5LFxuICAgICAgICAgICAgaXNEaXJ0eSxcbiAgICAgICAgICAgIHNjZW5lTmFtZTogZHVtcFZhbHVlPHN0cmluZz4odHJlZT8ubmFtZSwgJyjmnKrlkb3lkI3lnLrmma8pJyksXG4gICAgICAgICAgICBzY2VuZVV1aWQ6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/LnV1aWQsICcnKSxcbiAgICAgICAgICAgIG5vZGVDb3VudDogTWF0aC5tYXgoMCwgY291bnROb2Rlcyh0cmVlKSAtIDEpLFxuICAgICAgICAgICAgc2VsZWN0ZWROb2RlczogZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKSxcbiAgICAgICAgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVUcmVlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY2VuZS50cmVlJyxcbiAgICB0aXRsZTogJ+WcuuaZr+iKgueCueagkScsXG4gICAgZGVzY3JpcHRpb246ICfor7vlj5blvZPliY3lnLrmma/nmoTlrozmlbToioLngrnmoJHvvIjoioLngrnlkI0gLyB1dWlkIC8g57uE5Lu2IC8g5Z2Q5qCH77yJJyxcbiAgICBwYXJhbXM6IHt9LFxuICAgIHNjaGVtYTogbm9QYXJhbXMoKSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIGNvbnN0IHRyZWUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzY2VuZU5hbWU6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/Lm5hbWUsICco5pyq5ZG95ZCN5Zy65pmvKScpLFxuICAgICAgICAgICAgc2NlbmVVdWlkOiBkdW1wVmFsdWU8c3RyaW5nPih0cmVlPy51dWlkLCAnJyksXG4gICAgICAgICAgICBub2RlQ291bnQ6IE1hdGgubWF4KDAsIGNvdW50Tm9kZXModHJlZSkgLSAxKSxcbiAgICAgICAgICAgIHRyZWU6IGZvcm1hdE5vZGVUcmVlKHRyZWUpLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG4vKipcbiAqIOaKiiBidWlsdGluIOefreWQjSAvIHByZWZhYiDlvJXnlKjnu5/kuIDop6PmnpDmiJDlj6/lrp7kvovljJbnmoQgcHJlZmFiIOi1hOS6p+OAglxuICogLSBidWlsdGlu77yaZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8855+t5ZCNPi5wcmVmYWLvvIzljbPnvJbovpHlmajjgIzliJvlu7rjgI3oj5zljZXlkIzmrL7lhoXnva7mqKHmnb9cbiAqIC0gcHJlZmFi77yaZGI6Ly8gdXJsIOaIliB1dWlk77yM5Lu75oSPIHByZWZhYiDotYTkuqfvvIjlkKvpobnnm67oh6rlt7HnmoTpooTliLbkvZPvvIlcbiAqIOS4pOiAhemDveS4uuepuui/lOWbniBudWxs77yIPSDmma7pgJrnqbroioLngrnmqKHlvI/vvInjgIJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVByZWZhYkFzc2V0KGJ1aWx0aW46IHN0cmluZywgcHJlZmFiOiBzdHJpbmcpOiBQcm9taXNlPHsgdXVpZDogc3RyaW5nOyB1cmw6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0gfCBudWxsPiB7XG4gICAgaWYgKGJ1aWx0aW4gJiYgcHJlZmFiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignYnVpbHRpbiDkuI4gcHJlZmFiIOWPquiDveS6jOmAieS4gCcpO1xuICAgIH1cbiAgICBsZXQgdGFyZ2V0ID0gJyc7XG4gICAgaWYgKGJ1aWx0aW4pIHtcbiAgICAgICAgY29uc3Qgc2hvcnQgPSBidWlsdGluLnRyaW0oKS5yZXBsYWNlKC9cXC5wcmVmYWIkL2ksICcnKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCAnJyk7XG4gICAgICAgIHRhcmdldCA9IGBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyR7c2hvcnR9LnByZWZhYmA7XG4gICAgfSBlbHNlIGlmIChwcmVmYWIpIHtcbiAgICAgICAgdGFyZ2V0ID0gcHJlZmFiLnRyaW0oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgbGV0IGluZm86IGFueSA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgdGFyZ2V0KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGluZm8gPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIWluZm8gfHwgIWluZm8udXVpZCkge1xuICAgICAgICBsZXQgaGludCA9IGJ1aWx0aW4gPyAn77yb5Y+v55SoIGFzc2V0X2xpc3QocGF0dGVybj1cImRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvKiovKi5wcmVmYWJcIikg5p+l55yL5YWo6YOo5YaF572u5qih5p2/JyA6ICcnO1xuICAgICAgICBpZiAoYnVpbHRpbikge1xuICAgICAgICAgICAgLy8gMy44IOWGhee9ruaooeadv+e7neWkp+WkmuaVsOWcqCB1aS/jgIEzZC/jgIFsaWdodC8g5a2Q55uu5b2V5LiL77yM6KO455+t5ZCN5Z+65pys5LiN5a2Y5Zyo77yb5o6i5rWL5ZG95Lit5pe255u05o6l57uZ5Ye65q2j56Gu5YaZ5rOVXG4gICAgICAgICAgICBjb25zdCBzaG9ydCA9IGJ1aWx0aW4udHJpbSgpLnJlcGxhY2UoL151aVxcLy9pLCAnJyk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGRpciBvZiBbJ3VpJywgJzNkJywgJ2xpZ2h0J10pIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBhbHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyR7ZGlyfS8ke3Nob3J0fS5wcmVmYWJgKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFsdCAmJiBhbHQudXVpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaGludCA9IGDvvJvor6XmqKHmnb/lnKggJHtkaXJ9LyDlrZDnm67lvZXkuIvvvIzmraPnoa7lhpnms5XmmK8gYnVpbHRpbj1cIiR7ZGlyfS8ke3Nob3J0fVwiYDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyDmjqLmtYvlpLHotKXkuI3lvbHlk43ljp/mnKznmoTmiqXplJlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLAgcHJlZmFiIOi1hOS6pzogJHt0YXJnZXR9JHtoaW50fWApO1xuICAgIH1cbiAgICBpZiAoaW5mby50eXBlICYmIGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfotYTkuqfkuI3mmK8gcHJlZmFi77yIJHtpbmZvLnR5cGV977yJOiAke2luZm8udXJsIHx8IHRhcmdldH1gKTtcbiAgICB9XG4gICAgY29uc3QgdXJsOiBzdHJpbmcgPSBpbmZvLnVybCB8fCB0YXJnZXQ7XG4gICAgcmV0dXJuIHsgdXVpZDogaW5mby51dWlkLCB1cmwsIG5hbWU6IGJhc2VuYW1lKHVybCkucmVwbGFjZSgvXFwucHJlZmFiJC9pLCAnJykgfTtcbn1cblxuY29uc3Qgbm9kZUNyZWF0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5jcmVhdGUnLFxuICAgIHRpdGxlOiAn5Yib5bu66IqC54K5JyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9jcmVhdGUtbm9kZSDliJvlu7roioLngrnvvIzotbDnvJbovpHlmaggdW5kbyDkvZPns7vjgILkuInnp43nlKjms5XvvJoxKSDpu5jorqTlu7rnqbroioLngrnvvIjnvJbovpHlmajoh6rliqjpmYTliqAgY2MuVUlUcmFuc2Zvcm3vvIzli7/ph43lpI0gYWRkQ29tcG9uZW5077yJ77ybMikgYnVpbHRpbj3lhoXnva7mqKHmnb/nn63lkI3vvIzmmKDlsITliLAgZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8855+t5ZCNPi5wcmVmYWLvvIzkuIDmraXlrp7kvovljJblrozmlbTmqKHmnb/vvIjlkKvlrZDoioLngrnkuI7pu5jorqTotYTmupDlvJXnlKjvvInvvJvluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDigJTigJRVSSDnlKggdWkvQnV0dG9u44CBdWkvTGFiZWzjgIF1aS9TcHJpdGXjgIF1aS9DYW52YXPjgIF1aS9MYXlvdXTjgIF1aS9TY3JvbGxWaWV3IOetie+8iOimgeaxguWcuuaZr+W3suaciSBDYW52YXPvvInvvIwzRCDnlKggM2QvQ3ViZeOAgTNkL1NwaGVyZe+8jOeBr+WFieeUqCBsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIzkvJrmiqXjgIzmib7kuI3liLAgcHJlZmFiIOi1hOS6p+OAje+8m+WFqOmHj+WIl+ihqOeUqCBhc3NldF9saXN0KHBhdHRlcm49XCJkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyoqLyoucHJlZmFiXCIpIOafpeivou+8mzMpIHByZWZhYj3ku7vmhI/pooTliLbkvZPvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzmiorlt7LmnIkgcHJlZmFiIOWunuS+i+WMlui/m+WcuuaZr+OAguazqOaEj++8mnBhcmVudCDlv4XpobvmmK/nnJ/lrp7oioLngrkgdXVpZO+8iOS4jeino+aekOi3r+W+hO+8ie+8jOW8leeUqOaXoOaViOaXtuiKgueCueS8muiiq+mdmem7mOW7uuWIsOWcuuaZr+ague+8iOS4jeaKpemUme+8ie+8jOaJuemHj+aQreW7uuWQjuW7uuiuruWuoeiuoeWcuuaZr+agueaYr+WQpuWHuueOsOWtpOWEv+iKgueCuScsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIG5hbWU6ICfoioLngrnlkI3vvIznvLrnnIHml7bnqbroioLngrnnlKggTUNQX05vZGXjgIHmqKHmnb/mqKHlvI/nlKjmqKHmnb/lkI3vvIjlubbmjInniLboioLngrnnlJ/miJDkuI3ph43lkI3lkI3lrZfvvIknLFxuICAgICAgICBwYXJlbnQ6ICfniLboioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8jOaXoOaViOaXtumdmem7mOW7uuWIsOWcuuaZr+ague+8ie+8m+eVmeepuuWImeW7uuWcqOWcuuaZr+agueS4i++8m+WhqyBAc2VsZWN0aW9uIOWImeW7uuWcqOW9k+WJjemAieS4reiKgueCueS4iycsXG4gICAgICAgIGJ1aWx0aW46ICflhoXnva7mqKHmnb/nn63lkI3vvIzmmKDlsITliLAgZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi88YnVpbHRpbj4ucHJlZmFi77yb5bi455So5qih5p2/6YO95bim5a2Q55uu5b2V5YmN57yA77yadWkvQnV0dG9u44CBdWkvTGFiZWzjgIF1aS9TcHJpdGXjgIF1aS9DYW52YXPjgIF1aS9MYXlvdXTjgIF1aS9TY3JvbGxWaWV344CBM2QvQ3ViZeOAgTNkL1NwaGVyZeOAgWxpZ2h0L1BvaW50IExpZ2h077yb6KO455+t5ZCNIEJ1dHRvbuOAgUxhYmVs44CBU3ByaXRlIOS4jeWtmOWcqO+8iOmhu+WGmSB1aS9CdXR0b24g562J77yJ77yb5LiOIHByZWZhYiDkuozpgInkuIDvvJvlhajpm4bnlKggYXNzZXRfbGlzdChwYXR0ZXJuPVwiZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8qKi8qLnByZWZhYlwiKSDmn6UnLFxuICAgICAgICBwcmVmYWI6ICfku7vmhI8gcHJlZmFiIOi1hOS6p++8iGRiOi8vIHVybCDmiJYgdXVpZO+8ie+8jOWunuS+i+WMlui/m+WcuuaZr++8jOS4jiBidWlsdGluIOS6jOmAieS4gCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCNJyB9LFxuICAgICAgICAgICAgcGFyZW50OiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICfniLboioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8jOaXoOaViOaXtumdmem7mOW7uuWIsOWcuuaZr+ague+8ie+8m+eVmeepuuWImeW7uuWcqOWcuuaZr+agueS4i++8m+WhqyBAc2VsZWN0aW9uIOWImeW7uuWcqOW9k+WJjemAieS4reiKgueCueS4iycsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYnVpbHRpbjoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5YaF572u5qih5p2/55+t5ZCN77yM5pig5bCE5YiwIGRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvPGJ1aWx0aW4+LnByZWZhYu+8jOW4uOeUqOaooeadv+mDveW4puWtkOebruW9leWJjee8gO+8mnVpL0J1dHRvbuOAgXVpL0xhYmVs44CBdWkvU3ByaXRl44CBdWkvQ2FudmFz44CBdWkvTGF5b3V044CBM2QvQ3ViZeOAgWxpZ2h0L1BvaW50IExpZ2h077yb6KO455+t5ZCNIEJ1dHRvbuOAgUxhYmVs44CBU3ByaXRlIOS4jeWtmOWcqO+8iOmhu+WGmSB1aS9CdXR0b24g562J77yJ77yb5LiOIHByZWZhYiDkuozpgInkuIAnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHByZWZhYjoge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5Lu75oSPIHByZWZhYiDotYTkuqfvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzlrp7kvovljJbov5vlnLrmma/vvIzkuI4gYnVpbHRpbiDkuozpgInkuIAnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBidWlsdGluID0gcGlja1N0cmluZyhwYXJhbXMsICdidWlsdGluJywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3QgcHJlZmFiID0gcGlja1N0cmluZyhwYXJhbXMsICdwcmVmYWInLCAnJykudHJpbSgpO1xuICAgICAgICBjb25zdCByYXdQYXJlbnQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3BhcmVudCcsICcnKS50cmltKCk7XG4gICAgICAgIGxldCBwYXJlbnQgPSAnJztcbiAgICAgICAgbGV0IHBhcmVudFNvdXJjZSA9ICdzY2VuZS1yb290JztcblxuICAgICAgICBpZiAocmF3UGFyZW50ID09PSAnQHNlbGVjdGlvbicpIHtcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcbiAgICAgICAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdwYXJlbnQg5oyH5a6a5Li6IEBzZWxlY3Rpb27vvIzkvYblvZPliY3msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHBhcmVudCA9IHNlbGVjdGVkWzBdO1xuICAgICAgICAgICAgcGFyZW50U291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH0gZWxzZSBpZiAocmF3UGFyZW50KSB7XG4gICAgICAgICAgICBwYXJlbnQgPSByYXdQYXJlbnQ7XG4gICAgICAgICAgICBwYXJlbnRTb3VyY2UgPSAncGFyYW1zJztcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRlbXBsYXRlID0gYXdhaXQgcmVzb2x2ZVByZWZhYkFzc2V0KGJ1aWx0aW4sIHByZWZhYik7XG5cbiAgICAgICAgY29uc3QgcmF3TmFtZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAnbmFtZScsICcnKTtcbiAgICAgICAgbGV0IG5hbWUgPSByYXdOYW1lIHx8ICh0ZW1wbGF0ZSA/IHRlbXBsYXRlLm5hbWUgOiAnJykgfHwgJ01DUF9Ob2RlJztcbiAgICAgICAgLy8g5LiO57yW6L6R5Zmo6I+c5Y2V5LiA6Ie077ya5qih5p2/5qih5byP5LiL5oyJ54i26IqC54K555Sf5oiQ5LiN6YeN5ZCN55qE5ZCN5a2XXG4gICAgICAgIGlmICh0ZW1wbGF0ZSAmJiAhcmF3TmFtZSAmJiBwYXJlbnQpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2dlbmVyYXRlLWF2YWlsYWJsZS1uYW1lJywgbmFtZSwgcGFyZW50KTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGF2YWlsYWJsZSA9PT0gJ3N0cmluZycgJiYgYXZhaWxhYmxlKSBuYW1lID0gYXZhaWxhYmxlO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIC8vIOivpea2iOaBr+S4jeWPr+eUqOaXtuS/neaMgeWOn+WQje+8jOmHjeWQjeS4jeW9seWTjeWIm+W7ulxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgb3B0aW9uczogYW55ID0geyBuYW1lIH07XG4gICAgICAgIGlmIChwYXJlbnQpIG9wdGlvbnMucGFyZW50ID0gcGFyZW50O1xuICAgICAgICBpZiAodGVtcGxhdGUpIHtcbiAgICAgICAgICAgIG9wdGlvbnMuYXNzZXRVdWlkID0gdGVtcGxhdGUudXVpZDtcbiAgICAgICAgICAgIG9wdGlvbnMuc25hcHNob3QgPSB0cnVlO1xuICAgICAgICAgICAgLy8g5LiO57yW6L6R5Zmo6I+c5Y2V5LiA6Ie077yaVUkg5qih5p2/6KaB5rGC5Zy65pmv6YeM5pyJIENhbnZhc++8iENhbnZhcyDmqKHmnb/mnKzouqvpmaTlpJbvvIlcbiAgICAgICAgICAgIGlmIChidWlsdGluLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aCgndWkvJykgJiYgdGVtcGxhdGUubmFtZS50b0xvd2VyQ2FzZSgpICE9PSAnY2FudmFzJykge1xuICAgICAgICAgICAgICAgIG9wdGlvbnMuY2FudmFzUmVxdWlyZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHV1aWQgPSAnJztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHV1aWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnY3JlYXRlLW5vZGUnLCBvcHRpb25zKTtcbiAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgICAgICBjb25zdCBoaW50ID0gb3B0aW9ucy5jYW52YXNSZXF1aXJlZFxuICAgICAgICAgICAgICAgID8gJ++8m3VpLyog5qih5p2/6KaB5rGC5Zy65pmv5YWI5pyJIENhbnZhc++8jOWPr+WFiCBub2RlX2NyZWF0ZShidWlsdGluPVwiQ2FudmFzXCIpJ1xuICAgICAgICAgICAgICAgIDogJyc7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGNyZWF0ZS1ub2RlIOWksei0pTogJHtlPy5tZXNzYWdlIHx8IGV9JHtoaW50fWApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5LiA5qyhIHF1ZXJ5LW5vZGUtdHJlZSDlkIzml7blm57or7vnu4Tku7bliJfooajvvIjnqbroioLngrnmqKHlvI/nmoQgY2MuVUlUcmFuc2Zvcm0g5o+Q56S677yJ5LiO5qih5p2/5a2Q5qCRXG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCB1dWlkKTtcbiAgICAgICAgY29uc3QgY29tcHMgPSByZWFkTm9kZUNvbXBvbmVudHMoZm91bmQpO1xuICAgICAgICBjb25zdCBoYXNVSVRyYW5zZm9ybSA9IGNvbXBzLnNvbWUoKGM6IGFueSkgPT4gYy50eXBlID09PSAnY2MuVUlUcmFuc2Zvcm0nKTtcbiAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSB7IHV1aWQsIG5hbWUsIHBhcmVudDogcGFyZW50IHx8IG51bGwsIHBhcmVudFNvdXJjZSwgY29tcG9uZW50czogY29tcHMsIGhhc1VJVHJhbnNmb3JtIH07XG4gICAgICAgIGlmICh0ZW1wbGF0ZSkge1xuICAgICAgICAgICAgcmVzdWx0LnNvdXJjZSA9IGJ1aWx0aW4gPyAnYnVpbHRpbi10ZW1wbGF0ZScgOiAncHJlZmFiJztcbiAgICAgICAgICAgIHJlc3VsdC50ZW1wbGF0ZSA9IHRlbXBsYXRlLnVybDtcbiAgICAgICAgICAgIHJlc3VsdC50ZW1wbGF0ZVV1aWQgPSB0ZW1wbGF0ZS51dWlkO1xuICAgICAgICAgICAgcmVzdWx0Lm5vZGVDb3VudCA9IGNvdW50Tm9kZXMoZm91bmQpO1xuICAgICAgICAgICAgcmVzdWx0LnN1YnRyZWUgPSBmb3JtYXROb2RlVHJlZShmb3VuZCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZURlbGV0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5kZWxldGUnLFxuICAgIHRpdGxlOiAn5Yig6Zmk6IqC54K5JyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9yZW1vdmUtbm9kZSDliKDpmaToioLngrnvvIzpu5jorqTliKDpmaTlsYLnuqfnrqHnkIblmajkuK3pgInkuK3nmoToioLngrknLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnliKDpmaTlvZPliY3pgInkuK3oioLngrknLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ5Yig6Zmk5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXVpZCcsICcnKTtcbiAgICAgICAgbGV0IGxpc3Q6IHN0cmluZ1tdID0gcmF3LnNwbGl0KCcsJykubWFwKChpdGVtKSA9PiBpdGVtLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XG4gICAgICAgIGlmICghbGlzdC5sZW5ndGgpIHtcbiAgICAgICAgICAgIGxpc3QgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFsaXN0Lmxlbmd0aCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrproioLngrnvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncmVtb3ZlLW5vZGUnLCB7IHV1aWQ6IGxpc3QubGVuZ3RoID09PSAxID8gbGlzdFswXSA6IGxpc3QgfSk7XG4gICAgICAgIHJldHVybiB7IHJlbW92ZWQ6IGxpc3QsIHNvdXJjZSB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlTW92ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5tb3ZlJyxcbiAgICB0aXRsZTogJ+enu+WKqOiKgueCue+8iOa2iOaBr+mAmumBk++8iScsXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4cgc2NlbmUvc2V0LXByb3BlcnR5IOS/ruaUueiKgueCuSBwb3NpdGlvbu+8iOi1sOe8lui+keWZqCB1bmRvIOS9k+ezu++8iScsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXG4gICAgICAgIHg6ICd4IOWdkOaghycsXG4gICAgICAgIHk6ICd5IOWdkOaghycsXG4gICAgICAgIHo6ICd6IOWdkOaghycsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXG4gICAgICAgICAgICB4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3gg5Z2Q5qCHJyB9LFxuICAgICAgICAgICAgeTogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd5IOWdkOaghycgfSxcbiAgICAgICAgICAgIHo6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneiDlnZDmoIcnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XG4gICAgICAgIGxldCBzb3VyY2UgPSAncGFyYW1zJztcbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICB1dWlkID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXV1aWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSB7XG4gICAgICAgICAgICB4OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3gnLCAwKSxcbiAgICAgICAgICAgIHk6IHBpY2tOdW1iZXIocGFyYW1zLCAneScsIDApLFxuICAgICAgICAgICAgejogcGlja051bWJlcihwYXJhbXMsICd6JywgMCksXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IG9rID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NldC1wcm9wZXJ0eScsIHtcbiAgICAgICAgICAgIHV1aWQsXG4gICAgICAgICAgICBwYXRoOiAncG9zaXRpb24nLFxuICAgICAgICAgICAgZHVtcDogeyB2YWx1ZTogcG9zaXRpb24gfSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgcGF0aDogJ3Bvc2l0aW9uJywgcG9zaXRpb24sIGFwcGxpZWQ6IG9rIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVNb3ZlRW5naW5lOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLm1vdmUuZW5naW5lJyxcbiAgICB0aXRsZTogJ+enu+WKqOiKgueCue+8iOW8leaTjumAmumBk++8iScsXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4flnLrmma/ohJrmnKznm7TmjqXosIPnlKjlvJXmk44gQVBJIOiuvue9riBwb3NpdGlvbu+8iOS4jei/myB1bmRvIOS9k+ezu++8iScsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXG4gICAgICAgIHg6ICd4IOWdkOaghycsXG4gICAgICAgIHk6ICd5IOWdkOaghycsXG4gICAgICAgIHo6ICd6IOWdkOaghycsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXG4gICAgICAgICAgICB4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3gg5Z2Q5qCHJyB9LFxuICAgICAgICAgICAgeTogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd5IOWdkOaghycgfSxcbiAgICAgICAgICAgIHo6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneiDlnZDmoIcnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XG4gICAgICAgIGxldCBzb3VyY2UgPSAncGFyYW1zJztcbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICB1dWlkID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXV1aWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSB7XG4gICAgICAgICAgICB4OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3gnLCAwKSxcbiAgICAgICAgICAgIHk6IHBpY2tOdW1iZXIocGFyYW1zLCAneScsIDApLFxuICAgICAgICAgICAgejogcGlja051bWJlcihwYXJhbXMsICd6JywgMCksXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICAgICBtZXRob2Q6ICdtb3ZlTm9kZScsXG4gICAgICAgICAgICBhcmdzOiBbdXVpZCwgcG9zaXRpb25dLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgdXVpZCwgc291cmNlLCBwb3NpdGlvbiwgc2NyaXB0UmVzdWx0OiByZXN1bHQgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZVNldFByb3BlcnR5OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLnNldFByb3BlcnR5JyxcbiAgICB0aXRsZTogJ+iuvue9ruWxnuaAp++8iOa2iOaBr+mAmumBk++8iScsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfpgJrov4cgc2NlbmUvc2V0LXByb3BlcnR5IOiuvue9ruiKgueCueaIlue7hOS7tuWxnuaAp++8iOi1sOe8lui+keWZqCB1bmRvIOS9k+ezu++8ieOAgicgK1xuICAgICAgICAn5rOo5oSP77yadXVpZCDlv4XpobvmmK/nnJ/lrp7oioLngrkgdXVpZO+8jOacrOaTjeS9nOS4jeino+aekOiKgueCuei3r+W+hO+8iOS8oOi3r+W+hOS8mumdmem7mOaXoOaViO+8ie+8mycgK1xuICAgICAgICAn5aSa57uE5Lu26IqC54K56K6+IGNvbnRlbnRTaXplIOWcqOacrOmAmumBk+S8mumdmem7mOWksei0pe+8jOaUueeUqCBub2RlX3NldF9wcm9wZXJ0eV9lbmdpbmXvvIh7XCJfX3NpemVcIjpbdyxoXX3vvIzluKYgYXBwbGllZCDlm57or7vvvInjgIInICtcbiAgICAgICAgJ3BhdGgg5YaZ5rOV77ya6IqC54K55bGe5oCn55u05o6l5YaZ5ZCN5a2X77yIcG9zaXRpb24gLyBuYW1lIC8gYWN0aXZl77yJ77yb57uE5Lu25bGe5oCn5YaZIGNvbXBvbmVudHMuPOe0ouW8lT4uPOWxnuaApz7vvIwnICtcbiAgICAgICAgJ+e0ouW8leeUqCBub2RlX2xpc3RfY29tcG9uZW50cyDmn6XvvIjlpoIgY29tcG9uZW50cy4wLnN0cmluZ+OAgWNvbXBvbmVudHMuMi5jb250ZW50U2l6Ze+8ieOAgicgK1xuICAgICAgICAndmFsdWUg5piv57qvIEpTT07vvJvnu5PmnoTljJblgLzvvIh7eCx5LHp9L3t3aWR0aCxoZWlnaHR9L3tyLGcsYixhfe+8ieS8muiHquWKqOivhuWIq+aIkCBjYy5WZWMzL2NjLlNpemUvY2MuQ29sb3LjgIInICtcbiAgICAgICAgJ+W8leeUqOexu+Wei+WxnuaAp++8iEBwcm9wZXJ0eShMYWJlbCkg5LmL57G777yJ5LygIHR5cGU9Y2MuTGFiZWzjgIF2YWx1ZT17XCJ1dWlkXCI6XCLnm67moIfnu4Tku7bmiJboioLngrl1dWlkXCJ977ybJyArXG4gICAgICAgICflvJXnlKjnu5HlrprkvJjlhYjnlKggbm9kZV9iaW5kX3Byb3BlcnR577yI6Ieq5Yqo5a6a5L2N57uE5Lu2L+ino+aekOebruaghy/mibnph48v5Zue6K+76aqM6K+B77yJ44CCJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgdXVpZDogJ+iKgueCuSB1dWlk77yI5LiN5pSv5oyB6Lev5b6E77yJ77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICAgICAgcGF0aDogJ+WxnuaAp+i3r+W+hO+8jOWmgiBwb3NpdGlvbuOAgWNvbXBvbmVudHMuMC5zdHJpbmcnLFxuICAgICAgICB2YWx1ZTogJ+WxnuaAp+WAvO+8iOe6ryBKU09O77yJJyxcbiAgICAgICAgdHlwZTogJ+WPr+mAieOAgmR1bXAg57G75Z6L5ZCN77yIY2MuVmVjMy9jYy5TaXplL2NjLkNvbG9yL2NjLkxhYmVsL2NjLk5vZGXigKbvvInvvIzkuI3kvKDml7bmjIkgdmFsdWUg5b2i54q26Ieq5Yqo6K+G5YirJyxcbiAgICAgICAgZHVtcDogJ+WPr+mAieOAguWujOaVtCBkdW1wIOWvueixoe+8m+S8oOWFpeWQjuW/veeVpSB2YWx1ZS90eXBl77yM55So5LqO5YWc5bqV54m55q6K5qC85byPJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8ie+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScgfSxcbiAgICAgICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn6Lev5b6E77yM5aaCIHBvc2l0aW9u44CBY29tcG9uZW50cy4wLnN0cmluZycgfSxcbiAgICAgICAgICAgIHZhbHVlOiB7IGRlc2NyaXB0aW9uOiAn5bGe5oCn5YC8JyB9LFxuICAgICAgICAgICAgdHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdkdW1wIOexu+Wei+WQje+8iOWPr+mAie+8iScgfSxcbiAgICAgICAgICAgIGR1bXA6IHsgdHlwZTogJ29iamVjdCcsIGRlc2NyaXB0aW9uOiAn5a6M5pW0IGR1bXAg5a+56LGh77yI5Y+v6YCJ77yM5YWc5bqV55So77yJJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydwYXRoJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XG4gICAgICAgIGxldCBzb3VyY2UgPSAncGFyYW1zJztcbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICB1dWlkID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXV1aWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcGF0aCA9IHBpY2tTdHJpbmcocGFyYW1zLCAncGF0aCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghcGF0aCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogcGF0aO+8jOWmgiBwb3NpdGlvbiDmiJYgY29tcG9uZW50cy4wLnN0cmluZycpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGR1bXA6IGFueTtcbiAgICAgICAgaWYgKHBhcmFtcz8uZHVtcCAmJiB0eXBlb2YgcGFyYW1zLmR1bXAgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICBkdW1wID0gcGFyYW1zLmR1bXA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBleHBsaWNpdFR5cGUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3R5cGUnLCAnJykudHJpbSgpO1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBwYXJhbXM/LnZhbHVlO1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGV4cGxpY2l0VHlwZSB8fCBndWVzc0R1bXBUeXBlKHZhbHVlKTtcbiAgICAgICAgICAgIGR1bXAgPSB0eXBlID8geyB0eXBlLCB2YWx1ZSB9IDogeyB2YWx1ZSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NldC1wcm9wZXJ0eScsIHsgdXVpZCwgcGF0aCwgZHVtcCB9KTtcbiAgICAgICAgcmV0dXJuIHsgdXVpZCwgc291cmNlLCBwYXRoLCBkdW1wLCBhcHBsaWVkOiB0cnVlIH07XG4gICAgfSxcbn07XG5cbi8qKiDmjIkgdmFsdWUg55qE5b2i54q254yc5rWLIGR1bXAg57G75Z6L77yI5Y+q6K6k5pyA5YW45Z6L55qE5LiJ56eN77yM6K+G5Yir5LiN5LqG5bCx6L+U5Zue56m66LWw6KO4IHt2YWx1ZX3vvIkgKi9cbmZ1bmN0aW9uIGd1ZXNzRHVtcFR5cGUodmFsdWU6IGFueSk6IHN0cmluZyB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gJyc7XG4gICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKS5zb3J0KCk7XG4gICAgY29uc3QgYWxsTnVtYmVyID0ga2V5cy5sZW5ndGggPiAwICYmIGtleXMuZXZlcnkoKGtleSkgPT4gdHlwZW9mICh2YWx1ZSBhcyBhbnkpW2tleV0gPT09ICdudW1iZXInKTtcbiAgICBpZiAoIWFsbE51bWJlcikgcmV0dXJuICcnO1xuICAgIGlmIChrZXlzLmpvaW4oJywnKSA9PT0gJ3gseSx6JykgcmV0dXJuICdjYy5WZWMzJztcbiAgICBpZiAoa2V5cy5qb2luKCcsJykgPT09ICd4LHknKSByZXR1cm4gJ2NjLlZlYzInO1xuICAgIGlmIChrZXlzLmpvaW4oJywnKSA9PT0gJ2hlaWdodCx3aWR0aCcpIHJldHVybiAnY2MuU2l6ZSc7XG4gICAgaWYgKGtleXMuam9pbignLCcpID09PSAnYSxiLGcscicpIHJldHVybiAnY2MuQ29sb3InO1xuICAgIHJldHVybiAnJztcbn1cblxuY29uc3Qgbm9kZVNldFByb3BlcnR5RW5naW5lOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLnNldFByb3BlcnR5LmVuZ2luZScsXG4gICAgdGl0bGU6ICforr7nva7lsZ7mgKfvvIjlvJXmk47pgJrpgZPvvIknLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn6YCa6L+H5Zy65pmv6ISa5pys55So5byV5pOOIEFQSSDnm7TmjqXnu5noioLngrnmiJbnu4Tku7botYvlgLzvvIjkuI3ov5sgdW5kbyDkvZPns7vvvIzkv53lrZjlnLrmma/lkI7nlJ/mlYjvvInjgIInICtcbiAgICAgICAgJ2NvbXBvbmVudCDnlZnnqbrooajnpLroioLngrnmnKzouqvvvJvlkKbliJnkvKDnu4Tku7bnsbvlkI3miJYgY2lk44CCJyArXG4gICAgICAgICd2YWx1ZSDmlK/mjIHvvJrmma7pgJogSlNPTiDlgLzvvJt7XCJfX3V1aWRcIjpcInh4eFwifSDnu5HlrproioLngrkv57uE5Lu25byV55So77ybJyArXG4gICAgICAgICd7XCJfX3ZlY1wiOlt4LHksel19IOWQkemHj++8m3tcIl9fc2l6ZVwiOlt3LGhdfSDlsLrlr7jvvJt7XCJfX2NvbG9yXCI6W3IsZyxiLGFdfSDpopzoibLjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICBjb21wb25lbnQ6ICfnu4Tku7bnsbvlkI3miJYgY2lk77yI5aaCIGNjLkxhYmVsIC8gQ2FyZEl0ZW3vvInvvIznlZnnqbrooajnpLrorr7nva7oioLngrnlsZ7mgKcnLFxuICAgICAgICBwcm9wOiAn5bGe5oCn5ZCN77yI5aaCIHN0cmluZyAvIGNvbG9yIC8gdGlwTGFiZWwgLyBwb3NpdGlvbu+8iScsXG4gICAgICAgIHZhbHVlOiAn5bGe5oCn5YC877yM5pSv5oyBIF9fdXVpZCAvIF9fdmVjIC8gX19zaXplIC8gX19jb2xvciDnibnmrorlvaLlvI8nLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgY29tcG9uZW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tuexu+WQjeaIliBjaWTvvIznlZnnqbrooajnpLroioLngrnmnKzouqsnIH0sXG4gICAgICAgICAgICBwcm9wOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+WQjScgfSxcbiAgICAgICAgICAgIHZhbHVlOiB7IGRlc2NyaXB0aW9uOiAn5bGe5oCn5YC8JyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydwcm9wJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XG4gICAgICAgIGxldCBzb3VyY2UgPSAncGFyYW1zJztcbiAgICAgICAgaWYgKCF1dWlkKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICB1dWlkID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXV1aWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdjb21wb25lbnQnLCAnJykudHJpbSgpO1xuICAgICAgICBjb25zdCBwcm9wID0gcGlja1N0cmluZyhwYXJhbXMsICdwcm9wJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFwcm9wKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBwcm9wJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgbWV0aG9kOiAnc2V0Tm9kZVByb3BlcnR5JyxcbiAgICAgICAgICAgIGFyZ3M6IFt1dWlkLCBjb21wb25lbnQsIHByb3AsIHBhcmFtcz8udmFsdWVdLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyZXN1bHQgfHwgcmVzdWx0Lm9rICE9PSB0cnVlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgYOW8leaTjuiuvue9ruWxnuaAp+Wksei0pe+8miR7cmVzdWx0ICYmIHJlc3VsdC5lcnJvciA/IHJlc3VsdC5lcnJvciA6ICfmnKrnn6XplJnor68nfWBcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdXVpZCwgc291cmNlLCBzY3JpcHRSZXN1bHQ6IHJlc3VsdCB9O1xuICAgIH0sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOW8leeUqOe7keWumlxuXG4vKipcbiAqIHF1ZXJ5LWNvbXBvbmVudHMg5bu655qEIGNpZCDihpQg57G75ZCN57Si5byV44CCXG4gKiDoioLngrnmoJHph4zoh6rlrprkuYnohJrmnKznu4Tku7bnmoQgdHlwZSDlrZjnmoTmmK8gY2lk77yM6ICMIHNldC1wcm9wZXJ0eSDnmoQgZHVtcC50eXBlIOimgeexu+WQje+8iOWmgiBJdGVtQmFkZ2XvvInvvIxcbiAqIOaJgOS7peimgemdoOi/meW8oOihqOe/u+ivkeOAglxuICovXG5pbnRlcmZhY2UgQ29tcG9uZW50Q2xhc3NJbmRleCB7XG4gICAgYnlDaWQ6IHsgW2NpZDogc3RyaW5nXTogc3RyaW5nIH07XG4gICAgbmFtZXM6IFNldDxzdHJpbmc+O1xufVxuXG5hc3luYyBmdW5jdGlvbiBxdWVyeUNvbXBvbmVudENsYXNzSW5kZXgoKTogUHJvbWlzZTxDb21wb25lbnRDbGFzc0luZGV4PiB7XG4gICAgY29uc3QgbGlzdDogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY29tcG9uZW50cycpO1xuICAgIGNvbnN0IGJ5Q2lkOiB7IFtjaWQ6IHN0cmluZ106IHN0cmluZyB9ID0ge307XG4gICAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgbGlzdCB8fCBbXSkge1xuICAgICAgICBpZiAoaXRlbSAmJiBpdGVtLmNpZCkgYnlDaWRbU3RyaW5nKGl0ZW0uY2lkKV0gPSBTdHJpbmcoaXRlbS5uYW1lIHx8ICcnKTtcbiAgICAgICAgaWYgKGl0ZW0gJiYgaXRlbS5uYW1lKSBuYW1lcy5hZGQoU3RyaW5nKGl0ZW0ubmFtZSkpO1xuICAgIH1cbiAgICByZXR1cm4geyBieUNpZCwgbmFtZXMgfTtcbn1cblxuLyoqIOe7hOS7tuWcqCBkdW1wIOmHjOeahOexu+Wei+WQje+8muWGhee9rue7hOS7tuaYryBjYy5TcHJpdGXvvIzoh6rlrprkuYnohJrmnKznu4Tku7bmmK/nsbvlkI3vvIjlpoIgSXRlbUJhZGdl77yJICovXG5mdW5jdGlvbiBjb21wb25lbnREdW1wVHlwZShjb21wOiBhbnksIGNsYXNzSW5kZXg6IENvbXBvbmVudENsYXNzSW5kZXgpOiBzdHJpbmcge1xuICAgIGNvbnN0IHJhdyA9IFN0cmluZyhjb21wPy50eXBlIHx8ICcnKS50cmltKCk7XG4gICAgaWYgKGNvbXA/LmlzQ3VzdG9tKSB7XG4gICAgICAgIHJldHVybiBjbGFzc0luZGV4LmJ5Q2lkW3Jhd10gfHwgcmF3O1xuICAgIH1cbiAgICByZXR1cm4gcmF3IHx8IFN0cmluZyhjb21wPy5uYW1lIHx8ICcnKS50cmltKCk7XG59XG5cbi8qKiDnu4Tku7blkI3lrr3mnb7nm7jnrYnvvJrlv73nlaUgY2MuIOWJjee8gOS4juWkp+Wwj+WGmSAqL1xuZnVuY3Rpb24gc2FtZUNvbXBvbmVudE5hbWUoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoYSA9PT0gYikgcmV0dXJuIHRydWU7XG4gICAgY29uc3Qgc3RyaXAgPSAoczogc3RyaW5nKSA9PiAocy5zdGFydHNXaXRoKCdjYy4nKSA/IHMuc2xpY2UoMykgOiBzKTtcbiAgICByZXR1cm4gc3RyaXAoYSkudG9Mb3dlckNhc2UoKSA9PT0gc3RyaXAoYikudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqIOWcqOe7hOS7tuWIl+ihqOmHjOWumuS9jee7hOS7tu+8muaVsOWtl+e0ouW8lSAvIOexu+WQjSAvIGNpZCAvIOe7hOS7tiB1dWlk77ybY2FuZGlkYXRlcz4xIOivtOaYjuaMieWQjeWMuemFjeacieatp+S5ie+8jOW7uuiuruaUueS8oOe0ouW8lSAqL1xuZnVuY3Rpb24gbWF0Y2hDb21wb25lbnQoXG4gICAgY29tcHM6IGFueVtdLFxuICAgIHNwZWM6IHN0cmluZyxcbiAgICBjbGFzc0luZGV4OiBDb21wb25lbnRDbGFzc0luZGV4XG4pOiB7IGluZGV4OiBudW1iZXI7IGNvbXA6IGFueTsgY2FuZGlkYXRlczogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBjb25zdCBzID0gU3RyaW5nKHNwZWMgPz8gJycpLnRyaW0oKTtcbiAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgIGlmICgvXlxcZCskLy50ZXN0KHMpKSB7XG4gICAgICAgIGNvbnN0IGluZGV4ID0gcGFyc2VJbnQocywgMTApO1xuICAgICAgICByZXR1cm4gY29tcHNbaW5kZXhdID8geyBpbmRleCwgY29tcDogY29tcHNbaW5kZXhdLCBjYW5kaWRhdGVzOiAxIH0gOiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBoaXRzOiB7IGluZGV4OiBudW1iZXI7IGNvbXA6IGFueSB9W10gPSBbXTtcbiAgICBjb21wcy5mb3JFYWNoKChjb21wOiBhbnksIGluZGV4OiBudW1iZXIpID0+IHtcbiAgICAgICAgY29uc3QgdHlwZU5hbWUgPSBjb21wPy5pc0N1c3RvbVxuICAgICAgICAgICAgPyAoY2xhc3NJbmRleC5ieUNpZFtTdHJpbmcoY29tcC50eXBlIHx8ICcnKV0gfHwgY29tcC50eXBlKVxuICAgICAgICAgICAgOiBjb21wPy50eXBlO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgICBjb21wPy51dWlkID09PSBzIHx8XG4gICAgICAgICAgICBjb21wPy50eXBlID09PSBzIHx8XG4gICAgICAgICAgICBzYW1lQ29tcG9uZW50TmFtZShTdHJpbmcodHlwZU5hbWUgfHwgJycpLCBzKSB8fFxuICAgICAgICAgICAgc2FtZUNvbXBvbmVudE5hbWUoU3RyaW5nKGNvbXA/Lm5hbWUgfHwgJycpLCBzKVxuICAgICAgICApIHtcbiAgICAgICAgICAgIGhpdHMucHVzaCh7IGluZGV4LCBjb21wIH0pO1xuICAgICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGhpdHMubGVuZ3RoID8geyBpbmRleDogaGl0c1swXS5pbmRleCwgY29tcDogaGl0c1swXS5jb21wLCBjYW5kaWRhdGVzOiBoaXRzLmxlbmd0aCB9IDogbnVsbDtcbn1cblxuLyoqIOe7hOS7tuWIl+ihqOeahOS4gOihjOaRmOimge+8iOaKpemUmeaXtuaPkOekuueOsOaciee7hOS7tueUqO+8iSAqL1xuZnVuY3Rpb24gZGVzY3JpYmVDb21wb25lbnRzKGNvbXBzOiBhbnlbXSwgY2xhc3NJbmRleDogQ29tcG9uZW50Q2xhc3NJbmRleCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGNvbXBzXG4gICAgICAgIC5tYXAoKGNvbXA6IGFueSwgaW5kZXg6IG51bWJlcikgPT4ge1xuICAgICAgICAgICAgY29uc3QgbmFtZSA9IGNvbXA/LmlzQ3VzdG9tXG4gICAgICAgICAgICAgICAgPyAoY2xhc3NJbmRleC5ieUNpZFtTdHJpbmcoY29tcC50eXBlIHx8ICcnKV0gfHwgY29tcC50eXBlKVxuICAgICAgICAgICAgICAgIDogKGNvbXA/LnR5cGUgfHwgY29tcD8ubmFtZSB8fCAnPycpO1xuICAgICAgICAgICAgcmV0dXJuIGAke2luZGV4fToke25hbWV9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oJywgJykgfHwgJyjml6Dnu4Tku7YpJztcbn1cblxuaW50ZXJmYWNlIFRyZWVOb2RlUmVmIHsgdXVpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZzsgbm9kZTogYW55OyB9XG5cbmZ1bmN0aW9uIGNvbGxlY3RUcmVlTm9kZXMobm9kZTogYW55LCBwYXJlbnRQYXRoOiBzdHJpbmcsIG91dDogVHJlZU5vZGVSZWZbXSk6IHZvaWQge1xuICAgIGlmICghbm9kZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5hbWUgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLm5hbWUsICcnKTtcbiAgICBjb25zdCB1dWlkID0gZHVtcFZhbHVlPHN0cmluZz4obm9kZS51dWlkLCAnJyk7XG4gICAgY29uc3QgcGF0aCA9IHBhcmVudFBhdGggPyBgJHtwYXJlbnRQYXRofS8ke25hbWV9YCA6IG5hbWU7XG4gICAgb3V0LnB1c2goeyB1dWlkLCBuYW1lLCBwYXRoLCBub2RlIH0pO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgKG5vZGUuY2hpbGRyZW4gfHwgW10pKSBjb2xsZWN0VHJlZU5vZGVzKGNoaWxkLCBwYXRoLCBvdXQpO1xufVxuXG4vKiog6IqC54K55a6a5L2N77yadXVpZCDihpIg5a6M5pW06Lev5b6EIOKGkiDot6/lvoTlkI7nvIAg4oaSIOiKgueCueWQje+8iHByZWZhYiDnvJbovpHmqKHlvI/kuIvlkIzmoLfpgILnlKjvvIzot6/lvoTku6XnvJbovpHkuK3nmoTmoLnkuLrotbfngrnvvIkgKi9cbmZ1bmN0aW9uIHJlc29sdmVOb2RlUmVmKHRyZWU6IGFueSwgc3BlYzogc3RyaW5nKTogeyByZWY6IFRyZWVOb2RlUmVmOyBob3c6IHN0cmluZzsgY2FuZGlkYXRlczogbnVtYmVyIH0gfCBudWxsIHtcbiAgICBjb25zdCBzID0gU3RyaW5nKHNwZWMgfHwgJycpLnRyaW0oKTtcbiAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGFsbDogVHJlZU5vZGVSZWZbXSA9IFtdO1xuICAgIGNvbGxlY3RUcmVlTm9kZXModHJlZSwgJycsIGFsbCk7XG4gICAgY29uc3QgZXhhY3QgPSBhbGwuZmluZCgoaXRlbSkgPT4gaXRlbS51dWlkID09PSBzKTtcbiAgICBpZiAoZXhhY3QpIHJldHVybiB7IHJlZjogZXhhY3QsIGhvdzogJ3V1aWQnLCBjYW5kaWRhdGVzOiAxIH07XG4gICAgY29uc3QgYnlQYXRoID0gYWxsLmZpbmQoKGl0ZW0pID0+IGl0ZW0ucGF0aCA9PT0gcyk7XG4gICAgaWYgKGJ5UGF0aCkgcmV0dXJuIHsgcmVmOiBieVBhdGgsIGhvdzogJ3BhdGgnLCBjYW5kaWRhdGVzOiAxIH07XG4gICAgY29uc3QgYnlTdWZmaXggPSBhbGwuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnBhdGguZW5kc1dpdGgoYC8ke3N9YCkpO1xuICAgIGlmIChieVN1ZmZpeC5sZW5ndGgpIHJldHVybiB7IHJlZjogYnlTdWZmaXhbMF0sIGhvdzogJ3BhdGgtc3VmZml4JywgY2FuZGlkYXRlczogYnlTdWZmaXgubGVuZ3RoIH07XG4gICAgY29uc3QgYnlOYW1lID0gYWxsLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5uYW1lID09PSBzKTtcbiAgICBpZiAoYnlOYW1lLmxlbmd0aCkgcmV0dXJuIHsgcmVmOiBieU5hbWVbMF0sIGhvdzogJ25hbWUnLCBjYW5kaWRhdGVzOiBieU5hbWUubGVuZ3RoIH07XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiDotYTkuqfnm67moIfvvJpkYjovLyDot6/lvoQg4oaSIHV1aWQgKyDnsbvlnovvvJvlrZDotYTkuqfvvIh4eC5wbmcvc3ByaXRlRnJhbWXvvInov5Tlm57lrZDotYTkuqfoh6rlt7HnmoQgdXVpZCDkuI7nsbvlnovvvIjlpoIgY2MuU3ByaXRlRnJhbWXvvIkgKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVBc3NldFRhcmdldChcbiAgICB1cmw6IHN0cmluZyxcbiAgICBleHBsaWNpdFR5cGU6IHN0cmluZ1xuKTogUHJvbWlzZTx7IGR1bXBUeXBlOiBzdHJpbmc7IHZhbHVlVXVpZDogc3RyaW5nIHwgbnVsbDsgZGVzYzogc3RyaW5nIH0+IHtcbiAgICBjb25zdCBhc3NldHM6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogdXJsIH0pO1xuICAgIGNvbnN0IGhpdCA9IChhc3NldHMgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gdXJsKSB8fCAoYXNzZXRzIHx8IFtdKVswXTtcbiAgICBpZiAoIWhpdCB8fCAhaGl0LnV1aWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLDotYTkuqc6ICR7dXJsfe+8iOi0tOWbvuW8leeUqOimgeWGmeWIsOWtkOi1hOS6p++8jOWmgiBkYjovL2Fzc2V0cy8uLi4veHgucG5nL3Nwcml0ZUZyYW1l77yJYCk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIGR1bXBUeXBlOiBleHBsaWNpdFR5cGUgfHwgU3RyaW5nKGhpdC50eXBlIHx8ICcnKSxcbiAgICAgICAgdmFsdWVVdWlkOiBTdHJpbmcoaGl0LnV1aWQpLFxuICAgICAgICBkZXNjOiBg6LWE5LqnICR7aGl0LnVybH1gLFxuICAgIH07XG59XG5cbi8qKiDop6PmnpDnu5Hlrprnm67moIcg4oaSIGR1bXAg57G75Z6L5ZCNICsg55uu5qCHIHV1aWTvvIhudWxsIOihqOekuuino+e7ke+8iSAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJpbmRUYXJnZXQoXG4gICAgdHJlZTogYW55LFxuICAgIGNsYXNzSW5kZXg6IENvbXBvbmVudENsYXNzSW5kZXgsXG4gICAgdGFyZ2V0OiBhbnksXG4gICAgZXhwbGljaXRUeXBlOiBzdHJpbmdcbik6IFByb21pc2U8eyBkdW1wVHlwZTogc3RyaW5nOyB2YWx1ZVV1aWQ6IHN0cmluZyB8IG51bGw7IGRlc2M6IHN0cmluZyB9PiB7XG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCB8fCB0YXJnZXQgPT09IHVuZGVmaW5lZCB8fCB0YXJnZXQgPT09ICdudWxsJyB8fCB0YXJnZXQgPT09ICcnKSB7XG4gICAgICAgIHJldHVybiB7IGR1bXBUeXBlOiBleHBsaWNpdFR5cGUgfHwgJycsIHZhbHVlVXVpZDogbnVsbCwgZGVzYzogJ+ino+e7ke+8iG51bGzvvIknIH07XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdGFyZ2V0ID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAodGFyZ2V0LnN0YXJ0c1dpdGgoJ2RiOi8vJykpIHJldHVybiByZXNvbHZlQXNzZXRUYXJnZXQodGFyZ2V0LCBleHBsaWNpdFR5cGUpO1xuICAgICAgICByZXR1cm4geyBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8ICcnLCB2YWx1ZVV1aWQ6IHRhcmdldCwgZGVzYzogYHV1aWQ6JHt0YXJnZXR9YCB9O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHRhcmdldCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3QgYXNzZXQgPSBwaWNrU3RyaW5nKHRhcmdldCwgJ2Fzc2V0JywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gcmVzb2x2ZUFzc2V0VGFyZ2V0KGFzc2V0LCBleHBsaWNpdFR5cGUpO1xuICAgICAgICBjb25zdCByYXdVdWlkID0gcGlja1N0cmluZyh0YXJnZXQsICd1dWlkJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKHJhd1V1aWQpIHJldHVybiB7IGR1bXBUeXBlOiBleHBsaWNpdFR5cGUgfHwgJycsIHZhbHVlVXVpZDogcmF3VXVpZCwgZGVzYzogYHV1aWQ6JHtyYXdVdWlkfWAgfTtcbiAgICAgICAgY29uc3Qgbm9kZVNwZWMgPSBwaWNrU3RyaW5nKHRhcmdldCwgJ25vZGUnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAobm9kZVNwZWMpIHtcbiAgICAgICAgICAgIGNvbnN0IG5vZGVIaXQgPSByZXNvbHZlTm9kZVJlZih0cmVlLCBub2RlU3BlYyk7XG4gICAgICAgICAgICBpZiAoIW5vZGVIaXQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHRhcmdldC5ub2RlIOaJvuS4jeWIsOiKgueCuTogJHtub2RlU3BlY33vvIjlj6/nlKggdXVpZCDmiJYg6Lev5b6E77yM5aaCIFBhbm5lbC9iYWRnZe+8iWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgY29tcFNwZWMgPSB0YXJnZXQuY29tcG9uZW50O1xuICAgICAgICAgICAgY29uc3QgY29tcFRleHQgPSBjb21wU3BlYyA9PT0gdW5kZWZpbmVkIHx8IGNvbXBTcGVjID09PSBudWxsID8gJycgOiBTdHJpbmcoY29tcFNwZWMpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghY29tcFRleHQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8ICdjYy5Ob2RlJyxcbiAgICAgICAgICAgICAgICAgICAgdmFsdWVVdWlkOiBub2RlSGl0LnJlZi51dWlkLFxuICAgICAgICAgICAgICAgICAgICBkZXNjOiBg6IqC54K5ICR7bm9kZUhpdC5yZWYucGF0aH1gLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjb21wcyA9IHJlYWROb2RlQ29tcG9uZW50cyhub2RlSGl0LnJlZi5ub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZWQgPSBtYXRjaENvbXBvbmVudChjb21wcywgY29tcFRleHQsIGNsYXNzSW5kZXgpO1xuICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgdGFyZ2V0LmNvbXBvbmVudCDlnKjoioLngrkgJHtub2RlSGl0LnJlZi5wYXRofSDkuIrmib7kuI3liLDjgIwke2NvbXBUZXh0feOAje+8jOeOsOaciTogJHtkZXNjcmliZUNvbXBvbmVudHMoY29tcHMsIGNsYXNzSW5kZXgpfWBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdHlwZU5hbWUgPSBjb21wb25lbnREdW1wVHlwZShtYXRjaGVkLmNvbXAsIGNsYXNzSW5kZXgpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8IHR5cGVOYW1lLFxuICAgICAgICAgICAgICAgIHZhbHVlVXVpZDogU3RyaW5nKG1hdGNoZWQuY29tcC51dWlkIHx8ICcnKSxcbiAgICAgICAgICAgICAgICBkZXNjOiBg57uE5Lu2ICR7dHlwZU5hbWUgfHwgY29tcFRleHR9IEAgJHtub2RlSGl0LnJlZi5wYXRofWAsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcigndGFyZ2V0IOW/hemhu+aYryB7bm9kZSwgY29tcG9uZW50fSAvIHtub2RlfSAvIHthc3NldH0gLyB7dXVpZH0gLyBudWxsJyk7XG59XG5cbmNvbnN0IG5vZGVCaW5kUHJvcGVydHk6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUuYmluZFByb3BlcnR5JyxcbiAgICB0aXRsZTogJ+e7keWumuW8leeUqOWxnuaApycsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfnu5nnu4Tku7bnu5HlrprlvJXnlKjnsbvlnovlsZ7mgKfvvIhAcHJvcGVydHkoTGFiZWwvU3ByaXRlL+iHquWumuS5ieiEmuacrC9Ob2RlL1Nwcml0ZUZyYW1l4oCmKe+8ie+8jCcgK1xuICAgICAgICAn6LWwIHNjZW5lL3NldC1wcm9wZXJ0eSDmtojmga/pgJrpgZPvvIjov5sgdW5kbyDkvZPns7vjgIHlj6/kv53lrZjov5sgcHJlZmFiL3NjZW5l77yJ77yM5LiO5bGe5oCn5qOA5p+l5Zmo5ouW5ou957uR5a6a5a6M5YWo562J5Lu377yMJyArXG4gICAgICAgICfmlK/mjIHltYzlpZcgcHJlZmFiIOWunuS+i+WGhemDqOeahOe7hOS7tu+8iOiHquWKqOeUn+aIkCB0YXJnZXRPdmVycmlkZXMg5bqP5YiX5YyW6JC955uY77yJ44CCJyArXG4gICAgICAgICfljZXmnaHlj4LmlbDvvJp1dWlk77yI5bGe5oCn5omA5Zyo6IqC54K577yMdXVpZCDmiJbot6/lvoTvvIznlZnnqbo95b2T5YmN6YCJ5Lit6IqC54K577yJ44CBY29tcG9uZW5077yI57Si5byVL+exu+WQjS9jaWTvvInjgIFwcm9wZXJ0ee+8iOWxnuaAp+WQje+8ieOAgXRhcmdldCDigJTigJQgJyArXG4gICAgICAgICd7XCJub2RlXCI6XCJQYW5uZWwvYmFkZ2VcIixcImNvbXBvbmVudFwiOlwiSXRlbUJhZGdlXCJ9IOe7hOS7tuW8leeUqO+8iOaOqOiNkO+8jOiHquWKqOino+aekOebruaghyB1dWlkIOS4jiBkdW1wIOexu+Wei++8jOW1jOWllyBwcmVmYWIg5YaF55qE57uE5Lu25Lmf6IO95a6a5L2N77yJ77ybJyArXG4gICAgICAgICd7XCJub2RlXCI6XCLot6/lvoTmiJZ1dWlkXCJ9IOiKgueCueW8leeUqO+8iGNjLk5vZGXvvInvvJt7XCJhc3NldFwiOlwiZGI6Ly9hc3NldHMveC5wbmcvc3ByaXRlRnJhbWVcIn0g6LWE5Lqn5byV55So77ybbnVsbCDop6Pnu5HjgIInICtcbiAgICAgICAgJ3RhcmdldCDkuZ/lj6/nm7TmjqXkvKAgdXVpZCDlrZfnrKbkuLLvvIjmraTml7blu7rorq7mmL7lvI/kvKAgdHlwZe+8ieOAgicgK1xuICAgICAgICAn5om56YeP77yaYmluZGluZ3M9W3t1dWlkLGNvbXBvbmVudCxwcm9wZXJ0eSx0YXJnZXR9LOKApl0g5b2i5byP5LiK5pSv5oyB77yM5L2G5b2T5YmN5a6e546w5aSa5p2h5Y+q5pyJ56ys5LiA5p2h55yf5q2j55Sf5pWI77yI5bey55+l6Zeu6aKY77yJ77yM6K+35LiA5p2h5LiA5Liq6LCD55So77yI5Y+v5bm26KGM5Y+R77yJ44CCJyArXG4gICAgICAgICfnu5HlrprlkI7oh6rliqjlm57or7vlnLrmma/lrp7pmYXlvJXnlKjpqozor4HvvIzkuI3kuIDoh7TkvJrmiqXplJnjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1dWlkOiAn5bGe5oCn5omA5Zyo6IqC54K577yadXVpZCDmiJboioLngrnot6/lvoTvvIznlZnnqbrnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICBjb21wb25lbnQ6ICfnu4Tku7blrprkvY3vvJrntKLlvJXmlbDlrZcgLyDnsbvlkI3vvIhjYy5MYWJlbOOAgUl0ZW1CYWRnZe+8iS8gY2lkJyxcbiAgICAgICAgcHJvcGVydHk6ICflsZ7mgKflkI3vvIzlpoIgYmFkZ2XjgIF0aXBMYWJlbOOAgXNwcml0ZUZyYW1lJyxcbiAgICAgICAgdGFyZ2V0OiAn57uR5a6a55uu5qCH77yae25vZGUsY29tcG9uZW50fSDnu4Tku7blvJXnlKggfCB7bm9kZX0g6IqC54K55byV55SoIHwge2Fzc2V0OlwiZGI6Ly/igKZcIn0g6LWE5LqnIHwgdXVpZCDlrZfnrKbkuLIgfCBudWxsIOino+e7kScsXG4gICAgICAgIHR5cGU6ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8iOm7mOiupOiHquWKqOaOqOaWre+8mue7hOS7tuKGkuexu+WQjeOAgeiKgueCueKGkmNjLk5vZGXjgIHotYTkuqfihpLotYTmupDnsbvlnovvvIknLFxuICAgICAgICBwYXRoOiAn5Y+v6YCJ44CC5Y6f5aeL5bGe5oCn6Lev5b6E77yI5aaCIF9fY29tcHNfXy4xLmJhZGdl77yJ77yM5Lyg5LqG5bCx6Lez6L+HIGNvbXBvbmVudC9wcm9wZXJ0eSDmi7zoo4UnLFxuICAgICAgICBiaW5kaW5nczogJ+aJuemHj+e7keWumuaVsOe7hO+8iOW9k+WJjeWkmuadoeWPquacieesrOS4gOadoeeUn+aViO+8jOW7uuiurumAkOadoeiwg+eUqO+8ie+8jOavj+mhuSB7dXVpZCxjb21wb25lbnQscHJvcGVydHksdGFyZ2V0Wyx0eXBlXX3vvIzkuI7ljZXmnaHlj4LmlbDkuozpgInkuIAnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WxnuaAp+aJgOWcqOiKgueCue+8mnV1aWQg5oiW6IqC54K56Lev5b6E77yM55WZ56m655So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgY29tcG9uZW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tuWumuS9je+8mue0ouW8leaVsOWtlyAvIOexu+WQje+8iGNjLkxhYmVs44CBSXRlbUJhZGdl77yJLyBjaWQnIH0sXG4gICAgICAgICAgICBwcm9wZXJ0eTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflkI3vvIzlpoIgYmFkZ2XjgIF0aXBMYWJlbOOAgXNwcml0ZUZyYW1lJyB9LFxuICAgICAgICAgICAgdGFyZ2V0OiB7XG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgICAgICAgICAgICfnu5Hlrprnm67moIfvvJp7bm9kZSxjb21wb25lbnR9IOe7hOS7tuW8leeUqCB8IHtub2RlfSDoioLngrnlvJXnlKggfCB7YXNzZXQ6XCJkYjovL+KAplwifSDotYTkuqcgfCB1dWlkIOWtl+espuS4siB8IG51bGwg6Kej57uRJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB0eXBlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WPr+mAieOAgmR1bXAg57G75Z6L5ZCN77yM6buY6K6k6Ieq5Yqo5o6o5patJyB9LFxuICAgICAgICAgICAgcGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInjgILljp/lp4vlsZ7mgKfot6/lvoTvvIjlpoIgX19jb21wc19fLjEuYmFkZ2XvvInvvIzot7Pov4cgY29tcG9uZW50L3Byb3BlcnR5IOaLvOijhScgfSxcbiAgICAgICAgICAgIGJpbmRpbmdzOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aJuemHj+e7keWumu+8muavj+mhuSB7dXVpZCwgY29tcG9uZW50LCBwcm9wZXJ0eSwgdGFyZ2V0WywgdHlwZV1977yM5LiO5Y2V5p2h5Y+C5pWw5LqM6YCJ5LiA77yb5b2T5YmN5aSa5p2h5Y+q5pyJ56ys5LiA5p2h55Sf5pWI77yM5bu66K6u6YCQ5p2h6LCD55SoJyxcbiAgICAgICAgICAgICAgICBpdGVtczogeyB0eXBlOiAnb2JqZWN0JyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBzcGVjczogYW55W10gPSBBcnJheS5pc0FycmF5KHBhcmFtcz8uYmluZGluZ3MpID8gcGFyYW1zLmJpbmRpbmdzIDogW3BhcmFtc107XG4gICAgICAgIGlmICghc3BlY3MubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieWPr+aJp+ihjOeahOe7keWumu+8iGJpbmRpbmdzIOS4uuepuu+8iScpO1xuXG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICAgICAgaWYgKCF0cmVlKSB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZrycpO1xuICAgICAgICBjb25zdCBjbGFzc0luZGV4ID0gYXdhaXQgcXVlcnlDb21wb25lbnRDbGFzc0luZGV4KCk7XG5cbiAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gW107XG4gICAgICAgIGNvbnN0IHBsYW5zOiBhbnlbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygc3BlY3MpIHtcbiAgICAgICAgICAgIC8vIDEpIOWxnuaAp+aJgOWcqOiKgueCuVxuICAgICAgICAgICAgY29uc3Qgbm9kZVNwZWMgPSBwaWNrU3RyaW5nKHNwZWMsICd1dWlkJywgJycpLnRyaW0oKTtcbiAgICAgICAgICAgIGxldCBub2RlSGl0OiB7IHJlZjogVHJlZU5vZGVSZWY7IGhvdzogc3RyaW5nOyBjYW5kaWRhdGVzOiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgaWYgKCFub2RlU3BlYyB8fCBub2RlU3BlYyA9PT0gJ0BzZWxlY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xuICAgICAgICAgICAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumiB1dWlk77yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XG4gICAgICAgICAgICAgICAgbm9kZUhpdCA9IHJlc29sdmVOb2RlUmVmKHRyZWUsIHNlbGVjdGVkWzBdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbm9kZUhpdCA9IHJlc29sdmVOb2RlUmVmKHRyZWUsIG5vZGVTcGVjKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghbm9kZUhpdCkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/moJHph4zmib7kuI3liLDoioLngrk6ICR7bm9kZVNwZWMgfHwgJyjpgInkuK3oioLngrkpJ31gKTtcblxuICAgICAgICAgICAgLy8gMikg57uE5Lu25LiO5bGe5oCn6Lev5b6E77yIZHVtcCDot6/lvoTnu5/kuIDnlKggX19jb21wc19fIOWJjee8gO+8jOS4juWxnuaAp+ajgOafpeWZqOWPkeWHuueahOa2iOaBr+S4gOiHtO+8iVxuICAgICAgICAgICAgY29uc3QgcmF3UGF0aCA9IHBpY2tTdHJpbmcoc3BlYywgJ3BhdGgnLCAnJykudHJpbSgpO1xuICAgICAgICAgICAgbGV0IHBhdGggPSByYXdQYXRoXG4gICAgICAgICAgICAgICAgPyAocmF3UGF0aC5zdGFydHNXaXRoKCdjb21wb25lbnRzLicpID8gYF9fY29tcHNfXy4ke3Jhd1BhdGguc2xpY2UoJ2NvbXBvbmVudHMuJy5sZW5ndGgpfWAgOiByYXdQYXRoKVxuICAgICAgICAgICAgICAgIDogJyc7XG4gICAgICAgICAgICBsZXQgdmVyaWZ5SW5kZXggPSAnJztcbiAgICAgICAgICAgIGxldCB2ZXJpZnlQcm9wID0gJyc7XG4gICAgICAgICAgICBsZXQgbWF0Y2hlZDogeyBpbmRleDogbnVtYmVyOyBjb21wOiBhbnk7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gICAgICAgICAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwcm9wZXJ0eSA9IHBpY2tTdHJpbmcoc3BlYywgJ3Byb3BlcnR5JywgJycpLnRyaW0oKTtcbiAgICAgICAgICAgICAgICBpZiAoIXByb3BlcnR5KSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBwcm9wZXJ0ee+8iOaIluWOn+WniyBwYXRo77yJ77yM5aaCIGJhZGdlIC8gc3ByaXRlRnJhbWUnKTtcbiAgICAgICAgICAgICAgICBjb25zdCBjb21wU3BlYyA9IHNwZWM/LmNvbXBvbmVudDtcbiAgICAgICAgICAgICAgICBjb25zdCBjb21wVGV4dCA9IGNvbXBTcGVjID09PSB1bmRlZmluZWQgfHwgY29tcFNwZWMgPT09IG51bGwgPyAnJyA6IFN0cmluZyhjb21wU3BlYykudHJpbSgpO1xuICAgICAgICAgICAgICAgIGlmIChjb21wVGV4dCAmJiBjb21wVGV4dCAhPT0gJ25vZGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbXBzID0gcmVhZE5vZGVDb21wb25lbnRzKG5vZGVIaXQucmVmLm5vZGUpO1xuICAgICAgICAgICAgICAgICAgICBtYXRjaGVkID0gbWF0Y2hDb21wb25lbnQoY29tcHMsIGNvbXBUZXh0LCBjbGFzc0luZGV4KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYOiKgueCuSAke25vZGVIaXQucmVmLnBhdGh9IOS4iuaJvuS4jeWIsOe7hOS7tuOAjCR7Y29tcFRleHR944CN77yM546w5pyJOiAke2Rlc2NyaWJlQ29tcG9uZW50cyhjb21wcywgY2xhc3NJbmRleCl9YFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBwYXRoID0gYF9fY29tcHNfXy4ke21hdGNoZWQuaW5kZXh9LiR7cHJvcGVydHl9YDtcbiAgICAgICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXggPSBTdHJpbmcobWF0Y2hlZC5pbmRleCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcGF0aCA9IHByb3BlcnR5OyAvLyDoioLngrnnuqflsZ7mgKfvvIjlsJHop4HvvIlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmVyaWZ5UHJvcCA9IHByb3BlcnR5O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtID0gL15fX2NvbXBzX19cXC4oXFxkKylcXC4oLispJC8uZXhlYyhwYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAobSkge1xuICAgICAgICAgICAgICAgICAgICB2ZXJpZnlJbmRleCA9IG1bMV07XG4gICAgICAgICAgICAgICAgICAgIHZlcmlmeVByb3AgPSBtWzJdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gMykg55uu5qCHIOKGkiBkdW1wXG4gICAgICAgICAgICBjb25zdCB0YXJnZXRJbmZvID0gYXdhaXQgcmVzb2x2ZUJpbmRUYXJnZXQoXG4gICAgICAgICAgICAgICAgdHJlZSxcbiAgICAgICAgICAgICAgICBjbGFzc0luZGV4LFxuICAgICAgICAgICAgICAgIHNwZWM/LnRhcmdldCxcbiAgICAgICAgICAgICAgICBwaWNrU3RyaW5nKHNwZWMsICd0eXBlJywgJycpLnRyaW0oKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGNvbnN0IGR1bXAgPSB0YXJnZXRJbmZvLnZhbHVlVXVpZCA9PT0gbnVsbFxuICAgICAgICAgICAgICAgID8gKHRhcmdldEluZm8uZHVtcFR5cGUgPyB7IHR5cGU6IHRhcmdldEluZm8uZHVtcFR5cGUsIHZhbHVlOiBudWxsIH0gOiB7IHZhbHVlOiBudWxsIH0pXG4gICAgICAgICAgICAgICAgOiB7IHR5cGU6IHRhcmdldEluZm8uZHVtcFR5cGUsIHZhbHVlOiB7IHV1aWQ6IHRhcmdldEluZm8udmFsdWVVdWlkIH0gfTtcblxuICAgICAgICAgICAgaXRlbXMucHVzaCh7IHV1aWQ6IG5vZGVIaXQucmVmLnV1aWQsIHBhdGgsIGR1bXAgfSk7XG4gICAgICAgICAgICBwbGFucy5wdXNoKHtcbiAgICAgICAgICAgICAgICB1dWlkOiBub2RlSGl0LnJlZi51dWlkLFxuICAgICAgICAgICAgICAgIG5vZGVOYW1lOiBub2RlSGl0LnJlZi5uYW1lLFxuICAgICAgICAgICAgICAgIG5vZGVQYXRoOiBub2RlSGl0LnJlZi5wYXRoLFxuICAgICAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50OiBtYXRjaGVkXG4gICAgICAgICAgICAgICAgICAgID8gYCR7Y29tcG9uZW50RHVtcFR5cGUobWF0Y2hlZC5jb21wLCBjbGFzc0luZGV4KX0oIyR7bWF0Y2hlZC5pbmRleH0pYFxuICAgICAgICAgICAgICAgICAgICA6ICdub2RlJyxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRBbWJpZ3VvdXM6ICEhKG1hdGNoZWQgJiYgbWF0Y2hlZC5jYW5kaWRhdGVzID4gMSksXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiB0YXJnZXRJbmZvLmRlc2MsXG4gICAgICAgICAgICAgICAgZXhwZWN0ZWRVdWlkOiB0YXJnZXRJbmZvLnZhbHVlVXVpZCxcbiAgICAgICAgICAgICAgICB0eXBlTWlzc2luZzogdGFyZ2V0SW5mby52YWx1ZVV1aWQgIT09IG51bGwgJiYgIXRhcmdldEluZm8uZHVtcFR5cGUsXG4gICAgICAgICAgICAgICAgZHVtcCxcbiAgICAgICAgICAgICAgICB2ZXJpZnlJbmRleCxcbiAgICAgICAgICAgICAgICB2ZXJpZnlQcm9wLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyA0KSDkuIDmrKHmgKfmj5DkuqTvvJrlpJrkuKoge3V1aWQscGF0aCxkdW1wfSDkvZzkuLrlj5jlj4LvvIjkuI7lsZ7mgKfmo4Dmn6Xlmajmibnph4/lhpnlhaXlkIzmnoTvvIzkuIDmnaEgdW5kb++8ieOAglxuICAgICAgICAvLyAgICBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IOeahOexu+Wei+etvuWQjeS4jeaYryByZXN0IOWPguaVsO+8jOi/memHjOaMieWPmOWPguiwg+eUqOmcgOimgSBjYXN044CCXG4gICAgICAgIGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoU0NFTkUsICdzZXQtcHJvcGVydHknLCAuLi5pdGVtcyk7XG5cbiAgICAgICAgLy8gNSkg5Zue6K+76aqM6K+B77yI5Zy65pmv6ISa5pys6YCa6YGT77yb5Zy65pmv6L+b56iL6L+Y5rKh5Yqg6L295paw5pa55rOV5pe26ZmN57qn5Li6IHVuYXZhaWxhYmxl77yM5LiN6Zi75aGe57uR5a6a5pys6Lqr77yJXG4gICAgICAgIGNvbnN0IHJlc3VsdHM6IGFueVtdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgcGxhbiBvZiBwbGFucykge1xuICAgICAgICAgICAgbGV0IHZlcmlmaWVkOiBhbnkgPSAnc2tpcHBlZCc7XG4gICAgICAgICAgICBsZXQgYWN0dWFsOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgbGV0IG5vdGUgPSAnJztcbiAgICAgICAgICAgIGlmIChwbGFuLnZlcmlmeUluZGV4ICE9PSAnJyAmJiBwbGFuLnZlcmlmeVByb3ApIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCByOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiAncmVhZENvbXBvbmVudFByb3BlcnR5JyxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3M6IFtwbGFuLnV1aWQsIHBsYW4udmVyaWZ5SW5kZXgsIHBsYW4udmVyaWZ5UHJvcF0sXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAociAmJiByLm9rID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWwgPSByLnJlZiA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYWN0dWFsVXVpZCA9IGFjdHVhbCAmJiBhY3R1YWwudXVpZCA/IGFjdHVhbC51dWlkIDogbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcmlmaWVkID0gYWN0dWFsVXVpZCA9PT0gcGxhbi5leHBlY3RlZFV1aWQ7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJpZmllZCA9ICd1bmF2YWlsYWJsZSc7XG4gICAgICAgICAgICAgICAgICAgICAgICBub3RlID0gKHIgJiYgci5lcnJvcilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFN0cmluZyhyLmVycm9yKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogJ+WcuuaZr+iEmuacrOayoeaciei/lOWbnue7k+aenO+8iOe8lui+keWZqOmHjOmHjei9vSBjb2Nvcy1tY3Ag5omp5bGV5ZCO5Y+v6aqM6K+B77yJJztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAgICAgICAgICAgICB2ZXJpZmllZCA9ICd1bmF2YWlsYWJsZSc7XG4gICAgICAgICAgICAgICAgICAgIG5vdGUgPSBlPy5tZXNzYWdlID8/IFN0cmluZyhlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgICAgICAgIHV1aWQ6IHBsYW4udXVpZCxcbiAgICAgICAgICAgICAgICBub2RlTmFtZTogcGxhbi5ub2RlTmFtZSxcbiAgICAgICAgICAgICAgICBub2RlUGF0aDogcGxhbi5ub2RlUGF0aCxcbiAgICAgICAgICAgICAgICBwYXRoOiBwbGFuLnBhdGgsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50OiBwbGFuLmNvbXBvbmVudCxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRBbWJpZ3VvdXM6IHBsYW4uY29tcG9uZW50QW1iaWd1b3VzIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHBsYW4udGFyZ2V0LFxuICAgICAgICAgICAgICAgIGV4cGVjdGVkVXVpZDogcGxhbi5leHBlY3RlZFV1aWQsXG4gICAgICAgICAgICAgICAgdHlwZU1pc3Npbmc6IHBsYW4udHlwZU1pc3NpbmcgfHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIGR1bXA6IHBsYW4uZHVtcCxcbiAgICAgICAgICAgICAgICBhY3R1YWwsXG4gICAgICAgICAgICAgICAgdmVyaWZpZWQsXG4gICAgICAgICAgICAgICAgLi4uKG5vdGUgPyB7IHZlcmlmeU5vdGU6IG5vdGUgfSA6IHt9KSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbWlzbWF0Y2hlZCA9IHJlc3VsdHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnZlcmlmaWVkID09PSBmYWxzZSk7XG4gICAgICAgIGlmIChtaXNtYXRjaGVkLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3QgbGluZXMgPSBtaXNtYXRjaGVkLm1hcCgoaXRlbTogYW55KSA9PlxuICAgICAgICAgICAgICAgIGAke2l0ZW0ubm9kZVBhdGh9ICR7aXRlbS5wYXRofSDihpIg5pyf5pybICR7aXRlbS5leHBlY3RlZFV1aWQgPz8gJ251bGwnfe+8jOWunumZhSAke1xuICAgICAgICAgICAgICAgICAgICBpdGVtLmFjdHVhbCAmJiBpdGVtLmFjdHVhbC51dWlkID8gaXRlbS5hY3R1YWwudXVpZCA6IEpTT04uc3RyaW5naWZ5KGl0ZW0uYWN0dWFsKVxuICAgICAgICAgICAgICAgIH1gXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnu5Hlrprlt7Lmj5DkuqTkvYblm57or7vkuI3kuIDoh7TvvIjlj6/og73msqHmnInnnJ/mraPnlJ/mlYjvvIzlj68gQ3RybCtaIOaSpOmUgOWQjumHjeivle+8ie+8mlxcbiR7bGluZXMuam9pbignXFxuJyl9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYXBwbGllZDogaXRlbXMubGVuZ3RoLFxuICAgICAgICAgICAgc3VibWl0dGVkOiBpdGVtcyxcbiAgICAgICAgICAgIHZlcmlmaWVkQ291bnQ6IHJlc3VsdHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnZlcmlmaWVkID09PSB0cnVlKS5sZW5ndGgsXG4gICAgICAgICAgICByZXN1bHRzLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlQ3JlYXRlUHJlZmFiOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmNyZWF0ZVByZWZhYicsXG4gICAgdGl0bGU6ICfkv53lrZjoioLngrnkuLrpooTliLbkvZMnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn5oqK5Zy65pmv6IqC54K577yI5ZCr5pW05qO15a2Q5qCR77yJ5L+d5a2Y5Li6IC5wcmVmYWIg6LWE5rqQ77yIc2NlbmUvY3JlYXRlLXByZWZhYu+8jOiHquWKqOi/myB1bmRv77yJ77yMJyArXG4gICAgICAgICfoioLngrnmnKzouqvkvJrlj5jmiJDpooTliLbkvZPlrp7kvovjgIJ1cmwg55WZ56m65YiZ5a2Y5YiwIGRiOi8vYXNzZXRzL3ByZWZhYnMvPOiKgueCueWQjT4ucHJlZmFi77yMJyArXG4gICAgICAgICfnm67moIfnm67lvZXkuI3lrZjlnKjml7boh6rliqjliJvlu7rjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICBub2RlOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgICAgICB1cmw6ICfnm67moIfot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvcHJlZmFicy9DYXJkcy5wcmVmYWInLFxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI0gLnByZWZhYiDlt7LlrZjlnKjml7bmmK/lkKblhYjliKDpmaTlho3liJvlu7rvvIzpu5jorqQgZmFsc2UnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruagh+i3r+W+hCBkYjovL2Fzc2V0cy8uLi4ucHJlZmFi77yM55WZ56m65YiZ55SoIGRiOi8vYXNzZXRzL3ByZWZhYnMvPOiKgueCueWQjT4ucHJlZmFiJyB9LFxuICAgICAgICAgICAgb3ZlcndyaXRlOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICflkIzlkI3otYTmupDlt7LlrZjlnKjml7bmmK/lkKblhYjliKDpmaTlho3liJvlu7onIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgbGV0IG5vZGVVdWlkID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgbGV0IHNvdXJjZSA9ICdwYXJhbXMnO1xuICAgICAgICBpZiAoIW5vZGVVdWlkKSB7XG4gICAgICAgICAgICBub2RlVXVpZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKClbMF0gfHwgJyc7XG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcbiAgICAgICAgfVxuICAgICAgICBpZiAoIW5vZGVVdWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlVXVpZCk7XG4gICAgICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWcuuaZr+mHjOaJvuS4jeWIsOiKgueCuTogJHtub2RlVXVpZH1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzY2VuZVJvb3RVdWlkID0gZHVtcFZhbHVlPHN0cmluZz4odHJlZT8udXVpZCwgJycpO1xuICAgICAgICBpZiAoc2NlbmVSb290VXVpZCAmJiBzY2VuZVJvb3RVdWlkID09PSBub2RlVXVpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkuI3og73miorlnLrmma/moLnkv53lrZjkuLrpooTliLbkvZPvvIzor7fmjIflrprlroPnmoTmn5DkuKrlrZDoioLngrknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub2RlTmFtZSA9IGR1bXBWYWx1ZTxzdHJpbmc+KHRhcmdldC5uYW1lLCAnJyk7XG5cbiAgICAgICAgbGV0IHVybCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXJsJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmwpIHtcbiAgICAgICAgICAgIGlmICghbm9kZU5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+iKgueCueayoeacieWQjeWtl++8jOaXoOazleaOqOWvvOm7mOiupOi3r+W+hO+8jOivt+aYvuW8j+S8oCB1cmwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVybCA9IGBkYjovL2Fzc2V0cy9wcmVmYWJzLyR7bm9kZU5hbWV9LnByZWZhYmA7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly9hc3NldHMvJykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgdXJsIOW/hemhu+S9jeS6jiBkYjovL2Fzc2V0cy8g5LiLOiAke3VybH1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXVybC5lbmRzV2l0aCgnLnByZWZhYicpKSB7XG4gICAgICAgICAgICB1cmwgPSBgJHt1cmx9LnByZWZhYmA7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDpgJDnuqfnoa7kv53niLbnm67lvZXlrZjlnKjvvIhjcmVhdGUtYXNzZXQg55qEIHNvdXJjZSDkvKAgbnVsbCDljbPliJvlu7rnm67lvZXvvIlcbiAgICAgICAgY29uc3QgZm9sZGVyU2VnbWVudHMgPSB1cmwuc2xpY2UoJ2RiOi8vYXNzZXRzLycubGVuZ3RoKS5zcGxpdCgnLycpLnNsaWNlKDAsIC0xKTtcbiAgICAgICAgbGV0IGZvbGRlclVybCA9ICdkYjovL2Fzc2V0cyc7XG4gICAgICAgIGNvbnN0IGNyZWF0ZWRGb2xkZXJzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgZm9sZGVyU2VnbWVudHMpIHtcbiAgICAgICAgICAgIGlmICghc2VnbWVudCkgY29udGludWU7XG4gICAgICAgICAgICBmb2xkZXJVcmwgPSBgJHtmb2xkZXJVcmx9LyR7c2VnbWVudH1gO1xuICAgICAgICAgICAgY29uc3QgZXhpc3RzID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0LWluZm8nLCBmb2xkZXJVcmwpO1xuICAgICAgICAgICAgaWYgKCFleGlzdHMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2NyZWF0ZS1hc3NldCcsIGZvbGRlclVybCwgbnVsbCk7XG4gICAgICAgICAgICAgICAgaWYgKCFjcmVhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5Yib5bu655uu5b2V5aSx6LSlOiAke2ZvbGRlclVybH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY3JlYXRlZEZvbGRlcnMucHVzaChmb2xkZXJVcmwpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlKSB7XG4gICAgICAgICAgICBjb25zdCBleGlzdGluZzogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiB1cmwgfSk7XG4gICAgICAgICAgICBjb25zdCBoaXQgPSAoZXhpc3RpbmcgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gdXJsKTtcbiAgICAgICAgICAgIGlmIChoaXQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgaGl0LnV1aWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcHJlZmFiVXVpZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdjcmVhdGUtcHJlZmFiJywgbm9kZVV1aWQsIHVybCk7XG4gICAgICAgIGlmICghcHJlZmFiVXVpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtcHJlZmFiIOayoeaciei/lOWbnui1hOa6kCB1dWlk77yI55uu5qCH5bey5a2Y5Zyo77yf5Y+v5LygIG92ZXJ3cml0ZT10cnVl77yJOiAke3VybH1gKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBub2RlOiBub2RlVXVpZCwgbm9kZU5hbWUsIHVybCwgcHJlZmFiVXVpZCwgY3JlYXRlZEZvbGRlcnMsIHNvdXJjZSB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBwcmVmYWJPcGVuOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdwcmVmYWIub3BlbicsXG4gICAgdGl0bGU6ICfmiZPlvIDpooTliLbkvZMnLFxuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAgICfov5vlhaXpooTliLbkvZPnvJbovpHmqKHlvI/vvIjnrYnku7fotYTmupDnrqHnkIblmajph4zlj4zlh7sgLnByZWZhYu+8ieOAguWFiOS/neWtmOW9k+WJjeWcuuaZr+mBv+WFjeW8ueeql++8jCcgK1xuICAgICAgICAgICAgJ+WGjei1sCBhc3NldC1kYi9vcGVuLWFzc2V0IOW5tui9ruivouehruiupOW9k+WJjee8lui+keaWh+aho+WIh+aNouWujOaIkOOAgicgK1xuICAgICAgICAgICAgJ+azqOaEj++8mnNjZW5lL29wZW4tc2NlbmUg5a+5IHByZWZhYiB1dWlkIOaXoOaViO+8iOS8muiiq+W/veeVpe+8ie+8m3NjZW5lLm9wZW4g5Lmf5LiN6KaB55So4oCU4oCU5a6D5YaF6YOo5YWIIGxvYWQtZW1wdHktc2NlbmXvvIzkvJrkuqfnlJ/ml6DmoIfpopjlnLrmma/ov5vogIzlvLnjgIzkv53lrZjjgI3lr7nor53moYbjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1cmw6ICfpooTliLbkvZMgZGI6Ly8g6Lev5b6E5oiWIHV1aWTvvIzlpoIgZGI6Ly9hc3NldHMvcHJlZmFicy9Gb28ucHJlZmFiJyxcbiAgICAgICAgc2F2ZUN1cnJlbnQ6ICfov5vlhaXliY3mmK/lkKbkv53lrZjlvZPliY3lnLrmma/vvIzpu5jorqQgdHJ1ZScsXG4gICAgICAgIHRpbWVvdXQ6ICfnrYnlvoXov5vlhaXpooTliLbkvZPnvJbovpHmqKHlvI/nmoTotoXml7bmr6vnp5LvvIzpu5jorqQgMzAwMDAnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6aKE5Yi25L2TIGRiOi8vIOi3r+W+hOaIliB1dWlkJyB9LFxuICAgICAgICAgICAgc2F2ZUN1cnJlbnQ6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+m7mOiupCB0cnVlJyB9LFxuICAgICAgICAgICAgdGltZW91dDogeyB0eXBlOiAnaW50ZWdlcicsIG1pbmltdW06IDEwMDAsIG1heGltdW06IDEyMDAwMCwgZGVzY3JpcHRpb246ICfpu5jorqQgMzAwMDAnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ3VybCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IHVybCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXJsJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIHVybO+8iGRiOi8vIOi3r+W+hOaIliB1dWlk77yJJyk7XG4gICAgICAgIGxldCB1dWlkID0gdXJsO1xuICAgICAgICBpZiAodXJsLnN0YXJ0c1dpdGgoJ2RiOi8vJykpIHtcbiAgICAgICAgICAgIGNvbnN0IGluZm86IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgdXJsKTtcbiAgICAgICAgICAgIGlmICghaW5mbyB8fCAhaW5mby51dWlkKSB0aHJvdyBuZXcgRXJyb3IoYOaJvuS4jeWIsOmihOWItuS9k+i1hOS6pzogJHt1cmx9YCk7XG4gICAgICAgICAgICBpZiAoaW5mby50eXBlICYmIGluZm8udHlwZSAhPT0gJ3ByZWZhYicgJiYgaW5mby50eXBlICE9PSAnY2MuUHJlZmFiJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCH5LiN5piv6aKE5Yi25L2T77yIJHtpbmZvLnR5cGV977yJOiAke2luZm8udXJsIHx8IHVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHV1aWQgPSBTdHJpbmcoaW5mby51dWlkKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyYW1zPy5zYXZlQ3VycmVudCAhPT0gZmFsc2UpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyDkv53lrZjlpLHotKXkuI3pmLvmlq3vvIjml6DmoIfpopjmnKrkv53lrZjlnLrmma/kvJrlvLnlr7nor53moYbvvIzkurrlt6XlpITnkIblkI7ova7or6Lnu6fnu63vvIlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyBzY2VuZS9vcGVuLXNjZW5lIOWvuSBwcmVmYWIgdXVpZCDml6DmlYjvvIjlrp7mtYvooqvlv73nlaXjgIHlnLrmma/kuI3liIfmjaLvvInvvJtcbiAgICAgICAgLy8g5omT5byA6aKE5Yi25L2T55qE5q2j56Gu6YCa6YGT5pivIGFzc2V0LWRiL29wZW4tYXNzZXTvvIjnrYnku7fotYTmupDnrqHnkIblmajlj4zlh7vvvInjgIJcbiAgICAgICAgLy8g5rOo5oSPIHF1ZXJ5LWN1cnJlbnQtc2NlbmUg5Zyo6aKE5Yi25L2T5qih5byP5LiL5LuN6L+U5Zue5Zy65pmv6aG1562+IHV1aWTvvIzkuI3lj43mmKDnvJbovpHkuK3nmoTmlofmoaPvvJtcbiAgICAgICAgLy8g6KaB55SoIHF1ZXJ5LW5vZGUtdHJlZSDnmoTmoLkgdXVpZOKAlOKAlOmihOWItuS9k+aooeW8j+S4i+aWh+aho+aYr+WMheS6huS4gOWxgueahOS4tOaXtuWcuuaZr1xuICAgICAgICAvLyDvvIg85ZCN5a2XPi1zY2VuZe+8jOagueS4i+aciSBzaG91bGRfaGlkZV9pbl9oaWVyYXJjaHnvvInvvIzmiJDlip/liKTlrpogPSDmoLkgdXVpZCDnm7jlr7nmiZPlvIDliY3lj5jljJbvvIjov57nu63kuKTmrKHor7vliLDmiY3nrpfnqLPlrprvvIlcbiAgICAgICAgY29uc3QgYmVmb3JlVHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xuICAgICAgICBjb25zdCBiZWZvcmUgPSBkdW1wVmFsdWU8c3RyaW5nPihiZWZvcmVUcmVlPy51dWlkLCAnJyk7XG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdvcGVuLWFzc2V0JywgdXVpZCk7XG4gICAgICAgIGNvbnN0IHRpbWVvdXQgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ3RpbWVvdXQnLCAzMDAwMCkgfHwgMzAwMDA7XG4gICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXQ7XG4gICAgICAgIGxldCBjdXJyZW50ID0gYmVmb3JlO1xuICAgICAgICBsZXQgc3RhYmxlID0gMDtcbiAgICAgICAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzAwKSk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50ID0gZHVtcFZhbHVlPHN0cmluZz4odHJlZT8udXVpZCwgJycpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnQgPSAnJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjdXJyZW50ICYmIGN1cnJlbnQgIT09IGJlZm9yZSkge1xuICAgICAgICAgICAgICAgIHN0YWJsZSArPSAxO1xuICAgICAgICAgICAgICAgIGlmIChzdGFibGUgPj0gMikgYnJlYWs7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHN0YWJsZSA9IDA7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSB7IG9wZW5lZDogISEoY3VycmVudCAmJiBjdXJyZW50ICE9PSBiZWZvcmUpLCBwcmVmYWJVdWlkOiB1dWlkLCBmcm9tU2NlbmU6IGJlZm9yZSB8fCBudWxsLCBjdXJyZW50U2NlbmU6IGN1cnJlbnQgfHwgbnVsbCwgcmVxdWVzdGVkIH07XG4gICAgICAgIGlmICghcmVzdWx0Lm9wZW5lZCkge1xuICAgICAgICAgICAgcmVzdWx0LmhpbnQgPSAn6LaF5pe25pyq5YiH5o2i5paH5qGj77ya5Y+v6IO95b2T5YmN5bey5aSE5LqO6K+l6aKE5Yi25L2T55qE57yW6L6R5qih5byP77yM5oiW5b2T5YmN5piv5peg5qCH6aKY5pyq5L+d5a2Y5Zy65pmv5pe257yW6L6R5Zmo5by55LqG5L+d5a2Y5a+56K+d5qGG77yI5aSE55CG5ZCO6YeN6K+V77yJJztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVNhdmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLnNhdmUnLFxuICAgIHRpdGxlOiAn5L+d5a2Y5Zy65pmvJyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9zYXZlLXNjZW5lIOS/neWtmOW9k+WJjeWcuuaZr++8jOi/lOWbnuS/neWtmOe7k+aenCcsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IG5vUGFyYW1zKCksXG4gICAgYXN5bmMgcnVuKCkge1xuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1kaXJ0eScpO1xuICAgICAgICAvLyDms6jmhI/vvJozLjguOCDnmoQgc2F2ZS1zY2VuZSDov5Tlm57nmoTmmK/lnLrmma8gdXVpZO+8jOS4jeaYryBkYjovLyDot6/lvoRcbiAgICAgICAgY29uc3Qgc2NlbmVVdWlkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgY29uc3QgZGlydHlBZnRlciA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1kaXJ0eScpO1xuICAgICAgICBsZXQgdXJsOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgaWYgKHNjZW5lVXVpZCkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICB1cmwgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktcGF0aCcsIHNjZW5lVXVpZCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgdXJsID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBkaXJ0eUJlZm9yZSwgZGlydHlBZnRlciwgc2NlbmVVdWlkOiBzY2VuZVV1aWQgfHwgbnVsbCwgdXJsOiB1cmwgfHwgbnVsbCB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBhc3NldExpc3Q6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ2Fzc2V0Lmxpc3QnLFxuICAgIHRpdGxlOiAn6LWE5rqQ5YiX6KGoJyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBhc3NldC1kYi9xdWVyeS1hc3NldHMg5YiX5Ye66aG555uu6LWE5rqQJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgcGF0dGVybjogJ+i3r+W+hOWMuemFje+8jOm7mOiupCBkYjovL2Fzc2V0cy8qKicsXG4gICAgICAgIGxpbWl0OiAn5pyA5aSa6L+U5Zue5p2h5pWw77yM6buY6K6kIDUwJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgcGF0dGVybjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfot6/lvoTljLnphY3vvIhnbG9ic++8ie+8jOm7mOiupCBkYjovL2Fzc2V0cy8qKicgfSxcbiAgICAgICAgICAgIGxpbWl0OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ+acgOWkmui/lOWbnuadoeaVsO+8jOm7mOiupCA1MCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCBwYXR0ZXJuID0gcGlja1N0cmluZyhwYXJhbXMsICdwYXR0ZXJuJywgJycpIHx8ICdkYjovL2Fzc2V0cy8qKic7XG4gICAgICAgIGNvbnN0IGxpbWl0ID0gcGlja051bWJlcihwYXJhbXMsICdsaW1pdCcsIDUwKSB8fCA1MDtcbiAgICAgICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm4gfSk7XG4gICAgICAgIGNvbnN0IGxpc3QgPSAoYXNzZXRzIHx8IFtdKS5zbGljZSgwLCBsaW1pdCkubWFwKChhc3NldDogYW55KSA9PiAoe1xuICAgICAgICAgICAgdXJsOiBhc3NldC51cmwsXG4gICAgICAgICAgICB1dWlkOiBhc3NldC51dWlkLFxuICAgICAgICAgICAgdHlwZTogYXNzZXQudHlwZSxcbiAgICAgICAgICAgIGZpbGU6IGFzc2V0LmZpbGUsXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuIHsgcGF0dGVybiwgdG90YWw6IChhc3NldHMgfHwgW10pLmxlbmd0aCwgbGlzdGVkOiBsaXN0Lmxlbmd0aCwgYXNzZXRzOiBsaXN0IH07XG4gICAgfSxcbn07XG5cbmNvbnN0IGFzc2V0RGVsZXRlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdhc3NldC5kZWxldGUnLFxuICAgIHRpdGxlOiAn5Yig6Zmk6LWE5rqQJyxcbiAgICBkZXNjcmlwdGlvbjogJ+WIoOmZpCBhc3NldHMg5LiL55qE6LWE5rqQ77yI6ISa5pysIC8g6aKE5Yi25L2TIC8g6LS05Zu+562J77yJ77yM5LygIHV1aWQg5oiWIGRiOi8vIOi3r+W+hCcsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHV1aWQ6ICfotYTmupAgdXVpZCcsXG4gICAgICAgIHVybDogJ+i1hOa6kOi3r+W+hO+8jOWmgiBkYjovL2Fzc2V0cy9zY3JpcHRzL1BsYXllci50cycsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5rqQIHV1aWQnIH0sXG4gICAgICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6LWE5rqQ6Lev5b6EIGRiOi8vLi4uJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJykudHJpbSgpO1xuICAgICAgICBjb25zdCB1cmwgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3VybCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghdXVpZCAmJiAhdXJsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiB1dWlkIOaIliB1cmwnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0YXJnZXQgPSB1dWlkO1xuICAgICAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICAgICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IHVybCB9KTtcbiAgICAgICAgICAgIGNvbnN0IGhpdCA9IChhc3NldHMgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gdXJsKTtcbiAgICAgICAgICAgIGlmICghaGl0KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLDotYTmupA6ICR7dXJsfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFyZ2V0ID0gaGl0LnV1aWQ7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2RlbGV0ZS1hc3NldCcsIHRhcmdldCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIOacieS6m+eJiOacrOiupOi3r+W+hOS4jeiupCB1dWlk77yM6YCA5Zue5oyJ6Lev5b6E5YaN6K+V5LiA5qyhXG4gICAgICAgICAgICBpZiAoIXVybCkgdGhyb3cgZTtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdkZWxldGUtYXNzZXQnLCB1cmwpO1xuICAgICAgICAgICAgdGFyZ2V0ID0gdXJsO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IHRhcmdldCwgdXJsOiB1cmwgfHwgbnVsbCwgZGVsZXRlZDogdHJ1ZSB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBhc3NldEltcG9ydDogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnYXNzZXQuaW1wb3J0JyxcbiAgICB0aXRsZTogJ+WvvOWFpei1hOa6kOaWh+S7ticsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfmiorno4Hnm5jkuIrnmoTmlofku7Yv55uu5b2V5aSN5Yi26L+bIGFzc2V0cyDlubbop6blj5EgYXNzZXQtZGIg5a+85YWl77yM6L2u6K+i5YiwIHV1aWQg5bCx57uq5ZCO6L+U5Zue77yI5ZCr5a2Q6LWE5rqQIHV1aWTvvIzlpoIgc3ByaXRlRnJhbWXvvInjgIInICtcbiAgICAgICAgJ+WklumDqOWGmeebmOS4jeS8muinpuWPkee8lui+keWZqOeahOeql+WPo+eEpueCueWinumHj+ajgOafpe+8jOW/hemhu+i1sOacrOaTjeS9nO+8iOaIluaJi+WKqCByZWZyZXNoLWFzc2V077yJ77yM5ZCm5YiZIHV1aWQg5LiN5Lya55Sf5oiQ44CCJyArXG4gICAgICAgICdzcmMg55yB55Wl5pe25Li657qv5Yi35paw5qih5byP77ya5paH5Lu25bey55u05o6l5YaZ6L+bIGFzc2V0c++8iOiEmuacrC/otLTlm77ljp/lnLDlsLHkvY3vvInvvIzlj6rop6blj5Hlr7zlhaXkuI3lpI3liLbvvIzov5Tlm54gdXVpZOOAgicgK1xuICAgICAgICAnc3JjIOS4uuebruW9leaXtumAkuW9kuWkjeWItuaVtOS4quebruW9le+8iOiHquWKqOi3s+i/hyAubWV0YSDnrYnpmpDol4/mlofku7bvvIzpgb/lhY3luKblhaXml6cgdXVpZO+8ie+8mycgK1xuICAgICAgICAnZGJQYXRoIOS7pSAvIOe7k+WwvuaIluaXoOaJqeWxleWQjeaXtuinhuS4uuebruagh+ebruW9le+8jOWQpuWImeinhuS4uueyvuehruebruagh+aWh+S7tui3r+W+hOOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHNyYzogJ+ejgeebmOa6kOi3r+W+hO+8iOaWh+S7tuaIluebruW9le+8jOe7neWvuei3r+W+hOaIluebuOWvuemhueebruague+8ie+8m+ecgeeVpSA9IOe6r+WIt+aWsOaooeW8j++8iGRiUGF0aCDlpITmlofku7blt7LlsLHkvY3vvIknLFxuICAgICAgICBkYlBhdGg6ICfnm67moIcgZGI6Ly9hc3NldHMvLi4u77yM55uu5b2V5oiW57K+56Gu5paH5Lu26Lev5b6EJyxcbiAgICAgICAgd2FpdFRpbWVvdXQ6ICfova7or6Llr7zlhaXnu5PmnpzotoXml7bvvIjmr6vnp5LvvInvvIzpu5jorqQgMTUwMDAnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBzcmM6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn56OB55uY5rqQ6Lev5b6E77yI5paH5Lu25oiW55uu5b2V77yJ77yb55yB55WlID0g57qv5Yi35paw5qih5byPJyB9LFxuICAgICAgICAgICAgZGJQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+ebruaghyBkYjovL2Fzc2V0cy8uLi4nIH0sXG4gICAgICAgICAgICB3YWl0VGltZW91dDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfova7or6LotoXml7bmr6vnp5LvvIzpu5jorqQgMTUwMDAnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ2RiUGF0aCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IHNyYyA9IHBpY2tTdHJpbmcocGFyYW1zLCAnc3JjJywgJycpLnRyaW0oKTtcbiAgICAgICAgbGV0IGRiUGF0aCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnZGJQYXRoJywgJycpLnRyaW0oKTtcbiAgICAgICAgY29uc3Qgd2FpdFRpbWVvdXQgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ3dhaXRUaW1lb3V0JywgMTUwMDApIHx8IDE1MDAwO1xuICAgICAgICBpZiAoIWRiUGF0aC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkgdGhyb3cgbmV3IEVycm9yKGBkYlBhdGgg5b+F6aG75ZyoIGRiOi8vYXNzZXRzLyDkuIs6ICR7ZGJQYXRofWApO1xuXG4gICAgICAgIC8vIOe6r+WIt+aWsOaooeW8j++8muS4jeWkjeWItu+8jOWPquWvueW3suWwseS9jeeahOaWh+S7tuinpuWPkSBhc3NldC1kYiDlr7zlhaVcbiAgICAgICAgY29uc3QgcHVyZVJlZnJlc2ggPSAhc3JjO1xuICAgICAgICBjb25zdCBzcmNBYnMgPSBwdXJlUmVmcmVzaFxuICAgICAgICAgICAgPyBkYlVybFRvQWJzKGRiUGF0aClcbiAgICAgICAgICAgIDogKHNyYy5zdGFydHNXaXRoKCdkYjovLycpXG4gICAgICAgICAgICAgICAgPyBkYlVybFRvQWJzKHNyYylcbiAgICAgICAgICAgICAgICA6IChzcmMubWF0Y2goL15bQS1aYS16XTpbXFxcXC9dLykgPyBzcmMgOiBqb2luKHByb2plY3RSb290KCksIHNyYykpKTtcbiAgICAgICAgY29uc3Qgc3JjU3RhdCA9IGF3YWl0IHN0YXQoc3JjQWJzKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgaWYgKCFzcmNTdGF0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IocHVyZVJlZnJlc2hcbiAgICAgICAgICAgICAgICA/IGDnm67moIfmlofku7bkuI3lnKjno4Hnm5jkuIrvvIzml6Dms5XliLfmlrA6ICR7c3JjQWJzfe+8iOe6r+WIt+aWsOaooeW8j+imgeaxguaWh+S7tuW3suWGmei/myBhc3NldHPvvIlgXG4gICAgICAgICAgICAgICAgOiBg5rqQ6Lev5b6E5LiN5a2Y5ZyoOiAke3NyY0Fic31gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRiUGF0aCA9IGRiUGF0aC5yZXBsYWNlKC9cXC8rJC8sICcnKTtcbiAgICAgICAgY29uc3Qgc3JjSXNEaXIgPSBzcmNTdGF0LmlzRGlyZWN0b3J5KCk7XG4gICAgICAgIGNvbnN0IGRiRGlyID0gIXNyY0lzRGlyICYmIGV4dG5hbWUoZGJQYXRoKSA/IGRpcm5hbWUoZGJQYXRoKSA6IGRiUGF0aDtcblxuICAgICAgICAvLyDorqHnrpflpI3liLbmuIXljZXvvJrnm67lvZXpgJLlvZLlsZXlvIDvvIzmlofku7bljZXmnaFcbiAgICAgICAgY29uc3QgaXRlbXM6IEFycmF5PHsgZnJvbTogc3RyaW5nOyB0b0Ficzogc3RyaW5nOyBkYlVybDogc3RyaW5nOyByZWw6IHN0cmluZyB9PiA9IFtdO1xuICAgICAgICBpZiAoc3JjSXNEaXIpIHtcbiAgICAgICAgICAgIGNvbnN0IHdhbGsgPSBhc3luYyAoZGlyOiBzdHJpbmcsIHJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBhd2FpdCByZWFkZGlyKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxvd2VyID0gZW50cnkubmFtZS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgICAgICAgICAvLyDot7Pov4fngrnmlofku7bkuI4gQ29jb3Mg55qEIHh4eC50cy5tZXRh77yI57yW6L6R5Zmo6Ieq55Sf5oiQ77yM5a+85YWl5a6D5Y+q5Lya55m9562J6LaF5pe2L+W4puWFpeaXpyB1dWlk77yJXG4gICAgICAgICAgICAgICAgICAgIGlmIChsb3dlci5zdGFydHNXaXRoKCcuJykgfHwgbG93ZXIuZW5kc1dpdGgoJy5tZXRhJykpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmcm9tID0gam9pbihkaXIsIGVudHJ5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjaGlsZFJlbCA9IHJlbCA/IGAke3JlbH0vJHtlbnRyeS5uYW1lfWAgOiBlbnRyeS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgd2Fsayhmcm9tLCBjaGlsZFJlbCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtcy5wdXNoKHsgZnJvbSwgdG9BYnM6IGRiVXJsVG9BYnMoYCR7ZGJEaXJ9LyR7Y2hpbGRSZWx9YCksIGRiVXJsOiBgJHtkYkRpcn0vJHtjaGlsZFJlbH1gLCByZWw6IGNoaWxkUmVsIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGF3YWl0IHdhbGsoc3JjQWJzLCAnJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoYmFzZW5hbWUoc3JjQWJzKS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcubWV0YScpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkuI3opoHmioogLm1ldGEg5b2T5L2c5a+85YWl5a+56LGh77yI57yW6L6R5Zmo6Ieq55Sf5oiQ5paH5Lu277yJ77yb55u05o6l5a+85YWl5a+55bqU55qE6LWE5rqQ5paH5Lu25Y2z5Y+vJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBmaWxlTmFtZSA9IGJhc2VuYW1lKHNyY0Ficyk7XG4gICAgICAgICAgICBjb25zdCBkYlVybCA9IGV4dG5hbWUoZGJQYXRoKSA/IGRiUGF0aCA6IGAke2RiRGlyfS8ke2ZpbGVOYW1lfWA7XG4gICAgICAgICAgICBpdGVtcy5wdXNoKHsgZnJvbTogc3JjQWJzLCB0b0FiczogZGJVcmxUb0FicyhkYlVybCksIGRiVXJsLCByZWw6IGZpbGVOYW1lIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoYOa6kOebruW9lemHjOayoeacieWPr+WkjeWItueahOaWh+S7tjogJHtzcmNBYnN9YCk7XG5cbiAgICAgICAgLy8g5aSN5Yi25Yiw56OB55uY77yI5rqQ5LiO55uu5qCH5ZCM6Lev5b6EID0g5paH5Lu25bey5bCx5L2N77yM6Lez6L+H5aSN5Yi25Y+q6Kem5Y+R5a+85YWl77yJXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgICAgICAgaWYgKGlzU2FtZVBhdGgoaXRlbS5mcm9tLCBpdGVtLnRvQWJzKSkgY29udGludWU7XG4gICAgICAgICAgICBhd2FpdCBta2RpcihkaXJuYW1lKGl0ZW0udG9BYnMpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIGF3YWl0IGNvcHlGaWxlKGl0ZW0uZnJvbSwgaXRlbS50b0Ficyk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDop6blj5Hlr7zlhaXvvJrku47nm67moIfnm67lvZXlkJHkuIrmib7liLAgYXNzZXQtZGIg5bey55+l55qE5pyA6L+R56WW5YWI5YaN5Yi35paw77yI5paw55uu5b2V5pys6Lqr5Y+v6IO96L+Y5pyq5YWl5bqT77yJXG4gICAgICAgIGxldCByZWZyZXNoVXJsID0gZGJEaXI7XG4gICAgICAgIGZvciAobGV0IGd1YXJkID0gMDsgZ3VhcmQgPCA2OyBndWFyZCsrKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKHJlZnJlc2hVcmwpO1xuICAgICAgICAgICAgaWYgKHBhcmVudCA9PT0gcmVmcmVzaFVybCB8fCAhcGFyZW50LnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzJykpIGJyZWFrO1xuICAgICAgICAgICAgY29uc3Qga25vd246IGFueSA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgcmVmcmVzaFVybCk7XG4gICAgICAgICAgICBpZiAoa25vd24pIGJyZWFrO1xuICAgICAgICAgICAgcmVmcmVzaFVybCA9IHBhcmVudDtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KShBU1NFVF9EQiwgJ3JlZnJlc2gtYXNzZXQnLCByZWZyZXNoVXJsKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8g5Liq5Yir54mI5pys5LiN5pSv5oyB55uu5b2V5Yi35paw77yM6YCA5Zue6YCQ5paH5Lu25Yi35pawXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKEFTU0VUX0RCLCAncmVmcmVzaC1hc3NldCcsIGl0ZW0uZGJVcmwpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8g6L2u6K+i5a+85YWl57uT5p6c77yM5pS26ZuGIHV1aWQg5LiO5a2Q6LWE5rqQ77yIc3ByaXRlRnJhbWUg562J77yJXG4gICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHdhaXRUaW1lb3V0O1xuICAgICAgICBjb25zdCBmaWxlczogYW55W10gPSBbXTtcbiAgICAgICAgbGV0IHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICAgICAgICBsZXQgYXNzZXRJbmZvOiBhbnkgPSBudWxsO1xuICAgICAgICAgICAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgICAgICAgICAgICAgIGFzc2V0SW5mbyA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgaXRlbS5kYlVybCk7XG4gICAgICAgICAgICAgICAgaWYgKGFzc2V0SW5mbykgYnJlYWs7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghYXNzZXRJbmZvKSB7XG4gICAgICAgICAgICAgICAgcmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBmaWxlcy5wdXNoKHsgc3JjOiBpdGVtLmZyb20sIHVybDogaXRlbS5kYlVybCwgcmVsOiBpdGVtLnJlbCwgcmVhZHk6IGZhbHNlIH0pO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHN1YkFzc2V0czogYW55W10gPSBBcnJheS5pc0FycmF5KGFzc2V0SW5mby5zdWJBc3NldHMpXG4gICAgICAgICAgICAgICAgPyBhc3NldEluZm8uc3ViQXNzZXRzLm1hcCgoc3ViOiBhbnkpID0+ICh7IG5hbWU6IHN1Yi5uYW1lLCB1cmw6IHN1Yi51cmwsIHV1aWQ6IHN1Yi51dWlkLCB0eXBlOiBzdWIudHlwZSB9KSlcbiAgICAgICAgICAgICAgICA6IG51bGw7XG4gICAgICAgICAgICBpZiAoIXN1YkFzc2V0cykge1xuICAgICAgICAgICAgICAgIC8vIOWFnOW6le+8muWtkOi1hOa6kCB1cmwg5b2i5aaCIDzotYTmupB1cmw+LzzlkI3lrZc+77yM55SoIHF1ZXJ5LWFzc2V0cyDmn6VcbiAgICAgICAgICAgICAgICBjb25zdCBzdWJzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IGAke2l0ZW0uZGJVcmx9LypgIH0pO1xuICAgICAgICAgICAgICAgIHN1YkFzc2V0cyA9IChzdWJzIHx8IFtdKS5tYXAoKHN1YjogYW55KSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICBuYW1lOiBzdWIudXJsLnNsaWNlKGl0ZW0uZGJVcmwubGVuZ3RoICsgMSksXG4gICAgICAgICAgICAgICAgICAgIHVybDogc3ViLnVybCxcbiAgICAgICAgICAgICAgICAgICAgdXVpZDogc3ViLnV1aWQsXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IHN1Yi50eXBlLFxuICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZpbGVzLnB1c2goeyBzcmM6IGl0ZW0uZnJvbSwgdXJsOiBpdGVtLmRiVXJsLCByZWw6IGl0ZW0ucmVsLCByZWFkeTogdHJ1ZSwgdXVpZDogYXNzZXRJbmZvLnV1aWQsIHR5cGU6IGFzc2V0SW5mby50eXBlLCBzdWJBc3NldHMgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyByZWFkeSwgZGlyVXJsOiBkYkRpciwgcmVmcmVzaFVybCwgY291bnQ6IGl0ZW1zLmxlbmd0aCwgZmlsZXMgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgc2NlbmVTY3JpcHRJbmZvOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY2VuZS5zY3JpcHQuaW5mbycsXG4gICAgdGl0bGU6ICflnLrmma/ohJrmnKzpgJrpgZMgwrcg5byV5pOO5L+h5oGvJyxcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9leGVjdXRlLXNjZW5lLXNjcmlwdCDov5vlhaXlnLrmma/ov5vnqIvvvIzor7vlj5blvJXmk47kuI7lnLrmma/kv6Hmga8nLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIG1ldGhvZDogJ2VuZ2luZUluZm8nLFxuICAgICAgICAgICAgYXJnczogW10sXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4geyBzY3JpcHRSZXN1bHQ6IHJlc3VsdCB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVNjcmlwdERlbW86IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3NjZW5lLnNjcmlwdC5kZW1vJyxcbiAgICB0aXRsZTogJ+WcuuaZr+iEmuacrOmAmumBkyDCtyDlu7roioLngrknLFxuICAgIGRlc2NyaXB0aW9uOiAn6YCa6L+H5Zy65pmv6ISa5pys55So5byV5pOOIEFQSSDlnKjlvZPliY3lnLrmma/liJvlu7rkuIDkuKroioLngrknLFxuICAgIHBhcmFtczoge1xuICAgICAgICBuYW1lOiAn6IqC54K55ZCN77yM6buY6K6kIE1DUF9FbmdpbmVfTm9kZScsXG4gICAgICAgIHg6ICd4IOWdkOaghycsXG4gICAgICAgIHk6ICd5IOWdkOaghycsXG4gICAgICAgIHo6ICd6IOWdkOaghycsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCNJyB9LFxuICAgICAgICAgICAgeDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICd4IOWdkOaghycgfSxcbiAgICAgICAgICAgIHk6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAneSDlnZDmoIcnIH0sXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25hbWUnLCAnJykgfHwgJ01DUF9FbmdpbmVfTm9kZSc7XG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xuICAgICAgICAgICAgeDogcGlja051bWJlcihwYXJhbXMsICd4JywgMCksXG4gICAgICAgICAgICB5OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3knLCAwKSxcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgbWV0aG9kOiAnY3JlYXRlTm9kZScsXG4gICAgICAgICAgICBhcmdzOiBbbmFtZSwgcG9zaXRpb25dLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHsgc2NyaXB0UmVzdWx0OiByZXN1bHQgfTtcbiAgICB9LFxufTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDohJrmnKwgLyDnu4Tku7ZcblxuLyoqIOetieW+heafkOS4quiEmuacrOi1hOa6kOiiqyBDcmVhdG9yIOe8luivkeW5tuazqOWGjOS4uiBjY2NsYXNzICovXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yU2NyaXB0Q29tcGlsZWQoYXNzZXRVdWlkOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDMwMDAwKTogUHJvbWlzZTxhbnkgfCBudWxsPiB7XG4gICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnQgPCB0aW1lb3V0TXMpIHtcbiAgICAgICAgY29uc3QgbGlzdDogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY29tcG9uZW50cycpO1xuICAgICAgICBjb25zdCBmb3VuZCA9IChsaXN0IHx8IFtdKS5maW5kKChpdGVtKSA9PiBpdGVtICYmIGl0ZW0uYXNzZXRVdWlkID09PSBhc3NldFV1aWQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzAwKSk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIOaKiuWxnuaAp+m7mOiupOWAvOa4suafk+aIkOWPr+e8luivkeeahOa6kOeggeWtl+mdoumHj+OAglxuICpcbiAqIOS5i+WJjeaYr+aKiiBkZWZhdWx0IOWOn+agt+aLvOi/m+a6kOegge+8jOWtl+espuS4sum7mOiupOWAvOS8mua8j+aOieW8leWPt++8mlxuICogICBzdHJlZXROYW1lOiBzdHJpbmcgPSDooZfkuIo7ICAg4oaSIOe8luivkeaIkCBgcmV0dXJuIOihl+S4ijtg77yM57uE5Lu25p6E6YCg5pe2IFJlZmVyZW5jZUVycm9yXG4gKiDov5nph4zmjInnsbvlnovooaXpvZDlrZfpnaLph4/lhpnms5XvvIzlrZfnrKbkuLLpu5jorqTotbAgSlNPTi5zdHJpbmdpZnnjgIJcbiAqL1xuZnVuY3Rpb24gcmVuZGVyRGVmYXVsdChwcm9wOiBhbnksIHR5cGU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgaWYgKHByb3AuZGVmYXVsdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB0eXBlID09PSAnbnVtYmVyJyA/ICcwJyA6IHR5cGUgPT09ICdzdHJpbmcnID8gXCInJ1wiIDogJ251bGwnO1xuICAgIH1cbiAgICBjb25zdCByYXcgPSBTdHJpbmcocHJvcC5kZWZhdWx0KTtcbiAgICBpZiAodHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8g6LCD55So5pa55bey57uP5YaZ5LqG5a2X6Z2i6YeP77yI5bim5byV5Y+3L+WPjeW8leWPt++8ieWwseWOn+agt+S/neeVme+8jOWQpuWImeaMieWtl+espuS4suWtl+mdoumHj+i+k+WHulxuICAgICAgICByZXR1cm4gL15bJ1wiYF0vLnRlc3QocmF3KSA/IHJhdyA6IEpTT04uc3RyaW5naWZ5KHJhdyk7XG4gICAgfVxuICAgIHJldHVybiByYXc7XG59XG5cbi8qKiDnlJ/miJDmupDnoIHml7bpnIDopoHoh6rliqjooaXov5sgY2MgaW1wb3J0IOeahOW4uOeUqOexu+Wei+ihqCAqL1xuY29uc3QgQ0NfVFlQRV9OQU1FUzogc3RyaW5nW10gPSBbXG4gICAgJ05vZGUnLCAnTGFiZWwnLCAnQnV0dG9uJywgJ1Nwcml0ZScsICdTcHJpdGVGcmFtZScsICdTcHJpdGVBdGxhcycsICdUb2dnbGUnLCAnTGF5b3V0JywgJ1dpZGdldCcsXG4gICAgJ1Njcm9sbFZpZXcnLCAnRWRpdEJveCcsICdTbGlkZXInLCAnUHJvZ3Jlc3NCYXInLCAnR3JhcGhpY3MnLCAnQW5pbWF0aW9uJywgJ0F1ZGlvU291cmNlJyxcbiAgICAnVmVjMicsICdWZWMzJywgJ0NvbG9yJywgJ1NpemUnLCAnUHJlZmFiJywgJ01hc2snLCAnUmljaFRleHQnLCAnVUlPcGFjaXR5JywgJ0V2ZW50SGFuZGxlcicsXG5dO1xuXG4vKiog5LuO5bGe5oCn5aOw5piO5LiO57G75L2T6YeM5pS26ZuG55So5Yiw55qEIGNjIOexu+Wei++8jOeUn+aIkCBpbXBvcnQg5YiX6KGoICovXG5mdW5jdGlvbiBjb2xsZWN0Q2NUeXBlcyhwcm9wZXJ0aWVzOiBhbnlbXSwgYm9keTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHByb3Agb2YgcHJvcGVydGllcyB8fCBbXSkge1xuICAgICAgICBjb25zdCB0eXBlID0gU3RyaW5nKHByb3A/LnR5cGUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKENDX1RZUEVfTkFNRVMuaW5jbHVkZXModHlwZSkpIHVzZWQuYWRkKHR5cGUpO1xuICAgIH1cbiAgICBpZiAoYm9keSkge1xuICAgICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgQ0NfVFlQRV9OQU1FUykge1xuICAgICAgICAgICAgaWYgKG5ldyBSZWdFeHAoYFxcXFxiJHtuYW1lfVxcXFxiYCkudGVzdChib2R5KSkgdXNlZC5hZGQobmFtZSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIEFycmF5LmZyb20odXNlZCkuc29ydCgpO1xufVxuXG4vKiog55Sf5oiQ6ISa5pys5rqQ56CBICovXG5mdW5jdGlvbiBidWlsZFNjcmlwdFNvdXJjZShjbGFzc05hbWU6IHN0cmluZywgcHJvcGVydGllczogYW55W10sIGJvZHk6IHN0cmluZywgaW1wb3J0czogc3RyaW5nW10gPSBbXSk6IHN0cmluZyB7XG4gICAgY29uc3QgcHJvcExpbmVzID0gKHByb3BlcnRpZXMgfHwgW10pXG4gICAgICAgIC5tYXAoKHByb3ApID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBwcm9wLnR5cGUgfHwgJ251bWJlcic7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IHJlbmRlckRlZmF1bHQocHJvcCwgdHlwZSk7XG4gICAgICAgICAgICByZXR1cm4gYCAgICBAcHJvcGVydHlcXG4gICAgJHtwcm9wLm5hbWV9OiAke3R5cGV9ID0gJHt2YWx1ZX07YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oJ1xcbicpO1xuXG4gICAgY29uc3QgZXh0cmFUeXBlcyA9IGNvbGxlY3RDY1R5cGVzKHByb3BlcnRpZXMgfHwgW10sIGJvZHkpO1xuICAgIGNvbnN0IGltcG9ydExpbmUgPSBleHRyYVR5cGVzLmxlbmd0aFxuICAgICAgICA/IGBpbXBvcnQgeyBfZGVjb3JhdG9yLCBDb21wb25lbnQsICR7ZXh0cmFUeXBlcy5qb2luKCcsICcpfSB9IGZyb20gJ2NjJztgXG4gICAgICAgIDogYGltcG9ydCB7IF9kZWNvcmF0b3IsIENvbXBvbmVudCB9IGZyb20gJ2NjJztgO1xuXG4gICAgcmV0dXJuIFtcbiAgICAgICAgaW1wb3J0TGluZSxcbiAgICAgICAgLi4uKGltcG9ydHMgfHwgW10pLmZpbHRlcigobGluZSkgPT4gdHlwZW9mIGxpbmUgPT09ICdzdHJpbmcnICYmIGxpbmUudHJpbSgpKSxcbiAgICAgICAgYGNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHkgfSA9IF9kZWNvcmF0b3I7YCxcbiAgICAgICAgYGAsXG4gICAgICAgIGBAY2NjbGFzcygnJHtjbGFzc05hbWV9JylgLFxuICAgICAgICBgZXhwb3J0IGNsYXNzICR7Y2xhc3NOYW1lfSBleHRlbmRzIENvbXBvbmVudCB7YCxcbiAgICAgICAgcHJvcExpbmVzLFxuICAgICAgICBwcm9wTGluZXMgPyBgYCA6IGBgLFxuICAgICAgICBgICAgIHN0YXJ0KCkge2AsXG4gICAgICAgIGAgICAgICAgIGNvbnNvbGUubG9nKCdbJHtjbGFzc05hbWV9XSBzdGFydCcpO2AsXG4gICAgICAgIGAgICAgfWAsXG4gICAgICAgIGJvZHkgPyBgYCA6IGBgLFxuICAgICAgICBib2R5IHx8IGBgLFxuICAgICAgICBgfWAsXG4gICAgICAgIGBgLFxuICAgIF0uam9pbignXFxuJyk7XG59XG5cbmNvbnN0IHNjcmlwdENyZWF0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NyaXB0LmNyZWF0ZScsXG4gICAgdGl0bGU6ICfliJvlu7rohJrmnKwnLFxuICAgIGRlc2NyaXB0aW9uOiAn5ZyoIGFzc2V0cyDkuIvliJvlu7rkuIDkuKogVHlwZVNjcmlwdCDohJrmnKzvvIjoh6rliqjmjIIgY2NjbGFzc++8ie+8jOW5tuetieW+heWug+iiqyBDcmVhdG9yIOe8luivkeazqOWGjO+8jOi/lOWbniBjaWQnLFxuICAgIHBhcmFtczoge1xuICAgICAgICBwYXRoOiAn6ISa5pys6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjcmlwdHMvUGxheWVyLnRz77yb55WZ56m65YiZ55SoIGRiOi8vYXNzZXRzL3NjcmlwdHMvPOexu+WQjT4udHMnLFxuICAgICAgICBjbGFzc05hbWU6ICfnsbvlkI3vvIzpu5jorqTlj5bmlofku7blkI0nLFxuICAgICAgICBwcm9wZXJ0aWVzOiAn5bGe5oCn5aOw5piO5pWw57uE77yM5b2i5aaCIFt7XCJuYW1lXCI6XCJzcGVlZFwiLFwidHlwZVwiOlwibnVtYmVyXCIsXCJkZWZhdWx0XCI6MX1dJyxcbiAgICAgICAgYm9keTogJ+mineWklueahOexu+S9k+S7o+egge+8jOebtOaOpeaPkuWFpeWIsCBjbGFzcyDph4wnLFxuICAgICAgICBpbXBvcnRzOiAn6aKd5aSW55qEIGltcG9ydCDor63lj6XmlbDnu4TvvIjlvJXnlKjlhbbku5bnlKjmiLfohJrmnKzml7bnlKjvvInvvIzpgJDooYzmj5LliLAgY2MgaW1wb3J0IOS5i+WQjicsXG4gICAgICAgIG92ZXJ3cml0ZTogJ+WQjOWQjeaWh+S7tuW3suWtmOWcqOaXtuaYr+WQpuimhueblu+8jOm7mOiupCBmYWxzZScsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6ISa5pys6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjcmlwdHMvUGxheWVyLnRzJyB9LFxuICAgICAgICAgICAgY2xhc3NOYW1lOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+exu+WQje+8jOm7mOiupOWPluaWh+S7tuWQjScgfSxcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnYXJyYXknLFxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5bGe5oCn5aOw5piO5pWw57uEJyxcbiAgICAgICAgICAgICAgICBpdGVtczoge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogeyB0eXBlOiAnc3RyaW5nJyB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDoge30sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBib2R5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mineWklueahOexu+S9k+S7o+eggScgfSxcbiAgICAgICAgICAgIGltcG9ydHM6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnYXJyYXknLFxuICAgICAgICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6ICdzdHJpbmcnIH0sXG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICfpop3lpJbnmoQgaW1wb3J0IOivreWPpe+8jOmAkOihjOWOn+agt+aPkuWFpeWIsCBjYyBpbXBvcnQg5LmL5ZCOJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvdmVyd3JpdGU6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WQjOWQjeaWh+S7tuW3suWtmOWcqOaXtuaYr+WQpuimhueblicgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBsZXQgcGF0aCA9IHBpY2tTdHJpbmcocGFyYW1zLCAncGF0aCcsICcnKS50cmltKCk7XG4gICAgICAgIGNvbnN0IG92ZXJ3cml0ZSA9IHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlO1xuXG4gICAgICAgIGlmICghcGF0aCkge1xuICAgICAgICAgICAgY29uc3QgY2xhc3NOYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICdjbGFzc05hbWUnLCAnJykudHJpbSgpIHx8ICdNY3BTY3JpcHQnO1xuICAgICAgICAgICAgcGF0aCA9IGBkYjovL2Fzc2V0cy9zY3JpcHRzLyR7Y2xhc3NOYW1lfS50c2A7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCEvXFwudHMkLy50ZXN0KHBhdGgpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiEmuacrOi3r+W+hOW/hemhu+S7pSAudHMg57uT5bC+OiAke3BhdGh9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzLycpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiEmuacrOW/hemhu+WIm+W7uuWcqCBkYjovL2Fzc2V0cy8g5LiLOiAke3BhdGh9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IHBhdGguc2xpY2UocGF0aC5sYXN0SW5kZXhPZignLycpICsgMSkucmVwbGFjZSgvXFwudHMkLywgJycpO1xuICAgICAgICBjb25zdCBjbGFzc05hbWUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2NsYXNzTmFtZScsICcnKS50cmltKCkgfHwgZmlsZU5hbWU7XG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGJ1aWxkU2NyaXB0U291cmNlKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgcGFyYW1zPy5wcm9wZXJ0aWVzIHx8IFtdLFxuICAgICAgICAgICAgcGlja1N0cmluZyhwYXJhbXMsICdib2R5JywgJycpLFxuICAgICAgICAgICAgQXJyYXkuaXNBcnJheShwYXJhbXM/LmltcG9ydHMpID8gcGFyYW1zLmltcG9ydHMgOiBbXVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIG92ZXJ3cml0ZT10cnVl77ya5YWI5Yig6Zmk5ZCM5ZCN5pen6LWE5rqQ5YaN5Yib5bu677yI5LiN54S2IGNyZWF0ZS1hc3NldCDkvJrlm6Dmlofku7blt7LlrZjlnKjov5Tlm57nqbrvvIlcbiAgICAgICAgaWYgKG92ZXJ3cml0ZSkge1xuICAgICAgICAgICAgY29uc3QgZXhpc3Rpbmc6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogcGF0aCB9KTtcbiAgICAgICAgICAgIGNvbnN0IGhpdCA9IChleGlzdGluZyB8fCBbXSkuZmluZCgoYXNzZXQ6IGFueSkgPT4gYXNzZXQudXJsID09PSBwYXRoKTtcbiAgICAgICAgICAgIGlmIChoaXQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgaGl0LnV1aWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY3JlYXRlZDogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2NyZWF0ZS1hc3NldCcsIHBhdGgsIHNvdXJjZSk7XG4gICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtYXNzZXQg5rKh5pyJ6L+U5Zue6LWE5rqQ5L+h5oGvOiAke3BhdGh977yI5ZCM5ZCN5paH5Lu25bey5a2Y5Zyo77yf5Y+v5LygIG92ZXJ3cml0ZT10cnVlIOimhueblu+8iWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdXVpZCA9IGNyZWF0ZWQudXVpZDtcbiAgICAgICAgY29uc3QgY29tcGlsZWQgPSBhd2FpdCB3YWl0Rm9yU2NyaXB0Q29tcGlsZWQodXVpZCwgMzAwMDApO1xuICAgICAgICBpZiAoIWNvbXBpbGVkKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHV1aWQsXG4gICAgICAgICAgICAgICAgdXJsOiBjcmVhdGVkLnVybCxcbiAgICAgICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICBjb21waWxlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6ICfohJrmnKzlt7LlhpnlhaXvvIzkvYYgMzAg56eS5YaF5rKh5pyJ5Zyo57yW6L6R5Zmo6YeM5a6M5oiQ57yW6K+R5rOo5YaM77yI5Y+v6IO96K+t5rOV6ZSZ6K+v77yM5oiW57yW6L6R5Zmo5pyq5Zyo57yW6K+R77yJJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdXVpZCxcbiAgICAgICAgICAgIHVybDogY3JlYXRlZC51cmwsXG4gICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgY29tcGlsZWQ6IHRydWUsXG4gICAgICAgICAgICBjaWQ6IGNvbXBpbGVkLmNpZCxcbiAgICAgICAgICAgIG5hbWU6IGNvbXBpbGVkLm5hbWUsXG4gICAgICAgICAgICBjb21wb25lbnRQYXRoOiBjb21waWxlZC5wYXRoLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY3JpcHRMaXN0OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY3JpcHQubGlzdCcsXG4gICAgdGl0bGU6ICfliJflh7rohJrmnKznu4Tku7YnLFxuICAgIGRlc2NyaXB0aW9uOiAn5YiX5Ye657yW6L6R5Zmo6YeM5bey5rOo5YaM55qE5YWo6YOo57uE5Lu277yI5YaF572uICsg55So5oi36ISa5pys77yJ77yM5bimIGNpZCAvIHBhdGggLyBhc3NldFV1aWQnLFxuICAgIHBhcmFtczoge30sXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxuICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgY29uc3QgbGlzdDogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY29tcG9uZW50cycpO1xuICAgICAgICBjb25zdCBpdGVtcyA9IChsaXN0IHx8IFtdKS5tYXAoKGl0ZW0pID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpdGVtLm5hbWUsXG4gICAgICAgICAgICBjaWQ6IGl0ZW0uY2lkLFxuICAgICAgICAgICAgcGF0aDogaXRlbS5wYXRoLFxuICAgICAgICAgICAgYXNzZXRVdWlkOiBpdGVtLmFzc2V0VXVpZCxcbiAgICAgICAgICAgIGlzU2NyaXB0OiAhIWl0ZW0uYXNzZXRVdWlkLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybiB7IHRvdGFsOiBpdGVtcy5sZW5ndGgsIGNvbXBvbmVudHM6IGl0ZW1zIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVBZGRDb21wb25lbnQ6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUuYWRkQ29tcG9uZW50JyxcbiAgICB0aXRsZTogJ+aMgui9vee7hOS7ticsXG4gICAgZGVzY3JpcHRpb246ICfnu5noioLngrnmjILnu4Tku7bvvJrlhoXnva7nu4Tku7bkvKAgY2MuU3ByaXRlIOS5i+exu++8jOeUqOaIt+iEmuacrOS8oCBzY3JpcHQubGlzdCDmn6XliLDnmoQgY2lkJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu2IGNpZCDmiJbnsbvlkI3vvIzlpoIgY2MuU3ByaXRlIC8gZmNtUjNYQUROTGdKMUJ5S2hxY0M1WicsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIG5vZGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXG4gICAgICAgICAgICBjb21wb25lbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn57uE5Lu2IGNpZCDmiJbnsbvlkI0nIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ2NvbXBvbmVudCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnY29tcG9uZW50JywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFjb21wb25lbnQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIGNvbXBvbmVudCcpO1xuICAgICAgICB9XG4gICAgICAgIGxldCBub2RlID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFub2RlKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICBub2RlID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFub2RlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5bmC562J77ya5ZCM6IqC54K55LiN5YWB6K645ZCM57G75Z6L57uE5Lu26YeN5aSN5oyC6L2977yM5YWI5p+l5bey5pyJ57uE5Lu277yM5ZG95Lit5bCx55u05o6l6L+U5Zue77yMXG4gICAgICAgIC8vIOmBv+WFjee8lui+keWZqOaJk+WNsCBcIkNhbid0IGFkZCBjb21wb25lbnQgLi4uIGFscmVhZHkgY29udGFpbnMgdGhlIHNhbWUgY29tcG9uZW50XCIg6K2m5ZGK5bm25rGh5p+TIHVuZG9cbiAgICAgICAgY29uc3QgY29tcHNCZWZvcmUgPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xuICAgICAgICBjb25zdCBjYW5kaWRhdGVzID0gYXdhaXQgcmVzb2x2ZUNvbXBvbmVudENhbmRpZGF0ZXMoY29tcG9uZW50KTtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBtYXRjaEV4aXN0aW5nQ29tcG9uZW50KGNvbXBzQmVmb3JlLCBjYW5kaWRhdGVzKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50LFxuICAgICAgICAgICAgICAgIGNoYW5uZWw6ICdub25lJyxcbiAgICAgICAgICAgICAgICBhdHRhY2hlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICBhbHJlYWR5RXhpc3RzOiB0cnVlLFxuICAgICAgICAgICAgICAgIGV4aXN0aW5nOiB7IHV1aWQ6IGV4aXN0aW5nLnV1aWQsIHR5cGU6IGV4aXN0aW5nLnR5cGUsIG5hbWU6IGV4aXN0aW5nLm5hbWUgfSxcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzOiBjb21wc0JlZm9yZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyDlhoXnva7nu4Tku7bvvIhjYy5TcHJpdGUg5LmL57G777yJ6LWw57yW6L6R5Zmo5raI5oGv6YCa6YGT77yM6IO96L+bIHVuZG8g5L2T57O7XG4gICAgICAgIGNvbnN0IGlzQnVpbHRpbiA9IGNvbXBvbmVudC5zdGFydHNXaXRoKCdjYy4nKTtcbiAgICAgICAgbGV0IGNoYW5uZWwgPSAnbWVzc2FnZSc7XG5cbiAgICAgICAgaWYgKGlzQnVpbHRpbikge1xuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2NyZWF0ZS1jb21wb25lbnQnLCB7IHV1aWQ6IG5vZGUsIGNvbXBvbmVudCB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIOiHquWumuS5ieiEmuacrOe7hOS7tuW/hemhu+i1sOW8leaTju+8mue8lui+keWZqOa2iOaBr+mAmumBk+aMguS4jeS4iuWOu1xuICAgICAgICAgICAgY2hhbm5lbCA9ICdlbmdpbmUnO1xuICAgICAgICAgICAgY29uc3Qgc2NyaXB0UmVzdWx0OiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdhZGRDb21wb25lbnRUb05vZGUnLFxuICAgICAgICAgICAgICAgIGFyZ3M6IFtub2RlLCBjb21wb25lbnRdLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoIXNjcmlwdFJlc3VsdCB8fCBzY3JpcHRSZXN1bHQub2sgIT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGDmjILovb3oh6rlrprkuYnnu4Tku7blpLHotKXvvJoke3NjcmlwdFJlc3VsdCAmJiBzY3JpcHRSZXN1bHQuZXJyb3IgPyBzY3JpcHRSZXN1bHQuZXJyb3IgOiAn5pyq55+l6ZSZ6K+vJ31gICtcbiAgICAgICAgICAgICAgICAgICAgKHNjcmlwdFJlc3VsdCAmJiBzY3JpcHRSZXN1bHQucmVnaXN0ZXJlZFVzZXJDbGFzc2VzXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGDvvJvlvJXmk47ph4zlt7Lms6jlhoznmoTnlKjmiLfnsbs6ICR7c2NyaXB0UmVzdWx0LnJlZ2lzdGVyZWRVc2VyQ2xhc3Nlcy5qb2luKCcsICcpIHx8ICco5pegKSd9YFxuICAgICAgICAgICAgICAgICAgICAgICAgOiAnJylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gY3JlYXRlLWNvbXBvbmVudCAvIGFkZENvbXBvbmVudCDpg73kuI3ov5Tlm57mnInmlYjlgLzvvIzlv4Xpobvlm57or7vnoa7orqRcbiAgICAgICAgY29uc3QgY29tcHMgPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xuICAgICAgICBjb25zdCBhdHRhY2hlZCA9IG1hdGNoRXhpc3RpbmdDb21wb25lbnQoY29tcHMsIGNhbmRpZGF0ZXMpO1xuICAgICAgICBpZiAoIWF0dGFjaGVkKSB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gY29tcHMubWFwKChjOiBhbnkpID0+IGMudHlwZSB8fCBjLm5hbWUpLmpvaW4oJywgJykgfHwgJyjml6ApJztcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBg57uE5Lu25rKh5pyJ55yf5q2j5oyC5LiK77ya6IqC54K5ICR7bm9kZX0g5LiK5rKh5pyJ5Ye6546w57uE5Lu244CMJHtjb21wb25lbnR944CN77yI6YCa6YGT77yaJHtjaGFubmVsfe+8ie+8m2AgK1xuICAgICAgICAgICAgICAgIGDlvZPliY3nu4Tku7Y6ICR7Y3VycmVudH1gXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG5vZGUsIGNvbXBvbmVudCwgY2hhbm5lbCwgYXR0YWNoZWQ6IHRydWUsIGNvbXBvbmVudHM6IGNvbXBzIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IG5vZGVSZW1vdmVDb21wb25lbnQ6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUucmVtb3ZlQ29tcG9uZW50JyxcbiAgICB0aXRsZTogJ+enu+mZpOe7hOS7ticsXG4gICAgZGVzY3JpcHRpb246ICfmjInnu4Tku7YgdXVpZCDnp7vpmaToioLngrnkuIrnmoTnu4Tku7YnLFxuICAgIHBhcmFtczoge1xuICAgICAgICBjb21wb25lbnQ6ICfnu4Tku7YgdXVpZCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7YgdXVpZCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsnY29tcG9uZW50J10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdjb21wb25lbnQnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIWNvbXBvbmVudCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogY29tcG9uZW50IHV1aWQnKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncmVtb3ZlLWNvbXBvbmVudCcsIHsgdXVpZDogY29tcG9uZW50IH0pO1xuICAgICAgICByZXR1cm4geyBjb21wb25lbnQsIHJlbW92ZWQ6IHRydWUgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZUxpc3RDb21wb25lbnRzOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdub2RlLmxpc3RDb21wb25lbnRzJyxcbiAgICB0aXRsZTogJ+WIl+WHuuiKgueCuee7hOS7ticsXG4gICAgZGVzY3JpcHRpb246ICfliJflh7rmn5DkuKroioLngrnkuIrmjILnmoTmiYDmnInnu4Tku7YnLFxuICAgIHBhcmFtczoge1xuICAgICAgICBub2RlOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGxldCBub2RlID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCFub2RlKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XG4gICAgICAgICAgICBub2RlID0gc2VsZWN0ZWRbMF0gfHwgJyc7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFub2RlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlKTtcbiAgICAgICAgaWYgKCFmb3VuZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/moJHph4zmib7kuI3liLDoioLngrkgJHtub2RlfWApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNvbXBzID0gcmVhZE5vZGVDb21wb25lbnRzKGZvdW5kKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICBub2RlTmFtZTogZHVtcFZhbHVlPHN0cmluZz4oZm91bmQubmFtZSwgJycpLFxuICAgICAgICAgICAgY291bnQ6IGNvbXBzLmxlbmd0aCxcbiAgICAgICAgICAgIGNvbXBvbmVudHM6IGNvbXBzLFxuICAgICAgICB9O1xuICAgIH0sXG59O1xuXG5jb25zdCBub2RlRGVidWc6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ25vZGUuZGVidWcnLFxuICAgIHRpdGxlOiAn6LCD6K+V77ya5Y6f5aeL6IqC54K5IGR1bXAnLFxuICAgIGRlc2NyaXB0aW9uOiAn6L+U5Zue6IqC54K55Zyo57yW6L6R5ZmoIGR1bXAg6YeM55qE5Y6f5aeL5a2X5q6177yM55So5p2l5pG45riFIDMuOC44IOecn+WunueahOe7hOS7tuWtl+auteWQjScsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIG5vZGU6ICfoioLngrkgdXVpZCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIG5vZGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWQnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVkOiBbJ25vZGUnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1dWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBub2RlJyk7XG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcbiAgICAgICAgY29uc3QgZmluZCA9IChub2RlOiBhbnkpOiBhbnkgPT4ge1xuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGlmIChkdW1wVmFsdWU8c3RyaW5nPihub2RlLnV1aWQsICcnKSA9PT0gdXVpZCkgcmV0dXJuIG5vZGU7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIChub2RlLmNoaWxkcmVuIHx8IFtdKSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGhpdCA9IGZpbmQoY2hpbGQpO1xuICAgICAgICAgICAgICAgIGlmIChoaXQpIHJldHVybiBoaXQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kKHRyZWUpO1xuICAgICAgICBjb25zdCBkaXJlY3Q6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlJywgdXVpZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBmb3VuZEluVHJlZTogISFmb3VuZCxcbiAgICAgICAgICAgIHRyZWVOb2RlS2V5czogZm91bmQgPyBPYmplY3Qua2V5cyhmb3VuZCkgOiBbXSxcbiAgICAgICAgICAgIHRyZWVOb2RlOiBmb3VuZCB8fCBudWxsLFxuICAgICAgICAgICAgZGlyZWN0UXVlcnlLZXlzOiBkaXJlY3QgPyBPYmplY3Qua2V5cyhkaXJlY3QpIDogW10sXG4gICAgICAgICAgICBkaXJlY3RRdWVyeTogZGlyZWN0IHx8IG51bGwsXG4gICAgICAgIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5Zy65pmv5oiq5Zu+XG5cbmNvbnN0IHNjZW5lQ2FwdHVyZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUuY2FwdHVyZScsXG4gICAgdGl0bGU6ICflnLrmma/miKrlm74nLFxuICAgIGRlc2NyaXB0aW9uOiAn5oiq5Y+W5Zy65pmv6Z2i5p2/6KeG5Y+j5Li6IGJhc2U2NCBKUEVH77yI5ZCr57yW6L6R5Zmo572R5qC8L2dpem1v77yM6Z2e6L+Q6KGM5pe255S76Z2i77yJ44CC5LuF5b2T5Zy65pmv5Lit5a2Y5ZyoIENhbnZhcyDoioLngrnml7blj6/nlKjjgILov5Tlm54gc291cmNlV2lkdGgvSGVpZ2h0IOS4uueUu+W4g+eJqeeQhuWDj+e0oO+8jG91dHB1dFdpZHRoL0hlaWdodCDkuLrnvKnmlL7lkI7lsLrlr7jjgILkvKAgb3V0UGF0aCDlj6/lkIzml7bmiorlm77niYflhpnliLDno4Hnm5jvvIjnu53lr7not6/lvoTvvIknLFxuICAgIHBhcmFtczoge1xuICAgICAgICBtYXhXOiAn6L6T5Ye65Zu+5a695bqm5LiK6ZmQ77yI5YOP57Sg77yJ77yM6buY6K6kIDc2OCcsXG4gICAgICAgIG91dFBhdGg6ICflj6/pgInvvJrmioogSlBFRyDlhpnliLDor6Xnu53lr7not6/lvoTvvIjnm67lvZXkvJroh6rliqjliJvlu7rvvIknLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBtYXhXOiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ+i+k+WHuuWbvuWuveW6puS4iumZkO+8iOWDj+e0oO+8ie+8jOm7mOiupCA3NjgnIH0sXG4gICAgICAgICAgICBvdXRQYXRoOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+WPr+mAie+8mkpQRUcg6JC955uY55qE57ud5a+56Lev5b6EJyB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IG1heFcgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ21heFcnLCA3NjgpIHx8IDc2ODtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIG1ldGhvZDogJ2NhcHR1cmVTY2VuZScsXG4gICAgICAgICAgICBhcmdzOiBbbWF4V10sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQub2sgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoKHJlc3VsdCAmJiByZXN1bHQuZXJyb3IpIHx8ICflnLrmma/miKrlm77lpLHotKUnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvdXRQYXRoID0gcGlja1N0cmluZyhwYXJhbXMsICdvdXRQYXRoJywgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKG91dFBhdGggJiYgcmVzdWx0LmJhc2U2NCkge1xuICAgICAgICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShvdXRQYXRoKTtcbiAgICAgICAgICAgIGF3YWl0IG1rZGlyKGRpcm5hbWUoYWJzKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgICBhd2FpdCB3cml0ZUZpbGUoYWJzLCBCdWZmZXIuZnJvbShTdHJpbmcocmVzdWx0LmJhc2U2NCksICdiYXNlNjQnKSk7XG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIGJhc2U2NDogdW5kZWZpbmVkLCBzYXZlZFRvOiBhYnMgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0sXG59O1xuXG5jb25zdCBzY2VuZVJlb3BlbjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUucmVvcGVuJyxcbiAgICB0aXRsZTogJ+mHjeW8gOWcuuaZrycsXG4gICAgZGVzY3JpcHRpb246ICfkv53lrZjlvZPliY3lnLrmma/lkI7ph43mlrDmiZPlvIDlroPvvIzop6blj5HlnLrmma/ov5vnqIvph43mlrDlr7zlhaXnlKjmiLfohJrmnKzmqKHlnZfvvIjlpJbpg6jlhpnlhaXnmoQgLnRzIOe8luivkeWQjumcgOimgei/meS4gOatpeaJjeiDveWcqOW8leaTjumHjOaMgui9ve+8iScsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIGNvbnN0IHNhdmU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdzYXZlLXNjZW5lJyk7XG4gICAgICAgIGNvbnN0IHN0YXR1czogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWN1cnJlbnQtc2NlbmUnKTtcbiAgICAgICAgY29uc3QgdXVpZCA9IHR5cGVvZiBzdGF0dXMgPT09ICdzdHJpbmcnID8gc3RhdHVzIDogKHN0YXR1cyAmJiBzdGF0dXMudXVpZCk7XG4gICAgICAgIGlmICghdXVpZCkgdGhyb3cgbmV3IEVycm9yKCfmi7/kuI3liLDlvZPliY3lnLrmma8gdXVpZDogJyArIEpTT04uc3RyaW5naWZ5KHN0YXR1cykpO1xuICAgICAgICAvLyDlt7LmiZPlvIDlnLrmma/nmoQgb3Blbi1zY2VuZSDlj6/og73ooqvlv73nlaXvvJrlhYjliIfliLDnqbrlnLrmma/lho3liIflm57vvIzlvLrliLblnLrmma/ov5vnqIvph43ovb3ohJrmnKzmqKHlnZdcbiAgICAgICAgbGV0IGVtcHR5OiBhbnkgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZW1wdHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnbG9hZC1lbXB0eS1zY2VuZScpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBlbXB0eSA9IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSB8fCBlKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnb3Blbi1zY2VuZScsIHV1aWQpO1xuICAgICAgICByZXR1cm4geyBzYXZlZDogc2F2ZSwgc2NlbmVVdWlkOiB1dWlkLCBlbXB0eSwgb3BlbmVkIH07XG4gICAgfSxcbn07XG5cbmNvbnN0IHNjZW5lQ3JlYXRlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xuICAgIG5hbWU6ICdzY2VuZS5jcmVhdGUnLFxuICAgIHRpdGxlOiAn5paw5bu65Zy65pmvJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgJ+eUqCBhc3NldC1kYi9uZXctYXNzZXQg5oyJ57yW6L6R5Zmo5YaF572u5qih5p2/5paw5bu65Zy65pmv77yM5LiO6LWE5rqQ566h55CG5Zmo5Y+z6ZSu44CM5paw5bu6IOKGkiDlnLrmma/jgI3lkIzkuIDpgJrpgZMnICtcbiAgICAgICAgJ++8iGhhbmRsZXI9c2NlbmXvvIx0ZW1wbGF0ZT1kYjovL2ludGVybmFsL2RlZmF1bHRfZmlsZV9jb250ZW50L3NjZW5lL3NjZW5lLTJkLnNjZW5l77yJ44CCJyArXG4gICAgICAgICfms6jmhI/vvJpjcmVhdGUtYXNzZXQg5LygIG51bGwg5YaF5a655ZyoIDMuOC44IOWunua1i+WIm+W7uueahOaYr+ebruW9leiAjOmdnuWcuuaZr+aWh+S7tu+8jOS4jeimgeeUqOWug+W7uuWcuuaZr+OAgicgK1xuICAgICAgICAn54i255uu5b2V5LiN5a2Y5Zyo5Lya6Ieq5Yqo6YCQ57qn5Yib5bu644CCb3Blbj10cnVlIOaXtuWIm+W7uuWQjiBvcGVuLXNjZW5lIOW5tui9ruivouehruiupOWIh+aNouWujOaIkO+8mycgK1xuICAgICAgICAn5b2T5YmN5Zy65pmv5piv5peg5qCH6aKY5pyq5L+d5a2Y5Zy65pmv5pe257yW6L6R5Zmo5Lya5by55L+d5a2Y5a+56K+d5qGG77yM5Lq65bel5aSE55CG5ZCO6L2u6K+i6Ieq5Yqo57un57ut77yM6LaF5pe26L+U5ZueIG9wZW5lZD1mYWxzZSDlubbnu5nmj5DnpLrjgIInLFxuICAgIHBhcmFtczoge1xuICAgICAgICB1cmw6ICfmlrDlnLrmma8gZGI6Ly8g6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjZW5lcy9oZWxsb3dvcmxkLnNjZW5lJyxcbiAgICAgICAgdGVtcGxhdGU6IFwiJzJkJ++8iOm7mOiupO+8jOWQqyBDYW52YXMrQ2FtZXJh77yJLyAnZW1wdHkn77yI56m65Zy65pmv77yJ77yM5oiW5a6M5pW05qih5p2/6Lev5b6EIGRiOi8vaW50ZXJuYWwvZGVmYXVsdF9maWxlX2NvbnRlbnQvc2NlbmUveHh4LnNjZW5lXCIsXG4gICAgICAgIG9wZW46ICfliJvlu7rlkI7mmK/lkKbnq4vljbPmiZPlvIDor6XlnLrmma/vvIzpu5jorqQgZmFsc2UnLFxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI3mlofku7blt7LlrZjlnKjml7bmmK/lkKbopobnm5bvvIzpu5jorqQgZmFsc2UnLFxuICAgICAgICBvcGVuVGltZW91dDogJ29wZW49dHJ1ZSDml7bnrYnlvoXlnLrmma/liIfmjaLlrozmiJDnmoTotoXml7bmr6vnp5LvvIzpu5jorqQgMzAwMDAnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5paw5Zy65pmvIGRiOi8vIOi3r+W+hO+8jOWmgiBkYjovL2Fzc2V0cy9zY2VuZXMvaGVsbG93b3JsZC5zY2VuZScgfSxcbiAgICAgICAgICAgIHRlbXBsYXRlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogXCInMmQn77yI6buY6K6k77yJLyAnZW1wdHkn77yM5oiW5a6M5pW05qih5p2/IGRiOi8vIOi3r+W+hFwiIH0sXG4gICAgICAgICAgICBvcGVuOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICfliJvlu7rlkI7mmK/lkKbnq4vljbPmiZPlvIDvvIzpu5jorqQgZmFsc2UnIH0sXG4gICAgICAgICAgICBvdmVyd3JpdGU6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WQjOWQjeaWh+S7tuW3suWtmOWcqOaXtuaYr+WQpuimhueblu+8jOm7mOiupCBmYWxzZScgfSxcbiAgICAgICAgICAgIG9wZW5UaW1lb3V0OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ+etieW+heWcuuaZr+WIh+aNoui2heaXtuavq+enku+8jOm7mOiupCAzMDAwMCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsndXJsJ10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/lv4XpobvliJvlu7rlnKggZGI6Ly9hc3NldHMvIOS4izogJHt1cmx9YCk7XG4gICAgICAgIGlmICghdXJsLmVuZHNXaXRoKCcuc2NlbmUnKSkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/ot6/lvoTlv4Xpobvku6UgLnNjZW5lIOe7k+WwvjogJHt1cmx9YCk7XG4gICAgICAgIGNvbnN0IG92ZXJ3cml0ZSA9IHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlO1xuXG4gICAgICAgIC8vIOmAkOe6p+ehruS/neeItuebruW9leWtmOWcqO+8iGNyZWF0ZS1hc3NldCDnmoQgc291cmNlIOS8oCBudWxsIOWNs+WIm+W7uuebruW9le+8iVxuICAgICAgICBjb25zdCBmb2xkZXJTZWdtZW50cyA9IHVybC5zbGljZSgnZGI6Ly9hc3NldHMvJy5sZW5ndGgpLnNwbGl0KCcvJykuc2xpY2UoMCwgLTEpO1xuICAgICAgICBsZXQgZm9sZGVyVXJsID0gJ2RiOi8vYXNzZXRzJztcbiAgICAgICAgZm9yIChjb25zdCBzZWdtZW50IG9mIGZvbGRlclNlZ21lbnRzKSB7XG4gICAgICAgICAgICBpZiAoIXNlZ21lbnQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgZm9sZGVyVXJsID0gYCR7Zm9sZGVyVXJsfS8ke3NlZ21lbnR9YDtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0cyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgZm9sZGVyVXJsKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdjcmVhdGUtYXNzZXQnLCBmb2xkZXJVcmwsIG51bGwpO1xuICAgICAgICAgICAgICAgIGlmICghY3JlYXRlZCkgdGhyb3cgbmV3IEVycm9yKGDliJvlu7rnm67lvZXlpLHotKU6ICR7Zm9sZGVyVXJsfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRlbXBsYXRlID0gcGlja1N0cmluZyhwYXJhbXMsICd0ZW1wbGF0ZScsICcnKS50cmltKCkgfHwgJzJkJztcbiAgICAgICAgaWYgKHRlbXBsYXRlID09PSAnMmQnKSB0ZW1wbGF0ZSA9ICdkYjovL2ludGVybmFsL2RlZmF1bHRfZmlsZV9jb250ZW50L3NjZW5lL3NjZW5lLTJkLnNjZW5lJztcbiAgICAgICAgZWxzZSBpZiAodGVtcGxhdGUgPT09ICdlbXB0eScgfHwgdGVtcGxhdGUgPT09ICczZCcpIHRlbXBsYXRlID0gJ2RiOi8vaW50ZXJuYWwvZGVmYXVsdF9maWxlX2NvbnRlbnQvc2NlbmUvZGVmYXVsdC5zY2VuZSc7XG4gICAgICAgIGNvbnN0IGluZm86IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICduZXctYXNzZXQnLCB7XG4gICAgICAgICAgICBoYW5kbGVyOiAnc2NlbmUnLFxuICAgICAgICAgICAgdGFyZ2V0OiB1cmwsXG4gICAgICAgICAgICB0ZW1wbGF0ZSxcbiAgICAgICAgICAgIG92ZXJ3cml0ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghaW5mbyB8fCAhaW5mby51dWlkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYG5ldy1hc3NldCDmsqHmnInov5Tlm57otYTmupDkv6Hmga86ICR7dXJsfe+8iOWQjOWQjeaWh+S7tuW3suWtmOWcqO+8n+WPr+S8oCBvdmVyd3JpdGU9dHJ1Ze+8iWApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0geyB1dWlkOiBpbmZvLnV1aWQsIHVybDogaW5mby51cmwgfHwgdXJsLCBmaWxlOiBpbmZvLmZpbGUgfHwgbnVsbCwgdGVtcGxhdGUgfTtcblxuICAgICAgICBpZiAocGFyYW1zPy5vcGVuID09PSB0cnVlKSB7XG4gICAgICAgICAgICAvLyDkuI3lgZogbG9hZC1lbXB0eS1zY2VuZe+8muWug+S8muS6p+eUn+aXoOagh+mimOWcuuaZr++8jOWvvOiHtOmaj+WQjueahCBvcGVuLXNjZW5lIOW8ueOAjOS/neWtmOW9k+WJjeWcuuaZr+OAjeWvueivneahhlxuICAgICAgICAgICAgY29uc3QgdGltZW91dCA9IHBpY2tOdW1iZXIocGFyYW1zLCAnb3BlblRpbWVvdXQnLCAzMDAwMCkgfHwgMzAwMDA7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdvcGVuLXNjZW5lJywgaW5mby51dWlkKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyBvcGVuLXNjZW5lIOWPr+iDvemdmem7mOiiq+W/veeVpe+8jOS6pOe7meS4i+mdoueahOi9ruivouWIpOaWrVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dDtcbiAgICAgICAgICAgIGxldCBjdXJyZW50ID0gJyc7XG4gICAgICAgICAgICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzAwKSk7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhdHVzOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY3VycmVudC1zY2VuZScpO1xuICAgICAgICAgICAgICAgICAgICBjdXJyZW50ID0gdHlwZW9mIHN0YXR1cyA9PT0gJ3N0cmluZycgPyBzdGF0dXMgOiAoc3RhdHVzICYmIHN0YXR1cy51dWlkKSB8fCAnJztcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnQgPSAnJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGN1cnJlbnQgPT09IFN0cmluZyhpbmZvLnV1aWQpKSBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc3VsdC5vcGVuZWQgPSBjdXJyZW50ID09PSBTdHJpbmcoaW5mby51dWlkKTtcbiAgICAgICAgICAgIHJlc3VsdC5jdXJyZW50U2NlbmUgPSBjdXJyZW50IHx8IG51bGw7XG4gICAgICAgICAgICBpZiAoIXJlc3VsdC5vcGVuZWQpIHtcbiAgICAgICAgICAgICAgICByZXN1bHQuaGludCA9ICfotoXml7bmnKrliIfmjaLliLDmlrDlnLrmma/vvJrlvZPliY3lnLrmma/mnKrkv53lrZjml7Ygb3Blbi1zY2VuZSDkvJrlvLnkv53lrZjlr7nor53moYbvvIzlnKjnvJbovpHlmajph4zlpITnkIbor6Xlr7nor53moYblkI7lj6/nlKggc2NlbmUub3BlbiDph43or5UnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfSxcbn07XG5cbmNvbnN0IHNjZW5lT3BlbjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnc2NlbmUub3BlbicsXG4gICAgdGl0bGU6ICfmiZPlvIDlnLrmma8nLFxuICAgIGRlc2NyaXB0aW9uOiAn5oyJIGRiOi8vIOi3r+W+hOaIliB1dWlkIOaJk+W8gOaMh+WumuWcuuaZr++8iOm7mOiupOWFiOS/neWtmOW9k+WJjeWcuuaZr+WGjeWIh+aNou+8jHNhdmVDdXJyZW50PWZhbHNlIOWPr+i3s+i/h+S/neWtmO+8iScsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIHVybDogJ+WcuuaZr+i1hOS6pyBkYjovLyDot6/lvoTmiJYgdXVpZO+8jOWmgiBkYjovL2Fzc2V0cy9sb2JieS5zY2VuZScsXG4gICAgICAgIHNhdmVDdXJyZW50OiAn5YiH5o2i5YmN5piv5ZCm5L+d5a2Y5b2T5YmN5Zy65pmv77yM6buY6K6kIHRydWUnLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5Zy65pmv6LWE5LqnIGRiOi8vIOi3r+W+hOaIliB1dWlkJyB9LFxuICAgICAgICAgICAgc2F2ZUN1cnJlbnQ6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+m7mOiupCB0cnVlJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWyd1cmwnXSxcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxuICAgIH0sXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xuICAgICAgICBjb25zdCB1cmwgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3VybCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghdXJsKSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiB1cmzvvIhkYjovLyDot6/lvoTmiJYgdXVpZO+8iScpO1xuICAgICAgICBsZXQgdXVpZCA9IHVybDtcbiAgICAgICAgaWYgKHVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XG4gICAgICAgICAgICBjb25zdCBhc3NldHM6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogdXJsIH0pO1xuICAgICAgICAgICAgY29uc3QgaGl0ID0gKGFzc2V0cyB8fCBbXSkuZmluZCgoYTogYW55KSA9PiBhLnVybCA9PT0gdXJsKSB8fCAoYXNzZXRzIHx8IFtdKVswXTtcbiAgICAgICAgICAgIGlmICghaGl0IHx8ICFoaXQudXVpZCkgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLDlnLrmma/otYTkuqc6ICR7dXJsfWApO1xuICAgICAgICAgICAgdXVpZCA9IFN0cmluZyhoaXQudXVpZCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc2F2ZUN1cnJlbnQgPSBwYXJhbXM/LnNhdmVDdXJyZW50ID09PSBmYWxzZSA/IGZhbHNlIDogdHJ1ZTtcbiAgICAgICAgaWYgKHNhdmVDdXJyZW50KSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdzYXZlLXNjZW5lJyk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgLy8g5L+d5a2Y5aSx6LSl5LiN6Zi75pat5YiH5o2iXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gb3Blbi1zY2VuZSDlj6/og73lpI3nlKjlhoXlrZjph4znmoTohI/lnLrmma/vvIjlr7nlt7LliqDovb0gdXVpZCDkvJrooqvlv73nlaXvvInvvJrlhYjliIfnqbrlnLrmma/lvLrliLblubLlh4Dph43ovb1cbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2xvYWQtZW1wdHktc2NlbmUnKTtcbiAgICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ29wZW4tc2NlbmUnLCB1dWlkKTtcbiAgICAgICAgcmV0dXJuIHsgb3BlbmVkLCBzY2VuZVV1aWQ6IHV1aWQgfTtcbiAgICB9LFxufTtcblxuY29uc3QgcHJvamVjdFNldERlc2lnblJlc29sdXRpb246IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ3Byb2plY3Quc2V0RGVzaWduUmVzb2x1dGlvbicsXG4gICAgdGl0bGU6ICforr7nva7pobnnm67orr7orqHliIbovqjnjocnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAn6K6+572u6aG555uu6K6+6K6h5YiG6L6o546H77yI562J5Lu35LqOIOmhueebruiuvue9ruKGkumhueebriDpnaLmnb/vvJpFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0IOaMgeS5heWMluWIsCBzZXR0aW5ncy92Mi9wYWNrYWdlcy9wcm9qZWN0Lmpzb27vvIwnICtcbiAgICAgICAgJ+WGjeWPkSBwcm9qZWN0L2NoYW5nZS1kZXNpZ24tcmVzb2x1dGlvbu+8jHNjZW5lIOaJqeWxleebkeWQrOivpeW5v+aSreWIt+aWsOeUu+W4g++8ieOAgicgK1xuICAgICAgICAnd2lkdGgvaGVpZ2h0IOW/heWhq++8iDF+ODE5MiDmlbTmlbDvvInvvIxmaXRXaWR0aC9maXRIZWlnaHQg57y655yB5rK/55So5b2T5YmN5YC877yb6L+U5Zue5Zue6K+75YC85LiO6JC955uY5qCh6aqM57uT5p6c44CCJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgd2lkdGg6ICforr7orqHliIbovqjnjoflrr3vvIzlpoIgNzIwJyxcbiAgICAgICAgaGVpZ2h0OiAn6K6+6K6h5YiG6L6o546H6auY77yM5aaCIDEyODAnLFxuICAgICAgICBmaXRXaWR0aDogJ+WPr+mAieOAguaYr+WQpumAgumFjeWuveW6pu+8jOe8uuecgeayv+eUqOW9k+WJjeWAvCcsXG4gICAgICAgIGZpdEhlaWdodDogJ+WPr+mAieOAguaYr+WQpumAgumFjemrmOW6pu+8jOe8uuecgeayv+eUqOW9k+WJjeWAvCcsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIHdpZHRoOiB7IHR5cGU6ICdpbnRlZ2VyJywgbWluaW11bTogMSwgbWF4aW11bTogODE5MiwgZGVzY3JpcHRpb246ICforr7orqHliIbovqjnjoflrr3vvIzlpoIgNzIwJyB9LFxuICAgICAgICAgICAgaGVpZ2h0OiB7IHR5cGU6ICdpbnRlZ2VyJywgbWluaW11bTogMSwgbWF4aW11bTogODE5MiwgZGVzY3JpcHRpb246ICforr7orqHliIbovqjnjofpq5jvvIzlpoIgMTI4MCcgfSxcbiAgICAgICAgICAgIGZpdFdpZHRoOiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICflj6/pgInjgILmmK/lkKbpgILphY3lrr3luqbvvIznvLrnnIHmsr/nlKjlvZPliY3lgLwnIH0sXG4gICAgICAgICAgICBmaXRIZWlnaHQ6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WPr+mAieOAguaYr+WQpumAgumFjemrmOW6pu+8jOe8uuecgeayv+eUqOW9k+WJjeWAvCcgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZWQ6IFsnd2lkdGgnLCAnaGVpZ2h0J10sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3Qgd2lkdGggPSBNYXRoLnJvdW5kKHBpY2tOdW1iZXIocGFyYW1zLCAnd2lkdGgnLCAwKSk7XG4gICAgICAgIGNvbnN0IGhlaWdodCA9IE1hdGgucm91bmQocGlja051bWJlcihwYXJhbXMsICdoZWlnaHQnLCAwKSk7XG4gICAgICAgIGlmICghKHdpZHRoID49IDEgJiYgd2lkdGggPD0gODE5MikgfHwgIShoZWlnaHQgPj0gMSAmJiBoZWlnaHQgPD0gODE5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgd2lkdGgvaGVpZ2h0IOW/hemhu+aYryAxfjgxOTIg55qE5pW05pWw77yM5pS25YiwOiAke0pTT04uc3RyaW5naWZ5KHBhcmFtcz8ud2lkdGgpfSB4ICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zPy5oZWlnaHQpfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8g5b2T5YmN5YC877ya5a6Y5pa5IHF1ZXJ5LWRlc2lnbi1yZXNvbHV0aW9uIOa2iOaBr+S8mOWFiO+8jOWPluS4jeWIsOmAgOWbniBQcm9maWxlXG4gICAgICAgIGxldCBjdXJyZW50OiBhbnkgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY3VycmVudCA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoJ3Byb2plY3QnLCAncXVlcnktZGVzaWduLXJlc29sdXRpb24nKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgY3VycmVudCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFjdXJyZW50IHx8IHR5cGVvZiBjdXJyZW50ICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgY3VycmVudCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoJ3Byb2plY3QnLCAnZ2VuZXJhbC5kZXNpZ25SZXNvbHV0aW9uJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmVmb3JlID0ge1xuICAgICAgICAgICAgd2lkdGg6IE1hdGgucm91bmQoTnVtYmVyKGN1cnJlbnQ/LndpZHRoKSkgfHwgMCxcbiAgICAgICAgICAgIGhlaWdodDogTWF0aC5yb3VuZChOdW1iZXIoY3VycmVudD8uaGVpZ2h0KSkgfHwgMCxcbiAgICAgICAgICAgIGZpdFdpZHRoOiBjdXJyZW50Py5maXRXaWR0aCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIGZpdEhlaWdodDogY3VycmVudD8uZml0SGVpZ2h0ID09PSB0cnVlLFxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IHJlc29sdXRpb24gPSB7XG4gICAgICAgICAgICB3aWR0aCxcbiAgICAgICAgICAgIGhlaWdodCxcbiAgICAgICAgICAgIGZpdFdpZHRoOiB0eXBlb2YgcGFyYW1zPy5maXRXaWR0aCA9PT0gJ2Jvb2xlYW4nID8gcGFyYW1zLmZpdFdpZHRoIDogYmVmb3JlLmZpdFdpZHRoLFxuICAgICAgICAgICAgZml0SGVpZ2h0OiB0eXBlb2YgcGFyYW1zPy5maXRIZWlnaHQgPT09ICdib29sZWFuJyA/IHBhcmFtcy5maXRIZWlnaHQgOiBiZWZvcmUuZml0SGVpZ2h0LFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIOaMgeS5heWMlu+8iHNldHRpbmdzL3YyL3BhY2thZ2VzL3Byb2plY3QuanNvbu+8ie+8jOWumOaWuSBQcm9maWxlIEFQSVxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KCdwcm9qZWN0JywgJ2dlbmVyYWwuZGVzaWduUmVzb2x1dGlvbicsIHJlc29sdXRpb24pO1xuICAgICAgICAvLyDlupTnlKjvvJrkuI7orr7nva7pnaLmnb/lkIzkuIDmnaHmtojmga/vvIxzY2VuZSDmianlsZXnm5HlkKzlkI7liLfmlrDnlLvluINcbiAgICAgICAgYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KSgncHJvamVjdCcsICdjaGFuZ2UtZGVzaWduLXJlc29sdXRpb24nLCByZXNvbHV0aW9uKTtcblxuICAgICAgICAvLyDlm57or7vpqozor4FcbiAgICAgICAgbGV0IHF1ZXJpZWQ6IGFueSA9IG51bGw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBxdWVyaWVkID0gYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KSgncHJvamVjdCcsICdxdWVyeS1kZXNpZ24tcmVzb2x1dGlvbicpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBxdWVyaWVkID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICAvLyDokL3nm5jmoKHpqozvvIhQcm9maWxlIOW8guatpeWGmeebmO+8jOeojeetieWGjeivu++8jGJlc3QgZWZmb3J077yJXG4gICAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XG4gICAgICAgIGxldCBmaWxlOiBhbnkgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShqb2luKHByb2plY3RSb290KCksICdzZXR0aW5ncycsICd2MicsICdwYWNrYWdlcycsICdwcm9qZWN0Lmpzb24nKSwgJ3V0ZjgnKSk7XG4gICAgICAgICAgICBmaWxlID0gcmF3Py5nZW5lcmFsPy5kZXNpZ25SZXNvbHV0aW9uID8/IG51bGw7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGZpbGUgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZCA9ICEhKFxuICAgICAgICAgICAgZmlsZSAmJlxuICAgICAgICAgICAgTnVtYmVyKGZpbGUud2lkdGgpID09PSB3aWR0aCAmJlxuICAgICAgICAgICAgTnVtYmVyKGZpbGUuaGVpZ2h0KSA9PT0gaGVpZ2h0ICYmXG4gICAgICAgICAgICBmaWxlLmZpdFdpZHRoID09PSByZXNvbHV0aW9uLmZpdFdpZHRoICYmXG4gICAgICAgICAgICBmaWxlLmZpdEhlaWdodCA9PT0gcmVzb2x1dGlvbi5maXRIZWlnaHRcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHsgYmVmb3JlLCBhcHBsaWVkOiByZXNvbHV0aW9uLCBxdWVyaWVkLCBmaWxlLCBwZXJzaXN0ZWQgfTtcbiAgICB9LFxufTtcblxuY29uc3Qgbm9kZUNyZWF0ZUNvbXBvbmVudE1zZzogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbm9kZS5jcmVhdGVDb21wb25lbnRNc2cnLFxuICAgIHRpdGxlOiAn5oyC6L2957uE5Lu277yI5raI5oGv6YCa6YGT55u06YCa77yJJyxcbiAgICBkZXNjcmlwdGlvbjogJ+ebtOaOpei1sCBzY2VuZS9jcmVhdGUtY29tcG9uZW50IOa2iOaBr+aMgue7hOS7tu+8jOaUr+aMgeiHquWumuS5ieiEmuacrCBjaWTvvIjkuI3ov5vlvJXmk47pgJrpgZPvvIknLFxuICAgIHBhcmFtczoge1xuICAgICAgICBub2RlOiAn6IqC54K5IHV1aWQnLFxuICAgICAgICBjb21wb25lbnQ6ICfnu4Tku7YgY2lkIOaIluexu+WQje+8iOWPr+S7peaYr+eUqOaIt+iEmuacrCBjaWTvvIknLFxuICAgIH0sXG4gICAgc2NoZW1hOiB7XG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlkJyB9LFxuICAgICAgICAgICAgY29tcG9uZW50OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+e7hOS7tiBjaWQg5oiW57G75ZCNJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydub2RlJywgJ2NvbXBvbmVudCddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25vZGUnLCAnJykudHJpbSgpO1xuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2NvbXBvbmVudCcsICcnKS50cmltKCk7XG4gICAgICAgIGlmICghbm9kZSB8fCAhY29tcG9uZW50KSB0aHJvdyBuZXcgRXJyb3IoJ+mcgOimgSBub2RlIOS4jiBjb21wb25lbnQnKTtcbiAgICAgICAgLy8g5bmC562J77ya5bey5pyJ5ZCM57G75Z6L57uE5Lu255u05o6l6L+U5Zue77yM5LiN6YeN5aSN6Kem5Y+RIGNyZWF0ZS1jb21wb25lbnTvvIjlkKbliJnnvJbovpHlmajkvJrmiZPljbDorablkYrvvIlcbiAgICAgICAgY29uc3QgY29tcHNCZWZvcmUgPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xuICAgICAgICBjb25zdCBjYW5kaWRhdGVzID0gYXdhaXQgcmVzb2x2ZUNvbXBvbmVudENhbmRpZGF0ZXMoY29tcG9uZW50KTtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBtYXRjaEV4aXN0aW5nQ29tcG9uZW50KGNvbXBzQmVmb3JlLCBjYW5kaWRhdGVzKTtcbiAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50LFxuICAgICAgICAgICAgICAgIGFscmVhZHlFeGlzdHM6IHRydWUsXG4gICAgICAgICAgICAgICAgZXhpc3Rpbmc6IHsgdXVpZDogZXhpc3RpbmcudXVpZCwgdHlwZTogZXhpc3RpbmcudHlwZSwgbmFtZTogZXhpc3RpbmcubmFtZSB9LFxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IGNvbXBzQmVmb3JlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnY3JlYXRlLWNvbXBvbmVudCcsIHsgdXVpZDogbm9kZSwgY29tcG9uZW50IH0pO1xuICAgICAgICBjb25zdCBjb21wczogYW55W10gPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xuICAgICAgICByZXR1cm4geyBub2RlLCBjb21wb25lbnQsIGNvbXBvbmVudHM6IGNvbXBzIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6YCa55So5om56YePXG5cbi8qKlxuICog5oqK5Y+C5pWw6YeM55qEIFwiJDxpPi48YS5iLmM+XCIg5qih5p2/5pu/5o2i5oiQ56ysIGkg6aG55omn6KGM57uT5p6c6YeM55qE5a+55bqU5YC877yI5pSv5oyB5a+56LGhL+aVsOe7hOWGheW1jOWll++8ieOAglxuICog5Lik56eN6Lev5b6E5YaZ5rOV562J5Lu377yaXG4gKiAgIFwiJDAuZGF0YS51dWlkXCIg4oCU4oCUIOS7jiByZXN1bHRzW2ldIOi1t+WGmeWFqO+8iOS4juaWh+aho+ekuuS+i+OAgee7k+aenCBKU09OIOeahOWtl+mdoue7k+aehOS4gOiHtO+8ie+8m1xuICogICBcIiQwLnV1aWRcIiAgICAgIOKAlOKAlCDnm7jlr7kgcmVzdWx0c1tpXS5kYXRhIOeahOefreWGmeazleOAglxuICovXG5mdW5jdGlvbiByZXNvbHZlUmVzdWx0UmVmcyh2YWx1ZTogYW55LCByZXN1bHRzOiBhbnlbXSk6IGFueSB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3QgbSA9IC9eXFwkKFxcZCspKD86XFwuKFtcXHcuXSspKT8kLy5leGVjKHZhbHVlKTtcbiAgICAgICAgaWYgKCFtKSByZXR1cm4gdmFsdWU7XG4gICAgICAgIGNvbnN0IGhpdCA9IHJlc3VsdHNbTnVtYmVyKG1bMV0pXTtcbiAgICAgICAgaWYgKCFoaXQgfHwgIWhpdC5vaykgdGhyb3cgbmV3IEVycm9yKGDlvJXnlKggJCR7bVsxXX0g5aSx6LSl77ya6K+l6aG55pyq5oiQ5Yqf5omn6KGMYCk7XG4gICAgICAgIGNvbnN0IHNlZ3MgPSAobVsyXSB8fCAnJykuc3BsaXQoJy4nKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICAgIGxldCBjdXI6IGFueSA9IHNlZ3NbMF0gPT09ICdkYXRhJyA/IGhpdCA6IGhpdC5kYXRhO1xuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBzZWdzKSB7XG4gICAgICAgICAgICBjdXIgPSBjdXI/LltrZXldO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjdXI7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcCgodikgPT4gcmVzb2x2ZVJlc3VsdFJlZnModiwgcmVzdWx0cykpO1xuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogYW55ID0ge307XG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkgb3V0W2tleV0gPSByZXNvbHZlUmVzdWx0UmVmcyh2YWx1ZVtrZXldLCByZXN1bHRzKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG5jb25zdCBiYXRjaFJ1bjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnYmF0Y2gucnVuJyxcbiAgICB0aXRsZTogJ+aJuemHj+aJp+ihjOaTjeS9nCcsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAgICfmjInpobrluo/miafooYzkuIDnu4Tmk43kvZzvvIzmioogTiDmrKHlvoDov5TlkIjlubbkuLrkuIDmrKHosIPnlKjjgIInICtcbiAgICAgICAgJ+avj+mhueeLrOeri+i/m+e8lui+keWZqCB1bmRvIOS9k+ezu++8iOS4gOaJuSA9IOWkmuadoSB1bmRvIOiusOW9le+8ie+8m3N0b3BPbkVycm9yPXRydWXvvIjpu5jorqTvvInml7bpgYfplJnkuK3mraLvvIwnICtcbiAgICAgICAgJ+i/lOWbnumAkOmhuee7k+aenOOAgmJhdGNoLnJ1biDkuI3lhYHorrjltYzlpZfjgIInICtcbiAgICAgICAgJ+WPguaVsOWAvOaUr+aMgeW8leeUqOWJjemhuee7k+aenO+8muW9ouWmgiBcIiQwLmRhdGEudXVpZFwiIOeahOWtl+espuS4suS8muabv+aNouaIkOesrCAwIOmhuSByZXN1bHRzWzBdLmRhdGEudXVpZCDnmoTlgLzvvIwnICtcbiAgICAgICAgJ+S5n+WPr+eUqOetieS7t+efreWGmSBcIiQwLnV1aWRcIu+8iOi3r+W+hOebuOWvuSByZXN1bHRzW2ldLmRhdGEg6Kej5p6Q77yJ77yb5Y+v5bWM5aWX5Zyo5a+56LGhL+aVsOe7hOmHjCcgK1xuICAgICAgICAn77yI5L6L5aaCIG5vZGUuY3JlYXRlIOS5i+WQjiBub2RlLm1vdmUg5LygIHtcInV1aWRcIjpcIiQwLmRhdGEudXVpZFwife+8ieOAgicgK1xuICAgICAgICAn5rOo5oSP77yaXCIkTlwiIOW8leeUqOS7heWcqOWQjOS4gOasoeiwg+eUqOWGheacieaViO+8jOi3qOaJueW/hemhu+WFiOWPluWbnuecn+WuniB1dWlkIOWGjeW8leeUqOOAgicgK1xuICAgICAgICAnbm9kZS5iaW5kUHJvcGVydHkg55qEIGJpbmRpbmdzIOaJuemHj+W9k+WJjeWPquacieesrOS4gOadoeeUn+aViO+8jOa3t+eUqOaXtumAkOadoeiwg+eUqOOAgicsXG4gICAgcGFyYW1zOiB7XG4gICAgICAgIGl0ZW1zOiAn5pON5L2c5pWw57uE77yM5q+P6aG55b2i5aaCIHtcIm9wXCI6XCJub2RlLm1vdmVcIixcInBhcmFtc1wiOnsuLi59fe+8m3BhcmFtcyDph4zlj6/nlKggXCIkPGk+Ljzot6/lvoQ+XCIg5byV55So56ysIGkg6aG557uT5p6c77yI5LuF6ZmQ5pys5om577yJJyxcbiAgICAgICAgc3RvcE9uRXJyb3I6ICfpgYfplJnmmK/lkKbkuK3mraLlkI7nu63mk43kvZzvvIzpu5jorqQgdHJ1ZScsXG4gICAgfSxcbiAgICBzY2hlbWE6IHtcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgIGl0ZW1zOiB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aTjeS9nOaVsOe7hCcsXG4gICAgICAgICAgICAgICAgaXRlbXM6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+aTjeS9nOWQje+8jOWmgiBub2RlLmNyZWF0ZScgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtczogeyB0eXBlOiAnb2JqZWN0JywgZGVzY3JpcHRpb246ICfor6Xmk43kvZznmoTlj4LmlbDvvIzlj6/nlKggXCIkaS5wYXRoXCIg5byV55So5YmN6aG557uT5p6cJyB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICByZXF1aXJlZDogWydvcCddLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgc3RvcE9uRXJyb3I6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+mBh+mUmeaYr+WQpuS4reatou+8jOm7mOiupCB0cnVlJyB9LFxuICAgICAgICB9LFxuICAgICAgICByZXF1aXJlZDogWydpdGVtcyddLFxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXG4gICAgfSxcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocGFyYW1zPy5pdGVtcykgPyBwYXJhbXMuaXRlbXMgOiBbXTtcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignaXRlbXMg5Li656m6Jyk7XG4gICAgICAgIGNvbnN0IHN0b3BPbkVycm9yID0gcGFyYW1zPy5zdG9wT25FcnJvciAhPT0gZmFsc2U7XG5cbiAgICAgICAgY29uc3QgcmVzdWx0czogYW55W10gPSBbXTtcbiAgICAgICAgbGV0IGFib3J0ZWQgPSBmYWxzZTtcbiAgICAgICAgbGV0IG9rQ291bnQgPSAwO1xuICAgICAgICBsZXQgZmFpbENvdW50ID0gMDtcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGl0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IGl0ZW1zW2luZGV4XTtcbiAgICAgICAgICAgIGNvbnN0IG9wID0gaXRlbSAmJiB0eXBlb2YgaXRlbS5vcCA9PT0gJ3N0cmluZycgPyBpdGVtLm9wLnRyaW0oKSA6ICcnO1xuICAgICAgICAgICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xuICAgICAgICAgICAgaWYgKCFvcCB8fCBvcCA9PT0gJ2JhdGNoLnJ1bicpIHtcbiAgICAgICAgICAgICAgICBmYWlsQ291bnQrKztcbiAgICAgICAgICAgICAgICByZXN1bHRzLnB1c2goeyBvcCwgb2s6IGZhbHNlLCBlcnJvcjogb3AgPyAnYmF0Y2gucnVuIOS4jeWFgeiuuOW1jOWllycgOiAn57y65bCRIG9wJywgY29zdDogMCB9KTtcbiAgICAgICAgICAgICAgICBpZiAoc3RvcE9uRXJyb3IpIHsgYWJvcnRlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGxldCBpdGVtUGFyYW1zID0gaXRlbT8ucGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAmJiBpdGVtUGFyYW1zICYmIHR5cGVvZiBpdGVtUGFyYW1zID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICBpdGVtUGFyYW1zID0gcmVzb2x2ZVJlc3VsdFJlZnMoaXRlbVBhcmFtcywgcmVzdWx0cyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9wZXJhdGlvbiA9IHJlZ2lzdHJ5TWFwW29wXTtcbiAgICAgICAgICAgICAgICBpZiAoIW9wZXJhdGlvbikgdGhyb3cgbmV3IEVycm9yKGDmnKrnn6Xmk43kvZw6ICR7b3B9YCk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG9wZXJhdGlvbi5ydW4oaXRlbVBhcmFtcyk7XG4gICAgICAgICAgICAgICAgb2tDb3VudCsrO1xuICAgICAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7IG9wLCBvazogdHJ1ZSwgZGF0YSwgY29zdDogRGF0ZS5ub3coKSAtIHN0YXJ0IH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIGZhaWxDb3VudCsrO1xuICAgICAgICAgICAgICAgIHJlc3VsdHMucHVzaCh7IG9wLCBvazogZmFsc2UsIGVycm9yOiBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UgfHwgZSksIGNvc3Q6IERhdGUubm93KCkgLSBzdGFydCB9KTtcbiAgICAgICAgICAgICAgICBpZiAoc3RvcE9uRXJyb3IpIHsgYWJvcnRlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdG90YWw6IGl0ZW1zLmxlbmd0aCwgb2s6IG9rQ291bnQsIGZhaWxlZDogZmFpbENvdW50LCBhYm9ydGVkLCByZXN1bHRzIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gTUNQIOacjeWKoeWZqOiHqueuoeeQhlxuXG5jb25zdCBtY3BTdGF0dXM6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XG4gICAgbmFtZTogJ21jcC5zdGF0dXMnLFxuICAgIHRpdGxlOiAnTUNQIOacjeWKoeWZqOeKtuaAgScsXG4gICAgZGVzY3JpcHRpb246ICfmn6Xor6IgbWNwLXNlcnZlciDlrZDov5vnqIvov5DooYznirbmgIHvvJrnq6/lj6PjgIFwaWTjgIHmmK/lkKbmnKznvJbovpHlmajlkK/liqjjgIFIVFRQIOaOoua0u+e7k+aenCcsXG4gICAgcGFyYW1zOiB7fSxcbiAgICBzY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfSxcbiAgICBhc3luYyBydW4oKSB7XG4gICAgICAgIHJldHVybiBhd2FpdCBtY3BTZXJ2ZXJTdGF0dXMoKTtcbiAgICB9LFxufTtcblxuY29uc3QgbWNwUmVzdGFydDogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcbiAgICBuYW1lOiAnbWNwLnJlc3RhcnQnLFxuICAgIHRpdGxlOiAn6YeN5ZCvIE1DUCDmnI3liqHlmagnLFxuICAgIGRlc2NyaXB0aW9uOiAn6YeN5ZCvIG1jcC1zZXJ2ZXIg5a2Q6L+b56iL77yI5L+u5pS5IG1jcC1zZXJ2ZXIvaW5kZXguanMg5ZCO6K6p5Luj56CB55Sf5pWI77yJ77yb5Y+q5o6l566h5pys57yW6L6R5Zmo5ZCv5Yqo55qE5a6e5L6LJyxcbiAgICBwYXJhbXM6IHtcbiAgICAgICAgcG9ydDogJ+WPr+mAieOAguebkeWQrOerr+WPo++8jOm7mOiupOayv+eUqOW9k+WJjeerr+WPo++8iOaXoOi/kOihjOWunuS+i+aXtueUqOS4iuasoeerr+WPo++8jOWGjemAgOWbniAzMDAy77yJJyxcbiAgICB9LFxuICAgIHNjaGVtYToge1xuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgcG9ydDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfnm5HlkKznq6/lj6PvvIzpu5jorqTmsr/nlKjlvZPliY3nq6/lj6MnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcbiAgICB9LFxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcbiAgICAgICAgY29uc3QgYmVmb3JlID0gYXdhaXQgbWNwU2VydmVyU3RhdHVzKCk7XG4gICAgICAgIGNvbnN0IHBvcnQgPSBwaWNrTnVtYmVyKHBhcmFtcywgJ3BvcnQnLCAwKSB8fCBiZWZvcmUucG9ydCB8fCBiZWZvcmUubGFzdFBvcnQgfHwgMzAwMjtcbiAgICAgICAgaWYgKGJlZm9yZS5ydW5uaW5nICYmICFiZWZvcmUub3duZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBg56uv5Y+jICR7cG9ydH0g5LiK55qEIE1DUCBTZXJ2ZXLvvIhwaWQgJHtiZWZvcmUucGlkfe+8ieS4jeaYr+acrOe8lui+keWZqOWQr+WKqOeahO+8jOaXoOazleS7o+S4uumHjeWQr++8m2AgK1xuICAgICAgICAgICAgICAgICfor7flhYjlnKjnu4jnq6/nu5PmnZ/or6Xov5vnqIvvvIzmiJbmjaLnq6/lj6PlkK/liqjmlrDlrp7kvovjgIInXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChiZWZvcmUucnVubmluZyAmJiBiZWZvcmUub3duZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHN0b3BNY3BTZXJ2ZXIoKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IHN0YXJ0TWNwU2VydmVyKHBvcnQpO1xuICAgICAgICBpZiAoIXN0YXRlLnJ1bm5pbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg6YeN5ZCv5ZCOIG1jcC1zZXJ2ZXIg5pyq6L+Q6KGM77yM5pyA6L+R6L6T5Ye677yaJHtzdGF0ZS5yZWNlbnRPdXRwdXQuc2xpY2UoLTUpLmpvaW4oJyB8ICcpIHx8ICfml6AnfWApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IC4uLnN0YXRlLCByZXN0YXJ0ZWQ6IHRydWUsIHByZXZpb3VzUGlkOiBiZWZvcmUucGlkIH07XG4gICAgfSxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5rOo5YaM6KGoXG5cbmNvbnN0IHJlZ2lzdHJ5OiBPcGVyYXRpb25EZWZpbml0aW9uW10gPSBbXG4gICAgZWRpdG9ySW5mbyxcbiAgICBzY2VuZVN0YXR1cyxcbiAgICBzY2VuZVRyZWUsXG4gICAgbm9kZUNyZWF0ZSxcbiAgICBub2RlRGVsZXRlLFxuICAgIG5vZGVNb3ZlLFxuICAgIG5vZGVNb3ZlRW5naW5lLFxuICAgIG5vZGVTZXRQcm9wZXJ0eSxcbiAgICBub2RlU2V0UHJvcGVydHlFbmdpbmUsXG4gICAgbm9kZUJpbmRQcm9wZXJ0eSxcbiAgICBub2RlQ3JlYXRlUHJlZmFiLFxuICAgIHByZWZhYk9wZW4sXG4gICAgc2NlbmVTYXZlLFxuICAgIGFzc2V0TGlzdCxcbiAgICBhc3NldERlbGV0ZSxcbiAgICBhc3NldEltcG9ydCxcbiAgICBiYXRjaFJ1bixcbiAgICBtY3BTdGF0dXMsXG4gICAgbWNwUmVzdGFydCxcbiAgICBzY2VuZVNjcmlwdEluZm8sXG4gICAgc2NlbmVTY3JpcHREZW1vLFxuICAgIHNjZW5lQ2FwdHVyZSxcbiAgICBzY2VuZVJlb3BlbixcbiAgICBzY2VuZUNyZWF0ZSxcbiAgICBzY2VuZU9wZW4sXG4gICAgcHJvamVjdFNldERlc2lnblJlc29sdXRpb24sXG4gICAgbm9kZUNyZWF0ZUNvbXBvbmVudE1zZyxcbiAgICBzY3JpcHRDcmVhdGUsXG4gICAgc2NyaXB0TGlzdCxcbiAgICBub2RlQWRkQ29tcG9uZW50LFxuICAgIG5vZGVSZW1vdmVDb21wb25lbnQsXG4gICAgbm9kZUxpc3RDb21wb25lbnRzLFxuICAgIG5vZGVEZWJ1Zyxcbl07XG5cbmNvbnN0IHJlZ2lzdHJ5TWFwOiB7IFtuYW1lOiBzdHJpbmddOiBPcGVyYXRpb25EZWZpbml0aW9uIH0gPSB7fTtcbmZvciAoY29uc3Qgb3BlcmF0aW9uIG9mIHJlZ2lzdHJ5KSB7XG4gICAgcmVnaXN0cnlNYXBbb3BlcmF0aW9uLm5hbWVdID0gb3BlcmF0aW9uO1xufVxuXG4vKiog5YiX5Ye65omA5pyJ5pON5L2c77yITUNQIHRvb2xzL2xpc3Qg55qE5pWw5o2u5rqQ77yJICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdE9wZXJhdGlvbnMoKTogT3BlcmF0aW9uSW5mb1tdIHtcbiAgICByZXR1cm4gcmVnaXN0cnkubWFwKChvcGVyYXRpb24pID0+ICh7XG4gICAgICAgIG5hbWU6IG9wZXJhdGlvbi5uYW1lLFxuICAgICAgICB0aXRsZTogb3BlcmF0aW9uLnRpdGxlLFxuICAgICAgICBkZXNjcmlwdGlvbjogb3BlcmF0aW9uLmRlc2NyaXB0aW9uLFxuICAgICAgICBwYXJhbXM6IG9wZXJhdGlvbi5wYXJhbXMsXG4gICAgICAgIHNjaGVtYTogb3BlcmF0aW9uLnNjaGVtYSxcbiAgICB9KSk7XG59XG5cbi8qKiDmjInlkI3lrZfmiafooYzkuIDkuKrmk43kvZwgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5PcGVyYXRpb24obmFtZTogc3RyaW5nLCBwYXJhbXM6IHsgW2tleTogc3RyaW5nXTogYW55IH0gPSB7fSk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3Qgb3BlcmF0aW9uID0gcmVnaXN0cnlNYXBbbmFtZV07XG4gICAgaWYgKCFvcGVyYXRpb24pIHtcbiAgICAgICAgY29uc3Qga25vd24gPSByZWdpc3RyeS5tYXAoKGl0ZW0pID0+IGl0ZW0ubmFtZSkuam9pbignLCAnKTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmnKrnn6Xmk43kvZw6ICR7bmFtZX3vvJvlj6/nlKjmk43kvZw6ICR7a25vd259YCk7XG4gICAgfVxuICAgIHJldHVybiBvcGVyYXRpb24ucnVuKHBhcmFtcyB8fCB7fSk7XG59XG4iXX0=