// @ts-ignore
import packageJSON from '../package.json';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, resolve } from 'path';
import { JsonSchema, OperationInfo } from './types';
import { MAIN_BUILD } from './build-info';
import { mcpServerStatus, startMcpServer, stopMcpServer } from './mcp-process';

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

export interface OperationDefinition {
    /** 操作名，形如 scene.tree */
    name: string;
    /** 中文标题 */
    title: string;
    /** 说明 */
    description: string;
    /** 参数说明：key 为参数名，value 为含义 */
    params: { [key: string]: string };
    /** 参数 JSON Schema */
    schema: JsonSchema;
    /** 执行 */
    run(params: { [key: string]: any }): Promise<any>;
}

// ---------------------------------------------------------------- 工具函数

/** 从 dump 数据里取出真实值：dump 形如 { value: xxx } */
function dumpValue<T = any>(prop: any, fallback: T): T {
    if (prop === null || prop === undefined) return fallback;
    if (typeof prop === 'object' && 'value' in prop) {
        return (prop as { value: T }).value;
    }
    return prop as T;
}

function pickString(params: any, key: string, fallback = ''): string {
    const value = params?.[key];
    return typeof value === 'string' ? value : fallback;
}

function pickNumber(params: any, key: string, fallback = 0): number {
    const value = Number(params?.[key]);
    return Number.isFinite(value) ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 项目根目录（Editor.Project.path，直连模式下从 dist 位置推导） */
function projectRoot(): string {
    const editor = typeof Editor !== 'undefined' ? (Editor as any) : null;
    if (editor?.Project?.path) return editor.Project.path;
    return join(__dirname, '..', '..', '..');
}

/** db://assets/... 路径转磁盘绝对路径 */
function dbUrlToAbs(dbUrl: string): string {
    return join(projectRoot(), dbUrl.replace(/^db:\/\//, ''));
}

/** 同一磁盘路径判定（Windows 下大小写与分隔符不敏感） */
function isSamePath(a: string, b: string): boolean {
    const ra = resolve(a);
    const rb = resolve(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** 层级管理器里当前选中的节点 uuid 列表 */
function getSelectedNodeUuids(): string[] {
    try {
        return Editor.Selection.getSelected('node') || [];
    } catch (e) {
        return [];
    }
}

/** 从节点 dump 里取组件列表（3.8.8 的字段是 components，不是 __comps__） */
function readNodeComponents(node: any): any[] {
    if (!node) return [];
    const raw = node.components || node.__comps__ || [];
    return raw.map((comp: any) => {
        if (comp && typeof comp === 'object' && 'value' in comp && comp.value && typeof comp.value === 'object') {
            // 老格式：{ value: { uuid, name, enabled } }
            const value = comp.value;
            return { uuid: value.uuid || '', name: value.name || '', type: value.type || '', enabled: value.enabled, isCustom: !!comp.isCustom };
        }
        // 3.8.8 格式：{ isCustom, type, value: <组件uuid> }
        return {
            uuid: typeof comp?.value === 'string' ? comp.value : (comp?.uuid || ''),
            name: comp?.name || '',
            type: comp?.type || '',
            enabled: comp?.enabled,
            isCustom: !!comp?.isCustom,
        };
    });
}

/** 在场景树里按 uuid 找节点 */
function findNodeInTree(tree: any, uuid: string): any {
    if (!tree) return null;
    if (dumpValue<string>(tree.uuid, '') === uuid) return tree;
    for (const child of (tree.children || [])) {
        const hit = findNodeInTree(child, uuid);
        if (hit) return hit;
    }
    return null;
}

/** 读取某节点当前的组件列表（走 query-node-tree，3.8.8 的 query-node 返回 null） */
async function queryNodeComponents(nodeUuid: string): Promise<any[]> {
    const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
    const found = findNodeInTree(tree, nodeUuid);
    return readNodeComponents(found);
}

/**
 * 把组件标识（cc.Xxx / Xxx / 用户脚本 cid）展开成可与场景树组件列表比对的候选名。
 * 场景树里 3.8.8 的 components[].type：内置组件是 "cc.UITransform"，用户脚本是类名 "ScreenFill"。
 */
async function resolveComponentCandidates(component: string): Promise<string[]> {
    const raw = String(component || '').trim();
    if (!raw) return [];
    const candidates: string[] = [raw];

    let list: any[] = [];
    try {
        list = (await Editor.Message.request(SCENE, 'query-components')) || [];
    } catch (e) {
        list = [];
    }
    // 用户脚本按 cid 反查类名
    const byCid = list.find((item: any) => item && item.cid === raw);
    if (byCid && byCid.name) candidates.push(String(byCid.name));
    // 按类名反查 cid
    const byName = list.find((item: any) => item && item.name === raw);
    if (byName) {
        if (byName.name) candidates.push(String(byName.name));
        if (byName.cid) candidates.push(String(byName.cid));
    }

    if (raw.startsWith('cc.')) candidates.push(raw.slice(3));
    else if (!raw.includes('.')) candidates.push(`cc.${raw}`);

    return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * 在组件列表里找已存在的目标组件。
 * Cocos 不允许同一节点挂同类型组件，重复 add 会被编辑器拒绝并打印
 * "[Scene] Can't add component 'cc.UITransform' because X already contains the same component."
 */
function matchExistingComponent(comps: any[], candidates: string[]): any | null {
    if (!comps || !comps.length || !candidates || !candidates.length) return null;
    return (
        comps.find((comp: any) => {
            const type = String(comp?.type || '');
            const name = String(comp?.name || '');
            const uuid = String(comp?.uuid || '');
            return candidates.some((c) => c === type || c === name || c === uuid);
        }) || null
    );
}

/** 把 query-node-tree 返回的节点树转成可读文本 */
function formatNodeTree(node: any, depth = 0): string {
    if (!node) return '';
    const name = dumpValue<string>(node.name, '(未命名)');
    const uuid = dumpValue<string>(node.uuid, '');
    const active = dumpValue<boolean>(node.active, true);
    const comps: string[] = readNodeComponents(node).map((comp: any) => comp.type || comp.name).filter(Boolean);

    const indent = '  '.repeat(depth);
    let line = `${indent}- ${name}${active ? '' : ' [inactive]'}`;
    if (uuid) line += `  <${uuid}>`;
    if (comps.length) line += `  [${comps.join(', ')}]`;
    const position = dumpValue<any>(node.position, null);
    if (position && typeof position === 'object') {
        line += `  (${position.x ?? 0}, ${position.y ?? 0}, ${position.z ?? 0})`;
    }

    const children: any[] = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
        const text = formatNodeTree(child, depth + 1);
        if (text) line += `\n${text}`;
    }
    return line;
}

/** 统计节点数量（含根） */
function countNodes(node: any): number {
    if (!node) return 0;
    const children: any[] = Array.isArray(node.children) ? node.children : [];
    return 1 + children.reduce((sum: number, child: any) => sum + countNodes(child), 0);
}

/**
 * 把 query-node-tree 的子树摊平成结构化数组（父在前），供 batch.run 的 "$N.nodes[i].uuid" 引用，
 * 替代对 subtree 文本树的正则解析。
 */
function collectNodes(node: any, parentUuid: string | null, out: any[] = []): any[] {
    if (!node) return out;
    const uuid = dumpValue<string>(node.uuid, '');
    out.push({
        name: dumpValue<string>(node.name, '(未命名)'),
        uuid,
        parent: uuid ? parentUuid : null,
        components: readNodeComponents(node)
            .map((comp: any) => comp.type || comp.name)
            .filter(Boolean),
    });
    const children: any[] = Array.isArray(node.children) ? node.children : [];
    for (const child of children) collectNodes(child, uuid || null, out);
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
async function detectPrefabMode(): Promise<{ inPrefabMode: boolean; prefabName: string; sceneName: string }> {
    let tree: any = null;
    try {
        tree = await Editor.Message.request(SCENE, 'query-node-tree');
    } catch (e) {
        return { inPrefabMode: false, prefabName: '', sceneName: '' };
    }
    const sceneName = dumpValue<string>(tree && tree.name, '');
    const children: any[] = Array.isArray(tree && tree.children) ? tree.children : [];
    const firstChildName = dumpValue<string>(children[0] && children[0].name, '');
    const inPrefabMode = /-scene$/.test(sceneName) && firstChildName === 'should_hide_in_hierarchy';
    return {
        inPrefabMode,
        prefabName: inPrefabMode ? sceneName.replace(/-scene$/, '') : '',
        sceneName,
    };
}

/** 预制体编辑模式下拒绝保存/切换的统一报错（fail fast，避免静默堵在编辑器弹框上） */
function prefabModeBlockedError(prefabName: string, action: string): Error {
    return new Error(
        `当前处于预制体编辑模式（${prefabName}），无法${action}。` +
        '该模式下 query-dirty 恒 false、scene/save-scene 对预制体文档无效，切换文档可能弹「是否保存」对话框且无法自动处理。' +
        '请先在编辑器里保存并关闭预制体页签回到普通场景后重试；确认预制体无未保存修改时可传 assumeClean=true 跳过本检查。'
    );
}

/**
 * 用 asset-db/open-asset 切换编辑文档并轮询确认（等价资源管理器双击）。
 * 这是「普通场景 → 预制体编辑模式」的可靠通道（scene/open-scene 对 prefab uuid 无效）。
 * 成功判定靠 query-node-tree 根 uuid 相对打开前变化（连续两次读到才算稳定）：
 * 包裹场景 uuid 每次打开都会重新生成，不能用「等于某个固定值」判断。
 */
async function openAssetAndPoll(
    uuid: string,
    timeout: number
): Promise<{ opened: boolean; from: string; current: string }> {
    const beforeTree: any = await Editor.Message.request(SCENE, 'query-node-tree');
    const from = dumpValue<string>(beforeTree && beforeTree.uuid, '');
    await Editor.Message.request(ASSET_DB, 'open-asset', uuid);
    const deadline = Date.now() + timeout;
    let current = from;
    let stable = 0;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
            const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
            current = dumpValue<string>(tree && tree.uuid, '');
        } catch (e) {
            current = '';
        }
        if (current && current !== from) {
            stable += 1;
            if (stable >= 2) break;
        } else {
            stable = 0;
        }
    }
    return { opened: !!(current && current !== from), from, current };
}

/** 空的参数 schema */
function noParams(): JsonSchema {
    return { type: 'object', properties: {}, additionalProperties: false };
}

// ---------------------------------------------------------------- 操作定义

const editorInfo: OperationDefinition = {
    name: 'editor.info',
    title: '编辑器 / 项目信息',
    description: '打印当前 Creator 版本、项目路径、扩展自身信息',
    params: {},
    schema: noParams(),
    async run() {
        return {
            build: MAIN_BUILD,
            editorName: Editor.App.name,
            editorVersion: Editor.App.version,
            editorPath: Editor.App.path,
            projectPath: Editor.Project.path,
            extensionName: packageJSON.name,
            extensionVersion: packageJSON.version,
            nodeVersion: process.version,
            platform: `${process.platform} ${process.arch}`,
        };
    },
};

const sceneStatus: OperationDefinition = {
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
            sceneName: dumpValue<string>(tree?.name, '(未命名场景)'),
            sceneUuid: dumpValue<string>(tree?.uuid, ''),
            nodeCount: Math.max(0, countNodes(tree) - 1),
            selectedNodes: getSelectedNodeUuids(),
        };
    },
};

const sceneTree: OperationDefinition = {
    name: 'scene.tree',
    title: '场景节点树',
    description: '读取当前场景的完整节点树（节点名 / uuid / 组件 / 坐标）',
    params: {},
    schema: noParams(),
    async run() {
        const tree = await Editor.Message.request(SCENE, 'query-node-tree');
        return {
            sceneName: dumpValue<string>(tree?.name, '(未命名场景)'),
            sceneUuid: dumpValue<string>(tree?.uuid, ''),
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
async function resolvePrefabAsset(builtin: string, prefab: string): Promise<{ uuid: string; url: string; name: string } | null> {
    if (builtin && prefab) {
        throw new Error('builtin 与 prefab 只能二选一');
    }
    let target = '';
    if (builtin) {
        const short = builtin.trim().replace(/\.prefab$/i, '').replace(/^\/+|\/+$/g, '');
        target = `db://internal/default_prefab/${short}.prefab`;
    } else if (prefab) {
        target = prefab.trim();
    } else {
        return null;
    }
    let info: any = null;
    try {
        info = await Editor.Message.request(ASSET_DB, 'query-asset-info', target);
    } catch (e) {
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
                } catch (e) {
                    // 探测失败不影响原本的报错
                }
            }
        }
        throw new Error(`找不到 prefab 资产: ${target}${hint}`);
    }
    if (info.type && info.type !== 'cc.Prefab') {
        throw new Error(`目标资产不是 prefab（${info.type}）: ${info.url || target}`);
    }
    const url: string = info.url || target;
    return { uuid: info.uuid, url, name: basename(url).replace(/\.prefab$/i, '') };
}

const nodeCreate: OperationDefinition = {
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
        } else if (rawParent) {
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
                if (typeof available === 'string' && available) name = available;
            } catch (e) {
                // 该消息不可用时保持原名，重名不影响创建
            }
        }

        const options: any = { name };
        if (parent) options.parent = parent;
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
        } catch (e: any) {
            const hint = options.canvasRequired
                ? '；ui/* 模板要求场景先有 Canvas，可先 node_create(builtin="Canvas")'
                : '';
            throw new Error(`create-node 失败: ${e?.message || e}${hint}`);
        }

        // 一次 query-node-tree 同时回读组件列表（空节点模式的 cc.UITransform 提示）与模板子树
        const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
        const found = findNodeInTree(tree, uuid);
        const comps = readNodeComponents(found);
        const hasUITransform = comps.some((c: any) => c.type === 'cc.UITransform');
        const result: any = { uuid, name, parent: parent || null, parentSource, components: comps, hasUITransform };
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

