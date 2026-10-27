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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlcmF0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9vcGVyYXRpb25zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBaXRFQSx3Q0FRQztBQUdELG9DQU9DO0FBbnVFRCxhQUFhO0FBQ2IsbUVBQTBDO0FBQzFDLDBDQUFrRjtBQUNsRiwrQkFBaUU7QUFFakUsNkNBQTBDO0FBQzFDLCtDQUErRTtBQUUvRTs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUVILE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQztBQUN0QixNQUFNLFFBQVEsR0FBRyxVQUFVLENBQUM7QUFpQjVCLHdFQUF3RTtBQUV4RSw2Q0FBNkM7QUFDN0MsU0FBUyxTQUFTLENBQVUsSUFBUyxFQUFFLFFBQVc7SUFDOUMsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxTQUFTO1FBQUUsT0FBTyxRQUFRLENBQUM7SUFDekQsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDO1FBQzlDLE9BQVEsSUFBcUIsQ0FBQyxLQUFLLENBQUM7SUFDeEMsQ0FBQztJQUNELE9BQU8sSUFBUyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxNQUFXLEVBQUUsR0FBVyxFQUFFLFFBQVEsR0FBRyxFQUFFO0lBQ3ZELE1BQU0sS0FBSyxHQUFHLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENBQUMsQ0FBQztJQUM1QixPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLE1BQVcsRUFBRSxHQUFXLEVBQUUsUUFBUSxHQUFHLENBQUM7SUFDdEQsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRyxHQUFHLENB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QUFpQyxFQUFFO0lBQ2hGLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNwQyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDYixNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzNELE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxJQUFJLFVBQVUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUNwRCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUMsR0FBRyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQztBQUN2QyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQHRzLWlnbm9yZVxyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgY29weUZpbGUsIG1rZGlyLCByZWFkRmlsZSwgcmVhZGRpciwgc3RhdCwgd3JpdGVGaWxlIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgZXh0bmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBKc29uU2NoZW1hLCBPcGVyYXRpb25JbmZvIH0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB7IE1BSU5fQlVJTEQgfSBmcm9tICcuL2J1aWxkLWluZm8nO1xyXG5pbXBvcnQgeyBtY3BTZXJ2ZXJTdGF0dXMsIHN0YXJ0TWNwU2VydmVyLCBzdG9wTWNwU2VydmVyIH0gZnJvbSAnLi9tY3AtcHJvY2Vzcyc7XHJcblxyXG4vKipcclxuICog5pON5L2c5bGC77ya6Ieq56CUIE1DUCDmnI3liqHnmoTlhajpg6jog73lipvpg73mlLbmlZvlnKjov5nph4zjgIJcclxuICpcclxuICog6K6+6K6h6KaB54K577yaXHJcbiAqIDEuIOavj+S4quaTjeS9nOmDveaYr+e6r+WHveaVsOW8j+eahCBhc3luY++8jOWPguaVsOS4jui/lOWbnuWAvOmDveW/hemhu+aYr+e6ryBKU09O77yISVBDIOmZkOWItu+8ieOAglxyXG4gKiAyLiDmianlsZXkuLvov5vnqIvjgIHmnKzlnLAgSFRUUCDmoaXkuI4gTUNQIFNlcnZlciDotbDnmoTmmK/lkIzkuIDlpZcgb3BlcmF0aW9uc++8jFxyXG4gKiAgICBNQ1AgU2VydmVyIOWPqumcgOimgeaKiiB0b29sIOiwg+eUqOe/u+ivkeaIkCB7IG9wLCBwYXJhbXMgfSDljbPlj6/jgIJcclxuICogMy4g5Lik5p2h6YCa6YGT6YO95L+d55WZ77yaXHJcbiAqICAgIC0g57yW6L6R5Zmo5raI5oGv6YCa6YGT77yaRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAuLi4pIC8gKCdhc3NldC1kYicsIC4uLilcclxuICogICAgICDotbDnvJbovpHlmaggdW5kbyAvIGRpcnR5IOS9k+ezu++8jOS/neWtmOacgOWPr+mdoOOAglxyXG4gKiAgICAtIOWcuuaZr+iEmuacrOmAmumBk++8mkVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0JywgLi4uKVxyXG4gKiAgICAgIOi/m+WFpeWcuuaZr+i/m+eoi++8jOWPr+S7peebtOaOpeeUqOW8leaTjiBBUEnjgIJcclxuICogNC4g5q+P5Liq5pON5L2c6YO95bim5LiA5Lu9IEpTT04gU2NoZW1h77yMTUNQIOS+p+ebtOaOpeaLv+Wug+W9kyB0b29sIOeahCBpbnB1dFNjaGVtYe+8jFxyXG4gKiAgICDov5nmoLflt6XlhbfnmoTlj4LmlbDnsbvlnovmmK/nnJ/lrp7lo7DmmI7nmoTvvIzkuI3mmK/njJzlh7rmnaXnmoTjgIJcclxuICovXHJcblxyXG5jb25zdCBTQ0VORSA9ICdzY2VuZSc7XHJcbmNvbnN0IEFTU0VUX0RCID0gJ2Fzc2V0LWRiJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgT3BlcmF0aW9uRGVmaW5pdGlvbiB7XHJcbiAgICAvKiog5pON5L2c5ZCN77yM5b2i5aaCIHNjZW5lLnRyZWUgKi9cclxuICAgIG5hbWU6IHN0cmluZztcclxuICAgIC8qKiDkuK3mlofmoIfpopggKi9cclxuICAgIHRpdGxlOiBzdHJpbmc7XHJcbiAgICAvKiog6K+05piOICovXHJcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xyXG4gICAgLyoqIOWPguaVsOivtOaYju+8mmtleSDkuLrlj4LmlbDlkI3vvIx2YWx1ZSDkuLrlkKvkuYkgKi9cclxuICAgIHBhcmFtczogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcclxuICAgIC8qKiDlj4LmlbAgSlNPTiBTY2hlbWEgKi9cclxuICAgIHNjaGVtYTogSnNvblNjaGVtYTtcclxuICAgIC8qKiDmiafooYwgKi9cclxuICAgIHJ1bihwYXJhbXM6IHsgW2tleTogc3RyaW5nXTogYW55IH0pOiBQcm9taXNlPGFueT47XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5bel5YW35Ye95pWwXHJcblxyXG4vKiog5LuOIGR1bXAg5pWw5o2u6YeM5Y+W5Ye655yf5a6e5YC877yaZHVtcCDlvaLlpoIgeyB2YWx1ZTogeHh4IH0gKi9cclxuZnVuY3Rpb24gZHVtcFZhbHVlPFQgPSBhbnk+KHByb3A6IGFueSwgZmFsbGJhY2s6IFQpOiBUIHtcclxuICAgIGlmIChwcm9wID09PSBudWxsIHx8IHByb3AgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xyXG4gICAgaWYgKHR5cGVvZiBwcm9wID09PSAnb2JqZWN0JyAmJiAndmFsdWUnIGluIHByb3ApIHtcclxuICAgICAgICByZXR1cm4gKHByb3AgYXMgeyB2YWx1ZTogVCB9KS52YWx1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBwcm9wIGFzIFQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBpY2tTdHJpbmcocGFyYW1zOiBhbnksIGtleTogc3RyaW5nLCBmYWxsYmFjayA9ICcnKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHZhbHVlID0gcGFyYW1zPy5ba2V5XTtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUgOiBmYWxsYmFjaztcclxufVxyXG5cclxuZnVuY3Rpb24gcGlja051bWJlcihwYXJhbXM6IGFueSwga2V5OiBzdHJpbmcsIGZhbGxiYWNrID0gMCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE51bWJlcihwYXJhbXM/LltrZXldKTtcclxuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBmYWxsYmFjaztcclxufVxyXG5cclxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcikgPT4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcclxuXHJcbi8qKiDpobnnm67moLnnm67lvZXvvIhFZGl0b3IuUHJvamVjdC5wYXRo77yM55u06L+e5qih5byP5LiL5LuOIGRpc3Qg5L2N572u5o6o5a+877yJICovXHJcbmZ1bmN0aW9uIHByb2plY3RSb290KCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBlZGl0b3IgPSB0eXBlb2YgRWRpdG9yICE9PSAndW5kZWZpbmVkJyA/IChFZGl0b3IgYXMgYW55KSA6IG51bGw7XHJcbiAgICBpZiAoZWRpdG9yPy5Qcm9qZWN0Py5wYXRoKSByZXR1cm4gZWRpdG9yLlByb2plY3QucGF0aDtcclxuICAgIHJldHVybiBqb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJy4uJyk7XHJcbn1cclxuXHJcbi8qKiBkYjovL2Fzc2V0cy8uLi4g6Lev5b6E6L2s56OB55uY57ud5a+56Lev5b6EICovXHJcbmZ1bmN0aW9uIGRiVXJsVG9BYnMoZGJVcmw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihwcm9qZWN0Um9vdCgpLCBkYlVybC5yZXBsYWNlKC9eZGI6XFwvXFwvLywgJycpKTtcclxufVxyXG5cclxuLyoqIOWQjOS4gOejgeebmOi3r+W+hOWIpOWumu+8iFdpbmRvd3Mg5LiL5aSn5bCP5YaZ5LiO5YiG6ZqU56ym5LiN5pWP5oSf77yJICovXHJcbmZ1bmN0aW9uIGlzU2FtZVBhdGgoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IHJhID0gcmVzb2x2ZShhKTtcclxuICAgIGNvbnN0IHJiID0gcmVzb2x2ZShiKTtcclxuICAgIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gcmEudG9Mb3dlckNhc2UoKSA9PT0gcmIudG9Mb3dlckNhc2UoKSA6IHJhID09PSByYjtcclxufVxyXG5cclxuLyoqIOWxgue6p+euoeeQhuWZqOmHjOW9k+WJjemAieS4reeahOiKgueCuSB1dWlkIOWIl+ihqCAqL1xyXG5mdW5jdGlvbiBnZXRTZWxlY3RlZE5vZGVVdWlkcygpOiBzdHJpbmdbXSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHJldHVybiBFZGl0b3IuU2VsZWN0aW9uLmdldFNlbGVjdGVkKCdub2RlJykgfHwgW107XHJcbiAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKiog5LuO6IqC54K5IGR1bXAg6YeM5Y+W57uE5Lu25YiX6KGo77yIMy44Ljgg55qE5a2X5q615pivIGNvbXBvbmVudHPvvIzkuI3mmK8gX19jb21wc19f77yJICovXHJcbmZ1bmN0aW9uIHJlYWROb2RlQ29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7XHJcbiAgICBpZiAoIW5vZGUpIHJldHVybiBbXTtcclxuICAgIGNvbnN0IHJhdyA9IG5vZGUuY29tcG9uZW50cyB8fCBub2RlLl9fY29tcHNfXyB8fCBbXTtcclxuICAgIHJldHVybiByYXcubWFwKChjb21wOiBhbnkpID0+IHtcclxuICAgICAgICBpZiAoY29tcCAmJiB0eXBlb2YgY29tcCA9PT0gJ29iamVjdCcgJiYgJ3ZhbHVlJyBpbiBjb21wICYmIGNvbXAudmFsdWUgJiYgdHlwZW9mIGNvbXAudmFsdWUgPT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgICAgIC8vIOiAgeagvOW8j++8mnsgdmFsdWU6IHsgdXVpZCwgbmFtZSwgZW5hYmxlZCB9IH1cclxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBjb21wLnZhbHVlO1xyXG4gICAgICAgICAgICByZXR1cm4geyB1dWlkOiB2YWx1ZS51dWlkIHx8ICcnLCBuYW1lOiB2YWx1ZS5uYW1lIHx8ICcnLCB0eXBlOiB2YWx1ZS50eXBlIHx8ICcnLCBlbmFibGVkOiB2YWx1ZS5lbmFibGVkLCBpc0N1c3RvbTogISFjb21wLmlzQ3VzdG9tIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIDMuOC44IOagvOW8j++8mnsgaXNDdXN0b20sIHR5cGUsIHZhbHVlOiA857uE5Lu2dXVpZD4gfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHR5cGVvZiBjb21wPy52YWx1ZSA9PT0gJ3N0cmluZycgPyBjb21wLnZhbHVlIDogKGNvbXA/LnV1aWQgfHwgJycpLFxyXG4gICAgICAgICAgICBuYW1lOiBjb21wPy5uYW1lIHx8ICcnLFxyXG4gICAgICAgICAgICB0eXBlOiBjb21wPy50eXBlIHx8ICcnLFxyXG4gICAgICAgICAgICBlbmFibGVkOiBjb21wPy5lbmFibGVkLFxyXG4gICAgICAgICAgICBpc0N1c3RvbTogISFjb21wPy5pc0N1c3RvbSxcclxuICAgICAgICB9O1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbi8qKiDlnKjlnLrmma/moJHph4zmjIkgdXVpZCDmib7oioLngrkgKi9cclxuZnVuY3Rpb24gZmluZE5vZGVJblRyZWUodHJlZTogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkge1xyXG4gICAgaWYgKCF0cmVlKSByZXR1cm4gbnVsbDtcclxuICAgIGlmIChkdW1wVmFsdWU8c3RyaW5nPih0cmVlLnV1aWQsICcnKSA9PT0gdXVpZCkgcmV0dXJuIHRyZWU7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mICh0cmVlLmNoaWxkcmVuIHx8IFtdKSkge1xyXG4gICAgICAgIGNvbnN0IGhpdCA9IGZpbmROb2RlSW5UcmVlKGNoaWxkLCB1dWlkKTtcclxuICAgICAgICBpZiAoaGl0KSByZXR1cm4gaGl0O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKiDor7vlj5bmn5DoioLngrnlvZPliY3nmoTnu4Tku7bliJfooajvvIjotbAgcXVlcnktbm9kZS10cmVl77yMMy44Ljgg55qEIHF1ZXJ5LW5vZGUg6L+U5ZueIG51bGzvvIkgKi9cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlOb2RlQ29tcG9uZW50cyhub2RlVXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnlbXT4ge1xyXG4gICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xyXG4gICAgY29uc3QgZm91bmQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlVXVpZCk7XHJcbiAgICByZXR1cm4gcmVhZE5vZGVDb21wb25lbnRzKGZvdW5kKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOaKiue7hOS7tuagh+ivhu+8iGNjLlh4eCAvIFh4eCAvIOeUqOaIt+iEmuacrCBjaWTvvInlsZXlvIDmiJDlj6/kuI7lnLrmma/moJHnu4Tku7bliJfooajmr5Tlr7nnmoTlgJnpgInlkI3jgIJcclxuICog5Zy65pmv5qCR6YeMIDMuOC44IOeahCBjb21wb25lbnRzW10udHlwZe+8muWGhee9rue7hOS7tuaYryBcImNjLlVJVHJhbnNmb3JtXCLvvIznlKjmiLfohJrmnKzmmK/nsbvlkI0gXCJTY3JlZW5GaWxsXCLjgIJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDb21wb25lbnRDYW5kaWRhdGVzKGNvbXBvbmVudDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xyXG4gICAgY29uc3QgcmF3ID0gU3RyaW5nKGNvbXBvbmVudCB8fCAnJykudHJpbSgpO1xyXG4gICAgaWYgKCFyYXcpIHJldHVybiBbXTtcclxuICAgIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW3Jhd107XHJcblxyXG4gICAgbGV0IGxpc3Q6IGFueVtdID0gW107XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGxpc3QgPSAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKSkgfHwgW107XHJcbiAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgbGlzdCA9IFtdO1xyXG4gICAgfVxyXG4gICAgLy8g55So5oi36ISa5pys5oyJIGNpZCDlj43mn6XnsbvlkI1cclxuICAgIGNvbnN0IGJ5Q2lkID0gbGlzdC5maW5kKChpdGVtOiBhbnkpID0+IGl0ZW0gJiYgaXRlbS5jaWQgPT09IHJhdyk7XHJcbiAgICBpZiAoYnlDaWQgJiYgYnlDaWQubmFtZSkgY2FuZGlkYXRlcy5wdXNoKFN0cmluZyhieUNpZC5uYW1lKSk7XHJcbiAgICAvLyDmjInnsbvlkI3lj43mn6UgY2lkXHJcbiAgICBjb25zdCBieU5hbWUgPSBsaXN0LmZpbmQoKGl0ZW06IGFueSkgPT4gaXRlbSAmJiBpdGVtLm5hbWUgPT09IHJhdyk7XHJcbiAgICBpZiAoYnlOYW1lKSB7XHJcbiAgICAgICAgaWYgKGJ5TmFtZS5uYW1lKSBjYW5kaWRhdGVzLnB1c2goU3RyaW5nKGJ5TmFtZS5uYW1lKSk7XHJcbiAgICAgICAgaWYgKGJ5TmFtZS5jaWQpIGNhbmRpZGF0ZXMucHVzaChTdHJpbmcoYnlOYW1lLmNpZCkpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChyYXcuc3RhcnRzV2l0aCgnY2MuJykpIGNhbmRpZGF0ZXMucHVzaChyYXcuc2xpY2UoMykpO1xyXG4gICAgZWxzZSBpZiAoIXJhdy5pbmNsdWRlcygnLicpKSBjYW5kaWRhdGVzLnB1c2goYGNjLiR7cmF3fWApO1xyXG5cclxuICAgIHJldHVybiBBcnJheS5mcm9tKG5ldyBTZXQoY2FuZGlkYXRlcy5maWx0ZXIoQm9vbGVhbikpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOWcqOe7hOS7tuWIl+ihqOmHjOaJvuW3suWtmOWcqOeahOebruagh+e7hOS7tuOAglxyXG4gKiBDb2NvcyDkuI3lhYHorrjlkIzkuIDoioLngrnmjILlkIznsbvlnovnu4Tku7bvvIzph43lpI0gYWRkIOS8muiiq+e8lui+keWZqOaLkue7neW5tuaJk+WNsFxyXG4gKiBcIltTY2VuZV0gQ2FuJ3QgYWRkIGNvbXBvbmVudCAnY2MuVUlUcmFuc2Zvcm0nIGJlY2F1c2UgWCBhbHJlYWR5IGNvbnRhaW5zIHRoZSBzYW1lIGNvbXBvbmVudC5cIlxyXG4gKi9cclxuZnVuY3Rpb24gbWF0Y2hFeGlzdGluZ0NvbXBvbmVudChjb21wczogYW55W10sIGNhbmRpZGF0ZXM6IHN0cmluZ1tdKTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAoIWNvbXBzIHx8ICFjb21wcy5sZW5ndGggfHwgIWNhbmRpZGF0ZXMgfHwgIWNhbmRpZGF0ZXMubGVuZ3RoKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiAoXHJcbiAgICAgICAgY29tcHMuZmluZCgoY29tcDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBTdHJpbmcoY29tcD8udHlwZSB8fCAnJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBTdHJpbmcoY29tcD8ubmFtZSB8fCAnJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IHV1aWQgPSBTdHJpbmcoY29tcD8udXVpZCB8fCAnJyk7XHJcbiAgICAgICAgICAgIHJldHVybiBjYW5kaWRhdGVzLnNvbWUoKGMpID0+IGMgPT09IHR5cGUgfHwgYyA9PT0gbmFtZSB8fCBjID09PSB1dWlkKTtcclxuICAgICAgICB9KSB8fCBudWxsXHJcbiAgICApO1xyXG59XHJcblxyXG4vKiog5oqKIHF1ZXJ5LW5vZGUtdHJlZSDov5Tlm57nmoToioLngrnmoJHovazmiJDlj6/or7vmlofmnKwgKi9cclxuZnVuY3Rpb24gZm9ybWF0Tm9kZVRyZWUobm9kZTogYW55LCBkZXB0aCA9IDApOiBzdHJpbmcge1xyXG4gICAgaWYgKCFub2RlKSByZXR1cm4gJyc7XHJcbiAgICBjb25zdCBuYW1lID0gZHVtcFZhbHVlPHN0cmluZz4obm9kZS5uYW1lLCAnKOacquWRveWQjSknKTtcclxuICAgIGNvbnN0IHV1aWQgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLnV1aWQsICcnKTtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGR1bXBWYWx1ZTxib29sZWFuPihub2RlLmFjdGl2ZSwgdHJ1ZSk7XHJcbiAgICBjb25zdCBjb21wczogc3RyaW5nW10gPSByZWFkTm9kZUNvbXBvbmVudHMobm9kZSkubWFwKChjb21wOiBhbnkpID0+IGNvbXAudHlwZSB8fCBjb21wLm5hbWUpLmZpbHRlcihCb29sZWFuKTtcclxuXHJcbiAgICBjb25zdCBpbmRlbnQgPSAnICAnLnJlcGVhdChkZXB0aCk7XHJcbiAgICBsZXQgbGluZSA9IGAke2luZGVudH0tICR7bmFtZX0ke2FjdGl2ZSA/ICcnIDogJyBbaW5hY3RpdmVdJ31gO1xyXG4gICAgaWYgKHV1aWQpIGxpbmUgKz0gYCAgPCR7dXVpZH0+YDtcclxuICAgIGlmIChjb21wcy5sZW5ndGgpIGxpbmUgKz0gYCAgWyR7Y29tcHMuam9pbignLCAnKX1dYDtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gZHVtcFZhbHVlPGFueT4obm9kZS5wb3NpdGlvbiwgbnVsbCk7XHJcbiAgICBpZiAocG9zaXRpb24gJiYgdHlwZW9mIHBvc2l0aW9uID09PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIGxpbmUgKz0gYCAgKCR7cG9zaXRpb24ueCA/PyAwfSwgJHtwb3NpdGlvbi55ID8/IDB9LCAke3Bvc2l0aW9uLnogPz8gMH0pYDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSBBcnJheS5pc0FycmF5KG5vZGUuY2hpbGRyZW4pID8gbm9kZS5jaGlsZHJlbiA6IFtdO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IHRleHQgPSBmb3JtYXROb2RlVHJlZShjaGlsZCwgZGVwdGggKyAxKTtcclxuICAgICAgICBpZiAodGV4dCkgbGluZSArPSBgXFxuJHt0ZXh0fWA7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGluZTtcclxufVxyXG5cclxuLyoqIOe7n+iuoeiKgueCueaVsOmHj++8iOWQq+ague+8iSAqL1xyXG5mdW5jdGlvbiBjb3VudE5vZGVzKG5vZGU6IGFueSk6IG51bWJlciB7XHJcbiAgICBpZiAoIW5vZGUpIHJldHVybiAwO1xyXG4gICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gQXJyYXkuaXNBcnJheShub2RlLmNoaWxkcmVuKSA/IG5vZGUuY2hpbGRyZW4gOiBbXTtcclxuICAgIHJldHVybiAxICsgY2hpbGRyZW4ucmVkdWNlKChzdW06IG51bWJlciwgY2hpbGQ6IGFueSkgPT4gc3VtICsgY291bnROb2RlcyhjaGlsZCksIDApO1xyXG59XHJcblxyXG4vKiog56m655qE5Y+C5pWwIHNjaGVtYSAqL1xyXG5mdW5jdGlvbiBub1BhcmFtcygpOiBKc29uU2NoZW1hIHtcclxuICAgIHJldHVybiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSwgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH07XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5pON5L2c5a6a5LmJXHJcblxyXG5jb25zdCBlZGl0b3JJbmZvOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ2VkaXRvci5pbmZvJyxcclxuICAgIHRpdGxlOiAn57yW6L6R5ZmoIC8g6aG555uu5L+h5oGvJyxcclxuICAgIGRlc2NyaXB0aW9uOiAn5omT5Y2w5b2T5YmNIENyZWF0b3Ig54mI5pys44CB6aG555uu6Lev5b6E44CB5omp5bGV6Ieq6Lqr5L+h5oGvJyxcclxuICAgIHBhcmFtczoge30sXHJcbiAgICBzY2hlbWE6IG5vUGFyYW1zKCksXHJcbiAgICBhc3luYyBydW4oKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgYnVpbGQ6IE1BSU5fQlVJTEQsXHJcbiAgICAgICAgICAgIGVkaXRvck5hbWU6IEVkaXRvci5BcHAubmFtZSxcclxuICAgICAgICAgICAgZWRpdG9yVmVyc2lvbjogRWRpdG9yLkFwcC52ZXJzaW9uLFxyXG4gICAgICAgICAgICBlZGl0b3JQYXRoOiBFZGl0b3IuQXBwLnBhdGgsXHJcbiAgICAgICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgICAgICBleHRlbnNpb25OYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBleHRlbnNpb25WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgICAgICBub2RlVmVyc2lvbjogcHJvY2Vzcy52ZXJzaW9uLFxyXG4gICAgICAgICAgICBwbGF0Zm9ybTogYCR7cHJvY2Vzcy5wbGF0Zm9ybX0gJHtwcm9jZXNzLmFyY2h9YCxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbmNvbnN0IHNjZW5lU3RhdHVzOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ3NjZW5lLnN0YXR1cycsXHJcbiAgICB0aXRsZTogJ+W9k+WJjeWcuuaZr+eKtuaAgScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+WcuuaZr+aYr+WQpuWwsee7qiAvIOaYr+WQpuacieacquS/neWtmOaUueWKqCAvIOagueiKgueCuSAvIOmAieS4reiKgueCuScsXHJcbiAgICBwYXJhbXM6IHt9LFxyXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxyXG4gICAgYXN5bmMgcnVuKCkge1xyXG4gICAgICAgIGNvbnN0IGlzUmVhZHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktaXMtcmVhZHknKTtcclxuICAgICAgICBjb25zdCBpc0RpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWRpcnR5Jyk7XHJcbiAgICAgICAgY29uc3QgdHJlZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpc1JlYWR5LFxyXG4gICAgICAgICAgICBpc0RpcnR5LFxyXG4gICAgICAgICAgICBzY2VuZU5hbWU6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/Lm5hbWUsICco5pyq5ZG95ZCN5Zy65pmvKScpLFxyXG4gICAgICAgICAgICBzY2VuZVV1aWQ6IGR1bXBWYWx1ZTxzdHJpbmc+KHRyZWU/LnV1aWQsICcnKSxcclxuICAgICAgICAgICAgbm9kZUNvdW50OiBNYXRoLm1heCgwLCBjb3VudE5vZGVzKHRyZWUpIC0gMSksXHJcbiAgICAgICAgICAgIHNlbGVjdGVkTm9kZXM6IGdldFNlbGVjdGVkTm9kZVV1aWRzKCksXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBzY2VuZVRyZWU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnc2NlbmUudHJlZScsXHJcbiAgICB0aXRsZTogJ+WcuuaZr+iKgueCueagkScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+ivu+WPluW9k+WJjeWcuuaZr+eahOWujOaVtOiKgueCueagke+8iOiKgueCueWQjSAvIHV1aWQgLyDnu4Tku7YgLyDlnZDmoIfvvIknLFxyXG4gICAgcGFyYW1zOiB7fSxcclxuICAgIHNjaGVtYTogbm9QYXJhbXMoKSxcclxuICAgIGFzeW5jIHJ1bigpIHtcclxuICAgICAgICBjb25zdCB0cmVlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHNjZW5lTmFtZTogZHVtcFZhbHVlPHN0cmluZz4odHJlZT8ubmFtZSwgJyjmnKrlkb3lkI3lnLrmma8pJyksXHJcbiAgICAgICAgICAgIHNjZW5lVXVpZDogZHVtcFZhbHVlPHN0cmluZz4odHJlZT8udXVpZCwgJycpLFxyXG4gICAgICAgICAgICBub2RlQ291bnQ6IE1hdGgubWF4KDAsIGNvdW50Tm9kZXModHJlZSkgLSAxKSxcclxuICAgICAgICAgICAgdHJlZTogZm9ybWF0Tm9kZVRyZWUodHJlZSksXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG4vKipcclxuICog5oqKIGJ1aWx0aW4g55+t5ZCNIC8gcHJlZmFiIOW8leeUqOe7n+S4gOino+aekOaIkOWPr+WunuS+i+WMlueahCBwcmVmYWIg6LWE5Lqn44CCXHJcbiAqIC0gYnVpbHRpbu+8mmRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvPOefreWQjT4ucHJlZmFi77yM5Y2z57yW6L6R5Zmo44CM5Yib5bu644CN6I+c5Y2V5ZCM5qy+5YaF572u5qih5p2/XHJcbiAqIC0gcHJlZmFi77yaZGI6Ly8gdXJsIOaIliB1dWlk77yM5Lu75oSPIHByZWZhYiDotYTkuqfvvIjlkKvpobnnm67oh6rlt7HnmoTpooTliLbkvZPvvIlcclxuICog5Lik6ICF6YO95Li656m66L+U5ZueIG51bGzvvIg9IOaZrumAmuepuuiKgueCueaooeW8j++8ieOAglxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVByZWZhYkFzc2V0KGJ1aWx0aW46IHN0cmluZywgcHJlZmFiOiBzdHJpbmcpOiBQcm9taXNlPHsgdXVpZDogc3RyaW5nOyB1cmw6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0gfCBudWxsPiB7XHJcbiAgICBpZiAoYnVpbHRpbiAmJiBwcmVmYWIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2J1aWx0aW4g5LiOIHByZWZhYiDlj6rog73kuozpgInkuIAnKTtcclxuICAgIH1cclxuICAgIGxldCB0YXJnZXQgPSAnJztcclxuICAgIGlmIChidWlsdGluKSB7XHJcbiAgICAgICAgY29uc3Qgc2hvcnQgPSBidWlsdGluLnRyaW0oKS5yZXBsYWNlKC9cXC5wcmVmYWIkL2ksICcnKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCAnJyk7XHJcbiAgICAgICAgdGFyZ2V0ID0gYGRiOi8vaW50ZXJuYWwvZGVmYXVsdF9wcmVmYWIvJHtzaG9ydH0ucHJlZmFiYDtcclxuICAgIH0gZWxzZSBpZiAocHJlZmFiKSB7XHJcbiAgICAgICAgdGFyZ2V0ID0gcHJlZmFiLnRyaW0oKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBsZXQgaW5mbzogYW55ID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgdGFyZ2V0KTtcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICBpbmZvID0gbnVsbDtcclxuICAgIH1cclxuICAgIGlmICghaW5mbyB8fCAhaW5mby51dWlkKSB7XHJcbiAgICAgICAgbGV0IGhpbnQgPSBidWlsdGluID8gJ++8m+WPr+eUqCBhc3NldF9saXN0KHBhdHRlcm49XCJkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyoqLyoucHJlZmFiXCIpIOafpeeci+WFqOmDqOWGhee9ruaooeadvycgOiAnJztcclxuICAgICAgICBpZiAoYnVpbHRpbikge1xyXG4gICAgICAgICAgICAvLyAzLjgg5YaF572u5qih5p2/57ud5aSn5aSa5pWw5ZyoIHVpL+OAgTNkL+OAgWxpZ2h0LyDlrZDnm67lvZXkuIvvvIzoo7jnn63lkI3ln7rmnKzkuI3lrZjlnKjvvJvmjqLmtYvlkb3kuK3ml7bnm7TmjqXnu5nlh7rmraPnoa7lhpnms5VcclxuICAgICAgICAgICAgY29uc3Qgc2hvcnQgPSBidWlsdGluLnRyaW0oKS5yZXBsYWNlKC9edWlcXC8vaSwgJycpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGRpciBvZiBbJ3VpJywgJzNkJywgJ2xpZ2h0J10pIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0LWluZm8nLCBgZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8ke2Rpcn0vJHtzaG9ydH0ucHJlZmFiYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFsdCAmJiBhbHQudXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoaW50ID0gYO+8m+ivpeaooeadv+WcqCAke2Rpcn0vIOWtkOebruW9leS4i++8jOato+ehruWGmeazleaYryBidWlsdGluPVwiJHtkaXJ9LyR7c2hvcnR9XCJgO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8g5o6i5rWL5aSx6LSl5LiN5b2x5ZON5Y6f5pys55qE5oql6ZSZXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLAgcHJlZmFiIOi1hOS6pzogJHt0YXJnZXR9JHtoaW50fWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8udHlwZSAmJiBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfotYTkuqfkuI3mmK8gcHJlZmFi77yIJHtpbmZvLnR5cGV977yJOiAke2luZm8udXJsIHx8IHRhcmdldH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHVybDogc3RyaW5nID0gaW5mby51cmwgfHwgdGFyZ2V0O1xyXG4gICAgcmV0dXJuIHsgdXVpZDogaW5mby51dWlkLCB1cmwsIG5hbWU6IGJhc2VuYW1lKHVybCkucmVwbGFjZSgvXFwucHJlZmFiJC9pLCAnJykgfTtcclxufVxyXG5cclxuY29uc3Qgbm9kZUNyZWF0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcclxuICAgIG5hbWU6ICdub2RlLmNyZWF0ZScsXHJcbiAgICB0aXRsZTogJ+WIm+W7uuiKgueCuScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9jcmVhdGUtbm9kZSDliJvlu7roioLngrnvvIzotbDnvJbovpHlmaggdW5kbyDkvZPns7vjgILkuInnp43nlKjms5XvvJoxKSDpu5jorqTlu7rnqbroioLngrnvvIjnvJbovpHlmajoh6rliqjpmYTliqAgY2MuVUlUcmFuc2Zvcm3vvIzli7/ph43lpI0gYWRkQ29tcG9uZW5077yJ77ybMikgYnVpbHRpbj3lhoXnva7mqKHmnb/nn63lkI3vvIzmmKDlsITliLAgZGI6Ly9pbnRlcm5hbC9kZWZhdWx0X3ByZWZhYi8855+t5ZCNPi5wcmVmYWLvvIzkuIDmraXlrp7kvovljJblrozmlbTmqKHmnb/vvIjlkKvlrZDoioLngrnkuI7pu5jorqTotYTmupDlvJXnlKjvvInvvJvluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDigJTigJRVSSDnlKggdWkvQnV0dG9u44CBdWkvTGFiZWzjgIF1aS9TcHJpdGXjgIF1aS9DYW52YXPjgIF1aS9MYXlvdXTjgIF1aS9TY3JvbGxWaWV3IOetie+8iOimgeaxguWcuuaZr+W3suaciSBDYW52YXPvvInvvIwzRCDnlKggM2QvQ3ViZeOAgTNkL1NwaGVyZe+8jOeBr+WFieeUqCBsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIzkvJrmiqXjgIzmib7kuI3liLAgcHJlZmFiIOi1hOS6p+OAje+8m+WFqOmHj+WIl+ihqOeUqCBhc3NldF9saXN0KHBhdHRlcm49XCJkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyoqLyoucHJlZmFiXCIpIOafpeivou+8mzMpIHByZWZhYj3ku7vmhI/pooTliLbkvZPvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzmiorlt7LmnIkgcHJlZmFiIOWunuS+i+WMlui/m+WcuuaZr+OAguazqOaEj++8mnBhcmVudCDlv4XpobvmmK/nnJ/lrp7oioLngrkgdXVpZO+8iOS4jeino+aekOi3r+W+hO+8ie+8jOW8leeUqOaXoOaViOaXtuiKgueCueS8muiiq+mdmem7mOW7uuWIsOWcuuaZr+ague+8iOS4jeaKpemUme+8ie+8jOaJuemHj+aQreW7uuWQjuW7uuiuruWuoeiuoeWcuuaZr+agueaYr+WQpuWHuueOsOWtpOWEv+iKgueCuScsXHJcbiAgICBwYXJhbXM6IHtcclxuICAgICAgICBuYW1lOiAn6IqC54K55ZCN77yM57y655yB5pe256m66IqC54K555SoIE1DUF9Ob2Rl44CB5qih5p2/5qih5byP55So5qih5p2/5ZCN77yI5bm25oyJ54i26IqC54K555Sf5oiQ5LiN6YeN5ZCN5ZCN5a2X77yJJyxcclxuICAgICAgICBwYXJlbnQ6ICfniLboioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8jOaXoOaViOaXtumdmem7mOW7uuWIsOWcuuaZr+ague+8ie+8m+eVmeepuuWImeW7uuWcqOWcuuaZr+agueS4i++8m+WhqyBAc2VsZWN0aW9uIOWImeW7uuWcqOW9k+WJjemAieS4reiKgueCueS4iycsXHJcbiAgICAgICAgYnVpbHRpbjogJ+WGhee9ruaooeadv+efreWQje+8jOaYoOWwhOWIsCBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLzxidWlsdGluPi5wcmVmYWLvvJvluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDvvJp1aS9CdXR0b27jgIF1aS9MYWJlbOOAgXVpL1Nwcml0ZeOAgXVpL0NhbnZhc+OAgXVpL0xheW91dOOAgXVpL1Njcm9sbFZpZXfjgIEzZC9DdWJl44CBM2QvU3BoZXJl44CBbGlnaHQvUG9pbnQgTGlnaHTvvJvoo7jnn63lkI0gQnV0dG9u44CBTGFiZWzjgIFTcHJpdGUg5LiN5a2Y5Zyo77yI6aG75YaZIHVpL0J1dHRvbiDnrYnvvInvvJvkuI4gcHJlZmFiIOS6jOmAieS4gO+8m+WFqOmbhueUqCBhc3NldF9saXN0KHBhdHRlcm49XCJkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLyoqLyoucHJlZmFiXCIpIOafpScsXHJcbiAgICAgICAgcHJlZmFiOiAn5Lu75oSPIHByZWZhYiDotYTkuqfvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzlrp7kvovljJbov5vlnLrmma/vvIzkuI4gYnVpbHRpbiDkuozpgInkuIAnLFxyXG4gICAgfSxcclxuICAgIHNjaGVtYToge1xyXG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrnlkI0nIH0sXHJcbiAgICAgICAgICAgIHBhcmVudDoge1xyXG4gICAgICAgICAgICAgICAgdHlwZTogJ3N0cmluZycsXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+eItuiKgueCuSB1dWlk77yI5LiN5pSv5oyB6Lev5b6E77yM5peg5pWI5pe26Z2Z6buY5bu65Yiw5Zy65pmv5qC577yJ77yb55WZ56m65YiZ5bu65Zyo5Zy65pmv5qC55LiL77yb5aGrIEBzZWxlY3Rpb24g5YiZ5bu65Zyo5b2T5YmN6YCJ5Lit6IqC54K55LiLJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgYnVpbHRpbjoge1xyXG4gICAgICAgICAgICAgICAgdHlwZTogJ3N0cmluZycsXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+WGhee9ruaooeadv+efreWQje+8jOaYoOWwhOWIsCBkYjovL2ludGVybmFsL2RlZmF1bHRfcHJlZmFiLzxidWlsdGluPi5wcmVmYWLvvIzluLjnlKjmqKHmnb/pg73luKblrZDnm67lvZXliY3nvIDvvJp1aS9CdXR0b27jgIF1aS9MYWJlbOOAgXVpL1Nwcml0ZeOAgXVpL0NhbnZhc+OAgXVpL0xheW91dOOAgTNkL0N1YmXjgIFsaWdodC9Qb2ludCBMaWdodO+8m+ijuOefreWQjSBCdXR0b27jgIFMYWJlbOOAgVNwcml0ZSDkuI3lrZjlnKjvvIjpobvlhpkgdWkvQnV0dG9uIOetie+8ie+8m+S4jiBwcmVmYWIg5LqM6YCJ5LiAJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgcHJlZmFiOiB7XHJcbiAgICAgICAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcclxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiAn5Lu75oSPIHByZWZhYiDotYTkuqfvvIhkYjovLyB1cmwg5oiWIHV1aWTvvInvvIzlrp7kvovljJbov5vlnLrmma/vvIzkuI4gYnVpbHRpbiDkuozpgInkuIAnLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBjb25zdCBidWlsdGluID0gcGlja1N0cmluZyhwYXJhbXMsICdidWlsdGluJywgJycpLnRyaW0oKTtcclxuICAgICAgICBjb25zdCBwcmVmYWIgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3ByZWZhYicsICcnKS50cmltKCk7XHJcbiAgICAgICAgY29uc3QgcmF3UGFyZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdwYXJlbnQnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGxldCBwYXJlbnQgPSAnJztcclxuICAgICAgICBsZXQgcGFyZW50U291cmNlID0gJ3NjZW5lLXJvb3QnO1xyXG5cclxuICAgICAgICBpZiAocmF3UGFyZW50ID09PSAnQHNlbGVjdGlvbicpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xyXG4gICAgICAgICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdwYXJlbnQg5oyH5a6a5Li6IEBzZWxlY3Rpb27vvIzkvYblvZPliY3msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwYXJlbnQgPSBzZWxlY3RlZFswXTtcclxuICAgICAgICAgICAgcGFyZW50U291cmNlID0gJ3NlbGVjdGlvbic7XHJcbiAgICAgICAgfSBlbHNlIGlmIChyYXdQYXJlbnQpIHtcclxuICAgICAgICAgICAgcGFyZW50ID0gcmF3UGFyZW50O1xyXG4gICAgICAgICAgICBwYXJlbnRTb3VyY2UgPSAncGFyYW1zJztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHRlbXBsYXRlID0gYXdhaXQgcmVzb2x2ZVByZWZhYkFzc2V0KGJ1aWx0aW4sIHByZWZhYik7XHJcblxyXG4gICAgICAgIGNvbnN0IHJhd05hbWUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25hbWUnLCAnJyk7XHJcbiAgICAgICAgbGV0IG5hbWUgPSByYXdOYW1lIHx8ICh0ZW1wbGF0ZSA/IHRlbXBsYXRlLm5hbWUgOiAnJykgfHwgJ01DUF9Ob2RlJztcclxuICAgICAgICAvLyDkuI7nvJbovpHlmajoj5zljZXkuIDoh7TvvJrmqKHmnb/mqKHlvI/kuIvmjInniLboioLngrnnlJ/miJDkuI3ph43lkI3nmoTlkI3lrZdcclxuICAgICAgICBpZiAodGVtcGxhdGUgJiYgIXJhd05hbWUgJiYgcGFyZW50KSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZ2VuZXJhdGUtYXZhaWxhYmxlLW5hbWUnLCBuYW1lLCBwYXJlbnQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBhdmFpbGFibGUgPT09ICdzdHJpbmcnICYmIGF2YWlsYWJsZSkgbmFtZSA9IGF2YWlsYWJsZTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgLy8g6K+l5raI5oGv5LiN5Y+v55So5pe25L+d5oyB5Y6f5ZCN77yM6YeN5ZCN5LiN5b2x5ZON5Yib5bu6XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG9wdGlvbnM6IGFueSA9IHsgbmFtZSB9O1xyXG4gICAgICAgIGlmIChwYXJlbnQpIG9wdGlvbnMucGFyZW50ID0gcGFyZW50O1xyXG4gICAgICAgIGlmICh0ZW1wbGF0ZSkge1xyXG4gICAgICAgICAgICBvcHRpb25zLmFzc2V0VXVpZCA9IHRlbXBsYXRlLnV1aWQ7XHJcbiAgICAgICAgICAgIG9wdGlvbnMuc25hcHNob3QgPSB0cnVlO1xyXG4gICAgICAgICAgICAvLyDkuI7nvJbovpHlmajoj5zljZXkuIDoh7TvvJpVSSDmqKHmnb/opoHmsYLlnLrmma/ph4zmnIkgQ2FudmFz77yIQ2FudmFzIOaooeadv+acrOi6q+mZpOWklu+8iVxyXG4gICAgICAgICAgICBpZiAoYnVpbHRpbi50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ3VpLycpICYmIHRlbXBsYXRlLm5hbWUudG9Mb3dlckNhc2UoKSAhPT0gJ2NhbnZhcycpIHtcclxuICAgICAgICAgICAgICAgIG9wdGlvbnMuY2FudmFzUmVxdWlyZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgdXVpZCA9ICcnO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHV1aWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnY3JlYXRlLW5vZGUnLCBvcHRpb25zKTtcclxuICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcclxuICAgICAgICAgICAgY29uc3QgaGludCA9IG9wdGlvbnMuY2FudmFzUmVxdWlyZWRcclxuICAgICAgICAgICAgICAgID8gJ++8m3VpLyog5qih5p2/6KaB5rGC5Zy65pmv5YWI5pyJIENhbnZhc++8jOWPr+WFiCBub2RlX2NyZWF0ZShidWlsdGluPVwiQ2FudmFzXCIpJ1xyXG4gICAgICAgICAgICAgICAgOiAnJztcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtbm9kZSDlpLHotKU6ICR7ZT8ubWVzc2FnZSB8fCBlfSR7aGludH1gKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIOS4gOasoSBxdWVyeS1ub2RlLXRyZWUg5ZCM5pe25Zue6K+757uE5Lu25YiX6KGo77yI56m66IqC54K55qih5byP55qEIGNjLlVJVHJhbnNmb3JtIOaPkOekuu+8ieS4juaooeadv+WtkOagkVxyXG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmROb2RlSW5UcmVlKHRyZWUsIHV1aWQpO1xyXG4gICAgICAgIGNvbnN0IGNvbXBzID0gcmVhZE5vZGVDb21wb25lbnRzKGZvdW5kKTtcclxuICAgICAgICBjb25zdCBoYXNVSVRyYW5zZm9ybSA9IGNvbXBzLnNvbWUoKGM6IGFueSkgPT4gYy50eXBlID09PSAnY2MuVUlUcmFuc2Zvcm0nKTtcclxuICAgICAgICBjb25zdCByZXN1bHQ6IGFueSA9IHsgdXVpZCwgbmFtZSwgcGFyZW50OiBwYXJlbnQgfHwgbnVsbCwgcGFyZW50U291cmNlLCBjb21wb25lbnRzOiBjb21wcywgaGFzVUlUcmFuc2Zvcm0gfTtcclxuICAgICAgICBpZiAodGVtcGxhdGUpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNvdXJjZSA9IGJ1aWx0aW4gPyAnYnVpbHRpbi10ZW1wbGF0ZScgOiAncHJlZmFiJztcclxuICAgICAgICAgICAgcmVzdWx0LnRlbXBsYXRlID0gdGVtcGxhdGUudXJsO1xyXG4gICAgICAgICAgICByZXN1bHQudGVtcGxhdGVVdWlkID0gdGVtcGxhdGUudXVpZDtcclxuICAgICAgICAgICAgcmVzdWx0Lm5vZGVDb3VudCA9IGNvdW50Tm9kZXMoZm91bmQpO1xyXG4gICAgICAgICAgICByZXN1bHQuc3VidHJlZSA9IGZvcm1hdE5vZGVUcmVlKGZvdW5kKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBub2RlRGVsZXRlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUuZGVsZXRlJyxcclxuICAgIHRpdGxlOiAn5Yig6Zmk6IqC54K5JyxcclxuICAgIGRlc2NyaXB0aW9uOiAn6YCa6L+HIHNjZW5lL3JlbW92ZS1ub2RlIOWIoOmZpOiKgueCue+8jOm7mOiupOWIoOmZpOWxgue6p+euoeeQhuWZqOS4remAieS4reeahOiKgueCuScsXHJcbiAgICBwYXJhbXM6IHtcclxuICAgICAgICB1dWlkOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnliKDpmaTlvZPliY3pgInkuK3oioLngrknLFxyXG4gICAgfSxcclxuICAgIHNjaGVtYToge1xyXG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeWIoOmZpOW9k+WJjemAieS4reiKgueCuScgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgcmF3ID0gcGlja1N0cmluZyhwYXJhbXMsICd1dWlkJywgJycpO1xyXG4gICAgICAgIGxldCBsaXN0OiBzdHJpbmdbXSA9IHJhdy5zcGxpdCgnLCcpLm1hcCgoaXRlbSkgPT4gaXRlbS50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcclxuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XHJcbiAgICAgICAgaWYgKCFsaXN0Lmxlbmd0aCkge1xyXG4gICAgICAgICAgICBsaXN0ID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcclxuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghbGlzdC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrproioLngrnvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3JlbW92ZS1ub2RlJywgeyB1dWlkOiBsaXN0Lmxlbmd0aCA9PT0gMSA/IGxpc3RbMF0gOiBsaXN0IH0pO1xyXG4gICAgICAgIHJldHVybiB7IHJlbW92ZWQ6IGxpc3QsIHNvdXJjZSB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbmNvbnN0IG5vZGVNb3ZlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUubW92ZScsXHJcbiAgICB0aXRsZTogJ+enu+WKqOiKgueCue+8iOa2iOaBr+mAmumBk++8iScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9zZXQtcHJvcGVydHkg5L+u5pS56IqC54K5IHBvc2l0aW9u77yI6LWw57yW6L6R5ZmoIHVuZG8g5L2T57O777yJJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXHJcbiAgICAgICAgeDogJ3gg5Z2Q5qCHJyxcclxuICAgICAgICB5OiAneSDlnZDmoIcnLFxyXG4gICAgICAgIHo6ICd6IOWdkOaghycsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxyXG4gICAgICAgICAgICB4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3gg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB5OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3kg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBsZXQgdXVpZCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXVpZCcsICcnKTtcclxuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XHJcbiAgICAgICAgaWYgKCF1dWlkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcclxuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xyXG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCF1dWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xyXG4gICAgICAgICAgICB4OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3gnLCAwKSxcclxuICAgICAgICAgICAgeTogcGlja051bWJlcihwYXJhbXMsICd5JywgMCksXHJcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3Qgb2sgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnc2V0LXByb3BlcnR5Jywge1xyXG4gICAgICAgICAgICB1dWlkLFxyXG4gICAgICAgICAgICBwYXRoOiAncG9zaXRpb24nLFxyXG4gICAgICAgICAgICBkdW1wOiB7IHZhbHVlOiBwb3NpdGlvbiB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgcGF0aDogJ3Bvc2l0aW9uJywgcG9zaXRpb24sIGFwcGxpZWQ6IG9rIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3Qgbm9kZU1vdmVFbmdpbmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5tb3ZlLmVuZ2luZScsXHJcbiAgICB0aXRsZTogJ+enu+WKqOiKgueCue+8iOW8leaTjumAmumBk++8iScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/h+WcuuaZr+iEmuacrOebtOaOpeiwg+eUqOW8leaTjiBBUEkg6K6+572uIHBvc2l0aW9u77yI5LiN6L+bIHVuZG8g5L2T57O777yJJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXHJcbiAgICAgICAgeDogJ3gg5Z2Q5qCHJyxcclxuICAgICAgICB5OiAneSDlnZDmoIcnLFxyXG4gICAgICAgIHo6ICd6IOWdkOaghycsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxyXG4gICAgICAgICAgICB4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3gg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB5OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3kg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBsZXQgdXVpZCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXVpZCcsICcnKTtcclxuICAgICAgICBsZXQgc291cmNlID0gJ3BhcmFtcyc7XHJcbiAgICAgICAgaWYgKCF1dWlkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKTtcclxuICAgICAgICAgICAgdXVpZCA9IHNlbGVjdGVkWzBdIHx8ICcnO1xyXG4gICAgICAgICAgICBzb3VyY2UgPSAnc2VsZWN0aW9uJztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCF1dWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xyXG4gICAgICAgICAgICB4OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3gnLCAwKSxcclxuICAgICAgICAgICAgeTogcGlja051bWJlcihwYXJhbXMsICd5JywgMCksXHJcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdtb3ZlTm9kZScsXHJcbiAgICAgICAgICAgIGFyZ3M6IFt1dWlkLCBwb3NpdGlvbl0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmV0dXJuIHsgdXVpZCwgc291cmNlLCBwb3NpdGlvbiwgc2NyaXB0UmVzdWx0OiByZXN1bHQgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBub2RlU2V0UHJvcGVydHk6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5zZXRQcm9wZXJ0eScsXHJcbiAgICB0aXRsZTogJ+iuvue9ruWxnuaAp++8iOa2iOaBr+mAmumBk++8iScsXHJcbiAgICBkZXNjcmlwdGlvbjpcclxuICAgICAgICAn6YCa6L+HIHNjZW5lL3NldC1wcm9wZXJ0eSDorr7nva7oioLngrnmiJbnu4Tku7blsZ7mgKfvvIjotbDnvJbovpHlmaggdW5kbyDkvZPns7vvvInjgIInICtcclxuICAgICAgICAn5rOo5oSP77yadXVpZCDlv4XpobvmmK/nnJ/lrp7oioLngrkgdXVpZO+8jOacrOaTjeS9nOS4jeino+aekOiKgueCuei3r+W+hO+8iOS8oOi3r+W+hOS8mumdmem7mOaXoOaViO+8ie+8mycgK1xyXG4gICAgICAgICflpJrnu4Tku7boioLngrnorr4gY29udGVudFNpemUg5Zyo5pys6YCa6YGT5Lya6Z2Z6buY5aSx6LSl77yM5pS555SoIG5vZGVfc2V0X3Byb3BlcnR5X2VuZ2luZe+8iHtcIl9fc2l6ZVwiOlt3LGhdfe+8jOW4piBhcHBsaWVkIOWbnuivu++8ieOAgicgK1xyXG4gICAgICAgICdwYXRoIOWGmeazle+8muiKgueCueWxnuaAp+ebtOaOpeWGmeWQjeWtl++8iHBvc2l0aW9uIC8gbmFtZSAvIGFjdGl2Ze+8ie+8m+e7hOS7tuWxnuaAp+WGmSBjb21wb25lbnRzLjzntKLlvJU+LjzlsZ7mgKc+77yMJyArXHJcbiAgICAgICAgJ+e0ouW8leeUqCBub2RlX2xpc3RfY29tcG9uZW50cyDmn6XvvIjlpoIgY29tcG9uZW50cy4wLnN0cmluZ+OAgWNvbXBvbmVudHMuMi5jb250ZW50U2l6Ze+8ieOAgicgK1xyXG4gICAgICAgICd2YWx1ZSDmmK/nuq8gSlNPTu+8m+e7k+aehOWMluWAvO+8iHt4LHksen0ve3dpZHRoLGhlaWdodH0ve3IsZyxiLGF977yJ5Lya6Ieq5Yqo6K+G5Yir5oiQIGNjLlZlYzMvY2MuU2l6ZS9jYy5Db2xvcuOAgicgK1xyXG4gICAgICAgICflvJXnlKjnsbvlnovlsZ7mgKfvvIhAcHJvcGVydHkoTGFiZWwpIOS5i+exu++8ieS8oCB0eXBlPWNjLkxhYmVs44CBdmFsdWU9e1widXVpZFwiOlwi55uu5qCH57uE5Lu25oiW6IqC54K5dXVpZFwife+8mycgK1xyXG4gICAgICAgICflvJXnlKjnu5HlrprkvJjlhYjnlKggbm9kZV9iaW5kX3Byb3BlcnR577yI6Ieq5Yqo5a6a5L2N57uE5Lu2L+ino+aekOebruaghy/mibnph48v5Zue6K+76aqM6K+B77yJ44CCJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8iOS4jeaUr+aMgei3r+W+hO+8ie+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXHJcbiAgICAgICAgcGF0aDogJ+WxnuaAp+i3r+W+hO+8jOWmgiBwb3NpdGlvbuOAgWNvbXBvbmVudHMuMC5zdHJpbmcnLFxyXG4gICAgICAgIHZhbHVlOiAn5bGe5oCn5YC877yI57qvIEpTT07vvIknLFxyXG4gICAgICAgIHR5cGU6ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8iGNjLlZlYzMvY2MuU2l6ZS9jYy5Db2xvci9jYy5MYWJlbC9jYy5Ob2Rl4oCm77yJ77yM5LiN5Lyg5pe25oyJIHZhbHVlIOW9oueKtuiHquWKqOivhuWIqycsXHJcbiAgICAgICAgZHVtcDogJ+WPr+mAieOAguWujOaVtCBkdW1wIOWvueixoe+8m+S8oOWFpeWQjuW/veeVpSB2YWx1ZS90eXBl77yM55So5LqO5YWc5bqV54m55q6K5qC85byPJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIjkuI3mlK/mjIHot6/lvoTvvInvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXHJcbiAgICAgICAgICAgIHBhdGg6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn6Lev5b6E77yM5aaCIHBvc2l0aW9u44CBY29tcG9uZW50cy4wLnN0cmluZycgfSxcclxuICAgICAgICAgICAgdmFsdWU6IHsgZGVzY3JpcHRpb246ICflsZ7mgKflgLwnIH0sXHJcbiAgICAgICAgICAgIHR5cGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnZHVtcCDnsbvlnovlkI3vvIjlj6/pgInvvIknIH0sXHJcbiAgICAgICAgICAgIGR1bXA6IHsgdHlwZTogJ29iamVjdCcsIGRlc2NyaXB0aW9uOiAn5a6M5pW0IGR1bXAg5a+56LGh77yI5Y+v6YCJ77yM5YWc5bqV55So77yJJyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgcmVxdWlyZWQ6IFsncGF0aCddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XHJcbiAgICAgICAgbGV0IHNvdXJjZSA9ICdwYXJhbXMnO1xyXG4gICAgICAgIGlmICghdXVpZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XHJcbiAgICAgICAgICAgIHV1aWQgPSBzZWxlY3RlZFswXSB8fCAnJztcclxuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghdXVpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXRoID0gcGlja1N0cmluZyhwYXJhbXMsICdwYXRoJywgJycpLnRyaW0oKTtcclxuICAgICAgICBpZiAoIXBhdGgpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflv4XpobvmjIflrpogcGF0aO+8jOWmgiBwb3NpdGlvbiDmiJYgY29tcG9uZW50cy4wLnN0cmluZycpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGR1bXA6IGFueTtcclxuICAgICAgICBpZiAocGFyYW1zPy5kdW1wICYmIHR5cGVvZiBwYXJhbXMuZHVtcCA9PT0gJ29iamVjdCcpIHtcclxuICAgICAgICAgICAgZHVtcCA9IHBhcmFtcy5kdW1wO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4cGxpY2l0VHlwZSA9IHBpY2tTdHJpbmcocGFyYW1zLCAndHlwZScsICcnKS50cmltKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gcGFyYW1zPy52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGV4cGxpY2l0VHlwZSB8fCBndWVzc0R1bXBUeXBlKHZhbHVlKTtcclxuICAgICAgICAgICAgZHVtcCA9IHR5cGUgPyB7IHR5cGUsIHZhbHVlIH0gOiB7IHZhbHVlIH07XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnc2V0LXByb3BlcnR5JywgeyB1dWlkLCBwYXRoLCBkdW1wIH0pO1xyXG4gICAgICAgIHJldHVybiB7IHV1aWQsIHNvdXJjZSwgcGF0aCwgZHVtcCwgYXBwbGllZDogdHJ1ZSB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbi8qKiDmjIkgdmFsdWUg55qE5b2i54q254yc5rWLIGR1bXAg57G75Z6L77yI5Y+q6K6k5pyA5YW45Z6L55qE5LiJ56eN77yM6K+G5Yir5LiN5LqG5bCx6L+U5Zue56m66LWw6KO4IHt2YWx1ZX3vvIkgKi9cclxuZnVuY3Rpb24gZ3Vlc3NEdW1wVHlwZSh2YWx1ZTogYW55KTogc3RyaW5nIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuICcnO1xyXG4gICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKS5zb3J0KCk7XHJcbiAgICBjb25zdCBhbGxOdW1iZXIgPSBrZXlzLmxlbmd0aCA+IDAgJiYga2V5cy5ldmVyeSgoa2V5KSA9PiB0eXBlb2YgKHZhbHVlIGFzIGFueSlba2V5XSA9PT0gJ251bWJlcicpO1xyXG4gICAgaWYgKCFhbGxOdW1iZXIpIHJldHVybiAnJztcclxuICAgIGlmIChrZXlzLmpvaW4oJywnKSA9PT0gJ3gseSx6JykgcmV0dXJuICdjYy5WZWMzJztcclxuICAgIGlmIChrZXlzLmpvaW4oJywnKSA9PT0gJ3gseScpIHJldHVybiAnY2MuVmVjMic7XHJcbiAgICBpZiAoa2V5cy5qb2luKCcsJykgPT09ICdoZWlnaHQsd2lkdGgnKSByZXR1cm4gJ2NjLlNpemUnO1xyXG4gICAgaWYgKGtleXMuam9pbignLCcpID09PSAnYSxiLGcscicpIHJldHVybiAnY2MuQ29sb3InO1xyXG4gICAgcmV0dXJuICcnO1xyXG59XHJcblxyXG5jb25zdCBub2RlU2V0UHJvcGVydHlFbmdpbmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5zZXRQcm9wZXJ0eS5lbmdpbmUnLFxyXG4gICAgdGl0bGU6ICforr7nva7lsZ7mgKfvvIjlvJXmk47pgJrpgZPvvIknLFxyXG4gICAgZGVzY3JpcHRpb246XHJcbiAgICAgICAgJ+mAmui/h+WcuuaZr+iEmuacrOeUqOW8leaTjiBBUEkg55u05o6l57uZ6IqC54K55oiW57uE5Lu26LWL5YC877yI5LiN6L+bIHVuZG8g5L2T57O777yM5L+d5a2Y5Zy65pmv5ZCO55Sf5pWI77yJ44CCJyArXHJcbiAgICAgICAgJ2NvbXBvbmVudCDnlZnnqbrooajnpLroioLngrnmnKzouqvvvJvlkKbliJnkvKDnu4Tku7bnsbvlkI3miJYgY2lk44CCJyArXHJcbiAgICAgICAgJ3ZhbHVlIOaUr+aMge+8muaZrumAmiBKU09OIOWAvO+8m3tcIl9fdXVpZFwiOlwieHh4XCJ9IOe7keWumuiKgueCuS/nu4Tku7blvJXnlKjvvJsnICtcclxuICAgICAgICAne1wiX192ZWNcIjpbeCx5LHpdfSDlkJHph4/vvJt7XCJfX3NpemVcIjpbdyxoXX0g5bC65a+477ybe1wiX19jb2xvclwiOltyLGcsYixhXX0g6aKc6Imy44CCJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIHV1aWQ6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXHJcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu257G75ZCN5oiWIGNpZO+8iOWmgiBjYy5MYWJlbCAvIENhcmRJdGVt77yJ77yM55WZ56m66KGo56S66K6+572u6IqC54K55bGe5oCnJyxcclxuICAgICAgICBwcm9wOiAn5bGe5oCn5ZCN77yI5aaCIHN0cmluZyAvIGNvbG9yIC8gdGlwTGFiZWwgLyBwb3NpdGlvbu+8iScsXHJcbiAgICAgICAgdmFsdWU6ICflsZ7mgKflgLzvvIzmlK/mjIEgX191dWlkIC8gX192ZWMgLyBfX3NpemUgLyBfX2NvbG9yIOeJueauiuW9ouW8jycsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICB1dWlkOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxyXG4gICAgICAgICAgICBjb21wb25lbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn57uE5Lu257G75ZCN5oiWIGNpZO+8jOeVmeepuuihqOekuuiKgueCueacrOi6qycgfSxcclxuICAgICAgICAgICAgcHJvcDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflkI0nIH0sXHJcbiAgICAgICAgICAgIHZhbHVlOiB7IGRlc2NyaXB0aW9uOiAn5bGe5oCn5YC8JyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgcmVxdWlyZWQ6IFsncHJvcCddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgbGV0IHV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3V1aWQnLCAnJyk7XHJcbiAgICAgICAgbGV0IHNvdXJjZSA9ICdwYXJhbXMnO1xyXG4gICAgICAgIGlmICghdXVpZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XHJcbiAgICAgICAgICAgIHV1aWQgPSBzZWxlY3RlZFswXSB8fCAnJztcclxuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghdXVpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2NvbXBvbmVudCcsICcnKS50cmltKCk7XHJcbiAgICAgICAgY29uc3QgcHJvcCA9IHBpY2tTdHJpbmcocGFyYW1zLCAncHJvcCcsICcnKS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFwcm9wKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIHByb3AnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ3NldE5vZGVQcm9wZXJ0eScsXHJcbiAgICAgICAgICAgIGFyZ3M6IFt1dWlkLCBjb21wb25lbnQsIHByb3AsIHBhcmFtcz8udmFsdWVdLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5vayAhPT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg5byV5pOO6K6+572u5bGe5oCn5aSx6LSl77yaJHtyZXN1bHQgJiYgcmVzdWx0LmVycm9yID8gcmVzdWx0LmVycm9yIDogJ+acquefpemUmeivryd9YFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyB1dWlkLCBzb3VyY2UsIHNjcmlwdFJlc3VsdDogcmVzdWx0IH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSDlvJXnlKjnu5HlrppcclxuXHJcbi8qKlxyXG4gKiBxdWVyeS1jb21wb25lbnRzIOW7uueahCBjaWQg4oaUIOexu+WQjee0ouW8leOAglxyXG4gKiDoioLngrnmoJHph4zoh6rlrprkuYnohJrmnKznu4Tku7bnmoQgdHlwZSDlrZjnmoTmmK8gY2lk77yM6ICMIHNldC1wcm9wZXJ0eSDnmoQgZHVtcC50eXBlIOimgeexu+WQje+8iOWmgiBJdGVtQmFkZ2XvvInvvIxcclxuICog5omA5Lul6KaB6Z2g6L+Z5byg6KGo57+76K+R44CCXHJcbiAqL1xyXG5pbnRlcmZhY2UgQ29tcG9uZW50Q2xhc3NJbmRleCB7XHJcbiAgICBieUNpZDogeyBbY2lkOiBzdHJpbmddOiBzdHJpbmcgfTtcclxuICAgIG5hbWVzOiBTZXQ8c3RyaW5nPjtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlDb21wb25lbnRDbGFzc0luZGV4KCk6IFByb21pc2U8Q29tcG9uZW50Q2xhc3NJbmRleD4ge1xyXG4gICAgY29uc3QgbGlzdDogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY29tcG9uZW50cycpO1xyXG4gICAgY29uc3QgYnlDaWQ6IHsgW2NpZDogc3RyaW5nXTogc3RyaW5nIH0gPSB7fTtcclxuICAgIGNvbnN0IG5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgbGlzdCB8fCBbXSkge1xyXG4gICAgICAgIGlmIChpdGVtICYmIGl0ZW0uY2lkKSBieUNpZFtTdHJpbmcoaXRlbS5jaWQpXSA9IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpO1xyXG4gICAgICAgIGlmIChpdGVtICYmIGl0ZW0ubmFtZSkgbmFtZXMuYWRkKFN0cmluZyhpdGVtLm5hbWUpKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGJ5Q2lkLCBuYW1lcyB9O1xyXG59XHJcblxyXG4vKiog57uE5Lu25ZyoIGR1bXAg6YeM55qE57G75Z6L5ZCN77ya5YaF572u57uE5Lu25pivIGNjLlNwcml0Ze+8jOiHquWumuS5ieiEmuacrOe7hOS7tuaYr+exu+WQje+8iOWmgiBJdGVtQmFkZ2XvvIkgKi9cclxuZnVuY3Rpb24gY29tcG9uZW50RHVtcFR5cGUoY29tcDogYW55LCBjbGFzc0luZGV4OiBDb21wb25lbnRDbGFzc0luZGV4KTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHJhdyA9IFN0cmluZyhjb21wPy50eXBlIHx8ICcnKS50cmltKCk7XHJcbiAgICBpZiAoY29tcD8uaXNDdXN0b20pIHtcclxuICAgICAgICByZXR1cm4gY2xhc3NJbmRleC5ieUNpZFtyYXddIHx8IHJhdztcclxuICAgIH1cclxuICAgIHJldHVybiByYXcgfHwgU3RyaW5nKGNvbXA/Lm5hbWUgfHwgJycpLnRyaW0oKTtcclxufVxyXG5cclxuLyoqIOe7hOS7tuWQjeWuveadvuebuOetie+8muW/veeVpSBjYy4g5YmN57yA5LiO5aSn5bCP5YaZICovXHJcbmZ1bmN0aW9uIHNhbWVDb21wb25lbnROYW1lKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBmYWxzZTtcclxuICAgIGlmIChhID09PSBiKSByZXR1cm4gdHJ1ZTtcclxuICAgIGNvbnN0IHN0cmlwID0gKHM6IHN0cmluZykgPT4gKHMuc3RhcnRzV2l0aCgnY2MuJykgPyBzLnNsaWNlKDMpIDogcyk7XHJcbiAgICByZXR1cm4gc3RyaXAoYSkudG9Mb3dlckNhc2UoKSA9PT0gc3RyaXAoYikudG9Mb3dlckNhc2UoKTtcclxufVxyXG5cclxuLyoqIOWcqOe7hOS7tuWIl+ihqOmHjOWumuS9jee7hOS7tu+8muaVsOWtl+e0ouW8lSAvIOexu+WQjSAvIGNpZCAvIOe7hOS7tiB1dWlk77ybY2FuZGlkYXRlcz4xIOivtOaYjuaMieWQjeWMuemFjeacieatp+S5ie+8jOW7uuiuruaUueS8oOe0ouW8lSAqL1xyXG5mdW5jdGlvbiBtYXRjaENvbXBvbmVudChcclxuICAgIGNvbXBzOiBhbnlbXSxcclxuICAgIHNwZWM6IHN0cmluZyxcclxuICAgIGNsYXNzSW5kZXg6IENvbXBvbmVudENsYXNzSW5kZXhcclxuKTogeyBpbmRleDogbnVtYmVyOyBjb21wOiBhbnk7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCB7XHJcbiAgICBjb25zdCBzID0gU3RyaW5nKHNwZWMgPz8gJycpLnRyaW0oKTtcclxuICAgIGlmICghcykgcmV0dXJuIG51bGw7XHJcbiAgICBpZiAoL15cXGQrJC8udGVzdChzKSkge1xyXG4gICAgICAgIGNvbnN0IGluZGV4ID0gcGFyc2VJbnQocywgMTApO1xyXG4gICAgICAgIHJldHVybiBjb21wc1tpbmRleF0gPyB7IGluZGV4LCBjb21wOiBjb21wc1tpbmRleF0sIGNhbmRpZGF0ZXM6IDEgfSA6IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoaXRzOiB7IGluZGV4OiBudW1iZXI7IGNvbXA6IGFueSB9W10gPSBbXTtcclxuICAgIGNvbXBzLmZvckVhY2goKGNvbXA6IGFueSwgaW5kZXg6IG51bWJlcikgPT4ge1xyXG4gICAgICAgIGNvbnN0IHR5cGVOYW1lID0gY29tcD8uaXNDdXN0b21cclxuICAgICAgICAgICAgPyAoY2xhc3NJbmRleC5ieUNpZFtTdHJpbmcoY29tcC50eXBlIHx8ICcnKV0gfHwgY29tcC50eXBlKVxyXG4gICAgICAgICAgICA6IGNvbXA/LnR5cGU7XHJcbiAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICBjb21wPy51dWlkID09PSBzIHx8XHJcbiAgICAgICAgICAgIGNvbXA/LnR5cGUgPT09IHMgfHxcclxuICAgICAgICAgICAgc2FtZUNvbXBvbmVudE5hbWUoU3RyaW5nKHR5cGVOYW1lIHx8ICcnKSwgcykgfHxcclxuICAgICAgICAgICAgc2FtZUNvbXBvbmVudE5hbWUoU3RyaW5nKGNvbXA/Lm5hbWUgfHwgJycpLCBzKVxyXG4gICAgICAgICkge1xyXG4gICAgICAgICAgICBoaXRzLnB1c2goeyBpbmRleCwgY29tcCB9KTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiBoaXRzLmxlbmd0aCA/IHsgaW5kZXg6IGhpdHNbMF0uaW5kZXgsIGNvbXA6IGhpdHNbMF0uY29tcCwgY2FuZGlkYXRlczogaGl0cy5sZW5ndGggfSA6IG51bGw7XHJcbn1cclxuXHJcbi8qKiDnu4Tku7bliJfooajnmoTkuIDooYzmkZjopoHvvIjmiqXplJnml7bmj5DnpLrnjrDmnInnu4Tku7bnlKjvvIkgKi9cclxuZnVuY3Rpb24gZGVzY3JpYmVDb21wb25lbnRzKGNvbXBzOiBhbnlbXSwgY2xhc3NJbmRleDogQ29tcG9uZW50Q2xhc3NJbmRleCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gY29tcHNcclxuICAgICAgICAubWFwKChjb21wOiBhbnksIGluZGV4OiBudW1iZXIpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgbmFtZSA9IGNvbXA/LmlzQ3VzdG9tXHJcbiAgICAgICAgICAgICAgICA/IChjbGFzc0luZGV4LmJ5Q2lkW1N0cmluZyhjb21wLnR5cGUgfHwgJycpXSB8fCBjb21wLnR5cGUpXHJcbiAgICAgICAgICAgICAgICA6IChjb21wPy50eXBlIHx8IGNvbXA/Lm5hbWUgfHwgJz8nKTtcclxuICAgICAgICAgICAgcmV0dXJuIGAke2luZGV4fToke25hbWV9YDtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5qb2luKCcsICcpIHx8ICco5peg57uE5Lu2KSc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBUcmVlTm9kZVJlZiB7IHV1aWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IG5vZGU6IGFueTsgfVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdFRyZWVOb2Rlcyhub2RlOiBhbnksIHBhcmVudFBhdGg6IHN0cmluZywgb3V0OiBUcmVlTm9kZVJlZltdKTogdm9pZCB7XHJcbiAgICBpZiAoIW5vZGUpIHJldHVybjtcclxuICAgIGNvbnN0IG5hbWUgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLm5hbWUsICcnKTtcclxuICAgIGNvbnN0IHV1aWQgPSBkdW1wVmFsdWU8c3RyaW5nPihub2RlLnV1aWQsICcnKTtcclxuICAgIGNvbnN0IHBhdGggPSBwYXJlbnRQYXRoID8gYCR7cGFyZW50UGF0aH0vJHtuYW1lfWAgOiBuYW1lO1xyXG4gICAgb3V0LnB1c2goeyB1dWlkLCBuYW1lLCBwYXRoLCBub2RlIH0pO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiAobm9kZS5jaGlsZHJlbiB8fCBbXSkpIGNvbGxlY3RUcmVlTm9kZXMoY2hpbGQsIHBhdGgsIG91dCk7XHJcbn1cclxuXHJcbi8qKiDoioLngrnlrprkvY3vvJp1dWlkIOKGkiDlrozmlbTot6/lvoQg4oaSIOi3r+W+hOWQjue8gCDihpIg6IqC54K55ZCN77yIcHJlZmFiIOe8lui+keaooeW8j+S4i+WQjOagt+mAgueUqO+8jOi3r+W+hOS7pee8lui+keS4reeahOagueS4uui1t+eCue+8iSAqL1xyXG5mdW5jdGlvbiByZXNvbHZlTm9kZVJlZih0cmVlOiBhbnksIHNwZWM6IHN0cmluZyk6IHsgcmVmOiBUcmVlTm9kZVJlZjsgaG93OiBzdHJpbmc7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCB7XHJcbiAgICBjb25zdCBzID0gU3RyaW5nKHNwZWMgfHwgJycpLnRyaW0oKTtcclxuICAgIGlmICghcykgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBhbGw6IFRyZWVOb2RlUmVmW10gPSBbXTtcclxuICAgIGNvbGxlY3RUcmVlTm9kZXModHJlZSwgJycsIGFsbCk7XHJcbiAgICBjb25zdCBleGFjdCA9IGFsbC5maW5kKChpdGVtKSA9PiBpdGVtLnV1aWQgPT09IHMpO1xyXG4gICAgaWYgKGV4YWN0KSByZXR1cm4geyByZWY6IGV4YWN0LCBob3c6ICd1dWlkJywgY2FuZGlkYXRlczogMSB9O1xyXG4gICAgY29uc3QgYnlQYXRoID0gYWxsLmZpbmQoKGl0ZW0pID0+IGl0ZW0ucGF0aCA9PT0gcyk7XHJcbiAgICBpZiAoYnlQYXRoKSByZXR1cm4geyByZWY6IGJ5UGF0aCwgaG93OiAncGF0aCcsIGNhbmRpZGF0ZXM6IDEgfTtcclxuICAgIGNvbnN0IGJ5U3VmZml4ID0gYWxsLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5wYXRoLmVuZHNXaXRoKGAvJHtzfWApKTtcclxuICAgIGlmIChieVN1ZmZpeC5sZW5ndGgpIHJldHVybiB7IHJlZjogYnlTdWZmaXhbMF0sIGhvdzogJ3BhdGgtc3VmZml4JywgY2FuZGlkYXRlczogYnlTdWZmaXgubGVuZ3RoIH07XHJcbiAgICBjb25zdCBieU5hbWUgPSBhbGwuZmlsdGVyKChpdGVtKSA9PiBpdGVtLm5hbWUgPT09IHMpO1xyXG4gICAgaWYgKGJ5TmFtZS5sZW5ndGgpIHJldHVybiB7IHJlZjogYnlOYW1lWzBdLCBob3c6ICduYW1lJywgY2FuZGlkYXRlczogYnlOYW1lLmxlbmd0aCB9O1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKiDotYTkuqfnm67moIfvvJpkYjovLyDot6/lvoQg4oaSIHV1aWQgKyDnsbvlnovvvJvlrZDotYTkuqfvvIh4eC5wbmcvc3ByaXRlRnJhbWXvvInov5Tlm57lrZDotYTkuqfoh6rlt7HnmoQgdXVpZCDkuI7nsbvlnovvvIjlpoIgY2MuU3ByaXRlRnJhbWXvvIkgKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUFzc2V0VGFyZ2V0KFxyXG4gICAgdXJsOiBzdHJpbmcsXHJcbiAgICBleHBsaWNpdFR5cGU6IHN0cmluZ1xyXG4pOiBQcm9taXNlPHsgZHVtcFR5cGU6IHN0cmluZzsgdmFsdWVVdWlkOiBzdHJpbmcgfCBudWxsOyBkZXNjOiBzdHJpbmcgfT4ge1xyXG4gICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IHVybCB9KTtcclxuICAgIGNvbnN0IGhpdCA9IChhc3NldHMgfHwgW10pLmZpbmQoKGFzc2V0OiBhbnkpID0+IGFzc2V0LnVybCA9PT0gdXJsKSB8fCAoYXNzZXRzIHx8IFtdKVswXTtcclxuICAgIGlmICghaGl0IHx8ICFoaXQudXVpZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5om+5LiN5Yiw6LWE5LqnOiAke3VybH3vvIjotLTlm77lvJXnlKjopoHlhpnliLDlrZDotYTkuqfvvIzlpoIgZGI6Ly9hc3NldHMvLi4uL3h4LnBuZy9zcHJpdGVGcmFtZe+8iWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8IFN0cmluZyhoaXQudHlwZSB8fCAnJyksXHJcbiAgICAgICAgdmFsdWVVdWlkOiBTdHJpbmcoaGl0LnV1aWQpLFxyXG4gICAgICAgIGRlc2M6IGDotYTkuqcgJHtoaXQudXJsfWAsXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKiog6Kej5p6Q57uR5a6a55uu5qCHIOKGkiBkdW1wIOexu+Wei+WQjSArIOebruaghyB1dWlk77yIbnVsbCDooajnpLrop6Pnu5HvvIkgKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJpbmRUYXJnZXQoXHJcbiAgICB0cmVlOiBhbnksXHJcbiAgICBjbGFzc0luZGV4OiBDb21wb25lbnRDbGFzc0luZGV4LFxyXG4gICAgdGFyZ2V0OiBhbnksXHJcbiAgICBleHBsaWNpdFR5cGU6IHN0cmluZ1xyXG4pOiBQcm9taXNlPHsgZHVtcFR5cGU6IHN0cmluZzsgdmFsdWVVdWlkOiBzdHJpbmcgfCBudWxsOyBkZXNjOiBzdHJpbmcgfT4ge1xyXG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCB8fCB0YXJnZXQgPT09IHVuZGVmaW5lZCB8fCB0YXJnZXQgPT09ICdudWxsJyB8fCB0YXJnZXQgPT09ICcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgZHVtcFR5cGU6IGV4cGxpY2l0VHlwZSB8fCAnJywgdmFsdWVVdWlkOiBudWxsLCBkZXNjOiAn6Kej57uR77yIbnVsbO+8iScgfTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgdGFyZ2V0ID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIGlmICh0YXJnZXQuc3RhcnRzV2l0aCgnZGI6Ly8nKSkgcmV0dXJuIHJlc29sdmVBc3NldFRhcmdldCh0YXJnZXQsIGV4cGxpY2l0VHlwZSk7XHJcbiAgICAgICAgcmV0dXJuIHsgZHVtcFR5cGU6IGV4cGxpY2l0VHlwZSB8fCAnJywgdmFsdWVVdWlkOiB0YXJnZXQsIGRlc2M6IGB1dWlkOiR7dGFyZ2V0fWAgfTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgdGFyZ2V0ID09PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIGNvbnN0IGFzc2V0ID0gcGlja1N0cmluZyh0YXJnZXQsICdhc3NldCcsICcnKS50cmltKCk7XHJcbiAgICAgICAgaWYgKGFzc2V0KSByZXR1cm4gcmVzb2x2ZUFzc2V0VGFyZ2V0KGFzc2V0LCBleHBsaWNpdFR5cGUpO1xyXG4gICAgICAgIGNvbnN0IHJhd1V1aWQgPSBwaWNrU3RyaW5nKHRhcmdldCwgJ3V1aWQnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmIChyYXdVdWlkKSByZXR1cm4geyBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8ICcnLCB2YWx1ZVV1aWQ6IHJhd1V1aWQsIGRlc2M6IGB1dWlkOiR7cmF3VXVpZH1gIH07XHJcbiAgICAgICAgY29uc3Qgbm9kZVNwZWMgPSBwaWNrU3RyaW5nKHRhcmdldCwgJ25vZGUnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmIChub2RlU3BlYykge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlSGl0ID0gcmVzb2x2ZU5vZGVSZWYodHJlZSwgbm9kZVNwZWMpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGVIaXQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgdGFyZ2V0Lm5vZGUg5om+5LiN5Yiw6IqC54K5OiAke25vZGVTcGVjfe+8iOWPr+eUqCB1dWlkIOaIliDot6/lvoTvvIzlpoIgUGFubmVsL2JhZGdl77yJYCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgY29tcFNwZWMgPSB0YXJnZXQuY29tcG9uZW50O1xyXG4gICAgICAgICAgICBjb25zdCBjb21wVGV4dCA9IGNvbXBTcGVjID09PSB1bmRlZmluZWQgfHwgY29tcFNwZWMgPT09IG51bGwgPyAnJyA6IFN0cmluZyhjb21wU3BlYykudHJpbSgpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBUZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgICAgIGR1bXBUeXBlOiBleHBsaWNpdFR5cGUgfHwgJ2NjLk5vZGUnLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlVXVpZDogbm9kZUhpdC5yZWYudXVpZCxcclxuICAgICAgICAgICAgICAgICAgICBkZXNjOiBg6IqC54K5ICR7bm9kZUhpdC5yZWYucGF0aH1gLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBjb21wcyA9IHJlYWROb2RlQ29tcG9uZW50cyhub2RlSGl0LnJlZi5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2hlZCA9IG1hdGNoQ29tcG9uZW50KGNvbXBzLCBjb21wVGV4dCwgY2xhc3NJbmRleCk7XHJcbiAgICAgICAgICAgIGlmICghbWF0Y2hlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGB0YXJnZXQuY29tcG9uZW50IOWcqOiKgueCuSAke25vZGVIaXQucmVmLnBhdGh9IOS4iuaJvuS4jeWIsOOAjCR7Y29tcFRleHR944CN77yM546w5pyJOiAke2Rlc2NyaWJlQ29tcG9uZW50cyhjb21wcywgY2xhc3NJbmRleCl9YFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB0eXBlTmFtZSA9IGNvbXBvbmVudER1bXBUeXBlKG1hdGNoZWQuY29tcCwgY2xhc3NJbmRleCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBkdW1wVHlwZTogZXhwbGljaXRUeXBlIHx8IHR5cGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgdmFsdWVVdWlkOiBTdHJpbmcobWF0Y2hlZC5jb21wLnV1aWQgfHwgJycpLFxyXG4gICAgICAgICAgICAgICAgZGVzYzogYOe7hOS7tiAke3R5cGVOYW1lIHx8IGNvbXBUZXh0fSBAICR7bm9kZUhpdC5yZWYucGF0aH1gLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcigndGFyZ2V0IOW/hemhu+aYryB7bm9kZSwgY29tcG9uZW50fSAvIHtub2RlfSAvIHthc3NldH0gLyB7dXVpZH0gLyBudWxsJyk7XHJcbn1cclxuXHJcbmNvbnN0IG5vZGVCaW5kUHJvcGVydHk6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5iaW5kUHJvcGVydHknLFxyXG4gICAgdGl0bGU6ICfnu5HlrprlvJXnlKjlsZ7mgKcnLFxyXG4gICAgZGVzY3JpcHRpb246XHJcbiAgICAgICAgJ+e7mee7hOS7tue7keWumuW8leeUqOexu+Wei+WxnuaAp++8iEBwcm9wZXJ0eShMYWJlbC9TcHJpdGUv6Ieq5a6a5LmJ6ISa5pysL05vZGUvU3ByaXRlRnJhbWXigKYp77yJ77yMJyArXHJcbiAgICAgICAgJ+i1sCBzY2VuZS9zZXQtcHJvcGVydHkg5raI5oGv6YCa6YGT77yI6L+bIHVuZG8g5L2T57O744CB5Y+v5L+d5a2Y6L+bIHByZWZhYi9zY2VuZe+8ie+8jOS4juWxnuaAp+ajgOafpeWZqOaLluaLvee7keWumuWujOWFqOetieS7t++8jCcgK1xyXG4gICAgICAgICfmlK/mjIHltYzlpZcgcHJlZmFiIOWunuS+i+WGhemDqOeahOe7hOS7tu+8iOiHquWKqOeUn+aIkCB0YXJnZXRPdmVycmlkZXMg5bqP5YiX5YyW6JC955uY77yJ44CCJyArXHJcbiAgICAgICAgJ+WNleadoeWPguaVsO+8mnV1aWTvvIjlsZ7mgKfmiYDlnKjoioLngrnvvIx1dWlkIOaIlui3r+W+hO+8jOeVmeepuj3lvZPliY3pgInkuK3oioLngrnvvInjgIFjb21wb25lbnTvvIjntKLlvJUv57G75ZCNL2NpZO+8ieOAgXByb3BlcnR577yI5bGe5oCn5ZCN77yJ44CBdGFyZ2V0IOKAlOKAlCAnICtcclxuICAgICAgICAne1wibm9kZVwiOlwiUGFubmVsL2JhZGdlXCIsXCJjb21wb25lbnRcIjpcIkl0ZW1CYWRnZVwifSDnu4Tku7blvJXnlKjvvIjmjqjojZDvvIzoh6rliqjop6PmnpDnm67moIcgdXVpZCDkuI4gZHVtcCDnsbvlnovvvIzltYzlpZcgcHJlZmFiIOWGheeahOe7hOS7tuS5n+iDveWumuS9je+8ie+8mycgK1xyXG4gICAgICAgICd7XCJub2RlXCI6XCLot6/lvoTmiJZ1dWlkXCJ9IOiKgueCueW8leeUqO+8iGNjLk5vZGXvvInvvJt7XCJhc3NldFwiOlwiZGI6Ly9hc3NldHMveC5wbmcvc3ByaXRlRnJhbWVcIn0g6LWE5Lqn5byV55So77ybbnVsbCDop6Pnu5HjgIInICtcclxuICAgICAgICAndGFyZ2V0IOS5n+WPr+ebtOaOpeS8oCB1dWlkIOWtl+espuS4su+8iOatpOaXtuW7uuiuruaYvuW8j+S8oCB0eXBl77yJ44CCJyArXHJcbiAgICAgICAgJ+aJuemHj++8mmJpbmRpbmdzPVt7dXVpZCxjb21wb25lbnQscHJvcGVydHksdGFyZ2V0fSzigKZdIOW9ouW8j+S4iuaUr+aMge+8jOS9huW9k+WJjeWunueOsOWkmuadoeWPquacieesrOS4gOadoeecn+ato+eUn+aViO+8iOW3suefpemXrumimO+8ie+8jOivt+S4gOadoeS4gOS4quiwg+eUqO+8iOWPr+W5tuihjOWPke+8ieOAgicgK1xyXG4gICAgICAgICfnu5HlrprlkI7oh6rliqjlm57or7vlnLrmma/lrp7pmYXlvJXnlKjpqozor4HvvIzkuI3kuIDoh7TkvJrmiqXplJnjgIInLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgdXVpZDogJ+WxnuaAp+aJgOWcqOiKgueCue+8mnV1aWQg5oiW6IqC54K56Lev5b6E77yM55WZ56m655So5b2T5YmN6YCJ5Lit6IqC54K5JyxcclxuICAgICAgICBjb21wb25lbnQ6ICfnu4Tku7blrprkvY3vvJrntKLlvJXmlbDlrZcgLyDnsbvlkI3vvIhjYy5MYWJlbOOAgUl0ZW1CYWRnZe+8iS8gY2lkJyxcclxuICAgICAgICBwcm9wZXJ0eTogJ+WxnuaAp+WQje+8jOWmgiBiYWRnZeOAgXRpcExhYmVs44CBc3ByaXRlRnJhbWUnLFxyXG4gICAgICAgIHRhcmdldDogJ+e7keWumuebruagh++8mntub2RlLGNvbXBvbmVudH0g57uE5Lu25byV55SoIHwge25vZGV9IOiKgueCueW8leeUqCB8IHthc3NldDpcImRiOi8v4oCmXCJ9IOi1hOS6pyB8IHV1aWQg5a2X56ym5LiyIHwgbnVsbCDop6Pnu5EnLFxyXG4gICAgICAgIHR5cGU6ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8iOm7mOiupOiHquWKqOaOqOaWre+8mue7hOS7tuKGkuexu+WQjeOAgeiKgueCueKGkmNjLk5vZGXjgIHotYTkuqfihpLotYTmupDnsbvlnovvvIknLFxyXG4gICAgICAgIHBhdGg6ICflj6/pgInjgILljp/lp4vlsZ7mgKfot6/lvoTvvIjlpoIgX19jb21wc19fLjEuYmFkZ2XvvInvvIzkvKDkuoblsLHot7Pov4cgY29tcG9uZW50L3Byb3BlcnR5IOaLvOijhScsXHJcbiAgICAgICAgYmluZGluZ3M6ICfmibnph4/nu5HlrprmlbDnu4TvvIjlvZPliY3lpJrmnaHlj6rmnInnrKzkuIDmnaHnlJ/mlYjvvIzlu7rorq7pgJDmnaHosIPnlKjvvInvvIzmr4/pobkge3V1aWQsY29tcG9uZW50LHByb3BlcnR5LHRhcmdldFssdHlwZV1977yM5LiO5Y2V5p2h5Y+C5pWw5LqM6YCJ5LiAJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5bGe5oCn5omA5Zyo6IqC54K577yadXVpZCDmiJboioLngrnot6/lvoTvvIznlZnnqbrnlKjlvZPliY3pgInkuK3oioLngrknIH0sXHJcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7blrprkvY3vvJrntKLlvJXmlbDlrZcgLyDnsbvlkI3vvIhjYy5MYWJlbOOAgUl0ZW1CYWRnZe+8iS8gY2lkJyB9LFxyXG4gICAgICAgICAgICBwcm9wZXJ0eTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflsZ7mgKflkI3vvIzlpoIgYmFkZ2XjgIF0aXBMYWJlbOOAgXNwcml0ZUZyYW1lJyB9LFxyXG4gICAgICAgICAgICB0YXJnZXQ6IHtcclxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOlxyXG4gICAgICAgICAgICAgICAgICAgICfnu5Hlrprnm67moIfvvJp7bm9kZSxjb21wb25lbnR9IOe7hOS7tuW8leeUqCB8IHtub2RlfSDoioLngrnlvJXnlKggfCB7YXNzZXQ6XCJkYjovL+KAplwifSDotYTkuqcgfCB1dWlkIOWtl+espuS4siB8IG51bGwg6Kej57uRJyxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgdHlwZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInjgIJkdW1wIOexu+Wei+WQje+8jOm7mOiupOiHquWKqOaOqOaWrScgfSxcclxuICAgICAgICAgICAgcGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInjgILljp/lp4vlsZ7mgKfot6/lvoTvvIjlpoIgX19jb21wc19fLjEuYmFkZ2XvvInvvIzot7Pov4cgY29tcG9uZW50L3Byb3BlcnR5IOaLvOijhScgfSxcclxuICAgICAgICAgICAgYmluZGluZ3M6IHtcclxuICAgICAgICAgICAgICAgIHR5cGU6ICdhcnJheScsXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aJuemHj+e7keWumu+8muavj+mhuSB7dXVpZCwgY29tcG9uZW50LCBwcm9wZXJ0eSwgdGFyZ2V0WywgdHlwZV1977yM5LiO5Y2V5p2h5Y+C5pWw5LqM6YCJ5LiA77yb5b2T5YmN5aSa5p2h5Y+q5pyJ56ys5LiA5p2h55Sf5pWI77yM5bu66K6u6YCQ5p2h6LCD55SoJyxcclxuICAgICAgICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6ICdvYmplY3QnIH0sXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xyXG4gICAgICAgIGNvbnN0IHNwZWNzOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocGFyYW1zPy5iaW5kaW5ncykgPyBwYXJhbXMuYmluZGluZ3MgOiBbcGFyYW1zXTtcclxuICAgICAgICBpZiAoIXNwZWNzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInlj6/miafooYznmoTnu5HlrprvvIhiaW5kaW5ncyDkuLrnqbrvvIknKTtcclxuXHJcbiAgICAgICAgY29uc3QgdHJlZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUtdHJlZScpO1xyXG4gICAgICAgIGlmICghdHJlZSkgdGhyb3cgbmV3IEVycm9yKCflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma8nKTtcclxuICAgICAgICBjb25zdCBjbGFzc0luZGV4ID0gYXdhaXQgcXVlcnlDb21wb25lbnRDbGFzc0luZGV4KCk7XHJcblxyXG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IHBsYW5zOiBhbnlbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBzcGVjcykge1xyXG4gICAgICAgICAgICAvLyAxKSDlsZ7mgKfmiYDlnKjoioLngrlcclxuICAgICAgICAgICAgY29uc3Qgbm9kZVNwZWMgPSBwaWNrU3RyaW5nKHNwZWMsICd1dWlkJywgJycpLnRyaW0oKTtcclxuICAgICAgICAgICAgbGV0IG5vZGVIaXQ6IHsgcmVmOiBUcmVlTm9kZVJlZjsgaG93OiBzdHJpbmc7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbm9kZVNwZWMgfHwgbm9kZVNwZWMgPT09ICdAc2VsZWN0aW9uJykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6aIHV1aWTvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcclxuICAgICAgICAgICAgICAgIG5vZGVIaXQgPSByZXNvbHZlTm9kZVJlZih0cmVlLCBzZWxlY3RlZFswXSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBub2RlSGl0ID0gcmVzb2x2ZU5vZGVSZWYodHJlZSwgbm9kZVNwZWMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghbm9kZUhpdCkgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/moJHph4zmib7kuI3liLDoioLngrk6ICR7bm9kZVNwZWMgfHwgJyjpgInkuK3oioLngrkpJ31gKTtcclxuXHJcbiAgICAgICAgICAgIC8vIDIpIOe7hOS7tuS4juWxnuaAp+i3r+W+hO+8iGR1bXAg6Lev5b6E57uf5LiA55SoIF9fY29tcHNfXyDliY3nvIDvvIzkuI7lsZ7mgKfmo4Dmn6Xlmajlj5Hlh7rnmoTmtojmga/kuIDoh7TvvIlcclxuICAgICAgICAgICAgY29uc3QgcmF3UGF0aCA9IHBpY2tTdHJpbmcoc3BlYywgJ3BhdGgnLCAnJykudHJpbSgpO1xyXG4gICAgICAgICAgICBsZXQgcGF0aCA9IHJhd1BhdGhcclxuICAgICAgICAgICAgICAgID8gKHJhd1BhdGguc3RhcnRzV2l0aCgnY29tcG9uZW50cy4nKSA/IGBfX2NvbXBzX18uJHtyYXdQYXRoLnNsaWNlKCdjb21wb25lbnRzLicubGVuZ3RoKX1gIDogcmF3UGF0aClcclxuICAgICAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgICAgIGxldCB2ZXJpZnlJbmRleCA9ICcnO1xyXG4gICAgICAgICAgICBsZXQgdmVyaWZ5UHJvcCA9ICcnO1xyXG4gICAgICAgICAgICBsZXQgbWF0Y2hlZDogeyBpbmRleDogbnVtYmVyOyBjb21wOiBhbnk7IGNhbmRpZGF0ZXM6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghcGF0aCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJvcGVydHkgPSBwaWNrU3RyaW5nKHNwZWMsICdwcm9wZXJ0eScsICcnKS50cmltKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXByb3BlcnR5KSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBwcm9wZXJ0ee+8iOaIluWOn+WniyBwYXRo77yJ77yM5aaCIGJhZGdlIC8gc3ByaXRlRnJhbWUnKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbXBTcGVjID0gc3BlYz8uY29tcG9uZW50O1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29tcFRleHQgPSBjb21wU3BlYyA9PT0gdW5kZWZpbmVkIHx8IGNvbXBTcGVjID09PSBudWxsID8gJycgOiBTdHJpbmcoY29tcFNwZWMpLnRyaW0oKTtcclxuICAgICAgICAgICAgICAgIGlmIChjb21wVGV4dCAmJiBjb21wVGV4dCAhPT0gJ25vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29tcHMgPSByZWFkTm9kZUNvbXBvbmVudHMobm9kZUhpdC5yZWYubm9kZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2hlZCA9IG1hdGNoQ29tcG9uZW50KGNvbXBzLCBjb21wVGV4dCwgY2xhc3NJbmRleCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtYXRjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrkgJHtub2RlSGl0LnJlZi5wYXRofSDkuIrmib7kuI3liLDnu4Tku7bjgIwke2NvbXBUZXh0feOAje+8jOeOsOaciTogJHtkZXNjcmliZUNvbXBvbmVudHMoY29tcHMsIGNsYXNzSW5kZXgpfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgcGF0aCA9IGBfX2NvbXBzX18uJHttYXRjaGVkLmluZGV4fS4ke3Byb3BlcnR5fWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXggPSBTdHJpbmcobWF0Y2hlZC5pbmRleCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBhdGggPSBwcm9wZXJ0eTsgLy8g6IqC54K557qn5bGe5oCn77yI5bCR6KeB77yJXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB2ZXJpZnlQcm9wID0gcHJvcGVydHk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBtID0gL15fX2NvbXBzX19cXC4oXFxkKylcXC4oLispJC8uZXhlYyhwYXRoKTtcclxuICAgICAgICAgICAgICAgIGlmIChtKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXggPSBtWzFdO1xyXG4gICAgICAgICAgICAgICAgICAgIHZlcmlmeVByb3AgPSBtWzJdO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyAzKSDnm67moIcg4oaSIGR1bXBcclxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0SW5mbyA9IGF3YWl0IHJlc29sdmVCaW5kVGFyZ2V0KFxyXG4gICAgICAgICAgICAgICAgdHJlZSxcclxuICAgICAgICAgICAgICAgIGNsYXNzSW5kZXgsXHJcbiAgICAgICAgICAgICAgICBzcGVjPy50YXJnZXQsXHJcbiAgICAgICAgICAgICAgICBwaWNrU3RyaW5nKHNwZWMsICd0eXBlJywgJycpLnRyaW0oKVxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBkdW1wID0gdGFyZ2V0SW5mby52YWx1ZVV1aWQgPT09IG51bGxcclxuICAgICAgICAgICAgICAgID8gKHRhcmdldEluZm8uZHVtcFR5cGUgPyB7IHR5cGU6IHRhcmdldEluZm8uZHVtcFR5cGUsIHZhbHVlOiBudWxsIH0gOiB7IHZhbHVlOiBudWxsIH0pXHJcbiAgICAgICAgICAgICAgICA6IHsgdHlwZTogdGFyZ2V0SW5mby5kdW1wVHlwZSwgdmFsdWU6IHsgdXVpZDogdGFyZ2V0SW5mby52YWx1ZVV1aWQgfSB9O1xyXG5cclxuICAgICAgICAgICAgaXRlbXMucHVzaCh7IHV1aWQ6IG5vZGVIaXQucmVmLnV1aWQsIHBhdGgsIGR1bXAgfSk7XHJcbiAgICAgICAgICAgIHBsYW5zLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgdXVpZDogbm9kZUhpdC5yZWYudXVpZCxcclxuICAgICAgICAgICAgICAgIG5vZGVOYW1lOiBub2RlSGl0LnJlZi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbm9kZVBhdGg6IG5vZGVIaXQucmVmLnBhdGgsXHJcbiAgICAgICAgICAgICAgICBwYXRoLFxyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50OiBtYXRjaGVkXHJcbiAgICAgICAgICAgICAgICAgICAgPyBgJHtjb21wb25lbnREdW1wVHlwZShtYXRjaGVkLmNvbXAsIGNsYXNzSW5kZXgpfSgjJHttYXRjaGVkLmluZGV4fSlgXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnbm9kZScsXHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRBbWJpZ3VvdXM6ICEhKG1hdGNoZWQgJiYgbWF0Y2hlZC5jYW5kaWRhdGVzID4gMSksXHJcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHRhcmdldEluZm8uZGVzYyxcclxuICAgICAgICAgICAgICAgIGV4cGVjdGVkVXVpZDogdGFyZ2V0SW5mby52YWx1ZVV1aWQsXHJcbiAgICAgICAgICAgICAgICB0eXBlTWlzc2luZzogdGFyZ2V0SW5mby52YWx1ZVV1aWQgIT09IG51bGwgJiYgIXRhcmdldEluZm8uZHVtcFR5cGUsXHJcbiAgICAgICAgICAgICAgICBkdW1wLFxyXG4gICAgICAgICAgICAgICAgdmVyaWZ5SW5kZXgsXHJcbiAgICAgICAgICAgICAgICB2ZXJpZnlQcm9wLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIDQpIOS4gOasoeaAp+aPkOS6pO+8muWkmuS4qiB7dXVpZCxwYXRoLGR1bXB9IOS9nOS4uuWPmOWPgu+8iOS4juWxnuaAp+ajgOafpeWZqOaJuemHj+WGmeWFpeWQjOaehO+8jOS4gOadoSB1bmRv77yJ44CCXHJcbiAgICAgICAgLy8gICAgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCDnmoTnsbvlnovnrb7lkI3kuI3mmK8gcmVzdCDlj4LmlbDvvIzov5nph4zmjInlj5jlj4LosIPnlKjpnIDopoEgY2FzdOOAglxyXG4gICAgICAgIGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoU0NFTkUsICdzZXQtcHJvcGVydHknLCAuLi5pdGVtcyk7XHJcblxyXG4gICAgICAgIC8vIDUpIOWbnuivu+mqjOivge+8iOWcuuaZr+iEmuacrOmAmumBk++8m+WcuuaZr+i/m+eoi+i/mOayoeWKoOi9veaWsOaWueazleaXtumZjee6p+S4uiB1bmF2YWlsYWJsZe+8jOS4jemYu+Whnue7keWumuacrOi6q++8iVxyXG4gICAgICAgIGNvbnN0IHJlc3VsdHM6IGFueVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBwbGFuIG9mIHBsYW5zKSB7XHJcbiAgICAgICAgICAgIGxldCB2ZXJpZmllZDogYW55ID0gJ3NraXBwZWQnO1xyXG4gICAgICAgICAgICBsZXQgYWN0dWFsOiBhbnkgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgbm90ZSA9ICcnO1xyXG4gICAgICAgICAgICBpZiAocGxhbi52ZXJpZnlJbmRleCAhPT0gJycgJiYgcGxhbi52ZXJpZnlQcm9wKSB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHI6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiAncmVhZENvbXBvbmVudFByb3BlcnR5JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXJnczogW3BsYW4udXVpZCwgcGxhbi52ZXJpZnlJbmRleCwgcGxhbi52ZXJpZnlQcm9wXSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAociAmJiByLm9rID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjdHVhbCA9IHIucmVmID8/IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFjdHVhbFV1aWQgPSBhY3R1YWwgJiYgYWN0dWFsLnV1aWQgPyBhY3R1YWwudXVpZCA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcmlmaWVkID0gYWN0dWFsVXVpZCA9PT0gcGxhbi5leHBlY3RlZFV1aWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmVyaWZpZWQgPSAndW5hdmFpbGFibGUnO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub3RlID0gKHIgJiYgci5lcnJvcilcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gU3RyaW5nKHIuZXJyb3IpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA6ICflnLrmma/ohJrmnKzmsqHmnInov5Tlm57nu5PmnpzvvIjnvJbovpHlmajph4zph43ovb0gY29jb3MtbWNwIOaJqeWxleWQjuWPr+mqjOivge+8iSc7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdmVyaWZpZWQgPSAndW5hdmFpbGFibGUnO1xyXG4gICAgICAgICAgICAgICAgICAgIG5vdGUgPSBlPy5tZXNzYWdlID8/IFN0cmluZyhlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXN1bHRzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgdXVpZDogcGxhbi51dWlkLFxyXG4gICAgICAgICAgICAgICAgbm9kZU5hbWU6IHBsYW4ubm9kZU5hbWUsXHJcbiAgICAgICAgICAgICAgICBub2RlUGF0aDogcGxhbi5ub2RlUGF0aCxcclxuICAgICAgICAgICAgICAgIHBhdGg6IHBsYW4ucGF0aCxcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudDogcGxhbi5jb21wb25lbnQsXHJcbiAgICAgICAgICAgICAgICBjb21wb25lbnRBbWJpZ3VvdXM6IHBsYW4uY29tcG9uZW50QW1iaWd1b3VzIHx8IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgIHRhcmdldDogcGxhbi50YXJnZXQsXHJcbiAgICAgICAgICAgICAgICBleHBlY3RlZFV1aWQ6IHBsYW4uZXhwZWN0ZWRVdWlkLFxyXG4gICAgICAgICAgICAgICAgdHlwZU1pc3Npbmc6IHBsYW4udHlwZU1pc3NpbmcgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgZHVtcDogcGxhbi5kdW1wLFxyXG4gICAgICAgICAgICAgICAgYWN0dWFsLFxyXG4gICAgICAgICAgICAgICAgdmVyaWZpZWQsXHJcbiAgICAgICAgICAgICAgICAuLi4obm90ZSA/IHsgdmVyaWZ5Tm90ZTogbm90ZSB9IDoge30pLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG1pc21hdGNoZWQgPSByZXN1bHRzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS52ZXJpZmllZCA9PT0gZmFsc2UpO1xyXG4gICAgICAgIGlmIChtaXNtYXRjaGVkLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBjb25zdCBsaW5lcyA9IG1pc21hdGNoZWQubWFwKChpdGVtOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICBgJHtpdGVtLm5vZGVQYXRofSAke2l0ZW0ucGF0aH0g4oaSIOacn+acmyAke2l0ZW0uZXhwZWN0ZWRVdWlkID8/ICdudWxsJ33vvIzlrp7pmYUgJHtcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLmFjdHVhbCAmJiBpdGVtLmFjdHVhbC51dWlkID8gaXRlbS5hY3R1YWwudXVpZCA6IEpTT04uc3RyaW5naWZ5KGl0ZW0uYWN0dWFsKVxyXG4gICAgICAgICAgICAgICAgfWBcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnu5Hlrprlt7Lmj5DkuqTkvYblm57or7vkuI3kuIDoh7TvvIjlj6/og73msqHmnInnnJ/mraPnlJ/mlYjvvIzlj68gQ3RybCtaIOaSpOmUgOWQjumHjeivle+8ie+8mlxcbiR7bGluZXMuam9pbignXFxuJyl9YCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBhcHBsaWVkOiBpdGVtcy5sZW5ndGgsXHJcbiAgICAgICAgICAgIHN1Ym1pdHRlZDogaXRlbXMsXHJcbiAgICAgICAgICAgIHZlcmlmaWVkQ291bnQ6IHJlc3VsdHMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnZlcmlmaWVkID09PSB0cnVlKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHJlc3VsdHMsXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBub2RlQ3JlYXRlUHJlZmFiOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUuY3JlYXRlUHJlZmFiJyxcclxuICAgIHRpdGxlOiAn5L+d5a2Y6IqC54K55Li66aKE5Yi25L2TJyxcclxuICAgIGRlc2NyaXB0aW9uOlxyXG4gICAgICAgICfmiorlnLrmma/oioLngrnvvIjlkKvmlbTmo7XlrZDmoJHvvInkv53lrZjkuLogLnByZWZhYiDotYTmupDvvIhzY2VuZS9jcmVhdGUtcHJlZmFi77yM6Ieq5Yqo6L+bIHVuZG/vvInvvIwnICtcclxuICAgICAgICAn6IqC54K55pys6Lqr5Lya5Y+Y5oiQ6aKE5Yi25L2T5a6e5L6L44CCdXJsIOeVmeepuuWImeWtmOWIsCBkYjovL2Fzc2V0cy9wcmVmYWJzLzzoioLngrnlkI0+LnByZWZhYu+8jCcgK1xyXG4gICAgICAgICfnm67moIfnm67lvZXkuI3lrZjlnKjml7boh6rliqjliJvlu7rjgIInLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcclxuICAgICAgICB1cmw6ICfnm67moIfot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvcHJlZmFicy9DYXJkcy5wcmVmYWInLFxyXG4gICAgICAgIG92ZXJ3cml0ZTogJ+WQjOWQjSAucHJlZmFiIOW3suWtmOWcqOaXtuaYr+WQpuWFiOWIoOmZpOWGjeWIm+W7uu+8jOm7mOiupCBmYWxzZScsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxyXG4gICAgICAgICAgICB1cmw6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn55uu5qCH6Lev5b6EIGRiOi8vYXNzZXRzLy4uLi5wcmVmYWLvvIznlZnnqbrliJnnlKggZGI6Ly9hc3NldHMvcHJlZmFicy886IqC54K55ZCNPi5wcmVmYWInIH0sXHJcbiAgICAgICAgICAgIG92ZXJ3cml0ZTogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5ZCM5ZCN6LWE5rqQ5bey5a2Y5Zyo5pe25piv5ZCm5YWI5Yig6Zmk5YaN5Yib5bu6JyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBsZXQgbm9kZVV1aWQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25vZGUnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGxldCBzb3VyY2UgPSAncGFyYW1zJztcclxuICAgICAgICBpZiAoIW5vZGVVdWlkKSB7XHJcbiAgICAgICAgICAgIG5vZGVVdWlkID0gZ2V0U2VsZWN0ZWROb2RlVXVpZHMoKVswXSB8fCAnJztcclxuICAgICAgICAgICAgc291cmNlID0gJ3NlbGVjdGlvbic7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghbm9kZVV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInmjIflrproioLngrnvvIzkuZ/msqHmnInpgInkuK3ku7vkvZXoioLngrknKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHRyZWU6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1ub2RlLXRyZWUnKTtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlVXVpZCk7XHJcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlnLrmma/ph4zmib7kuI3liLDoioLngrk6ICR7bm9kZVV1aWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHNjZW5lUm9vdFV1aWQgPSBkdW1wVmFsdWU8c3RyaW5nPih0cmVlPy51dWlkLCAnJyk7XHJcbiAgICAgICAgaWYgKHNjZW5lUm9vdFV1aWQgJiYgc2NlbmVSb290VXVpZCA9PT0gbm9kZVV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkuI3og73miorlnLrmma/moLnkv53lrZjkuLrpooTliLbkvZPvvIzor7fmjIflrprlroPnmoTmn5DkuKrlrZDoioLngrknKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZU5hbWUgPSBkdW1wVmFsdWU8c3RyaW5nPih0YXJnZXQubmFtZSwgJycpO1xyXG5cclxuICAgICAgICBsZXQgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmICghdXJsKSB7XHJcbiAgICAgICAgICAgIGlmICghbm9kZU5hbWUpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign6IqC54K55rKh5pyJ5ZCN5a2X77yM5peg5rOV5o6o5a+86buY6K6k6Lev5b6E77yM6K+35pi+5byP5LygIHVybCcpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHVybCA9IGBkYjovL2Fzc2V0cy9wcmVmYWJzLyR7bm9kZU5hbWV9LnByZWZhYmA7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzLycpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgdXJsIOW/hemhu+S9jeS6jiBkYjovL2Fzc2V0cy8g5LiLOiAke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCF1cmwuZW5kc1dpdGgoJy5wcmVmYWInKSkge1xyXG4gICAgICAgICAgICB1cmwgPSBgJHt1cmx9LnByZWZhYmA7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyDpgJDnuqfnoa7kv53niLbnm67lvZXlrZjlnKjvvIhjcmVhdGUtYXNzZXQg55qEIHNvdXJjZSDkvKAgbnVsbCDljbPliJvlu7rnm67lvZXvvIlcclxuICAgICAgICBjb25zdCBmb2xkZXJTZWdtZW50cyA9IHVybC5zbGljZSgnZGI6Ly9hc3NldHMvJy5sZW5ndGgpLnNwbGl0KCcvJykuc2xpY2UoMCwgLTEpO1xyXG4gICAgICAgIGxldCBmb2xkZXJVcmwgPSAnZGI6Ly9hc3NldHMnO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWRGb2xkZXJzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3Qgc2VnbWVudCBvZiBmb2xkZXJTZWdtZW50cykge1xyXG4gICAgICAgICAgICBpZiAoIXNlZ21lbnQpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBmb2xkZXJVcmwgPSBgJHtmb2xkZXJVcmx9LyR7c2VnbWVudH1gO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdHMgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGZvbGRlclVybCk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2NyZWF0ZS1hc3NldCcsIGZvbGRlclVybCwgbnVsbCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWIm+W7uuebruW9leWksei0pTogJHtmb2xkZXJVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkRm9sZGVycy5wdXNoKGZvbGRlclVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChwYXJhbXM/Lm92ZXJ3cml0ZSA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZzogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAncXVlcnktYXNzZXRzJywgeyBwYXR0ZXJuOiB1cmwgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGhpdCA9IChleGlzdGluZyB8fCBbXSkuZmluZCgoYXNzZXQ6IGFueSkgPT4gYXNzZXQudXJsID09PSB1cmwpO1xyXG4gICAgICAgICAgICBpZiAoaGl0KSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgaGl0LnV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBwcmVmYWJVdWlkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2NyZWF0ZS1wcmVmYWInLCBub2RlVXVpZCwgdXJsKTtcclxuICAgICAgICBpZiAoIXByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtcHJlZmFiIOayoeaciei/lOWbnui1hOa6kCB1dWlk77yI55uu5qCH5bey5a2Y5Zyo77yf5Y+v5LygIG92ZXJ3cml0ZT10cnVl77yJOiAke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgbm9kZTogbm9kZVV1aWQsIG5vZGVOYW1lLCB1cmwsIHByZWZhYlV1aWQsIGNyZWF0ZWRGb2xkZXJzLCBzb3VyY2UgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBzY2VuZVNhdmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnc2NlbmUuc2F2ZScsXHJcbiAgICB0aXRsZTogJ+S/neWtmOWcuuaZrycsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/hyBzY2VuZS9zYXZlLXNjZW5lIOS/neWtmOW9k+WJjeWcuuaZr++8jOi/lOWbnuS/neWtmOe7k+aenCcsXHJcbiAgICBwYXJhbXM6IHt9LFxyXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxyXG4gICAgYXN5bmMgcnVuKCkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5QmVmb3JlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWRpcnR5Jyk7XHJcbiAgICAgICAgLy8g5rOo5oSP77yaMy44Ljgg55qEIHNhdmUtc2NlbmUg6L+U5Zue55qE5piv5Zy65pmvIHV1aWTvvIzkuI3mmK8gZGI6Ly8g6Lev5b6EXHJcbiAgICAgICAgY29uc3Qgc2NlbmVVdWlkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBjb25zdCBkaXJ0eUFmdGVyID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWRpcnR5Jyk7XHJcbiAgICAgICAgbGV0IHVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgaWYgKHNjZW5lVXVpZCkge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgdXJsID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LXBhdGgnLCBzY2VuZVV1aWQpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICB1cmwgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGRpcnR5QmVmb3JlLCBkaXJ0eUFmdGVyLCBzY2VuZVV1aWQ6IHNjZW5lVXVpZCB8fCBudWxsLCB1cmw6IHVybCB8fCBudWxsIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3QgYXNzZXRMaXN0OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ2Fzc2V0Lmxpc3QnLFxyXG4gICAgdGl0bGU6ICfotYTmupDliJfooagnLFxyXG4gICAgZGVzY3JpcHRpb246ICfpgJrov4cgYXNzZXQtZGIvcXVlcnktYXNzZXRzIOWIl+WHuumhueebrui1hOa6kCcsXHJcbiAgICBwYXJhbXM6IHtcclxuICAgICAgICBwYXR0ZXJuOiAn6Lev5b6E5Yy56YWN77yM6buY6K6kIGRiOi8vYXNzZXRzLyoqJyxcclxuICAgICAgICBsaW1pdDogJ+acgOWkmui/lOWbnuadoeaVsO+8jOm7mOiupCA1MCcsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICBwYXR0ZXJuOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i3r+W+hOWMuemFje+8iGdsb2Jz77yJ77yM6buY6K6kIGRiOi8vYXNzZXRzLyoqJyB9LFxyXG4gICAgICAgICAgICBsaW1pdDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfmnIDlpJrov5Tlm57mnaHmlbDvvIzpu5jorqQgNTAnIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm4gPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3BhdHRlcm4nLCAnJykgfHwgJ2RiOi8vYXNzZXRzLyoqJztcclxuICAgICAgICBjb25zdCBsaW1pdCA9IHBpY2tOdW1iZXIocGFyYW1zLCAnbGltaXQnLCA1MCkgfHwgNTA7XHJcbiAgICAgICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm4gfSk7XHJcbiAgICAgICAgY29uc3QgbGlzdCA9IChhc3NldHMgfHwgW10pLnNsaWNlKDAsIGxpbWl0KS5tYXAoKGFzc2V0OiBhbnkpID0+ICh7XHJcbiAgICAgICAgICAgIHVybDogYXNzZXQudXJsLFxyXG4gICAgICAgICAgICB1dWlkOiBhc3NldC51dWlkLFxyXG4gICAgICAgICAgICB0eXBlOiBhc3NldC50eXBlLFxyXG4gICAgICAgICAgICBmaWxlOiBhc3NldC5maWxlLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm4geyBwYXR0ZXJuLCB0b3RhbDogKGFzc2V0cyB8fCBbXSkubGVuZ3RoLCBsaXN0ZWQ6IGxpc3QubGVuZ3RoLCBhc3NldHM6IGxpc3QgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBhc3NldERlbGV0ZTogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcclxuICAgIG5hbWU6ICdhc3NldC5kZWxldGUnLFxyXG4gICAgdGl0bGU6ICfliKDpmaTotYTmupAnLFxyXG4gICAgZGVzY3JpcHRpb246ICfliKDpmaQgYXNzZXRzIOS4i+eahOi1hOa6kO+8iOiEmuacrCAvIOmihOWItuS9kyAvIOi0tOWbvuetie+8ie+8jOS8oCB1dWlkIOaIliBkYjovLyDot6/lvoQnLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgdXVpZDogJ+i1hOa6kCB1dWlkJyxcclxuICAgICAgICB1cmw6ICfotYTmupDot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvc2NyaXB0cy9QbGF5ZXIudHMnLFxyXG4gICAgfSxcclxuICAgIHNjaGVtYToge1xyXG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgdXVpZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfotYTmupAgdXVpZCcgfSxcclxuICAgICAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+i1hOa6kOi3r+W+hCBkYjovLy4uLicgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IHBpY2tTdHJpbmcocGFyYW1zLCAndXVpZCcsICcnKS50cmltKCk7XHJcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmICghdXVpZCAmJiAhdXJsKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIHV1aWQg5oiWIHVybCcpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IHRhcmdldCA9IHV1aWQ7XHJcbiAgICAgICAgaWYgKCF0YXJnZXQpIHtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXRzOiBhbnlbXSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoQVNTRVRfREIsICdxdWVyeS1hc3NldHMnLCB7IHBhdHRlcm46IHVybCB9KTtcclxuICAgICAgICAgICAgY29uc3QgaGl0ID0gKGFzc2V0cyB8fCBbXSkuZmluZCgoYXNzZXQ6IGFueSkgPT4gYXNzZXQudXJsID09PSB1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIWhpdCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDmib7kuI3liLDotYTmupA6ICR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRhcmdldCA9IGhpdC51dWlkO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2RlbGV0ZS1hc3NldCcsIHRhcmdldCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAvLyDmnInkupvniYjmnKzorqTot6/lvoTkuI3orqQgdXVpZO+8jOmAgOWbnuaMiei3r+W+hOWGjeivleS4gOasoVxyXG4gICAgICAgICAgICBpZiAoIXVybCkgdGhyb3cgZTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ2RlbGV0ZS1hc3NldCcsIHVybCk7XHJcbiAgICAgICAgICAgIHRhcmdldCA9IHVybDtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdGFyZ2V0LCB1cmw6IHVybCB8fCBudWxsLCBkZWxldGVkOiB0cnVlIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3QgYXNzZXRJbXBvcnQ6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnYXNzZXQuaW1wb3J0JyxcclxuICAgIHRpdGxlOiAn5a+85YWl6LWE5rqQ5paH5Lu2JyxcclxuICAgIGRlc2NyaXB0aW9uOlxyXG4gICAgICAgICfmiorno4Hnm5jkuIrnmoTmlofku7Yv55uu5b2V5aSN5Yi26L+bIGFzc2V0cyDlubbop6blj5EgYXNzZXQtZGIg5a+85YWl77yM6L2u6K+i5YiwIHV1aWQg5bCx57uq5ZCO6L+U5Zue77yI5ZCr5a2Q6LWE5rqQIHV1aWTvvIzlpoIgc3ByaXRlRnJhbWXvvInjgIInICtcclxuICAgICAgICAn5aSW6YOo5YaZ55uY5LiN5Lya6Kem5Y+R57yW6L6R5Zmo55qE56qX5Y+j54Sm54K55aKe6YeP5qOA5p+l77yM5b+F6aG76LWw5pys5pON5L2c77yI5oiW5omL5YqoIHJlZnJlc2gtYXNzZXTvvInvvIzlkKbliJkgdXVpZCDkuI3kvJrnlJ/miJDjgIInICtcclxuICAgICAgICAnc3JjIOecgeeVpeaXtuS4uue6r+WIt+aWsOaooeW8j++8muaWh+S7tuW3suebtOaOpeWGmei/myBhc3NldHPvvIjohJrmnKwv6LS05Zu+5Y6f5Zyw5bCx5L2N77yJ77yM5Y+q6Kem5Y+R5a+85YWl5LiN5aSN5Yi277yM6L+U5ZueIHV1aWTjgIInICtcclxuICAgICAgICAnc3JjIOS4uuebruW9leaXtumAkuW9kuWkjeWItuaVtOS4quebruW9le+8iOiHquWKqOi3s+i/hyAubWV0YSDnrYnpmpDol4/mlofku7bvvIzpgb/lhY3luKblhaXml6cgdXVpZO+8ie+8mycgK1xyXG4gICAgICAgICdkYlBhdGgg5LulIC8g57uT5bC+5oiW5peg5omp5bGV5ZCN5pe26KeG5Li655uu5qCH55uu5b2V77yM5ZCm5YiZ6KeG5Li657K+56Gu55uu5qCH5paH5Lu26Lev5b6E44CCJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIHNyYzogJ+ejgeebmOa6kOi3r+W+hO+8iOaWh+S7tuaIluebruW9le+8jOe7neWvuei3r+W+hOaIluebuOWvuemhueebruague+8ie+8m+ecgeeVpSA9IOe6r+WIt+aWsOaooeW8j++8iGRiUGF0aCDlpITmlofku7blt7LlsLHkvY3vvIknLFxyXG4gICAgICAgIGRiUGF0aDogJ+ebruaghyBkYjovL2Fzc2V0cy8uLi7vvIznm67lvZXmiJbnsr7noa7mlofku7bot6/lvoQnLFxyXG4gICAgICAgIHdhaXRUaW1lb3V0OiAn6L2u6K+i5a+85YWl57uT5p6c6LaF5pe277yI5q+r56eS77yJ77yM6buY6K6kIDE1MDAwJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHNyYzogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfno4Hnm5jmupDot6/lvoTvvIjmlofku7bmiJbnm67lvZXvvInvvJvnnIHnlaUgPSDnuq/liLfmlrDmqKHlvI8nIH0sXHJcbiAgICAgICAgICAgIGRiUGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnm67moIcgZGI6Ly9hc3NldHMvLi4uJyB9LFxyXG4gICAgICAgICAgICB3YWl0VGltZW91dDogeyB0eXBlOiAnbnVtYmVyJywgZGVzY3JpcHRpb246ICfova7or6LotoXml7bmr6vnp5LvvIzpu5jorqQgMTUwMDAnIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICByZXF1aXJlZDogWydkYlBhdGgnXSxcclxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xyXG4gICAgICAgIGNvbnN0IHNyYyA9IHBpY2tTdHJpbmcocGFyYW1zLCAnc3JjJywgJycpLnRyaW0oKTtcclxuICAgICAgICBsZXQgZGJQYXRoID0gcGlja1N0cmluZyhwYXJhbXMsICdkYlBhdGgnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGNvbnN0IHdhaXRUaW1lb3V0ID0gcGlja051bWJlcihwYXJhbXMsICd3YWl0VGltZW91dCcsIDE1MDAwKSB8fCAxNTAwMDtcclxuICAgICAgICBpZiAoIWRiUGF0aC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkgdGhyb3cgbmV3IEVycm9yKGBkYlBhdGgg5b+F6aG75ZyoIGRiOi8vYXNzZXRzLyDkuIs6ICR7ZGJQYXRofWApO1xyXG5cclxuICAgICAgICAvLyDnuq/liLfmlrDmqKHlvI/vvJrkuI3lpI3liLbvvIzlj6rlr7nlt7LlsLHkvY3nmoTmlofku7bop6blj5EgYXNzZXQtZGIg5a+85YWlXHJcbiAgICAgICAgY29uc3QgcHVyZVJlZnJlc2ggPSAhc3JjO1xyXG4gICAgICAgIGNvbnN0IHNyY0FicyA9IHB1cmVSZWZyZXNoXHJcbiAgICAgICAgICAgID8gZGJVcmxUb0FicyhkYlBhdGgpXHJcbiAgICAgICAgICAgIDogKHNyYy5zdGFydHNXaXRoKCdkYjovLycpXHJcbiAgICAgICAgICAgICAgICA/IGRiVXJsVG9BYnMoc3JjKVxyXG4gICAgICAgICAgICAgICAgOiAoc3JjLm1hdGNoKC9eW0EtWmEtel06W1xcXFwvXS8pID8gc3JjIDogam9pbihwcm9qZWN0Um9vdCgpLCBzcmMpKSk7XHJcbiAgICAgICAgY29uc3Qgc3JjU3RhdCA9IGF3YWl0IHN0YXQoc3JjQWJzKS5jYXRjaCgoKSA9PiBudWxsKTtcclxuICAgICAgICBpZiAoIXNyY1N0YXQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKHB1cmVSZWZyZXNoXHJcbiAgICAgICAgICAgICAgICA/IGDnm67moIfmlofku7bkuI3lnKjno4Hnm5jkuIrvvIzml6Dms5XliLfmlrA6ICR7c3JjQWJzfe+8iOe6r+WIt+aWsOaooeW8j+imgeaxguaWh+S7tuW3suWGmei/myBhc3NldHPvvIlgXHJcbiAgICAgICAgICAgICAgICA6IGDmupDot6/lvoTkuI3lrZjlnKg6ICR7c3JjQWJzfWApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgZGJQYXRoID0gZGJQYXRoLnJlcGxhY2UoL1xcLyskLywgJycpO1xyXG4gICAgICAgIGNvbnN0IHNyY0lzRGlyID0gc3JjU3RhdC5pc0RpcmVjdG9yeSgpO1xyXG4gICAgICAgIGNvbnN0IGRiRGlyID0gIXNyY0lzRGlyICYmIGV4dG5hbWUoZGJQYXRoKSA/IGRpcm5hbWUoZGJQYXRoKSA6IGRiUGF0aDtcclxuXHJcbiAgICAgICAgLy8g6K6h566X5aSN5Yi25riF5Y2V77ya55uu5b2V6YCS5b2S5bGV5byA77yM5paH5Lu25Y2V5p2hXHJcbiAgICAgICAgY29uc3QgaXRlbXM6IEFycmF5PHsgZnJvbTogc3RyaW5nOyB0b0Ficzogc3RyaW5nOyBkYlVybDogc3RyaW5nOyByZWw6IHN0cmluZyB9PiA9IFtdO1xyXG4gICAgICAgIGlmIChzcmNJc0Rpcikge1xyXG4gICAgICAgICAgICBjb25zdCB3YWxrID0gYXN5bmMgKGRpcjogc3RyaW5nLCByZWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBhd2FpdCByZWFkZGlyKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbG93ZXIgPSBlbnRyeS5uYW1lLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8g6Lez6L+H54K55paH5Lu25LiOIENvY29zIOeahCB4eHgudHMubWV0Ye+8iOe8lui+keWZqOiHqueUn+aIkO+8jOWvvOWFpeWug+WPquS8mueZveetiei2heaXti/luKblhaXml6cgdXVpZO+8iVxyXG4gICAgICAgICAgICAgICAgICAgIGlmIChsb3dlci5zdGFydHNXaXRoKCcuJykgfHwgbG93ZXIuZW5kc1dpdGgoJy5tZXRhJykpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZyb20gPSBqb2luKGRpciwgZW50cnkubmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2hpbGRSZWwgPSByZWwgPyBgJHtyZWx9LyR7ZW50cnkubmFtZX1gIDogZW50cnkubmFtZTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB3YWxrKGZyb20sIGNoaWxkUmVsKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtcy5wdXNoKHsgZnJvbSwgdG9BYnM6IGRiVXJsVG9BYnMoYCR7ZGJEaXJ9LyR7Y2hpbGRSZWx9YCksIGRiVXJsOiBgJHtkYkRpcn0vJHtjaGlsZFJlbH1gLCByZWw6IGNoaWxkUmVsIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgYXdhaXQgd2FsayhzcmNBYnMsICcnKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBpZiAoYmFzZW5hbWUoc3JjQWJzKS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcubWV0YScpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S4jeimgeaKiiAubWV0YSDlvZPkvZzlr7zlhaXlr7nosaHvvIjnvJbovpHlmajoh6rnlJ/miJDmlofku7bvvInvvJvnm7TmjqXlr7zlhaXlr7nlupTnmoTotYTmupDmlofku7bljbPlj68nKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBmaWxlTmFtZSA9IGJhc2VuYW1lKHNyY0Ficyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGRiVXJsID0gZXh0bmFtZShkYlBhdGgpID8gZGJQYXRoIDogYCR7ZGJEaXJ9LyR7ZmlsZU5hbWV9YDtcclxuICAgICAgICAgICAgaXRlbXMucHVzaCh7IGZyb206IHNyY0FicywgdG9BYnM6IGRiVXJsVG9BYnMoZGJVcmwpLCBkYlVybCwgcmVsOiBmaWxlTmFtZSB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihg5rqQ55uu5b2V6YeM5rKh5pyJ5Y+v5aSN5Yi255qE5paH5Lu2OiAke3NyY0Fic31gKTtcclxuXHJcbiAgICAgICAgLy8g5aSN5Yi25Yiw56OB55uY77yI5rqQ5LiO55uu5qCH5ZCM6Lev5b6EID0g5paH5Lu25bey5bCx5L2N77yM6Lez6L+H5aSN5Yi25Y+q6Kem5Y+R5a+85YWl77yJXHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpc1NhbWVQYXRoKGl0ZW0uZnJvbSwgaXRlbS50b0FicykpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBhd2FpdCBta2RpcihkaXJuYW1lKGl0ZW0udG9BYnMpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgYXdhaXQgY29weUZpbGUoaXRlbS5mcm9tLCBpdGVtLnRvQWJzKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIOinpuWPkeWvvOWFpe+8muS7juebruagh+ebruW9leWQkeS4iuaJvuWIsCBhc3NldC1kYiDlt7Lnn6XnmoTmnIDov5HnpZblhYjlho3liLfmlrDvvIjmlrDnm67lvZXmnKzouqvlj6/og73ov5jmnKrlhaXlupPvvIlcclxuICAgICAgICBsZXQgcmVmcmVzaFVybCA9IGRiRGlyO1xyXG4gICAgICAgIGZvciAobGV0IGd1YXJkID0gMDsgZ3VhcmQgPCA2OyBndWFyZCsrKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUocmVmcmVzaFVybCk7XHJcbiAgICAgICAgICAgIGlmIChwYXJlbnQgPT09IHJlZnJlc2hVcmwgfHwgIXBhcmVudC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cycpKSBicmVhaztcclxuICAgICAgICAgICAgY29uc3Qga25vd246IGFueSA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoQVNTRVRfREIsICdxdWVyeS1hc3NldC1pbmZvJywgcmVmcmVzaFVybCk7XHJcbiAgICAgICAgICAgIGlmIChrbm93bikgYnJlYWs7XHJcbiAgICAgICAgICAgIHJlZnJlc2hVcmwgPSBwYXJlbnQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoQVNTRVRfREIsICdyZWZyZXNoLWFzc2V0JywgcmVmcmVzaFVybCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAvLyDkuKrliKvniYjmnKzkuI3mlK/mjIHnm67lvZXliLfmlrDvvIzpgIDlm57pgJDmlofku7bliLfmlrBcclxuICAgICAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKEFTU0VUX0RCLCAncmVmcmVzaC1hc3NldCcsIGl0ZW0uZGJVcmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyDova7or6Llr7zlhaXnu5PmnpzvvIzmlLbpm4YgdXVpZCDkuI7lrZDotYTmupDvvIhzcHJpdGVGcmFtZSDnrYnvvIlcclxuICAgICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB3YWl0VGltZW91dDtcclxuICAgICAgICBjb25zdCBmaWxlczogYW55W10gPSBbXTtcclxuICAgICAgICBsZXQgcmVhZHkgPSB0cnVlO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBsZXQgYXNzZXRJbmZvOiBhbnkgPSBudWxsO1xyXG4gICAgICAgICAgICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XHJcbiAgICAgICAgICAgICAgICBhc3NldEluZm8gPSBhd2FpdCAoRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCBhcyBhbnkpKEFTU0VUX0RCLCAncXVlcnktYXNzZXQtaW5mbycsIGl0ZW0uZGJVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGFzc2V0SW5mbykgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBzbGVlcCgzMDApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghYXNzZXRJbmZvKSB7XHJcbiAgICAgICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgZmlsZXMucHVzaCh7IHNyYzogaXRlbS5mcm9tLCB1cmw6IGl0ZW0uZGJVcmwsIHJlbDogaXRlbS5yZWwsIHJlYWR5OiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBzdWJBc3NldHM6IGFueVtdID0gQXJyYXkuaXNBcnJheShhc3NldEluZm8uc3ViQXNzZXRzKVxyXG4gICAgICAgICAgICAgICAgPyBhc3NldEluZm8uc3ViQXNzZXRzLm1hcCgoc3ViOiBhbnkpID0+ICh7IG5hbWU6IHN1Yi5uYW1lLCB1cmw6IHN1Yi51cmwsIHV1aWQ6IHN1Yi51dWlkLCB0eXBlOiBzdWIudHlwZSB9KSlcclxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFzdWJBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIC8vIOWFnOW6le+8muWtkOi1hOa6kCB1cmwg5b2i5aaCIDzotYTmupB1cmw+LzzlkI3lrZc+77yM55SoIHF1ZXJ5LWFzc2V0cyDmn6VcclxuICAgICAgICAgICAgICAgIGNvbnN0IHN1YnM6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogYCR7aXRlbS5kYlVybH0vKmAgfSk7XHJcbiAgICAgICAgICAgICAgICBzdWJBc3NldHMgPSAoc3VicyB8fCBbXSkubWFwKChzdWI6IGFueSkgPT4gKHtcclxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBzdWIudXJsLnNsaWNlKGl0ZW0uZGJVcmwubGVuZ3RoICsgMSksXHJcbiAgICAgICAgICAgICAgICAgICAgdXJsOiBzdWIudXJsLFxyXG4gICAgICAgICAgICAgICAgICAgIHV1aWQ6IHN1Yi51dWlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IHN1Yi50eXBlLFxyXG4gICAgICAgICAgICAgICAgfSkpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbGVzLnB1c2goeyBzcmM6IGl0ZW0uZnJvbSwgdXJsOiBpdGVtLmRiVXJsLCByZWw6IGl0ZW0ucmVsLCByZWFkeTogdHJ1ZSwgdXVpZDogYXNzZXRJbmZvLnV1aWQsIHR5cGU6IGFzc2V0SW5mby50eXBlLCBzdWJBc3NldHMgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4geyByZWFkeSwgZGlyVXJsOiBkYkRpciwgcmVmcmVzaFVybCwgY291bnQ6IGl0ZW1zLmxlbmd0aCwgZmlsZXMgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBzY2VuZVNjcmlwdEluZm86IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnc2NlbmUuc2NyaXB0LmluZm8nLFxyXG4gICAgdGl0bGU6ICflnLrmma/ohJrmnKzpgJrpgZMgwrcg5byV5pOO5L+h5oGvJyxcclxuICAgIGRlc2NyaXB0aW9uOiAn6YCa6L+HIHNjZW5lL2V4ZWN1dGUtc2NlbmUtc2NyaXB0IOi/m+WFpeWcuuaZr+i/m+eoi++8jOivu+WPluW8leaTjuS4juWcuuaZr+S/oeaBrycsXHJcbiAgICBwYXJhbXM6IHt9LFxyXG4gICAgc2NoZW1hOiBub1BhcmFtcygpLFxyXG4gICAgYXN5bmMgcnVuKCkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnZW5naW5lSW5mbycsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtdLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJldHVybiB7IHNjcmlwdFJlc3VsdDogcmVzdWx0IH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3Qgc2NlbmVTY3JpcHREZW1vOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ3NjZW5lLnNjcmlwdC5kZW1vJyxcclxuICAgIHRpdGxlOiAn5Zy65pmv6ISa5pys6YCa6YGTIMK3IOW7uuiKgueCuScsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+mAmui/h+WcuuaZr+iEmuacrOeUqOW8leaTjiBBUEkg5Zyo5b2T5YmN5Zy65pmv5Yib5bu65LiA5Liq6IqC54K5JyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIG5hbWU6ICfoioLngrnlkI3vvIzpu5jorqQgTUNQX0VuZ2luZV9Ob2RlJyxcclxuICAgICAgICB4OiAneCDlnZDmoIcnLFxyXG4gICAgICAgIHk6ICd5IOWdkOaghycsXHJcbiAgICAgICAgejogJ3og5Z2Q5qCHJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIG5hbWU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K55ZCNJyB9LFxyXG4gICAgICAgICAgICB4OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3gg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB5OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3kg5Z2Q5qCHJyB9LFxyXG4gICAgICAgICAgICB6OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ3og5Z2Q5qCHJyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBjb25zdCBuYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICduYW1lJywgJycpIHx8ICdNQ1BfRW5naW5lX05vZGUnO1xyXG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0ge1xyXG4gICAgICAgICAgICB4OiBwaWNrTnVtYmVyKHBhcmFtcywgJ3gnLCAwKSxcclxuICAgICAgICAgICAgeTogcGlja051bWJlcihwYXJhbXMsICd5JywgMCksXHJcbiAgICAgICAgICAgIHo6IHBpY2tOdW1iZXIocGFyYW1zLCAneicsIDApLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdjcmVhdGVOb2RlJyxcclxuICAgICAgICAgICAgYXJnczogW25hbWUsIHBvc2l0aW9uXSxcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4geyBzY3JpcHRSZXN1bHQ6IHJlc3VsdCB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6ISa5pysIC8g57uE5Lu2XHJcblxyXG4vKiog562J5b6F5p+Q5Liq6ISa5pys6LWE5rqQ6KKrIENyZWF0b3Ig57yW6K+R5bm25rOo5YaM5Li6IGNjY2xhc3MgKi9cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjcmlwdENvbXBpbGVkKGFzc2V0VXVpZDogc3RyaW5nLCB0aW1lb3V0TXMgPSAzMDAwMCk6IFByb21pc2U8YW55IHwgbnVsbD4ge1xyXG4gICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydCA8IHRpbWVvdXRNcykge1xyXG4gICAgICAgIGNvbnN0IGxpc3Q6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LWNvbXBvbmVudHMnKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IChsaXN0IHx8IFtdKS5maW5kKChpdGVtKSA9PiBpdGVtICYmIGl0ZW0uYXNzZXRVdWlkID09PSBhc3NldFV1aWQpO1xyXG4gICAgICAgIGlmIChmb3VuZCkgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDmiorlsZ7mgKfpu5jorqTlgLzmuLLmn5PmiJDlj6/nvJbor5HnmoTmupDnoIHlrZfpnaLph4/jgIJcclxuICpcclxuICog5LmL5YmN5piv5oqKIGRlZmF1bHQg5Y6f5qC35ou86L+b5rqQ56CB77yM5a2X56ym5Liy6buY6K6k5YC85Lya5ryP5o6J5byV5Y+377yaXHJcbiAqICAgc3RyZWV0TmFtZTogc3RyaW5nID0g6KGX5LiKOyAgIOKGkiDnvJbor5HmiJAgYHJldHVybiDooZfkuIo7YO+8jOe7hOS7tuaehOmAoOaXtiBSZWZlcmVuY2VFcnJvclxyXG4gKiDov5nph4zmjInnsbvlnovooaXpvZDlrZfpnaLph4/lhpnms5XvvIzlrZfnrKbkuLLpu5jorqTotbAgSlNPTi5zdHJpbmdpZnnjgIJcclxuICovXHJcbmZ1bmN0aW9uIHJlbmRlckRlZmF1bHQocHJvcDogYW55LCB0eXBlOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKHByb3AuZGVmYXVsdCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgcmV0dXJuIHR5cGUgPT09ICdudW1iZXInID8gJzAnIDogdHlwZSA9PT0gJ3N0cmluZycgPyBcIicnXCIgOiAnbnVsbCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCByYXcgPSBTdHJpbmcocHJvcC5kZWZhdWx0KTtcclxuICAgIGlmICh0eXBlID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIC8vIOiwg+eUqOaWueW3sue7j+WGmeS6huWtl+mdoumHj++8iOW4puW8leWPty/lj43lvJXlj7fvvInlsLHljp/moLfkv53nlZnvvIzlkKbliJnmjInlrZfnrKbkuLLlrZfpnaLph4/ovpPlh7pcclxuICAgICAgICByZXR1cm4gL15bJ1wiYF0vLnRlc3QocmF3KSA/IHJhdyA6IEpTT04uc3RyaW5naWZ5KHJhdyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmF3O1xyXG59XHJcblxyXG4vKiog55Sf5oiQ5rqQ56CB5pe26ZyA6KaB6Ieq5Yqo6KGl6L+bIGNjIGltcG9ydCDnmoTluLjnlKjnsbvlnovooaggKi9cclxuY29uc3QgQ0NfVFlQRV9OQU1FUzogc3RyaW5nW10gPSBbXHJcbiAgICAnTm9kZScsICdMYWJlbCcsICdCdXR0b24nLCAnU3ByaXRlJywgJ1Nwcml0ZUZyYW1lJywgJ1Nwcml0ZUF0bGFzJywgJ1RvZ2dsZScsICdMYXlvdXQnLCAnV2lkZ2V0JyxcclxuICAgICdTY3JvbGxWaWV3JywgJ0VkaXRCb3gnLCAnU2xpZGVyJywgJ1Byb2dyZXNzQmFyJywgJ0dyYXBoaWNzJywgJ0FuaW1hdGlvbicsICdBdWRpb1NvdXJjZScsXHJcbiAgICAnVmVjMicsICdWZWMzJywgJ0NvbG9yJywgJ1NpemUnLCAnUHJlZmFiJywgJ01hc2snLCAnUmljaFRleHQnLCAnVUlPcGFjaXR5JywgJ0V2ZW50SGFuZGxlcicsXHJcbl07XHJcblxyXG4vKiog5LuO5bGe5oCn5aOw5piO5LiO57G75L2T6YeM5pS26ZuG55So5Yiw55qEIGNjIOexu+Wei++8jOeUn+aIkCBpbXBvcnQg5YiX6KGoICovXHJcbmZ1bmN0aW9uIGNvbGxlY3RDY1R5cGVzKHByb3BlcnRpZXM6IGFueVtdLCBib2R5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCB1c2VkID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IHByb3Agb2YgcHJvcGVydGllcyB8fCBbXSkge1xyXG4gICAgICAgIGNvbnN0IHR5cGUgPSBTdHJpbmcocHJvcD8udHlwZSB8fCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmIChDQ19UWVBFX05BTUVTLmluY2x1ZGVzKHR5cGUpKSB1c2VkLmFkZCh0eXBlKTtcclxuICAgIH1cclxuICAgIGlmIChib2R5KSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIENDX1RZUEVfTkFNRVMpIHtcclxuICAgICAgICAgICAgaWYgKG5ldyBSZWdFeHAoYFxcXFxiJHtuYW1lfVxcXFxiYCkudGVzdChib2R5KSkgdXNlZC5hZGQobmFtZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIEFycmF5LmZyb20odXNlZCkuc29ydCgpO1xyXG59XHJcblxyXG4vKiog55Sf5oiQ6ISa5pys5rqQ56CBICovXHJcbmZ1bmN0aW9uIGJ1aWxkU2NyaXB0U291cmNlKGNsYXNzTmFtZTogc3RyaW5nLCBwcm9wZXJ0aWVzOiBhbnlbXSwgYm9keTogc3RyaW5nLCBpbXBvcnRzOiBzdHJpbmdbXSA9IFtdKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHByb3BMaW5lcyA9IChwcm9wZXJ0aWVzIHx8IFtdKVxyXG4gICAgICAgIC5tYXAoKHByb3ApID0+IHtcclxuICAgICAgICAgICAgY29uc3QgdHlwZSA9IHByb3AudHlwZSB8fCAnbnVtYmVyJztcclxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSByZW5kZXJEZWZhdWx0KHByb3AsIHR5cGUpO1xyXG4gICAgICAgICAgICByZXR1cm4gYCAgICBAcHJvcGVydHlcXG4gICAgJHtwcm9wLm5hbWV9OiAke3R5cGV9ID0gJHt2YWx1ZX07YDtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5qb2luKCdcXG4nKTtcclxuXHJcbiAgICBjb25zdCBleHRyYVR5cGVzID0gY29sbGVjdENjVHlwZXMocHJvcGVydGllcyB8fCBbXSwgYm9keSk7XHJcbiAgICBjb25zdCBpbXBvcnRMaW5lID0gZXh0cmFUeXBlcy5sZW5ndGhcclxuICAgICAgICA/IGBpbXBvcnQgeyBfZGVjb3JhdG9yLCBDb21wb25lbnQsICR7ZXh0cmFUeXBlcy5qb2luKCcsICcpfSB9IGZyb20gJ2NjJztgXHJcbiAgICAgICAgOiBgaW1wb3J0IHsgX2RlY29yYXRvciwgQ29tcG9uZW50IH0gZnJvbSAnY2MnO2A7XHJcblxyXG4gICAgcmV0dXJuIFtcclxuICAgICAgICBpbXBvcnRMaW5lLFxyXG4gICAgICAgIC4uLihpbXBvcnRzIHx8IFtdKS5maWx0ZXIoKGxpbmUpID0+IHR5cGVvZiBsaW5lID09PSAnc3RyaW5nJyAmJiBsaW5lLnRyaW0oKSksXHJcbiAgICAgICAgYGNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHkgfSA9IF9kZWNvcmF0b3I7YCxcclxuICAgICAgICBgYCxcclxuICAgICAgICBgQGNjY2xhc3MoJyR7Y2xhc3NOYW1lfScpYCxcclxuICAgICAgICBgZXhwb3J0IGNsYXNzICR7Y2xhc3NOYW1lfSBleHRlbmRzIENvbXBvbmVudCB7YCxcclxuICAgICAgICBwcm9wTGluZXMsXHJcbiAgICAgICAgcHJvcExpbmVzID8gYGAgOiBgYCxcclxuICAgICAgICBgICAgIHN0YXJ0KCkge2AsXHJcbiAgICAgICAgYCAgICAgICAgY29uc29sZS5sb2coJ1ske2NsYXNzTmFtZX1dIHN0YXJ0Jyk7YCxcclxuICAgICAgICBgICAgIH1gLFxyXG4gICAgICAgIGJvZHkgPyBgYCA6IGBgLFxyXG4gICAgICAgIGJvZHkgfHwgYGAsXHJcbiAgICAgICAgYH1gLFxyXG4gICAgICAgIGBgLFxyXG4gICAgXS5qb2luKCdcXG4nKTtcclxufVxyXG5cclxuY29uc3Qgc2NyaXB0Q3JlYXRlOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ3NjcmlwdC5jcmVhdGUnLFxyXG4gICAgdGl0bGU6ICfliJvlu7rohJrmnKwnLFxyXG4gICAgZGVzY3JpcHRpb246ICflnKggYXNzZXRzIOS4i+WIm+W7uuS4gOS4qiBUeXBlU2NyaXB0IOiEmuacrO+8iOiHquWKqOaMgiBjY2NsYXNz77yJ77yM5bm2562J5b6F5a6D6KKrIENyZWF0b3Ig57yW6K+R5rOo5YaM77yM6L+U5ZueIGNpZCcsXHJcbiAgICBwYXJhbXM6IHtcclxuICAgICAgICBwYXRoOiAn6ISa5pys6Lev5b6E77yM5aaCIGRiOi8vYXNzZXRzL3NjcmlwdHMvUGxheWVyLnRz77yb55WZ56m65YiZ55SoIGRiOi8vYXNzZXRzL3NjcmlwdHMvPOexu+WQjT4udHMnLFxyXG4gICAgICAgIGNsYXNzTmFtZTogJ+exu+WQje+8jOm7mOiupOWPluaWh+S7tuWQjScsXHJcbiAgICAgICAgcHJvcGVydGllczogJ+WxnuaAp+WjsOaYjuaVsOe7hO+8jOW9ouWmgiBbe1wibmFtZVwiOlwic3BlZWRcIixcInR5cGVcIjpcIm51bWJlclwiLFwiZGVmYXVsdFwiOjF9XScsXHJcbiAgICAgICAgYm9keTogJ+mineWklueahOexu+S9k+S7o+egge+8jOebtOaOpeaPkuWFpeWIsCBjbGFzcyDph4wnLFxyXG4gICAgICAgIGltcG9ydHM6ICfpop3lpJbnmoQgaW1wb3J0IOivreWPpeaVsOe7hO+8iOW8leeUqOWFtuS7lueUqOaIt+iEmuacrOaXtueUqO+8ie+8jOmAkOihjOaPkuWIsCBjYyBpbXBvcnQg5LmL5ZCOJyxcclxuICAgICAgICBvdmVyd3JpdGU6ICflkIzlkI3mlofku7blt7LlrZjlnKjml7bmmK/lkKbopobnm5bvvIzpu5jorqQgZmFsc2UnLFxyXG4gICAgfSxcclxuICAgIHNjaGVtYToge1xyXG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgcGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfohJrmnKzot6/lvoTvvIzlpoIgZGI6Ly9hc3NldHMvc2NyaXB0cy9QbGF5ZXIudHMnIH0sXHJcbiAgICAgICAgICAgIGNsYXNzTmFtZTogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnsbvlkI3vvIzpu5jorqTlj5bmlofku7blkI0nIH0sXHJcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgICAgIHR5cGU6ICdhcnJheScsXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+WxnuaAp+WjsOaYjuaVsOe7hCcsXHJcbiAgICAgICAgICAgICAgICBpdGVtczoge1xyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogeyB0eXBlOiAnc3RyaW5nJyB9LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiB7IHR5cGU6ICdzdHJpbmcnIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6IHt9LFxyXG4gICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBib2R5OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+mineWklueahOexu+S9k+S7o+eggScgfSxcclxuICAgICAgICAgICAgaW1wb3J0czoge1xyXG4gICAgICAgICAgICAgICAgdHlwZTogJ2FycmF5JyxcclxuICAgICAgICAgICAgICAgIGl0ZW1zOiB7IHR5cGU6ICdzdHJpbmcnIH0sXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+mineWklueahCBpbXBvcnQg6K+t5Y+l77yM6YCQ6KGM5Y6f5qC35o+S5YWl5YiwIGNjIGltcG9ydCDkuYvlkI4nLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBvdmVyd3JpdGU6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WQjOWQjeaWh+S7tuW3suWtmOWcqOaXtuaYr+WQpuimhueblicgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgbGV0IHBhdGggPSBwaWNrU3RyaW5nKHBhcmFtcywgJ3BhdGgnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGNvbnN0IG92ZXJ3cml0ZSA9IHBhcmFtcz8ub3ZlcndyaXRlID09PSB0cnVlO1xyXG5cclxuICAgICAgICBpZiAoIXBhdGgpIHtcclxuICAgICAgICAgICAgY29uc3QgY2xhc3NOYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICdjbGFzc05hbWUnLCAnJykudHJpbSgpIHx8ICdNY3BTY3JpcHQnO1xyXG4gICAgICAgICAgICBwYXRoID0gYGRiOi8vYXNzZXRzL3NjcmlwdHMvJHtjbGFzc05hbWV9LnRzYDtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCEvXFwudHMkLy50ZXN0KHBhdGgpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg6ISa5pys6Lev5b6E5b+F6aG75LulIC50cyDnu5PlsL46ICR7cGF0aH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzLycpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg6ISa5pys5b+F6aG75Yib5bu65ZyoIGRiOi8vYXNzZXRzLyDkuIs6ICR7cGF0aH1gKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IGZpbGVOYW1lID0gcGF0aC5zbGljZShwYXRoLmxhc3RJbmRleE9mKCcvJykgKyAxKS5yZXBsYWNlKC9cXC50cyQvLCAnJyk7XHJcbiAgICAgICAgY29uc3QgY2xhc3NOYW1lID0gcGlja1N0cmluZyhwYXJhbXMsICdjbGFzc05hbWUnLCAnJykudHJpbSgpIHx8IGZpbGVOYW1lO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGJ1aWxkU2NyaXB0U291cmNlKFxyXG4gICAgICAgICAgICBjbGFzc05hbWUsXHJcbiAgICAgICAgICAgIHBhcmFtcz8ucHJvcGVydGllcyB8fCBbXSxcclxuICAgICAgICAgICAgcGlja1N0cmluZyhwYXJhbXMsICdib2R5JywgJycpLFxyXG4gICAgICAgICAgICBBcnJheS5pc0FycmF5KHBhcmFtcz8uaW1wb3J0cykgPyBwYXJhbXMuaW1wb3J0cyA6IFtdXHJcbiAgICAgICAgKTtcclxuXHJcbiAgICAgICAgLy8gb3ZlcndyaXRlPXRydWXvvJrlhYjliKDpmaTlkIzlkI3ml6fotYTmupDlho3liJvlu7rvvIjkuI3nhLYgY3JlYXRlLWFzc2V0IOS8muWboOaWh+S7tuW3suWtmOWcqOi/lOWbnuepuu+8iVxyXG4gICAgICAgIGlmIChvdmVyd3JpdGUpIHtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3Rpbmc6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogcGF0aCB9KTtcclxuICAgICAgICAgICAgY29uc3QgaGl0ID0gKGV4aXN0aW5nIHx8IFtdKS5maW5kKChhc3NldDogYW55KSA9PiBhc3NldC51cmwgPT09IHBhdGgpO1xyXG4gICAgICAgICAgICBpZiAoaGl0KSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnZGVsZXRlLWFzc2V0JywgaGl0LnV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBjcmVhdGVkOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KEFTU0VUX0RCLCAnY3JlYXRlLWFzc2V0JywgcGF0aCwgc291cmNlKTtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBjcmVhdGUtYXNzZXQg5rKh5pyJ6L+U5Zue6LWE5rqQ5L+h5oGvOiAke3BhdGh977yI5ZCM5ZCN5paH5Lu25bey5a2Y5Zyo77yf5Y+v5LygIG92ZXJ3cml0ZT10cnVlIOimhueblu+8iWApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgdXVpZCA9IGNyZWF0ZWQudXVpZDtcclxuICAgICAgICBjb25zdCBjb21waWxlZCA9IGF3YWl0IHdhaXRGb3JTY3JpcHRDb21waWxlZCh1dWlkLCAzMDAwMCk7XHJcbiAgICAgICAgaWYgKCFjb21waWxlZCkge1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgdXVpZCxcclxuICAgICAgICAgICAgICAgIHVybDogY3JlYXRlZC51cmwsXHJcbiAgICAgICAgICAgICAgICBwYXRoLFxyXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxyXG4gICAgICAgICAgICAgICAgY29tcGlsZWQ6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICfohJrmnKzlt7LlhpnlhaXvvIzkvYYgMzAg56eS5YaF5rKh5pyJ5Zyo57yW6L6R5Zmo6YeM5a6M5oiQ57yW6K+R5rOo5YaM77yI5Y+v6IO96K+t5rOV6ZSZ6K+v77yM5oiW57yW6L6R5Zmo5pyq5Zyo57yW6K+R77yJJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHV1aWQsXHJcbiAgICAgICAgICAgIHVybDogY3JlYXRlZC51cmwsXHJcbiAgICAgICAgICAgIHBhdGgsXHJcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcclxuICAgICAgICAgICAgY29tcGlsZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIGNpZDogY29tcGlsZWQuY2lkLFxyXG4gICAgICAgICAgICBuYW1lOiBjb21waWxlZC5uYW1lLFxyXG4gICAgICAgICAgICBjb21wb25lbnRQYXRoOiBjb21waWxlZC5wYXRoLFxyXG4gICAgICAgIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3Qgc2NyaXB0TGlzdDogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcclxuICAgIG5hbWU6ICdzY3JpcHQubGlzdCcsXHJcbiAgICB0aXRsZTogJ+WIl+WHuuiEmuacrOe7hOS7ticsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+WIl+WHuue8lui+keWZqOmHjOW3suazqOWGjOeahOWFqOmDqOe7hOS7tu+8iOWGhee9riArIOeUqOaIt+iEmuacrO+8ie+8jOW4piBjaWQgLyBwYXRoIC8gYXNzZXRVdWlkJyxcclxuICAgIHBhcmFtczoge30sXHJcbiAgICBzY2hlbWE6IG5vUGFyYW1zKCksXHJcbiAgICBhc3luYyBydW4oKSB7XHJcbiAgICAgICAgY29uc3QgbGlzdDogYW55W10gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktY29tcG9uZW50cycpO1xyXG4gICAgICAgIGNvbnN0IGl0ZW1zID0gKGxpc3QgfHwgW10pLm1hcCgoaXRlbSkgPT4gKHtcclxuICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lLFxyXG4gICAgICAgICAgICBjaWQ6IGl0ZW0uY2lkLFxyXG4gICAgICAgICAgICBwYXRoOiBpdGVtLnBhdGgsXHJcbiAgICAgICAgICAgIGFzc2V0VXVpZDogaXRlbS5hc3NldFV1aWQsXHJcbiAgICAgICAgICAgIGlzU2NyaXB0OiAhIWl0ZW0uYXNzZXRVdWlkLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm4geyB0b3RhbDogaXRlbXMubGVuZ3RoLCBjb21wb25lbnRzOiBpdGVtcyB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbmNvbnN0IG5vZGVBZGRDb21wb25lbnQ6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5hZGRDb21wb25lbnQnLFxyXG4gICAgdGl0bGU6ICfmjILovb3nu4Tku7YnLFxyXG4gICAgZGVzY3JpcHRpb246ICfnu5noioLngrnmjILnu4Tku7bvvJrlhoXnva7nu4Tku7bkvKAgY2MuU3ByaXRlIOS5i+exu++8jOeUqOaIt+iEmuacrOS8oCBzY3JpcHQubGlzdCDmn6XliLDnmoQgY2lkJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIG5vZGU6ICfoioLngrkgdXVpZO+8jOeVmeepuuWImeeUqOW9k+WJjemAieS4reiKgueCuScsXHJcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu2IGNpZCDmiJbnsbvlkI3vvIzlpoIgY2MuU3ByaXRlIC8gZmNtUjNYQUROTGdKMUJ5S2hxY0M1WicsXHJcbiAgICB9LFxyXG4gICAgc2NoZW1hOiB7XHJcbiAgICAgICAgdHlwZTogJ29iamVjdCcsXHJcbiAgICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgICAgICBub2RlOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyB9LFxyXG4gICAgICAgICAgICBjb21wb25lbnQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn57uE5Lu2IGNpZCDmiJbnsbvlkI0nIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICByZXF1aXJlZDogWydjb21wb25lbnQnXSxcclxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHBpY2tTdHJpbmcocGFyYW1zLCAnY29tcG9uZW50JywgJycpLnRyaW0oKTtcclxuICAgICAgICBpZiAoIWNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiBjb21wb25lbnQnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IG5vZGUgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ25vZGUnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGdldFNlbGVjdGVkTm9kZVV1aWRzKCk7XHJcbiAgICAgICAgICAgIG5vZGUgPSBzZWxlY3RlZFswXSB8fCAnJztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ5oyH5a6a6IqC54K577yM5Lmf5rKh5pyJ6YCJ5Lit5Lu75L2V6IqC54K5Jyk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyDluYLnrYnvvJrlkIzoioLngrnkuI3lhYHorrjlkIznsbvlnovnu4Tku7bph43lpI3mjILovb3vvIzlhYjmn6Xlt7LmnInnu4Tku7bvvIzlkb3kuK3lsLHnm7TmjqXov5Tlm57vvIxcclxuICAgICAgICAvLyDpgb/lhY3nvJbovpHlmajmiZPljbAgXCJDYW4ndCBhZGQgY29tcG9uZW50IC4uLiBhbHJlYWR5IGNvbnRhaW5zIHRoZSBzYW1lIGNvbXBvbmVudFwiIOitpuWRiuW5tuaxoeafkyB1bmRvXHJcbiAgICAgICAgY29uc3QgY29tcHNCZWZvcmUgPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xyXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhd2FpdCByZXNvbHZlQ29tcG9uZW50Q2FuZGlkYXRlcyhjb21wb25lbnQpO1xyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWF0Y2hFeGlzdGluZ0NvbXBvbmVudChjb21wc0JlZm9yZSwgY2FuZGlkYXRlcyk7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgY2hhbm5lbDogJ25vbmUnLFxyXG4gICAgICAgICAgICAgICAgYXR0YWNoZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBhbHJlYWR5RXhpc3RzOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgZXhpc3Rpbmc6IHsgdXVpZDogZXhpc3RpbmcudXVpZCwgdHlwZTogZXhpc3RpbmcudHlwZSwgbmFtZTogZXhpc3RpbmcubmFtZSB9LFxyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50czogY29tcHNCZWZvcmUsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyDlhoXnva7nu4Tku7bvvIhjYy5TcHJpdGUg5LmL57G777yJ6LWw57yW6L6R5Zmo5raI5oGv6YCa6YGT77yM6IO96L+bIHVuZG8g5L2T57O7XHJcbiAgICAgICAgY29uc3QgaXNCdWlsdGluID0gY29tcG9uZW50LnN0YXJ0c1dpdGgoJ2NjLicpO1xyXG4gICAgICAgIGxldCBjaGFubmVsID0gJ21lc3NhZ2UnO1xyXG5cclxuICAgICAgICBpZiAoaXNCdWlsdGluKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdjcmVhdGUtY29tcG9uZW50JywgeyB1dWlkOiBub2RlLCBjb21wb25lbnQgfSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgLy8g6Ieq5a6a5LmJ6ISa5pys57uE5Lu25b+F6aG76LWw5byV5pOO77ya57yW6L6R5Zmo5raI5oGv6YCa6YGT5oyC5LiN5LiK5Y67XHJcbiAgICAgICAgICAgIGNoYW5uZWwgPSAnZW5naW5lJztcclxuICAgICAgICAgICAgY29uc3Qgc2NyaXB0UmVzdWx0OiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnYWRkQ29tcG9uZW50VG9Ob2RlJyxcclxuICAgICAgICAgICAgICAgIGFyZ3M6IFtub2RlLCBjb21wb25lbnRdLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgaWYgKCFzY3JpcHRSZXN1bHQgfHwgc2NyaXB0UmVzdWx0Lm9rICE9PSB0cnVlKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYOaMgui9veiHquWumuS5iee7hOS7tuWksei0pe+8miR7c2NyaXB0UmVzdWx0ICYmIHNjcmlwdFJlc3VsdC5lcnJvciA/IHNjcmlwdFJlc3VsdC5lcnJvciA6ICfmnKrnn6XplJnor68nfWAgK1xyXG4gICAgICAgICAgICAgICAgICAgIChzY3JpcHRSZXN1bHQgJiYgc2NyaXB0UmVzdWx0LnJlZ2lzdGVyZWRVc2VyQ2xhc3Nlc1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGDvvJvlvJXmk47ph4zlt7Lms6jlhoznmoTnlKjmiLfnsbs6ICR7c2NyaXB0UmVzdWx0LnJlZ2lzdGVyZWRVc2VyQ2xhc3Nlcy5qb2luKCcsICcpIHx8ICco5pegKSd9YFxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6ICcnKVxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gY3JlYXRlLWNvbXBvbmVudCAvIGFkZENvbXBvbmVudCDpg73kuI3ov5Tlm57mnInmlYjlgLzvvIzlv4Xpobvlm57or7vnoa7orqRcclxuICAgICAgICBjb25zdCBjb21wcyA9IGF3YWl0IHF1ZXJ5Tm9kZUNvbXBvbmVudHMobm9kZSk7XHJcbiAgICAgICAgY29uc3QgYXR0YWNoZWQgPSBtYXRjaEV4aXN0aW5nQ29tcG9uZW50KGNvbXBzLCBjYW5kaWRhdGVzKTtcclxuICAgICAgICBpZiAoIWF0dGFjaGVkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBjb21wcy5tYXAoKGM6IGFueSkgPT4gYy50eXBlIHx8IGMubmFtZSkuam9pbignLCAnKSB8fCAnKOaXoCknO1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg57uE5Lu25rKh5pyJ55yf5q2j5oyC5LiK77ya6IqC54K5ICR7bm9kZX0g5LiK5rKh5pyJ5Ye6546w57uE5Lu244CMJHtjb21wb25lbnR944CN77yI6YCa6YGT77yaJHtjaGFubmVsfe+8ie+8m2AgK1xyXG4gICAgICAgICAgICAgICAgYOW9k+WJjee7hOS7tjogJHtjdXJyZW50fWBcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgbm9kZSwgY29tcG9uZW50LCBjaGFubmVsLCBhdHRhY2hlZDogdHJ1ZSwgY29tcG9uZW50czogY29tcHMgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBub2RlUmVtb3ZlQ29tcG9uZW50OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUucmVtb3ZlQ29tcG9uZW50JyxcclxuICAgIHRpdGxlOiAn56e76Zmk57uE5Lu2JyxcclxuICAgIGRlc2NyaXB0aW9uOiAn5oyJ57uE5Lu2IHV1aWQg56e76Zmk6IqC54K55LiK55qE57uE5Lu2JyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIGNvbXBvbmVudDogJ+e7hOS7tiB1dWlkJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7YgdXVpZCcgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHJlcXVpcmVkOiBbJ2NvbXBvbmVudCddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gcGlja1N0cmluZyhwYXJhbXMsICdjb21wb25lbnQnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmICghY29tcG9uZW50KSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIGNvbXBvbmVudCB1dWlkJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdyZW1vdmUtY29tcG9uZW50JywgeyB1dWlkOiBjb21wb25lbnQgfSk7XHJcbiAgICAgICAgcmV0dXJuIHsgY29tcG9uZW50LCByZW1vdmVkOiB0cnVlIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3Qgbm9kZUxpc3RDb21wb25lbnRzOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUubGlzdENvbXBvbmVudHMnLFxyXG4gICAgdGl0bGU6ICfliJflh7roioLngrnnu4Tku7YnLFxyXG4gICAgZGVzY3JpcHRpb246ICfliJflh7rmn5DkuKroioLngrnkuIrmjILnmoTmiYDmnInnu4Tku7YnLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlk77yM55WZ56m65YiZ55So5b2T5YmN6YCJ5Lit6IqC54K5JyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIG5vZGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWTvvIznlZnnqbrliJnnlKjlvZPliY3pgInkuK3oioLngrknIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UsXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcnVuKHBhcmFtcykge1xyXG4gICAgICAgIGxldCBub2RlID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBnZXRTZWxlY3RlZE5vZGVVdWlkcygpO1xyXG4gICAgICAgICAgICBub2RlID0gc2VsZWN0ZWRbMF0gfHwgJyc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeacieaMh+WumuiKgueCue+8jOS5n+ayoeaciemAieS4reS7u+S9leiKgueCuScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kTm9kZUluVHJlZSh0cmVlLCBub2RlKTtcclxuICAgICAgICBpZiAoIWZvdW5kKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5Zy65pmv5qCR6YeM5om+5LiN5Yiw6IqC54K5ICR7bm9kZX1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcHMgPSByZWFkTm9kZUNvbXBvbmVudHMoZm91bmQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgIG5vZGVOYW1lOiBkdW1wVmFsdWU8c3RyaW5nPihmb3VuZC5uYW1lLCAnJyksXHJcbiAgICAgICAgICAgIGNvdW50OiBjb21wcy5sZW5ndGgsXHJcbiAgICAgICAgICAgIGNvbXBvbmVudHM6IGNvbXBzLFxyXG4gICAgICAgIH07XHJcbiAgICB9LFxyXG59O1xyXG5cclxuY29uc3Qgbm9kZURlYnVnOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ25vZGUuZGVidWcnLFxyXG4gICAgdGl0bGU6ICfosIPor5XvvJrljp/lp4voioLngrkgZHVtcCcsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+i/lOWbnuiKgueCueWcqOe8lui+keWZqCBkdW1wIOmHjOeahOWOn+Wni+Wtl+aute+8jOeUqOadpeaRuOa4hSAzLjguOCDnnJ/lrp7nmoTnu4Tku7blrZfmrrXlkI0nLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgbm9kZTogJ+iKgueCuSB1dWlkJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIG5vZGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWQnIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICByZXF1aXJlZDogWydub2RlJ10sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcclxuICAgICAgICBpZiAoIXV1aWQpIHRocm93IG5ldyBFcnJvcign5b+F6aG75oyH5a6aIG5vZGUnKTtcclxuICAgICAgICBjb25zdCB0cmVlOiBhbnkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAncXVlcnktbm9kZS10cmVlJyk7XHJcbiAgICAgICAgY29uc3QgZmluZCA9IChub2RlOiBhbnkpOiBhbnkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoZHVtcFZhbHVlPHN0cmluZz4obm9kZS51dWlkLCAnJykgPT09IHV1aWQpIHJldHVybiBub2RlO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIChub2RlLmNoaWxkcmVuIHx8IFtdKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaGl0ID0gZmluZChjaGlsZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGl0KSByZXR1cm4gaGl0O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kKHRyZWUpO1xyXG4gICAgICAgIGNvbnN0IGRpcmVjdDogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3F1ZXJ5LW5vZGUnLCB1dWlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBmb3VuZEluVHJlZTogISFmb3VuZCxcclxuICAgICAgICAgICAgdHJlZU5vZGVLZXlzOiBmb3VuZCA/IE9iamVjdC5rZXlzKGZvdW5kKSA6IFtdLFxyXG4gICAgICAgICAgICB0cmVlTm9kZTogZm91bmQgfHwgbnVsbCxcclxuICAgICAgICAgICAgZGlyZWN0UXVlcnlLZXlzOiBkaXJlY3QgPyBPYmplY3Qua2V5cyhkaXJlY3QpIDogW10sXHJcbiAgICAgICAgICAgIGRpcmVjdFF1ZXJ5OiBkaXJlY3QgfHwgbnVsbCxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g5Zy65pmv5oiq5Zu+XHJcblxyXG5jb25zdCBzY2VuZUNhcHR1cmU6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnc2NlbmUuY2FwdHVyZScsXHJcbiAgICB0aXRsZTogJ+WcuuaZr+aIquWbvicsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+aIquWPluWcuuaZr+mdouadv+inhuWPo+S4uiBiYXNlNjQgSlBFR++8iOWQq+e8lui+keWZqOe9keagvC9naXptb++8jOmdnui/kOihjOaXtueUu+mdou+8ieOAguS7heW9k+WcuuaZr+S4reWtmOWcqCBDYW52YXMg6IqC54K55pe25Y+v55So44CC6L+U5ZueIHNvdXJjZVdpZHRoL0hlaWdodCDkuLrnlLvluIPniannkIblg4/ntKDvvIxvdXRwdXRXaWR0aC9IZWlnaHQg5Li657yp5pS+5ZCO5bC65a+444CC5LygIG91dFBhdGgg5Y+v5ZCM5pe25oqK5Zu+54mH5YaZ5Yiw56OB55uY77yI57ud5a+56Lev5b6E77yJJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIG1heFc6ICfovpPlh7rlm77lrr3luqbkuIrpmZDvvIjlg4/ntKDvvInvvIzpu5jorqQgNzY4JyxcclxuICAgICAgICBvdXRQYXRoOiAn5Y+v6YCJ77ya5oqKIEpQRUcg5YaZ5Yiw6K+l57ud5a+56Lev5b6E77yI55uu5b2V5Lya6Ieq5Yqo5Yib5bu677yJJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIG1heFc6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAn6L6T5Ye65Zu+5a695bqm5LiK6ZmQ77yI5YOP57Sg77yJ77yM6buY6K6kIDc2OCcgfSxcclxuICAgICAgICAgICAgb3V0UGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflj6/pgInvvJpKUEVHIOiQveebmOeahOe7neWvuei3r+W+hCcgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgbWF4VyA9IHBpY2tOdW1iZXIocGFyYW1zLCAnbWF4VycsIDc2OCkgfHwgNzY4O1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnY2FwdHVyZVNjZW5lJyxcclxuICAgICAgICAgICAgYXJnczogW21heFddLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5vayA9PT0gZmFsc2UpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKChyZXN1bHQgJiYgcmVzdWx0LmVycm9yKSB8fCAn5Zy65pmv5oiq5Zu+5aSx6LSlJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG91dFBhdGggPSBwaWNrU3RyaW5nKHBhcmFtcywgJ291dFBhdGgnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmIChvdXRQYXRoICYmIHJlc3VsdC5iYXNlNjQpIHtcclxuICAgICAgICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShvdXRQYXRoKTtcclxuICAgICAgICAgICAgYXdhaXQgbWtkaXIoZGlybmFtZShhYnMpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgYXdhaXQgd3JpdGVGaWxlKGFicywgQnVmZmVyLmZyb20oU3RyaW5nKHJlc3VsdC5iYXNlNjQpLCAnYmFzZTY0JykpO1xyXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXN1bHQsIGJhc2U2NDogdW5kZWZpbmVkLCBzYXZlZFRvOiBhYnMgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBzY2VuZVJlb3BlbjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcclxuICAgIG5hbWU6ICdzY2VuZS5yZW9wZW4nLFxyXG4gICAgdGl0bGU6ICfph43lvIDlnLrmma8nLFxyXG4gICAgZGVzY3JpcHRpb246ICfkv53lrZjlvZPliY3lnLrmma/lkI7ph43mlrDmiZPlvIDlroPvvIzop6blj5HlnLrmma/ov5vnqIvph43mlrDlr7zlhaXnlKjmiLfohJrmnKzmqKHlnZfvvIjlpJbpg6jlhpnlhaXnmoQgLnRzIOe8luivkeWQjumcgOimgei/meS4gOatpeaJjeiDveWcqOW8leaTjumHjOaMgui9ve+8iScsXHJcbiAgICBwYXJhbXM6IHt9LFxyXG4gICAgc2NoZW1hOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSwgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH0sXHJcbiAgICBhc3luYyBydW4oKSB7XHJcbiAgICAgICAgY29uc3Qgc2F2ZTogYW55ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBjb25zdCBzdGF0dXM6IGFueSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdxdWVyeS1jdXJyZW50LXNjZW5lJyk7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IHR5cGVvZiBzdGF0dXMgPT09ICdzdHJpbmcnID8gc3RhdHVzIDogKHN0YXR1cyAmJiBzdGF0dXMudXVpZCk7XHJcbiAgICAgICAgaWYgKCF1dWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aLv+S4jeWIsOW9k+WJjeWcuuaZryB1dWlkOiAnICsgSlNPTi5zdHJpbmdpZnkoc3RhdHVzKSk7XHJcbiAgICAgICAgLy8g5bey5omT5byA5Zy65pmv55qEIG9wZW4tc2NlbmUg5Y+v6IO96KKr5b+955Wl77ya5YWI5YiH5Yiw56m65Zy65pmv5YaN5YiH5Zue77yM5by65Yi25Zy65pmv6L+b56iL6YeN6L296ISa5pys5qih5Z2XXHJcbiAgICAgICAgbGV0IGVtcHR5OiBhbnkgPSBudWxsO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVtcHR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ2xvYWQtZW1wdHktc2NlbmUnKTtcclxuICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgIGVtcHR5ID0gU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlIHx8IGUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnb3Blbi1zY2VuZScsIHV1aWQpO1xyXG4gICAgICAgIHJldHVybiB7IHNhdmVkOiBzYXZlLCBzY2VuZVV1aWQ6IHV1aWQsIGVtcHR5LCBvcGVuZWQgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBzY2VuZU9wZW46IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnc2NlbmUub3BlbicsXHJcbiAgICB0aXRsZTogJ+aJk+W8gOWcuuaZrycsXHJcbiAgICBkZXNjcmlwdGlvbjogJ+aMiSBkYjovLyDot6/lvoTmiJYgdXVpZCDmiZPlvIDmjIflrprlnLrmma/vvIjpu5jorqTlhYjkv53lrZjlvZPliY3lnLrmma/lho3liIfmjaLvvIxzYXZlQ3VycmVudD1mYWxzZSDlj6/ot7Pov4fkv53lrZjvvIknLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgdXJsOiAn5Zy65pmv6LWE5LqnIGRiOi8vIOi3r+W+hOaIliB1dWlk77yM5aaCIGRiOi8vYXNzZXRzL2xvYmJ5LnNjZW5lJyxcclxuICAgICAgICBzYXZlQ3VycmVudDogJ+WIh+aNouWJjeaYr+WQpuS/neWtmOW9k+WJjeWcuuaZr++8jOm7mOiupCB0cnVlJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHVybDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICflnLrmma/otYTkuqcgZGI6Ly8g6Lev5b6E5oiWIHV1aWQnIH0sXHJcbiAgICAgICAgICAgIHNhdmVDdXJyZW50OiB7IHR5cGU6ICdib29sZWFuJywgZGVzY3JpcHRpb246ICfpu5jorqQgdHJ1ZScgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHJlcXVpcmVkOiBbJ3VybCddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgdXJsID0gcGlja1N0cmluZyhwYXJhbXMsICd1cmwnLCAnJykudHJpbSgpO1xyXG4gICAgICAgIGlmICghdXJsKSB0aHJvdyBuZXcgRXJyb3IoJ+W/hemhu+aMh+WumiB1cmzvvIhkYjovLyDot6/lvoTmiJYgdXVpZO+8iScpO1xyXG4gICAgICAgIGxldCB1dWlkID0gdXJsO1xyXG4gICAgICAgIGlmICh1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldHM6IGFueVtdID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChBU1NFVF9EQiwgJ3F1ZXJ5LWFzc2V0cycsIHsgcGF0dGVybjogdXJsIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBoaXQgPSAoYXNzZXRzIHx8IFtdKS5maW5kKChhOiBhbnkpID0+IGEudXJsID09PSB1cmwpIHx8IChhc3NldHMgfHwgW10pWzBdO1xyXG4gICAgICAgICAgICBpZiAoIWhpdCB8fCAhaGl0LnV1aWQpIHRocm93IG5ldyBFcnJvcihg5om+5LiN5Yiw5Zy65pmv6LWE5LqnOiAke3VybH1gKTtcclxuICAgICAgICAgICAgdXVpZCA9IFN0cmluZyhoaXQudXVpZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHNhdmVDdXJyZW50ID0gcGFyYW1zPy5zYXZlQ3VycmVudCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XHJcbiAgICAgICAgaWYgKHNhdmVDdXJyZW50KSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAvLyDkv53lrZjlpLHotKXkuI3pmLvmlq3liIfmjaJcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBvcGVuLXNjZW5lIOWPr+iDveWkjeeUqOWGheWtmOmHjOeahOiEj+WcuuaZr++8iOWvueW3suWKoOi9vSB1dWlkIOS8muiiq+W/veeVpe+8ie+8muWFiOWIh+epuuWcuuaZr+W8uuWItuW5suWHgOmHjei9vVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoU0NFTkUsICdsb2FkLWVtcHR5LXNjZW5lJyk7XHJcbiAgICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChTQ0VORSwgJ29wZW4tc2NlbmUnLCB1dWlkKTtcclxuICAgICAgICByZXR1cm4geyBvcGVuZWQsIHNjZW5lVXVpZDogdXVpZCB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbmNvbnN0IHByb2plY3RTZXREZXNpZ25SZXNvbHV0aW9uOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ3Byb2plY3Quc2V0RGVzaWduUmVzb2x1dGlvbicsXHJcbiAgICB0aXRsZTogJ+iuvue9rumhueebruiuvuiuoeWIhui+qOeOhycsXHJcbiAgICBkZXNjcmlwdGlvbjpcclxuICAgICAgICAn6K6+572u6aG555uu6K6+6K6h5YiG6L6o546H77yI562J5Lu35LqOIOmhueebruiuvue9ruKGkumhueebriDpnaLmnb/vvJpFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0IOaMgeS5heWMluWIsCBzZXR0aW5ncy92Mi9wYWNrYWdlcy9wcm9qZWN0Lmpzb27vvIwnICtcclxuICAgICAgICAn5YaN5Y+RIHByb2plY3QvY2hhbmdlLWRlc2lnbi1yZXNvbHV0aW9u77yMc2NlbmUg5omp5bGV55uR5ZCs6K+l5bm/5pKt5Yi35paw55S75biD77yJ44CCJyArXHJcbiAgICAgICAgJ3dpZHRoL2hlaWdodCDlv4XloavvvIgxfjgxOTIg5pW05pWw77yJ77yMZml0V2lkdGgvZml0SGVpZ2h0IOe8uuecgeayv+eUqOW9k+WJjeWAvO+8m+i/lOWbnuWbnuivu+WAvOS4juiQveebmOagoemqjOe7k+aenOOAgicsXHJcbiAgICBwYXJhbXM6IHtcclxuICAgICAgICB3aWR0aDogJ+iuvuiuoeWIhui+qOeOh+Wuve+8jOWmgiA3MjAnLFxyXG4gICAgICAgIGhlaWdodDogJ+iuvuiuoeWIhui+qOeOh+mrmO+8jOWmgiAxMjgwJyxcclxuICAgICAgICBmaXRXaWR0aDogJ+WPr+mAieOAguaYr+WQpumAgumFjeWuveW6pu+8jOe8uuecgeayv+eUqOW9k+WJjeWAvCcsXHJcbiAgICAgICAgZml0SGVpZ2h0OiAn5Y+v6YCJ44CC5piv5ZCm6YCC6YWN6auY5bqm77yM57y655yB5rK/55So5b2T5YmN5YC8JyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHdpZHRoOiB7IHR5cGU6ICdpbnRlZ2VyJywgbWluaW11bTogMSwgbWF4aW11bTogODE5MiwgZGVzY3JpcHRpb246ICforr7orqHliIbovqjnjoflrr3vvIzlpoIgNzIwJyB9LFxyXG4gICAgICAgICAgICBoZWlnaHQ6IHsgdHlwZTogJ2ludGVnZXInLCBtaW5pbXVtOiAxLCBtYXhpbXVtOiA4MTkyLCBkZXNjcmlwdGlvbjogJ+iuvuiuoeWIhui+qOeOh+mrmO+8jOWmgiAxMjgwJyB9LFxyXG4gICAgICAgICAgICBmaXRXaWR0aDogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn5Y+v6YCJ44CC5piv5ZCm6YCC6YWN5a695bqm77yM57y655yB5rK/55So5b2T5YmN5YC8JyB9LFxyXG4gICAgICAgICAgICBmaXRIZWlnaHQ6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZXNjcmlwdGlvbjogJ+WPr+mAieOAguaYr+WQpumAgumFjemrmOW6pu+8jOe8uuecgeayv+eUqOW9k+WJjeWAvCcgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHJlcXVpcmVkOiBbJ3dpZHRoJywgJ2hlaWdodCddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3Qgd2lkdGggPSBNYXRoLnJvdW5kKHBpY2tOdW1iZXIocGFyYW1zLCAnd2lkdGgnLCAwKSk7XHJcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gTWF0aC5yb3VuZChwaWNrTnVtYmVyKHBhcmFtcywgJ2hlaWdodCcsIDApKTtcclxuICAgICAgICBpZiAoISh3aWR0aCA+PSAxICYmIHdpZHRoIDw9IDgxOTIpIHx8ICEoaGVpZ2h0ID49IDEgJiYgaGVpZ2h0IDw9IDgxOTIpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgd2lkdGgvaGVpZ2h0IOW/hemhu+aYryAxfjgxOTIg55qE5pW05pWw77yM5pS25YiwOiAke0pTT04uc3RyaW5naWZ5KHBhcmFtcz8ud2lkdGgpfSB4ICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zPy5oZWlnaHQpfWApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8g5b2T5YmN5YC877ya5a6Y5pa5IHF1ZXJ5LWRlc2lnbi1yZXNvbHV0aW9uIOa2iOaBr+S8mOWFiO+8jOWPluS4jeWIsOmAgOWbniBQcm9maWxlXHJcbiAgICAgICAgbGV0IGN1cnJlbnQ6IGFueSA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY3VycmVudCA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoJ3Byb2plY3QnLCAncXVlcnktZGVzaWduLXJlc29sdXRpb24nKTtcclxuICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgIGN1cnJlbnQgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWN1cnJlbnQgfHwgdHlwZW9mIGN1cnJlbnQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgICAgIGN1cnJlbnQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KCdwcm9qZWN0JywgJ2dlbmVyYWwuZGVzaWduUmVzb2x1dGlvbicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBiZWZvcmUgPSB7XHJcbiAgICAgICAgICAgIHdpZHRoOiBNYXRoLnJvdW5kKE51bWJlcihjdXJyZW50Py53aWR0aCkpIHx8IDAsXHJcbiAgICAgICAgICAgIGhlaWdodDogTWF0aC5yb3VuZChOdW1iZXIoY3VycmVudD8uaGVpZ2h0KSkgfHwgMCxcclxuICAgICAgICAgICAgZml0V2lkdGg6IGN1cnJlbnQ/LmZpdFdpZHRoID09PSB0cnVlLFxyXG4gICAgICAgICAgICBmaXRIZWlnaHQ6IGN1cnJlbnQ/LmZpdEhlaWdodCA9PT0gdHJ1ZSxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBjb25zdCByZXNvbHV0aW9uID0ge1xyXG4gICAgICAgICAgICB3aWR0aCxcclxuICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICBmaXRXaWR0aDogdHlwZW9mIHBhcmFtcz8uZml0V2lkdGggPT09ICdib29sZWFuJyA/IHBhcmFtcy5maXRXaWR0aCA6IGJlZm9yZS5maXRXaWR0aCxcclxuICAgICAgICAgICAgZml0SGVpZ2h0OiB0eXBlb2YgcGFyYW1zPy5maXRIZWlnaHQgPT09ICdib29sZWFuJyA/IHBhcmFtcy5maXRIZWlnaHQgOiBiZWZvcmUuZml0SGVpZ2h0LFxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIC8vIOaMgeS5heWMlu+8iHNldHRpbmdzL3YyL3BhY2thZ2VzL3Byb2plY3QuanNvbu+8ie+8jOWumOaWuSBQcm9maWxlIEFQSVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoJ3Byb2plY3QnLCAnZ2VuZXJhbC5kZXNpZ25SZXNvbHV0aW9uJywgcmVzb2x1dGlvbik7XHJcbiAgICAgICAgLy8g5bqU55So77ya5LiO6K6+572u6Z2i5p2/5ZCM5LiA5p2h5raI5oGv77yMc2NlbmUg5omp5bGV55uR5ZCs5ZCO5Yi35paw55S75biDXHJcbiAgICAgICAgYXdhaXQgKEVkaXRvci5NZXNzYWdlLnJlcXVlc3QgYXMgYW55KSgncHJvamVjdCcsICdjaGFuZ2UtZGVzaWduLXJlc29sdXRpb24nLCByZXNvbHV0aW9uKTtcclxuXHJcbiAgICAgICAgLy8g5Zue6K+76aqM6K+BXHJcbiAgICAgICAgbGV0IHF1ZXJpZWQ6IGFueSA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcXVlcmllZCA9IGF3YWl0IChFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0IGFzIGFueSkoJ3Byb2plY3QnLCAncXVlcnktZGVzaWduLXJlc29sdXRpb24nKTtcclxuICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgIHF1ZXJpZWQgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyDokL3nm5jmoKHpqozvvIhQcm9maWxlIOW8guatpeWGmeebmO+8jOeojeetieWGjeivu++8jGJlc3QgZWZmb3J077yJXHJcbiAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICBsZXQgZmlsZTogYW55ID0gbnVsbDtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByYXcgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKGpvaW4ocHJvamVjdFJvb3QoKSwgJ3NldHRpbmdzJywgJ3YyJywgJ3BhY2thZ2VzJywgJ3Byb2plY3QuanNvbicpLCAndXRmOCcpKTtcclxuICAgICAgICAgICAgZmlsZSA9IHJhdz8uZ2VuZXJhbD8uZGVzaWduUmVzb2x1dGlvbiA/PyBudWxsO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgZmlsZSA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZCA9ICEhKFxyXG4gICAgICAgICAgICBmaWxlICYmXHJcbiAgICAgICAgICAgIE51bWJlcihmaWxlLndpZHRoKSA9PT0gd2lkdGggJiZcclxuICAgICAgICAgICAgTnVtYmVyKGZpbGUuaGVpZ2h0KSA9PT0gaGVpZ2h0ICYmXHJcbiAgICAgICAgICAgIGZpbGUuZml0V2lkdGggPT09IHJlc29sdXRpb24uZml0V2lkdGggJiZcclxuICAgICAgICAgICAgZmlsZS5maXRIZWlnaHQgPT09IHJlc29sdXRpb24uZml0SGVpZ2h0XHJcbiAgICAgICAgKTtcclxuICAgICAgICByZXR1cm4geyBiZWZvcmUsIGFwcGxpZWQ6IHJlc29sdXRpb24sIHF1ZXJpZWQsIGZpbGUsIHBlcnNpc3RlZCB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbmNvbnN0IG5vZGVDcmVhdGVDb21wb25lbnRNc2c6IE9wZXJhdGlvbkRlZmluaXRpb24gPSB7XHJcbiAgICBuYW1lOiAnbm9kZS5jcmVhdGVDb21wb25lbnRNc2cnLFxyXG4gICAgdGl0bGU6ICfmjILovb3nu4Tku7bvvIjmtojmga/pgJrpgZPnm7TpgJrvvIknLFxyXG4gICAgZGVzY3JpcHRpb246ICfnm7TmjqXotbAgc2NlbmUvY3JlYXRlLWNvbXBvbmVudCDmtojmga/mjILnu4Tku7bvvIzmlK/mjIHoh6rlrprkuYnohJrmnKwgY2lk77yI5LiN6L+b5byV5pOO6YCa6YGT77yJJyxcclxuICAgIHBhcmFtczoge1xyXG4gICAgICAgIG5vZGU6ICfoioLngrkgdXVpZCcsXHJcbiAgICAgICAgY29tcG9uZW50OiAn57uE5Lu2IGNpZCDmiJbnsbvlkI3vvIjlj6/ku6XmmK/nlKjmiLfohJrmnKwgY2lk77yJJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIG5vZGU6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn6IqC54K5IHV1aWQnIH0sXHJcbiAgICAgICAgICAgIGNvbXBvbmVudDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICfnu4Tku7YgY2lkIOaIluexu+WQjScgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHJlcXVpcmVkOiBbJ25vZGUnLCAnY29tcG9uZW50J10sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBjb25zdCBub2RlID0gcGlja1N0cmluZyhwYXJhbXMsICdub2RlJywgJycpLnRyaW0oKTtcclxuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBwaWNrU3RyaW5nKHBhcmFtcywgJ2NvbXBvbmVudCcsICcnKS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFub2RlIHx8ICFjb21wb25lbnQpIHRocm93IG5ldyBFcnJvcign6ZyA6KaBIG5vZGUg5LiOIGNvbXBvbmVudCcpO1xyXG4gICAgICAgIC8vIOW5guetie+8muW3suacieWQjOexu+Wei+e7hOS7tuebtOaOpei/lOWbnu+8jOS4jemHjeWkjeinpuWPkSBjcmVhdGUtY29tcG9uZW5077yI5ZCm5YiZ57yW6L6R5Zmo5Lya5omT5Y2w6K2m5ZGK77yJXHJcbiAgICAgICAgY29uc3QgY29tcHNCZWZvcmUgPSBhd2FpdCBxdWVyeU5vZGVDb21wb25lbnRzKG5vZGUpO1xyXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhd2FpdCByZXNvbHZlQ29tcG9uZW50Q2FuZGlkYXRlcyhjb21wb25lbnQpO1xyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWF0Y2hFeGlzdGluZ0NvbXBvbmVudChjb21wc0JlZm9yZSwgY2FuZGlkYXRlcyk7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgYWxyZWFkeUV4aXN0czogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGV4aXN0aW5nOiB7IHV1aWQ6IGV4aXN0aW5nLnV1aWQsIHR5cGU6IGV4aXN0aW5nLnR5cGUsIG5hbWU6IGV4aXN0aW5nLm5hbWUgfSxcclxuICAgICAgICAgICAgICAgIGNvbXBvbmVudHM6IGNvbXBzQmVmb3JlLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFNDRU5FLCAnY3JlYXRlLWNvbXBvbmVudCcsIHsgdXVpZDogbm9kZSwgY29tcG9uZW50IH0pO1xyXG4gICAgICAgIGNvbnN0IGNvbXBzOiBhbnlbXSA9IGF3YWl0IHF1ZXJ5Tm9kZUNvbXBvbmVudHMobm9kZSk7XHJcbiAgICAgICAgcmV0dXJuIHsgbm9kZSwgY29tcG9uZW50LCBjb21wb25lbnRzOiBjb21wcyB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g6YCa55So5om56YePXHJcblxyXG4vKipcclxuICog5oqK5Y+C5pWw6YeM55qEIFwiJDxpPi48YS5iLmM+XCIg5qih5p2/5pu/5o2i5oiQ56ysIGkg6aG55omn6KGM57uT5p6c6YeM55qE5a+55bqU5YC877yI5pSv5oyB5a+56LGhL+aVsOe7hOWGheW1jOWll++8ieOAglxyXG4gKiDkuKTnp43ot6/lvoTlhpnms5XnrYnku7fvvJpcclxuICogICBcIiQwLmRhdGEudXVpZFwiIOKAlOKAlCDku44gcmVzdWx0c1tpXSDotbflhpnlhajvvIjkuI7mlofmoaPnpLrkvovjgIHnu5PmnpwgSlNPTiDnmoTlrZfpnaLnu5PmnoTkuIDoh7TvvInvvJtcclxuICogICBcIiQwLnV1aWRcIiAgICAgIOKAlOKAlCDnm7jlr7kgcmVzdWx0c1tpXS5kYXRhIOeahOefreWGmeazleOAglxyXG4gKi9cclxuZnVuY3Rpb24gcmVzb2x2ZVJlc3VsdFJlZnModmFsdWU6IGFueSwgcmVzdWx0czogYW55W10pOiBhbnkge1xyXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICBjb25zdCBtID0gL15cXCQoXFxkKykoPzpcXC4oW1xcdy5dKykpPyQvLmV4ZWModmFsdWUpO1xyXG4gICAgICAgIGlmICghbSkgcmV0dXJuIHZhbHVlO1xyXG4gICAgICAgIGNvbnN0IGhpdCA9IHJlc3VsdHNbTnVtYmVyKG1bMV0pXTtcclxuICAgICAgICBpZiAoIWhpdCB8fCAhaGl0Lm9rKSB0aHJvdyBuZXcgRXJyb3IoYOW8leeUqCAkJHttWzFdfSDlpLHotKXvvJror6XpobnmnKrmiJDlip/miafooYxgKTtcclxuICAgICAgICBjb25zdCBzZWdzID0gKG1bMl0gfHwgJycpLnNwbGl0KCcuJykuZmlsdGVyKEJvb2xlYW4pO1xyXG4gICAgICAgIGxldCBjdXI6IGFueSA9IHNlZ3NbMF0gPT09ICdkYXRhJyA/IGhpdCA6IGhpdC5kYXRhO1xyXG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIHNlZ3MpIHtcclxuICAgICAgICAgICAgY3VyID0gY3VyPy5ba2V5XTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGN1cjtcclxuICAgIH1cclxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcCgodikgPT4gcmVzb2x2ZVJlc3VsdFJlZnModiwgcmVzdWx0cykpO1xyXG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcclxuICAgICAgICBjb25zdCBvdXQ6IGFueSA9IHt9O1xyXG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkgb3V0W2tleV0gPSByZXNvbHZlUmVzdWx0UmVmcyh2YWx1ZVtrZXldLCByZXN1bHRzKTtcclxuICAgICAgICByZXR1cm4gb3V0O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5jb25zdCBiYXRjaFJ1bjogT3BlcmF0aW9uRGVmaW5pdGlvbiA9IHtcclxuICAgIG5hbWU6ICdiYXRjaC5ydW4nLFxyXG4gICAgdGl0bGU6ICfmibnph4/miafooYzmk43kvZwnLFxyXG4gICAgZGVzY3JpcHRpb246XHJcbiAgICAgICAgJ+aMiemhuuW6j+aJp+ihjOS4gOe7hOaTjeS9nO+8jOaKiiBOIOasoeW+gOi/lOWQiOW5tuS4uuS4gOasoeiwg+eUqOOAgicgK1xyXG4gICAgICAgICfmr4/pobnni6znq4vov5vnvJbovpHlmaggdW5kbyDkvZPns7vvvIjkuIDmibkgPSDlpJrmnaEgdW5kbyDorrDlvZXvvInvvJtzdG9wT25FcnJvcj10cnVl77yI6buY6K6k77yJ5pe26YGH6ZSZ5Lit5q2i77yMJyArXHJcbiAgICAgICAgJ+i/lOWbnumAkOmhuee7k+aenOOAgmJhdGNoLnJ1biDkuI3lhYHorrjltYzlpZfjgIInICtcclxuICAgICAgICAn5Y+C5pWw5YC85pSv5oyB5byV55So5YmN6aG557uT5p6c77ya5b2i5aaCIFwiJDAuZGF0YS51dWlkXCIg55qE5a2X56ym5Liy5Lya5pu/5o2i5oiQ56ysIDAg6aG5IHJlc3VsdHNbMF0uZGF0YS51dWlkIOeahOWAvO+8jCcgK1xyXG4gICAgICAgICfkuZ/lj6/nlKjnrYnku7fnn63lhpkgXCIkMC51dWlkXCLvvIjot6/lvoTnm7jlr7kgcmVzdWx0c1tpXS5kYXRhIOino+aekO+8ie+8m+WPr+W1jOWll+WcqOWvueixoS/mlbDnu4Tph4wnICtcclxuICAgICAgICAn77yI5L6L5aaCIG5vZGUuY3JlYXRlIOS5i+WQjiBub2RlLm1vdmUg5LygIHtcInV1aWRcIjpcIiQwLmRhdGEudXVpZFwife+8ieOAgicgK1xyXG4gICAgICAgICfms6jmhI/vvJpcIiROXCIg5byV55So5LuF5Zyo5ZCM5LiA5qyh6LCD55So5YaF5pyJ5pWI77yM6Leo5om55b+F6aG75YWI5Y+W5Zue55yf5a6eIHV1aWQg5YaN5byV55So44CCJyArXHJcbiAgICAgICAgJ25vZGUuYmluZFByb3BlcnR5IOeahCBiaW5kaW5ncyDmibnph4/lvZPliY3lj6rmnInnrKzkuIDmnaHnlJ/mlYjvvIzmt7fnlKjml7bpgJDmnaHosIPnlKjjgIInLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgaXRlbXM6ICfmk43kvZzmlbDnu4TvvIzmr4/pobnlvaLlpoIge1wib3BcIjpcIm5vZGUubW92ZVwiLFwicGFyYW1zXCI6ey4uLn1977ybcGFyYW1zIOmHjOWPr+eUqCBcIiQ8aT4uPOi3r+W+hD5cIiDlvJXnlKjnrKwgaSDpobnnu5PmnpzvvIjku4XpmZDmnKzmibnvvIknLFxyXG4gICAgICAgIHN0b3BPbkVycm9yOiAn6YGH6ZSZ5piv5ZCm5Lit5q2i5ZCO57ut5pON5L2c77yM6buY6K6kIHRydWUnLFxyXG4gICAgfSxcclxuICAgIHNjaGVtYToge1xyXG4gICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgaXRlbXM6IHtcclxuICAgICAgICAgICAgICAgIHR5cGU6ICdhcnJheScsXHJcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ+aTjeS9nOaVsOe7hCcsXHJcbiAgICAgICAgICAgICAgICBpdGVtczoge1xyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdvYmplY3QnLFxyXG4gICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgb3A6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAn5pON5L2c5ZCN77yM5aaCIG5vZGUuY3JlYXRlJyB9LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IHsgdHlwZTogJ29iamVjdCcsIGRlc2NyaXB0aW9uOiAn6K+l5pON5L2c55qE5Y+C5pWw77yM5Y+v55SoIFwiJGkucGF0aFwiIOW8leeUqOWJjemhuee7k+aenCcgfSxcclxuICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgIHJlcXVpcmVkOiBbJ29wJ10sXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBzdG9wT25FcnJvcjogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAn6YGH6ZSZ5piv5ZCm5Lit5q2i77yM6buY6K6kIHRydWUnIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICByZXF1aXJlZDogWydpdGVtcyddLFxyXG4gICAgICAgIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSxcclxuICAgIH0sXHJcbiAgICBhc3luYyBydW4ocGFyYW1zKSB7XHJcbiAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gQXJyYXkuaXNBcnJheShwYXJhbXM/Lml0ZW1zKSA/IHBhcmFtcy5pdGVtcyA6IFtdO1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ2l0ZW1zIOS4uuepuicpO1xyXG4gICAgICAgIGNvbnN0IHN0b3BPbkVycm9yID0gcGFyYW1zPy5zdG9wT25FcnJvciAhPT0gZmFsc2U7XHJcblxyXG4gICAgICAgIGNvbnN0IHJlc3VsdHM6IGFueVtdID0gW107XHJcbiAgICAgICAgbGV0IGFib3J0ZWQgPSBmYWxzZTtcclxuICAgICAgICBsZXQgb2tDb3VudCA9IDA7XHJcbiAgICAgICAgbGV0IGZhaWxDb3VudCA9IDA7XHJcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGl0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xyXG4gICAgICAgICAgICBjb25zdCBpdGVtID0gaXRlbXNbaW5kZXhdO1xyXG4gICAgICAgICAgICBjb25zdCBvcCA9IGl0ZW0gJiYgdHlwZW9mIGl0ZW0ub3AgPT09ICdzdHJpbmcnID8gaXRlbS5vcC50cmltKCkgOiAnJztcclxuICAgICAgICAgICAgY29uc3Qgc3RhcnQgPSBEYXRlLm5vdygpO1xyXG4gICAgICAgICAgICBpZiAoIW9wIHx8IG9wID09PSAnYmF0Y2gucnVuJykge1xyXG4gICAgICAgICAgICAgICAgZmFpbENvdW50Kys7XHJcbiAgICAgICAgICAgICAgICByZXN1bHRzLnB1c2goeyBvcCwgb2s6IGZhbHNlLCBlcnJvcjogb3AgPyAnYmF0Y2gucnVuIOS4jeWFgeiuuOW1jOWllycgOiAn57y65bCRIG9wJywgY29zdDogMCB9KTtcclxuICAgICAgICAgICAgICAgIGlmIChzdG9wT25FcnJvcikgeyBhYm9ydGVkID0gdHJ1ZTsgYnJlYWs7IH1cclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBsZXQgaXRlbVBhcmFtcyA9IGl0ZW0/LnBhcmFtcyB8fCB7fTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAmJiBpdGVtUGFyYW1zICYmIHR5cGVvZiBpdGVtUGFyYW1zID09PSAnb2JqZWN0Jykge1xyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW1QYXJhbXMgPSByZXNvbHZlUmVzdWx0UmVmcyhpdGVtUGFyYW1zLCByZXN1bHRzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wZXJhdGlvbiA9IHJlZ2lzdHJ5TWFwW29wXTtcclxuICAgICAgICAgICAgICAgIGlmICghb3BlcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoYOacquefpeaTjeS9nDogJHtvcH1gKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBvcGVyYXRpb24ucnVuKGl0ZW1QYXJhbXMpO1xyXG4gICAgICAgICAgICAgICAgb2tDb3VudCsrO1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHsgb3AsIG9rOiB0cnVlLCBkYXRhLCBjb3N0OiBEYXRlLm5vdygpIC0gc3RhcnQgfSk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgICAgIGZhaWxDb3VudCsrO1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHsgb3AsIG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSB8fCBlKSwgY29zdDogRGF0ZS5ub3coKSAtIHN0YXJ0IH0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKHN0b3BPbkVycm9yKSB7IGFib3J0ZWQgPSB0cnVlOyBicmVhazsgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IHRvdGFsOiBpdGVtcy5sZW5ndGgsIG9rOiBva0NvdW50LCBmYWlsZWQ6IGZhaWxDb3VudCwgYWJvcnRlZCwgcmVzdWx0cyB9O1xyXG4gICAgfSxcclxufTtcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gTUNQIOacjeWKoeWZqOiHqueuoeeQhlxyXG5cclxuY29uc3QgbWNwU3RhdHVzOiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ21jcC5zdGF0dXMnLFxyXG4gICAgdGl0bGU6ICdNQ1Ag5pyN5Yqh5Zmo54q25oCBJyxcclxuICAgIGRlc2NyaXB0aW9uOiAn5p+l6K+iIG1jcC1zZXJ2ZXIg5a2Q6L+b56iL6L+Q6KGM54q25oCB77ya56uv5Y+j44CBcGlk44CB5piv5ZCm5pys57yW6L6R5Zmo5ZCv5Yqo44CBSFRUUCDmjqLmtLvnu5PmnpwnLFxyXG4gICAgcGFyYW1zOiB7fSxcclxuICAgIHNjaGVtYTogeyB0eXBlOiAnb2JqZWN0JywgcHJvcGVydGllczoge30sIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSB9LFxyXG4gICAgYXN5bmMgcnVuKCkge1xyXG4gICAgICAgIHJldHVybiBhd2FpdCBtY3BTZXJ2ZXJTdGF0dXMoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5jb25zdCBtY3BSZXN0YXJ0OiBPcGVyYXRpb25EZWZpbml0aW9uID0ge1xyXG4gICAgbmFtZTogJ21jcC5yZXN0YXJ0JyxcclxuICAgIHRpdGxlOiAn6YeN5ZCvIE1DUCDmnI3liqHlmagnLFxyXG4gICAgZGVzY3JpcHRpb246ICfph43lkK8gbWNwLXNlcnZlciDlrZDov5vnqIvvvIjkv67mlLkgbWNwLXNlcnZlci9pbmRleC5qcyDlkI7orqnku6PnoIHnlJ/mlYjvvInvvJvlj6rmjqXnrqHmnKznvJbovpHlmajlkK/liqjnmoTlrp7kvosnLFxyXG4gICAgcGFyYW1zOiB7XHJcbiAgICAgICAgcG9ydDogJ+WPr+mAieOAguebkeWQrOerr+WPo++8jOm7mOiupOayv+eUqOW9k+WJjeerr+WPo++8iOaXoOi/kOihjOWunuS+i+aXtueUqOS4iuasoeerr+WPo++8jOWGjemAgOWbniAzMDAy77yJJyxcclxuICAgIH0sXHJcbiAgICBzY2hlbWE6IHtcclxuICAgICAgICB0eXBlOiAnb2JqZWN0JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgIHBvcnQ6IHsgdHlwZTogJ251bWJlcicsIGRlc2NyaXB0aW9uOiAn55uR5ZCs56uv5Y+j77yM6buY6K6k5rK/55So5b2T5YmN56uv5Y+jJyB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlLFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJ1bihwYXJhbXMpIHtcclxuICAgICAgICBjb25zdCBiZWZvcmUgPSBhd2FpdCBtY3BTZXJ2ZXJTdGF0dXMoKTtcclxuICAgICAgICBjb25zdCBwb3J0ID0gcGlja051bWJlcihwYXJhbXMsICdwb3J0JywgMCkgfHwgYmVmb3JlLnBvcnQgfHwgYmVmb3JlLmxhc3RQb3J0IHx8IDMwMDI7XHJcbiAgICAgICAgaWYgKGJlZm9yZS5ydW5uaW5nICYmICFiZWZvcmUub3duZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgYOerr+WPoyAke3BvcnR9IOS4iueahCBNQ1AgU2VydmVy77yIcGlkICR7YmVmb3JlLnBpZH3vvInkuI3mmK/mnKznvJbovpHlmajlkK/liqjnmoTvvIzml6Dms5Xku6PkuLrph43lkK/vvJtgICtcclxuICAgICAgICAgICAgICAgICfor7flhYjlnKjnu4jnq6/nu5PmnZ/or6Xov5vnqIvvvIzmiJbmjaLnq6/lj6PlkK/liqjmlrDlrp7kvovjgIInXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChiZWZvcmUucnVubmluZyAmJiBiZWZvcmUub3duZWQpIHtcclxuICAgICAgICAgICAgYXdhaXQgc3RvcE1jcFNlcnZlcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IHN0YXJ0TWNwU2VydmVyKHBvcnQpO1xyXG4gICAgICAgIGlmICghc3RhdGUucnVubmluZykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOmHjeWQr+WQjiBtY3Atc2VydmVyIOacqui/kOihjO+8jOacgOi/kei+k+WHuu+8miR7c3RhdGUucmVjZW50T3V0cHV0LnNsaWNlKC01KS5qb2luKCcgfCAnKSB8fCAn5pegJ31gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uc3RhdGUsIHJlc3RhcnRlZDogdHJ1ZSwgcHJldmlvdXNQaWQ6IGJlZm9yZS5waWQgfTtcclxuICAgIH0sXHJcbn07XHJcblxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIOazqOWGjOihqFxyXG5cclxuY29uc3QgcmVnaXN0cnk6IE9wZXJhdGlvbkRlZmluaXRpb25bXSA9IFtcclxuICAgIGVkaXRvckluZm8sXHJcbiAgICBzY2VuZVN0YXR1cyxcclxuICAgIHNjZW5lVHJlZSxcclxuICAgIG5vZGVDcmVhdGUsXHJcbiAgICBub2RlRGVsZXRlLFxyXG4gICAgbm9kZU1vdmUsXHJcbiAgICBub2RlTW92ZUVuZ2luZSxcclxuICAgIG5vZGVTZXRQcm9wZXJ0eSxcclxuICAgIG5vZGVTZXRQcm9wZXJ0eUVuZ2luZSxcclxuICAgIG5vZGVCaW5kUHJvcGVydHksXHJcbiAgICBub2RlQ3JlYXRlUHJlZmFiLFxyXG4gICAgc2NlbmVTYXZlLFxyXG4gICAgYXNzZXRMaXN0LFxyXG4gICAgYXNzZXREZWxldGUsXHJcbiAgICBhc3NldEltcG9ydCxcclxuICAgIGJhdGNoUnVuLFxyXG4gICAgbWNwU3RhdHVzLFxyXG4gICAgbWNwUmVzdGFydCxcclxuICAgIHNjZW5lU2NyaXB0SW5mbyxcclxuICAgIHNjZW5lU2NyaXB0RGVtbyxcclxuICAgIHNjZW5lQ2FwdHVyZSxcclxuICAgIHNjZW5lUmVvcGVuLFxyXG4gICAgc2NlbmVPcGVuLFxyXG4gICAgcHJvamVjdFNldERlc2lnblJlc29sdXRpb24sXHJcbiAgICBub2RlQ3JlYXRlQ29tcG9uZW50TXNnLFxyXG4gICAgc2NyaXB0Q3JlYXRlLFxyXG4gICAgc2NyaXB0TGlzdCxcclxuICAgIG5vZGVBZGRDb21wb25lbnQsXHJcbiAgICBub2RlUmVtb3ZlQ29tcG9uZW50LFxyXG4gICAgbm9kZUxpc3RDb21wb25lbnRzLFxyXG4gICAgbm9kZURlYnVnLFxyXG5dO1xyXG5cclxuY29uc3QgcmVnaXN0cnlNYXA6IHsgW25hbWU6IHN0cmluZ106IE9wZXJhdGlvbkRlZmluaXRpb24gfSA9IHt9O1xyXG5mb3IgKGNvbnN0IG9wZXJhdGlvbiBvZiByZWdpc3RyeSkge1xyXG4gICAgcmVnaXN0cnlNYXBbb3BlcmF0aW9uLm5hbWVdID0gb3BlcmF0aW9uO1xyXG59XHJcblxyXG4vKiog5YiX5Ye65omA5pyJ5pON5L2c77yITUNQIHRvb2xzL2xpc3Qg55qE5pWw5o2u5rqQ77yJICovXHJcbmV4cG9ydCBmdW5jdGlvbiBsaXN0T3BlcmF0aW9ucygpOiBPcGVyYXRpb25JbmZvW10ge1xyXG4gICAgcmV0dXJuIHJlZ2lzdHJ5Lm1hcCgob3BlcmF0aW9uKSA9PiAoe1xyXG4gICAgICAgIG5hbWU6IG9wZXJhdGlvbi5uYW1lLFxyXG4gICAgICAgIHRpdGxlOiBvcGVyYXRpb24udGl0bGUsXHJcbiAgICAgICAgZGVzY3JpcHRpb246IG9wZXJhdGlvbi5kZXNjcmlwdGlvbixcclxuICAgICAgICBwYXJhbXM6IG9wZXJhdGlvbi5wYXJhbXMsXHJcbiAgICAgICAgc2NoZW1hOiBvcGVyYXRpb24uc2NoZW1hLFxyXG4gICAgfSkpO1xyXG59XHJcblxyXG4vKiog5oyJ5ZCN5a2X5omn6KGM5LiA5Liq5pON5L2cICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5PcGVyYXRpb24obmFtZTogc3RyaW5nLCBwYXJhbXM6IHsgW2tleTogc3RyaW5nXTogYW55IH0gPSB7fSk6IFByb21pc2U8YW55PiB7XHJcbiAgICBjb25zdCBvcGVyYXRpb24gPSByZWdpc3RyeU1hcFtuYW1lXTtcclxuICAgIGlmICghb3BlcmF0aW9uKSB7XHJcbiAgICAgICAgY29uc3Qga25vd24gPSByZWdpc3RyeS5tYXAoKGl0ZW0pID0+IGl0ZW0ubmFtZSkuam9pbignLCAnKTtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOacquefpeaTjeS9nDogJHtuYW1lfe+8m+WPr+eUqOaTjeS9nDogJHtrbm93bn1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiBvcGVyYXRpb24ucnVuKHBhcmFtcyB8fCB7fSk7XHJcbn1cclxuIl19