const nodeDelete: OperationDefinition = {
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
        let list: string[] = raw.split(',').map((item) => item.trim()).filter(Boolean);
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

const nodeMove: OperationDefinition = {
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

const nodeMoveEngine: OperationDefinition = {
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
            name: packageJSON.name,
            method: 'moveNode',
            args: [uuid, position],
        });
        return { uuid, source, position, scriptResult: result };
    },
};

const nodeSetProperty: OperationDefinition = {
    name: 'node.setProperty',
    title: '设置属性（消息通道）',
    description:
        '通过 scene/set-property 设置节点或组件属性（走编辑器 undo 体系）。' +
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

        let dump: any;
        if (params?.dump && typeof params.dump === 'object') {
            dump = params.dump;
        } else {
            const explicitType = pickString(params, 'type', '').trim();
            const value = params?.value;
            const type = explicitType || guessDumpType(value);
            dump = type ? { type, value } : { value };
        }

        await Editor.Message.request(SCENE, 'set-property', { uuid, path, dump });
        return { uuid, source, path, dump, applied: true };
    },
};

/** 按 value 的形状猜测 dump 类型（只认最典型的三种，识别不了就返回空走裸 {value}） */
function guessDumpType(value: any): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const keys = Object.keys(value).sort();
    const allNumber = keys.length > 0 && keys.every((key) => typeof (value as any)[key] === 'number');
    if (!allNumber) return '';
    if (keys.join(',') === 'x,y,z') return 'cc.Vec3';
    if (keys.join(',') === 'x,y') return 'cc.Vec2';
    if (keys.join(',') === 'height,width') return 'cc.Size';
    if (keys.join(',') === 'a,b,g,r') return 'cc.Color';
    return '';
}

const nodeSetPropertyEngine: OperationDefinition = {
    name: 'node.setProperty.engine',
    title: '设置属性（引擎通道）',
    description:
        '通过场景脚本用引擎 API 直接给节点或组件赋值（不进 undo 体系，保存场景后生效）。' +
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
        const result: any = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: packageJSON.name,
            method: 'setNodeProperty',
            args: [uuid, component, prop, params?.value],
        });
        if (!result || result.ok !== true) {
            throw new Error(
                `引擎设置属性失败：${result && result.error ? result.error : '未知错误'}`
            );
        }
        return { uuid, source, scriptResult: result };
    },
};

// ---------------------------------------------------------------- 引用绑定

/**
 * query-components 建的 cid ↔ 类名索引。
 * 节点树里自定义脚本组件的 type 存的是 cid，而 set-property 的 dump.type 要类名（如 ItemBadge），
 * 所以要靠这张表翻译。
 */
interface ComponentClassIndex {
    byCid: { [cid: string]: string };
    names: Set<string>;
}

async function queryComponentClassIndex(): Promise<ComponentClassIndex> {
    const list: any[] = await Editor.Message.request(SCENE, 'query-components');
    const byCid: { [cid: string]: string } = {};
    const names = new Set<string>();
    for (const item of list || []) {
        if (item && item.cid) byCid[String(item.cid)] = String(item.name || '');
        if (item && item.name) names.add(String(item.name));
    }
    return { byCid, names };
}

/** 组件在 dump 里的类型名：内置组件是 cc.Sprite，自定义脚本组件是类名（如 ItemBadge） */
function componentDumpType(comp: any, classIndex: ComponentClassIndex): string {
    const raw = String(comp?.type || '').trim();
    if (comp?.isCustom) {
        return classIndex.byCid[raw] || raw;
    }
    return raw || String(comp?.name || '').trim();
}

/** 组件名宽松相等：忽略 cc. 前缀与大小写 */
function sameComponentName(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const strip = (s: string) => (s.startsWith('cc.') ? s.slice(3) : s);
    return strip(a).toLowerCase() === strip(b).toLowerCase();
}

/** 在组件列表里定位组件：数字索引 / 类名 / cid / 组件 uuid；candidates>1 说明按名匹配有歧义，建议改传索引 */
function matchComponent(
    comps: any[],
    spec: string,
    classIndex: ComponentClassIndex
): { index: number; comp: any; candidates: number } | null {
    const s = String(spec ?? '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
        const index = parseInt(s, 10);
        return comps[index] ? { index, comp: comps[index], candidates: 1 } : null;
    }
    const hits: { index: number; comp: any }[] = [];
    comps.forEach((comp: any, index: number) => {
        const typeName = comp?.isCustom
            ? (classIndex.byCid[String(comp.type || '')] || comp.type)
            : comp?.type;
        if (
            comp?.uuid === s ||
            comp?.type === s ||
            sameComponentName(String(typeName || ''), s) ||
            sameComponentName(String(comp?.name || ''), s)
        ) {
            hits.push({ index, comp });
        }
    });
    return hits.length ? { index: hits[0].index, comp: hits[0].comp, candidates: hits.length } : null;
}

/** 组件列表的一行摘要（报错时提示现有组件用） */
function describeComponents(comps: any[], classIndex: ComponentClassIndex): string {
    return comps
        .map((comp: any, index: number) => {
            const name = comp?.isCustom
                ? (classIndex.byCid[String(comp.type || '')] || comp.type)
                : (comp?.type || comp?.name || '?');
            return `${index}:${name}`;
        })
        .join(', ') || '(无组件)';
}

interface TreeNodeRef { uuid: string; name: string; path: string; node: any; }

function collectTreeNodes(node: any, parentPath: string, out: TreeNodeRef[]): void {
    if (!node) return;
    const name = dumpValue<string>(node.name, '');
    const uuid = dumpValue<string>(node.uuid, '');
    const path = parentPath ? `${parentPath}/${name}` : name;
    out.push({ uuid, name, path, node });
    for (const child of (node.children || [])) collectTreeNodes(child, path, out);
}

/** 节点定位：uuid → 完整路径 → 路径后缀 → 节点名（prefab 编辑模式下同样适用，路径以编辑中的根为起点） */
function resolveNodeRef(tree: any, spec: string): { ref: TreeNodeRef; how: string; candidates: number } | null {
    const s = String(spec || '').trim();
    if (!s) return null;
    const all: TreeNodeRef[] = [];
    collectTreeNodes(tree, '', all);
    const exact = all.find((item) => item.uuid === s);
    if (exact) return { ref: exact, how: 'uuid', candidates: 1 };
    const byPath = all.find((item) => item.path === s);
    if (byPath) return { ref: byPath, how: 'path', candidates: 1 };
    const bySuffix = all.filter((item) => item.path.endsWith(`/${s}`));
    if (bySuffix.length) return { ref: bySuffix[0], how: 'path-suffix', candidates: bySuffix.length };
    const byName = all.filter((item) => item.name === s);
    if (byName.length) return { ref: byName[0], how: 'name', candidates: byName.length };
    return null;
}

/** 资产目标：db:// 路径 → uuid + 类型；子资产（xx.png/spriteFrame）返回子资产自己的 uuid 与类型（如 cc.SpriteFrame） */
async function resolveAssetTarget(
    url: string,
    explicitType: string
): Promise<{ dumpType: string; valueUuid: string | null; desc: string }> {
    const assets: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
    const hit = (assets || []).find((asset: any) => asset.url === url) || (assets || [])[0];
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
async function resolveBindTarget(
    tree: any,
    classIndex: ComponentClassIndex,
    target: any,
    explicitType: string
): Promise<{ dumpType: string; valueUuid: string | null; desc: string }> {
    if (target === null || target === undefined || target === 'null' || target === '') {
        return { dumpType: explicitType || '', valueUuid: null, desc: '解绑（null）' };
    }
    if (typeof target === 'string') {
        if (target.startsWith('db://')) return resolveAssetTarget(target, explicitType);
        return { dumpType: explicitType || '', valueUuid: target, desc: `uuid:${target}` };
    }
    if (typeof target === 'object') {
        const asset = pickString(target, 'asset', '').trim();
        if (asset) return resolveAssetTarget(asset, explicitType);
        const rawUuid = pickString(target, 'uuid', '').trim();
        if (rawUuid) return { dumpType: explicitType || '', valueUuid: rawUuid, desc: `uuid:${rawUuid}` };
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
                throw new Error(
                    `target.component 在节点 ${nodeHit.ref.path} 上找不到「${compText}」，现有: ${describeComponents(comps, classIndex)}`
                );
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

const nodeBindProperty: OperationDefinition = {
    name: 'node.bindProperty',
    title: '绑定引用属性',
    description:
        '给组件绑定引用类型属性（@property(Label/Sprite/自定义脚本/Node/SpriteFrame…)），' +
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
                description:
                    '绑定目标：{node,component} 组件引用 | {node} 节点引用 | {asset:"db://…"} 资产 | uuid 字符串 | null 解绑',
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
        const specs: any[] = Array.isArray(params?.bindings) ? params.bindings : [params];
        if (!specs.length) throw new Error('没有可执行的绑定（bindings 为空）');

        const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
        if (!tree) throw new Error('当前没有打开的场景');
        const classIndex = await queryComponentClassIndex();

        const items: any[] = [];
        const plans: any[] = [];
        for (const spec of specs) {
            // 1) 属性所在节点
            const nodeSpec = pickString(spec, 'uuid', '').trim();
            let nodeHit: { ref: TreeNodeRef; how: string; candidates: number } | null = null;
            if (!nodeSpec || nodeSpec === '@selection') {
                const selected = getSelectedNodeUuids();
                if (!selected.length) throw new Error('没有指定 uuid，也没有选中任何节点');
                nodeHit = resolveNodeRef(tree, selected[0]);
            } else {
                nodeHit = resolveNodeRef(tree, nodeSpec);
            }
            if (!nodeHit) throw new Error(`场景树里找不到节点: ${nodeSpec || '(选中节点)'}`);

            // 2) 组件与属性路径（dump 路径统一用 __comps__ 前缀，与属性检查器发出的消息一致）
            const rawPath = pickString(spec, 'path', '').trim();
            let path = rawPath
                ? (rawPath.startsWith('components.') ? `__comps__.${rawPath.slice('components.'.length)}` : rawPath)
                : '';
            let verifyIndex = '';
            let verifyProp = '';
            let matched: { index: number; comp: any; candidates: number } | null = null;
            if (!path) {
                const property = pickString(spec, 'property', '').trim();
                if (!property) throw new Error('必须指定 property（或原始 path），如 badge / spriteFrame');
                const compSpec = spec?.component;
                const compText = compSpec === undefined || compSpec === null ? '' : String(compSpec).trim();
                if (compText && compText !== 'node') {
                    const comps = readNodeComponents(nodeHit.ref.node);
                    matched = matchComponent(comps, compText, classIndex);
                    if (!matched) {
                        throw new Error(
                            `节点 ${nodeHit.ref.path} 上找不到组件「${compText}」，现有: ${describeComponents(comps, classIndex)}`
                        );
                    }
                    path = `__comps__.${matched.index}.${property}`;
                    verifyIndex = String(matched.index);
                } else {
                    path = property; // 节点级属性（少见）
                }
                verifyProp = property;
            } else {
                const m = /^__comps__\.(\d+)\.(.+)$/.exec(path);
                if (m) {
                    verifyIndex = m[1];
                    verifyProp = m[2];
                }
            }

            // 3) 目标 → dump
            const targetInfo = await resolveBindTarget(
                tree,
                classIndex,
                spec?.target,
                pickString(spec, 'type', '').trim()
            );
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
            await (Editor.Message.request as any)(SCENE, 'set-property', item);
        }

        // 5) 回读验证（场景脚本通道；场景进程还没加载新方法时降级为 unavailable，不阻塞绑定本身）
        const results: any[] = [];
        for (const plan of plans) {
            let verified: any = 'skipped';
            let actual: any = null;
            let note = '';
            if (plan.verifyIndex !== '' && plan.verifyProp) {
                try {
                    const r: any = await Editor.Message.request(SCENE, 'execute-scene-script', {
                        name: packageJSON.name,
                        method: 'readComponentProperty',
                        args: [plan.uuid, plan.verifyIndex, plan.verifyProp],
                    });
                    if (r && r.ok === true) {
                        actual = r.ref ?? null;
                        const actualUuid = actual && actual.uuid ? actual.uuid : null;
                        verified = actualUuid === plan.expectedUuid;
                    } else {
                        verified = 'unavailable';
                        note = (r && r.error)
                            ? String(r.error)
                            : '场景脚本没有返回结果（编辑器里重载 cocos-mcp 扩展后可验证）';
                    }
                } catch (e: any) {
                    verified = 'unavailable';
                    note = e?.message ?? String(e);
                }
            }
            results.push({
                uuid: plan.uuid,
                nodeName: plan.nodeName,
                nodePath: plan.nodePath,
                path: plan.path,
                component: plan.component,
                componentAmbiguous: plan.componentAmbiguous || undefined,
                target: plan.target,
                expectedUuid: plan.expectedUuid,
                typeMissing: plan.typeMissing || undefined,
                dump: plan.dump,
                actual,
                verified,
                ...(note ? { verifyNote: note } : {}),
            });
        }

        const mismatched = results.filter((item) => item.verified === false);
        if (mismatched.length) {
            const lines = mismatched.map((item: any) =>
                `${item.nodePath} ${item.path} → 期望 ${item.expectedUuid ?? 'null'}，实际 ${
                    item.actual && item.actual.uuid ? item.actual.uuid : JSON.stringify(item.actual)
                }`
            );
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

const nodeCreatePrefab: OperationDefinition = {
    name: 'node.createPrefab',
    title: '保存节点为预制体',
    description:
        '把场景节点（含整棵子树）保存为 .prefab 资源（scene/create-prefab，自动进 undo），' +
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

        const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
        const target = findNodeInTree(tree, nodeUuid);
        if (!target) {
            throw new Error(`场景里找不到节点: ${nodeUuid}`);
        }
        const sceneRootUuid = dumpValue<string>(tree?.uuid, '');
        if (sceneRootUuid && sceneRootUuid === nodeUuid) {
            throw new Error('不能把场景根保存为预制体，请指定它的某个子节点');
        }
        const nodeName = dumpValue<string>(target.name, '');

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
        const createdFolders: string[] = [];
        for (const segment of folderSegments) {
            if (!segment) continue;
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

        if (params?.overwrite === true) {
            const existing: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (existing || []).find((asset: any) => asset.url === url);
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

const prefabOpen: OperationDefinition = {
    name: 'prefab.open',
    title: '打开预制体',
        description:
            '进入预制体编辑模式（等价资源管理器里双击 .prefab）。普通场景下先保存当前场景避免弹窗，' +
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
        if (!url) throw new Error('必须指定 url（db:// 路径或 uuid）');
        let uuid = url;
        if (url.startsWith('db://')) {
            const info: any = await Editor.Message.request(ASSET_DB, 'query-asset-info', url);
            if (!info || !info.uuid) throw new Error(`找不到预制体资产: ${url}`);
            if (info.type && info.type !== 'prefab' && info.type !== 'cc.Prefab') {
                throw new Error(`目标不是预制体（${info.type}）: ${info.url || url}`);
            }
            uuid = String(info.uuid);
        }
        // 已处于预制体编辑模式时直接尝试 open-asset 切换（prefab→prefab 未充分验证，失败走超时提示）
        const mode = await detectPrefabMode();
        if (mode.inPrefabMode) {
            if (params?.assumeClean !== true) {
                throw prefabModeBlockedError(mode.prefabName, `打开预制体 ${url}`);
            }
        }
        if (params?.saveCurrent !== false && !mode.inPrefabMode) {
            try {
                await Editor.Message.request(SCENE, 'save-scene');
            } catch (e) {
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
        const result: any = { opened: switched.opened, prefabUuid: uuid, fromScene: switched.from || null, currentScene: switched.current || null, requested: true };
        if (!result.opened) {
            result.hint = '超时未切换文档：可能当前已处于该预制体的编辑模式，或当前是无标题未保存场景时编辑器弹了保存对话框（处理后重试）';
        }
        return result;
    },
};

const sceneSave: OperationDefinition = {
    name: 'scene.save',
    title: '保存场景',
    description:
        '通过 scene/save-scene 保存当前场景，返回保存结果。' +
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
        let url: string | null = null;
        if (sceneUuid) {
            try {
                url = await Editor.Message.request(ASSET_DB, 'query-path', sceneUuid);
            } catch (e) {
                url = null;
            }
        }
        return { dirtyBefore, dirtyAfter, sceneUuid: sceneUuid || null, url: url || null };
    },
};

const assetList: OperationDefinition = {
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
        const assets: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern });
        const list = (assets || []).slice(0, limit).map((asset: any) => ({
            url: asset.url,
            uuid: asset.uuid,
            type: asset.type,
            file: asset.file,
        }));
        return { pattern, total: (assets || []).length, listed: list.length, assets: list };
    },
};

const assetDelete: OperationDefinition = {
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
            const assets: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (assets || []).find((asset: any) => asset.url === url);
            if (!hit) {
                throw new Error(`找不到资源: ${url}`);
            }
            target = hit.uuid;
        }

        try {
            await Editor.Message.request(ASSET_DB, 'delete-asset', target);
        } catch (e) {
            // 有些版本认路径不认 uuid，退回按路径再试一次
            if (!url) throw e;
            await Editor.Message.request(ASSET_DB, 'delete-asset', url);
            target = url;
        }
        return { target, url: url || null, deleted: true };
    },
};

const assetImport: OperationDefinition = {
    name: 'asset.import',
    title: '导入资源文件',
    description:
        '把磁盘上的文件/目录复制进 assets 并触发 asset-db 导入，轮询到 uuid 就绪后返回（含子资源 uuid，如 spriteFrame）。' +
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
        if (!dbPath.startsWith('db://assets/')) throw new Error(`dbPath 必须在 db://assets/ 下: ${dbPath}`);

        // 纯刷新模式：不复制，只对已就位的文件触发 asset-db 导入
        const pureRefresh = !src;
        const srcAbs = pureRefresh
            ? dbUrlToAbs(dbPath)
            : (src.startsWith('db://')
                ? dbUrlToAbs(src)
                : (src.match(/^[A-Za-z]:[\\/]/) ? src : join(projectRoot(), src)));
        const srcStat = await stat(srcAbs).catch(() => null);
        if (!srcStat) {
            throw new Error(pureRefresh
                ? `目标文件不在磁盘上，无法刷新: ${srcAbs}（纯刷新模式要求文件已写进 assets）`
                : `源路径不存在: ${srcAbs}`);
        }

        dbPath = dbPath.replace(/\/+$/, '');
        const srcIsDir = srcStat.isDirectory();
        const dbDir = !srcIsDir && extname(dbPath) ? dirname(dbPath) : dbPath;

        // 计算复制清单：目录递归展开，文件单条
        const items: Array<{ from: string; toAbs: string; dbUrl: string; rel: string }> = [];
        if (srcIsDir) {
            const walk = async (dir: string, rel: string): Promise<void> => {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    const lower = entry.name.toLowerCase();
                    // 跳过点文件与 Cocos 的 xxx.ts.meta（编辑器自生成，导入它只会白等超时/带入旧 uuid）
                    if (lower.startsWith('.') || lower.endsWith('.meta')) continue;
                    const from = join(dir, entry.name);
                    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        await walk(from, childRel);
                    } else {
                        items.push({ from, toAbs: dbUrlToAbs(`${dbDir}/${childRel}`), dbUrl: `${dbDir}/${childRel}`, rel: childRel });
                    }
                }
            };
            await walk(srcAbs, '');
        } else {
            if (basename(srcAbs).toLowerCase().endsWith('.meta')) {
                throw new Error('不要把 .meta 当作导入对象（编辑器自生成文件）；直接导入对应的资源文件即可');
            }
            const fileName = basename(srcAbs);
            const dbUrl = extname(dbPath) ? dbPath : `${dbDir}/${fileName}`;
            items.push({ from: srcAbs, toAbs: dbUrlToAbs(dbUrl), dbUrl, rel: fileName });
        }
        if (!items.length) throw new Error(`源目录里没有可复制的文件: ${srcAbs}`);

        // 复制到磁盘（源与目标同路径 = 文件已就位，跳过复制只触发导入）
        for (const item of items) {
            if (isSamePath(item.from, item.toAbs)) continue;
            await mkdir(dirname(item.toAbs), { recursive: true });
            await copyFile(item.from, item.toAbs);
        }

        // 触发导入：从目标目录向上找到 asset-db 已知的最近祖先再刷新（新目录本身可能还未入库）
        let refreshUrl = dbDir;
        for (let guard = 0; guard < 6; guard++) {
            const parent = dirname(refreshUrl);
            if (parent === refreshUrl || !parent.startsWith('db://assets')) break;
            const known: any = await (Editor.Message.request as any)(ASSET_DB, 'query-asset-info', refreshUrl);
            if (known) break;
            refreshUrl = parent;
        }
        try {
            await (Editor.Message.request as any)(ASSET_DB, 'refresh-asset', refreshUrl);
        } catch (e) {
            // 个别版本不支持目录刷新，退回逐文件刷新
            for (const item of items) {
                await (Editor.Message.request as any)(ASSET_DB, 'refresh-asset', item.dbUrl);
            }
        }

        // 轮询导入结果，收集 uuid 与子资源（spriteFrame 等）
        const deadline = Date.now() + waitTimeout;
        const files: any[] = [];
        let ready = true;
        for (const item of items) {
            let assetInfo: any = null;
            while (Date.now() < deadline) {
                assetInfo = await (Editor.Message.request as any)(ASSET_DB, 'query-asset-info', item.dbUrl);
                if (assetInfo) break;
                await sleep(300);
            }
            if (!assetInfo) {
                ready = false;
                files.push({ src: item.from, url: item.dbUrl, rel: item.rel, ready: false });
                continue;
            }
            let subAssets: any[] = Array.isArray(assetInfo.subAssets)
                ? assetInfo.subAssets.map((sub: any) => ({ name: sub.name, url: sub.url, uuid: sub.uuid, type: sub.type }))
                : null;
            if (!subAssets) {
                // 兜底：子资源 url 形如 <资源url>/<名字>，用 query-assets 查
                const subs: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: `${item.dbUrl}/*` });
                subAssets = (subs || []).map((sub: any) => ({
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

const sceneScriptInfo: OperationDefinition = {
    name: 'scene.script.info',
    title: '场景脚本通道 · 引擎信息',
    description: '通过 scene/execute-scene-script 进入场景进程，读取引擎与场景信息',
    params: {},
    schema: noParams(),
    async run() {
        const result = await Editor.Message.request(SCENE, 'execute-scene-script', {
            name: packageJSON.name,
            method: 'engineInfo',
            args: [],
        });
        return { scriptResult: result };
    },
};

const sceneScriptDemo: OperationDefinition = {
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
            name: packageJSON.name,
            method: 'createNode',
            args: [name, position],
        });
        return { scriptResult: result };
    },
};

// ---------------------------------------------------------------- 脚本 / 组件

/** 等待某个脚本资源被 Creator 编译并注册为 ccclass */
async function waitForScriptCompiled(assetUuid: string, timeoutMs = 30000): Promise<any | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const list: any[] = await Editor.Message.request(SCENE, 'query-components');
        const found = (list || []).find((item) => item && item.assetUuid === assetUuid);
        if (found) return found;
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
function renderDefault(prop: any, type: string): string {
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
const CC_TYPE_NAMES: string[] = [
    'Node', 'Label', 'Button', 'Sprite', 'SpriteFrame', 'SpriteAtlas', 'Toggle', 'Layout', 'Widget',
    'ScrollView', 'EditBox', 'Slider', 'ProgressBar', 'Graphics', 'Animation', 'AudioSource',
    'Vec2', 'Vec3', 'Color', 'Size', 'Prefab', 'Mask', 'RichText', 'UIOpacity', 'EventHandler',
];

/** 从属性声明与类体里收集用到的 cc 类型，生成 import 列表 */
function collectCcTypes(properties: any[], body: string): string[] {
    const used = new Set<string>();
    for (const prop of properties || []) {
        const type = String(prop?.type || '').trim();
        if (CC_TYPE_NAMES.includes(type)) used.add(type);
    }
    if (body) {
        for (const name of CC_TYPE_NAMES) {
            if (new RegExp(`\\b${name}\\b`).test(body)) used.add(name);
        }
    }
    return Array.from(used).sort();
}

/** 生成脚本源码 */
function buildScriptSource(className: string, properties: any[], body: string, imports: string[] = []): string {
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

const scriptCreate: OperationDefinition = {
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
        const overwrite = params?.overwrite === true;

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
        const source = buildScriptSource(
            className,
            params?.properties || [],
            pickString(params, 'body', ''),
            Array.isArray(params?.imports) ? params.imports : []
        );

        // overwrite=true：先删除同名旧资源再创建（不然 create-asset 会因文件已存在返回空）
        if (overwrite) {
            const existing: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: path });
            const hit = (existing || []).find((asset: any) => asset.url === path);
            if (hit) {
                await Editor.Message.request(ASSET_DB, 'delete-asset', hit.uuid);
            }
        }

        const created: any = await Editor.Message.request(ASSET_DB, 'create-asset', path, source);
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

const scriptList: OperationDefinition = {
    name: 'script.list',
    title: '列出脚本组件',
    description: '列出编辑器里已注册的全部组件（内置 + 用户脚本），带 cid / path / assetUuid',
    params: {},
    schema: noParams(),
    async run() {
        const list: any[] = await Editor.Message.request(SCENE, 'query-components');
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

const nodeAddComponent: OperationDefinition = {
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
        } else {
            // 自定义脚本组件必须走引擎：编辑器消息通道挂不上去
            channel = 'engine';
            const scriptResult: any = await Editor.Message.request(SCENE, 'execute-scene-script', {
                name: packageJSON.name,
                method: 'addComponentToNode',
                args: [node, component],
            });
            if (!scriptResult || scriptResult.ok !== true) {
                throw new Error(
                    `挂载自定义组件失败：${scriptResult && scriptResult.error ? scriptResult.error : '未知错误'}` +
                    (scriptResult && scriptResult.registeredUserClasses
                        ? `；引擎里已注册的用户类: ${scriptResult.registeredUserClasses.join(', ') || '(无)'}`
                        : '')
                );
            }
        }

        // create-component / addComponent 都不返回有效值，必须回读确认
        const comps = await queryNodeComponents(node);
        const attached = matchExistingComponent(comps, candidates);
        if (!attached) {
            const current = comps.map((c: any) => c.type || c.name).join(', ') || '(无)';
            throw new Error(
                `组件没有真正挂上：节点 ${node} 上没有出现组件「${component}」（通道：${channel}）；` +
                `当前组件: ${current}`
            );
        }
        return { node, component, channel, attached: true, components: comps };
    },
};

const nodeRemoveComponent: OperationDefinition = {
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

const nodeListComponents: OperationDefinition = {
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
        const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
        const found = findNodeInTree(tree, node);
        if (!found) {
            throw new Error(`场景树里找不到节点 ${node}`);
        }
        const comps = readNodeComponents(found);
        return {
            node,
            nodeName: dumpValue<string>(found.name, ''),
            count: comps.length,
            components: comps,
        };
    },
};

const nodeDebug: OperationDefinition = {
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
        if (!uuid) throw new Error('必须指定 node');
        const tree: any = await Editor.Message.request(SCENE, 'query-node-tree');
        const find = (node: any): any => {
            if (!node) return null;
            if (dumpValue<string>(node.uuid, '') === uuid) return node;
            for (const child of (node.children || [])) {
                const hit = find(child);
                if (hit) return hit;
            }
            return null;
        };
        const found = find(tree);
        const direct: any = await Editor.Message.request(SCENE, 'query-node', uuid);
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

const sceneCapture: OperationDefinition = {
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
            name: packageJSON.name,
            method: 'captureScene',
            args: [maxW],
        });
        if (!result || result.ok === false) {
            throw new Error((result && result.error) || '场景截图失败');
        }
        const outPath = pickString(params, 'outPath', '').trim();
        if (outPath && result.base64) {
            const abs = resolve(outPath);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, Buffer.from(String(result.base64), 'base64'));
            return { ...result, base64: undefined, savedTo: abs };
        }
        return result;
    },
};

const sceneReopen: OperationDefinition = {
    name: 'scene.reopen',
    title: '重开场景',
    description: '保存当前场景后重新打开它，触发场景进程重新导入用户脚本模块（外部写入的 .ts 编译后需要这一步才能在引擎里挂载）',
    params: {},
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
        const save: any = await Editor.Message.request(SCENE, 'save-scene');
        const status: any = await Editor.Message.request(SCENE, 'query-current-scene');
        const uuid = typeof status === 'string' ? status : (status && status.uuid);
        if (!uuid) throw new Error('拿不到当前场景 uuid: ' + JSON.stringify(status));
        // 已打开场景的 open-scene 可能被忽略：先切到空场景再切回，强制场景进程重载脚本模块
        let empty: any = null;
        try {
            empty = await Editor.Message.request(SCENE, 'load-empty-scene');
        } catch (e) {
            empty = String((e as Error).message || e);
        }
        const opened = await Editor.Message.request(SCENE, 'open-scene', uuid);
        return { saved: save, sceneUuid: uuid, empty, opened };
    },
};

const sceneCreate: OperationDefinition = {
    name: 'scene.create',
    title: '新建场景',
    description:
        '用 asset-db/new-asset 按编辑器内置模板新建场景，与资源管理器右键「新建 → 场景」同一通道' +
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
        if (!url.startsWith('db://assets/')) throw new Error(`场景必须创建在 db://assets/ 下: ${url}`);
        if (!url.endsWith('.scene')) throw new Error(`场景路径必须以 .scene 结尾: ${url}`);
        const overwrite = params?.overwrite === true;

        // 预制体编辑模式下切换文档会弹「是否保存」对话框且无法自动处理（save-scene 对预制体文档无效），
        // 先检测先拒绝；确认包裹场景无未保存修改时可 assumeClean=true 跳过
        let fromPrefabMode = false;
        if (params?.open === true) {
            const mode = await detectPrefabMode();
            if (mode.inPrefabMode) {
                if (params?.assumeClean !== true) throw prefabModeBlockedError(mode.prefabName, `创建并打开新场景 ${url}`);
                // 新场景一定不是「已加载 uuid」，open-scene 可以正常切换（见 scene.open 内注释），
                // 但 query-current-scene 在脱离前是盲的——下面的轮询在脱离后自然拿到正确 uuid
                fromPrefabMode = true;
            }
        }

        // 逐级确保父目录存在（create-asset 的 source 传 null 即创建目录）
        const folderSegments = url.slice('db://assets/'.length).split('/').slice(0, -1);
        let folderUrl = 'db://assets';
        for (const segment of folderSegments) {
            if (!segment) continue;
            folderUrl = `${folderUrl}/${segment}`;
            const exists = await Editor.Message.request(ASSET_DB, 'query-asset-info', folderUrl);
            if (!exists) {
                const created = await Editor.Message.request(ASSET_DB, 'create-asset', folderUrl, null);
                if (!created) throw new Error(`创建目录失败: ${folderUrl}`);
            }
        }

        let template = pickString(params, 'template', '').trim() || '2d';
        if (template === '2d') template = 'db://internal/default_file_content/scene/scene-2d.scene';
        else if (template === 'empty' || template === '3d') template = 'db://internal/default_file_content/scene/default.scene';
        const info: any = await Editor.Message.request(ASSET_DB, 'new-asset', {
            handler: 'scene',
            target: url,
            template,
            overwrite,
        });
        if (!info || !info.uuid) {
            throw new Error(`new-asset 没有返回资源信息: ${url}（同名文件已存在？可传 overwrite=true）`);
        }
        const result: any = { uuid: info.uuid, url: info.url || url, file: info.file || null, template };

        if (params?.open === true) {
            // 不做 load-empty-scene：它会产生无标题场景，导致随后的 open-scene 弹「保存当前场景」对话框
            const timeout = pickNumber(params, 'openTimeout', 30000) || 30000;
            try {
                await Editor.Message.request(SCENE, 'open-scene', info.uuid);
            } catch (e) {
                // open-scene 可能静默被忽略，交给下面的轮询判断
            }
            const deadline = Date.now() + timeout;
            let current = '';
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                try {
                    const status: any = await Editor.Message.request(SCENE, 'query-current-scene');
                    current = typeof status === 'string' ? status : (status && status.uuid) || '';
                } catch (e) {
                    current = '';
                }
                if (current === String(info.uuid)) break;
            }
            result.opened = current === String(info.uuid);
            result.currentScene = current || null;
            if (fromPrefabMode) result.fromPrefabMode = true;
            if (!result.opened) {
                result.hint = '超时未切换到新场景：当前场景未保存时 open-scene 会弹保存对话框，在编辑器里处理该对话框后可用 scene.open 重试';
            }
        }
        return result;
    },
};

const sceneOpen: OperationDefinition = {
    name: 'scene.open',
    title: '打开场景',
    description:
        '按 db:// 路径或 uuid 打开指定场景（默认先保存当前场景再切换，saveCurrent=false 可跳过保存）。' +
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
        if (!url) throw new Error('必须指定 url（db:// 路径或 uuid）');
        let uuid = url;
        if (url.startsWith('db://')) {
            const assets: any[] = await Editor.Message.request(ASSET_DB, 'query-assets', { pattern: url });
            const hit = (assets || []).find((a: any) => a.url === url) || (assets || [])[0];
            if (!hit || !hit.uuid) throw new Error(`找不到场景资产: ${url}`);
            uuid = String(hit.uuid);
        }
        const mode = await detectPrefabMode();
        const fromPrefab = mode.inPrefabMode;
        if (fromPrefab && params?.assumeClean !== true) {
            throw prefabModeBlockedError(mode.prefabName, `打开场景 ${url}`);
        }
        const saveCurrent = params?.saveCurrent === false ? false : true;
        if (saveCurrent && !fromPrefab) {
            try {
                await Editor.Message.request(SCENE, 'save-scene');
            } catch (e) {
                // 保存失败不阻断切换
            }
        }
        if (fromPrefab) {
            // 实测（2026-10）：预制体模式下 open-scene 对「已加载的场景 uuid」（背后的场景页签）会被忽略，
            // 对未加载的场景可以正常切换；close-scene 在该模式下无效、不要用。
            // query-current-scene 在该模式下是盲的（返回包裹场景 uuid），所以先用 detectPrefabMode 判断是否脱离
            try {
                await Editor.Message.request(SCENE, 'open-scene', uuid);
            } catch (e) {
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
                    const st: any = await Editor.Message.request(SCENE, 'query-current-scene');
                    current = typeof st === 'string' ? st : (st && st.uuid) || '';
                } catch (e) {
                    current = '';
                }
                if (current === uuid) break;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            const result: any = { opened: current === uuid, sceneUuid: uuid, fromPrefabMode: true, currentScene: current || null };
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

const sceneClose: OperationDefinition = {
    name: 'scene.close',
    title: '关闭当前场景',
    description:
        '关闭当前场景文档（scene/close-scene）。核心用途：外部直改过 .scene 文件后强制重开——' +
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
        if (mode.inPrefabMode) throw prefabModeBlockedError(mode.prefabName, '关闭场景文档');
        let dirty = false;
        try {
            dirty = dumpValue<boolean>(await Editor.Message.request(SCENE, 'query-dirty'), false) === true;
        } catch (e) {
            // query-dirty 不可用时按不脏处理（close-scene 自身对脏场景的行为交由编辑器）
        }
        if (dirty && params?.force !== true) {
            throw new Error('当前场景有未保存改动，关闭会弹「是否保存」对话框。请先 scene.save；确认可丢弃时传 force=true。');
        }
        const closed = dumpValue<boolean>(await Editor.Message.request(SCENE, 'close-scene'), false);
        let current = '';
        try {
            current = dumpValue<string>(await Editor.Message.request(SCENE, 'query-current-scene'), '') || '';
        } catch (e) {
            // 关闭后可能没有活动文档，query 失败属正常
        }
        return { closed, currentScene: current || null };
    },
};

const projectSetDesignResolution: OperationDefinition = {
    name: 'project.setDesignResolution',
    title: '设置项目设计分辨率',
    description:
        '设置项目设计分辨率（等价于 项目设置→项目 面板：Editor.Profile.setProject 持久化到 settings/v2/packages/project.json，' +
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
        const width = Math.round(pickNumber(params, 'width', 0));
        const height = Math.round(pickNumber(params, 'height', 0));
        if (!(width >= 1 && width <= 8192) || !(height >= 1 && height <= 8192)) {
            throw new Error(`width/height 必须是 1~8192 的整数，收到: ${JSON.stringify(params?.width)} x ${JSON.stringify(params?.height)}`);
        }

        // 当前值：官方 query-design-resolution 消息优先，取不到退回 Profile
        let current: any = null;
        try {
            current = await (Editor.Message.request as any)('project', 'query-design-resolution');
        } catch (e) {
            current = null;
        }
        if (!current || typeof current !== 'object') {
            current = await Editor.Profile.getProject('project', 'general.designResolution');
        }
        const before = {
            width: Math.round(Number(current?.width)) || 0,
            height: Math.round(Number(current?.height)) || 0,
            fitWidth: current?.fitWidth === true,
            fitHeight: current?.fitHeight === true,
        };

        const resolution = {
            width,
            height,
            fitWidth: typeof params?.fitWidth === 'boolean' ? params.fitWidth : before.fitWidth,
            fitHeight: typeof params?.fitHeight === 'boolean' ? params.fitHeight : before.fitHeight,
        };

        // 持久化（settings/v2/packages/project.json），官方 Profile API
        await Editor.Profile.setProject('project', 'general.designResolution', resolution);
        // 应用：与设置面板同一条消息，scene 扩展监听后刷新画布
        await (Editor.Message.request as any)('project', 'change-design-resolution', resolution);

        // 回读验证
        let queried: any = null;
        try {
            queried = await (Editor.Message.request as any)('project', 'query-design-resolution');
        } catch (e) {
            queried = null;
        }
        // 落盘校验（Profile 异步写盘，稍等再读，best effort）
        await sleep(500);
        let file: any = null;
        try {
            const raw = JSON.parse(await readFile(join(projectRoot(), 'settings', 'v2', 'packages', 'project.json'), 'utf8'));
            file = raw?.general?.designResolution ?? null;
        } catch (e) {
            file = null;
        }
        const persisted = !!(
            file &&
            Number(file.width) === width &&
            Number(file.height) === height &&
            file.fitWidth === resolution.fitWidth &&
            file.fitHeight === resolution.fitHeight
        );
        return { before, applied: resolution, queried, file, persisted };
    },
};

const nodeCreateComponentMsg: OperationDefinition = {
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
        if (!node || !component) throw new Error('需要 node 与 component');
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
        const comps: any[] = await queryNodeComponents(node);
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
function resolveResultRefs(value: any, results: any[]): any {
    if (typeof value === 'string') {
        const m = /^\$(\d+)(?:\.([\w.[\]]+))?$/.exec(value);
        if (!m) return value;
        const hit = results[Number(m[1])];
        if (!hit || !hit.ok) throw new Error(`引用 $${m[1]} 失败：该项未成功执行`);
        const segs = (m[2] || '').split('.').filter(Boolean);
        let cur: any = segs[0] === 'data' ? hit : hit.data;
        for (const key of segs) {
            const im = /^(.*?)\[(\d+)\]$/.exec(key);
            cur = im ? cur?.[im[1]]?.[Number(im[2])] : cur?.[key];
        }
        return cur;
    }
    if (Array.isArray(value)) return value.map((v) => resolveResultRefs(v, results));
    if (value && typeof value === 'object') {
        const out: any = {};
        for (const key of Object.keys(value)) out[key] = resolveResultRefs(value[key], results);
        return out;
    }
    return value;
}

const batchRun: OperationDefinition = {
    name: 'batch.run',
    title: '批量执行操作',
    description:
        '按顺序执行一组操作，把 N 次往返合并为一次调用。' +
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
        const items: any[] = Array.isArray(params?.items) ? params.items : [];
        if (!items.length) throw new Error('items 为空');
        const stopOnError = params?.stopOnError !== false;

        const results: any[] = [];
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
                if (stopOnError) { aborted = true; break; }
                continue;
            }
            try {
                let itemParams = item?.params || {};
                if (results.length && itemParams && typeof itemParams === 'object') {
                    itemParams = resolveResultRefs(itemParams, results);
                }
                const operation = registryMap[op];
                if (!operation) throw new Error(`未知操作: ${op}`);
                const data = await operation.run(itemParams);
                okCount++;
                results.push({ op, ok: true, data, cost: Date.now() - start });
            } catch (e) {
                failCount++;
                results.push({ op, ok: false, error: String((e as Error).message || e), cost: Date.now() - start });
                if (stopOnError) { aborted = true; break; }
            }
        }
        return { total: items.length, ok: okCount, failed: failCount, aborted, results };
    },
};

// ---------------------------------------------------------------- MCP 服务器自管理

const mcpStatus: OperationDefinition = {
    name: 'mcp.status',
    title: 'MCP 服务器状态',
    description: '查询 mcp-server 子进程运行状态：端口、pid、是否本编辑器启动、HTTP 探活结果',
    params: {},
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
        return await mcpServerStatus();
    },
};

const mcpRestart: OperationDefinition = {
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
        const before = await mcpServerStatus();
        const port = pickNumber(params, 'port', 0) || before.port || before.lastPort || 3002;
        if (before.running && !before.owned) {
            throw new Error(
                `端口 ${port} 上的 MCP Server（pid ${before.pid}）不是本编辑器启动的，无法代为重启；` +
                '请先在终端结束该进程，或换端口启动新实例。'
            );
        }
        if (before.running && before.owned) {
            await stopMcpServer();
        }
        const state = await startMcpServer(port);
        if (!state.running) {
            throw new Error(`重启后 mcp-server 未运行，最近输出：${state.recentOutput.slice(-5).join(' | ') || '无'}`);
        }
        return { ...state, restarted: true, previousPid: before.pid };
    },
};

// ---------------------------------------------------------------- 注册表

const registry: OperationDefinition[] = [
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

const registryMap: { [name: string]: OperationDefinition } = {};
for (const operation of registry) {
    registryMap[operation.name] = operation;
}

/** 列出所有操作（MCP tools/list 的数据源） */
export function listOperations(): OperationInfo[] {
    return registry.map((operation) => ({
        name: operation.name,
        title: operation.title,
        description: operation.description,
        params: operation.params,
        schema: operation.schema,
    }));
}

/** 按名字执行一个操作 */
export async function runOperation(name: string, params: { [key: string]: any } = {}): Promise<any> {
    const operation = registryMap[name];
    if (!operation) {
        const known = registry.map((item) => item.name).join(', ');
        throw new Error(`未知操作: ${name}；可用操作: ${known}`);
    }
    return operation.run(params || {});
}
