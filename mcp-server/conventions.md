# Cocos Creator 3.8 开发规范

> 适用于所有由 AI 生成或修改的 Cocos Creator 3.8 + TypeScript 代码。
> 本文件可直接作为 `CLAUDE.md` / `.cursorrules` / 系统提示词使用。

---

## 0. 核心原则（优先级最高）

1. **像人类开发者一样使用编辑器**：引用在编辑器里绑定，结构在编辑器里搭建，代码只负责逻辑，不负责"找节点"和"拼结构"。
2. **优先使用引擎自带机制**：事件用 `EventTarget` / `Node` 事件，不自造订阅发布容器。
3. **层级是设计，不是实现细节**：每个节点都必须能说清"归属谁、生命周期跟谁"。
4. **能直接调用就不要发事件，能放场景就不要拆 Prefab**：不过度解耦，不过度拆分。
5. **AI 无法操作编辑器**：凡需要在编辑器中手动完成的事（绑定属性、拆 Prefab、调整层级），必须在回复中明确列出。
6. **改动既有结构前先说明、后修改**：层级结构、Prefab 根节点、Prefab 根脚本公开接口，未经确认不得擅自改动。
7. 禁止使用 Cocos 2.x 写法（`cc.Class`、`cc.systemEvent`、`cc.director`、`cc.find`、`cc.Node.EventType` 等任何带 `cc.` 前缀的 API），统一使用 3.x 的 `import { ... } from 'cc'`。

---

## 1. 节点引用：编辑器绑定优先

### 1.1 总则
- 节点和组件引用**默认通过 `@property` 声明，并在 Inspector 中拖拽绑定**。
- 原因：引用由引擎按 UUID 维护，调整节点位置、层级、改名都不会使引用失效；同时减少查找代码，在编辑器里即可看清脚本依赖了哪些节点。
- 代码中**不得通过节点的位置、层级路径、名字或子节点序号**获取引用。
- 如果某个引用看起来需要在代码里查找，先判断能否改成编辑器绑定，能就必须绑定。

### 1.2 声明写法
```ts
import { _decorator, Component, Node, Label, Sprite, Button, Prefab } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ShopPanel')
export class ShopPanel extends Component {
    @property(Label)   titleLabel: Label = null!;
    @property(Sprite)  iconSprite: Sprite = null!;
    @property(Button)  buyButton: Button = null!;
    @property(Node)    listRoot: Node = null!;          // 仅需要节点本身时才用 Node
    @property(Prefab)  itemPrefab: Prefab = null!;
    @property([Label]) priceLabels: Label[] = [];       // 同类多个引用用数组
}
```
- 需要组件就直接声明组件类型，不要一律声明 `Node` 再 `getComponent`。只有确实只用节点本身（作为容器、显隐、设置父节点）时才用 `Node`。
- 属性名用 `camelCase` 且体现用途（`closeButton`、`scoreLabel`），不用 `node1`、`child`、`temp`。
- 必填引用使用 `null!`，并在 `onLoad` 中做存在性校验，缺失时明确报错，不得静默忽略。
- 可选引用声明为 `Type | null = null`，使用前判空。

### 1.3 禁止项
- `find('Canvas/UILayer/ShopPanel/Title')` 等全路径查找。
- `node.getChildByName('xxx')` 及其链式调用。
- `node.children[0]` 这类按序号取固定子节点。
- `node.parent` / `node.parent.parent` 向上穿透获取引用。
- 用 `getComponentInChildren(Xxx)` 获取"某个特定的那一个"子节点组件（层级改动后可能取错）。
- 在 `update` / `lateUpdate` 中查找节点或组件。
- 用节点名字做逻辑判断（如 `if (node.name === 'Boss')`）。
- 子节点访问父节点、祖先节点或兄弟节点的组件。一个组件只管理自己的子树。

### 1.4 允许的例外（须在注释中写明原因）
1. **同一节点上的组件**：`this.getComponent(Sprite)`，必须在 `onLoad` 中缓存；必需组件可配合 `@requireComponent`。
2. **运行时 `instantiate` 创建的节点**：可直接使用其根节点及根脚本；内部引用由根脚本通过 `@property` 暴露，外部不得深入 Prefab 内部按路径查找。
3. **遍历动态列表**：遍历列表容器的 `children` 逐个处理，但不得假定固定顺序对应固定含义。
4. **引擎固定入口**：如 `director.getScene()`、`Camera.main`，仅在确实没有其他方式时使用。

### 1.5 跨节点、跨模块引用
- 兄弟节点或相邻模块的引用，由**共同的上级脚本**绑定并分发，不让子节点自己去找兄弟。
- 向上通信走回调或事件（见第 4 节）。
- 全局模块的访问走统一的管理类单例或全局事件，不通过查找节点实现。

### 1.6 修改已有代码时
- 发现已有代码用 `find` / `getChildByName` 获取引用，**不得在其基础上继续堆叠同类写法**，新增功能必须用 `@property`。
- 把路径查找改成 `@property` 时，必须在回复中提示："需要在编辑器中为 XX 组件的 XX 属性重新拖拽绑定"。

---

## 2. 节点层级：设计先于实现

### 2.1 总则
- 父子关系必须表达明确含义：**归属**（谁拥有谁）、**生命周期**（父销毁子随之销毁）、**坐标空间**（子相对父定位）、**渲染顺序**（同级按 sibling 顺序，UI 还受 Canvas 影响）、**显隐范围**（父隐藏则子隐藏）。
- 新增或移动节点前，先回答：**这个节点属于谁？生命周期跟谁一致？** 答不出来就不要挂。
- 不得为了"先跑通"把节点随手挂到 `Canvas`、场景根节点或当前脚本所在节点上。
- 层级结构以编辑器中搭建的场景和 Prefab 为准，代码不得悄悄改变既有层级约定。

### 2.2 层级设计规则
1. **按职责分层，使用容器节点**：同类节点放进语义明确的容器（`UILayer` / `PopupLayer` / `EffectRoot` / `EntityRoot`），不要平铺在同一层。
2. **一个功能一个根节点**：每个面板、角色、关卡单元封装为独立 Prefab，根节点是唯一对外入口。
3. **生命周期一致的放同一棵子树**：随角色销毁的血条、挂点放在角色下；需要独立于角色存在的（飘字、死亡特效）放入公共容器，不挂在会被销毁的节点下。
4. **UI 与世界对象分离**：UI 在 `Canvas` 子树下，世界对象在各自世界根节点下。跟随型 UI（血条等）通过坐标转换跟随目标，不为了跟随而把 UI 挂到世界对象上（除非项目已约定）。
5. **渲染顺序靠层级和容器表达**：优先使用容器先后顺序、`Layer`、`UITransform.priority`，不要靠频繁 `setSiblingIndex` 或反复 `setParent` 来"顶到最前"。

### 2.3 代码创建与修改节点
- 优先 `instantiate(prefab)`，避免用 `new Node()` 手拼复杂结构。
- 创建时的**父节点必须来自 `@property` 注入的容器**，不得写 `director.getScene().addChild(...)` 或 `find('Canvas').addChild(...)`。
- 谁创建谁负责销毁，或明确移交给对象池/管理者，不得创建后无人持有。
- 动态创建的节点设置有意义的 `name`，必要时设置正确的 `layer`。
- 禁止为了"方便获取数据"或"让显示正确"随意 `setParent` / `addChild` / `removeFromParent`。确需改父节点时（如拖拽物品放入背包），必须：
  - 明确使用 `setParent(newParent, true)` 还是 `false`（是否保持世界坐标）；
  - 在注释中写明原因，并说明改变后生命周期、坐标、渲染顺序、显隐如何变化。
- **想要调整既有层级、新增容器层、移动 Prefab 内部节点时，必须先说明方案和理由，等确认后再改。**

### 2.4 命名与结构
- 节点名用 `PascalCase`，体现职责（`HpBar`、`PopupLayer`），不用 `Node1`、`New Node`、`temp`。
- 容器节点以 `Layer` / `Root` / `Container` 结尾。
- Prefab 内部层级深度原则上不超过 5 层，过深说明职责没拆好，应拆成子 Prefab。

### 2.5 标准层级图（按项目实际情况修改）
```
Scene
├─ Canvas
│   ├─ UILayer
│   ├─ PopupLayer
│   └─ TopLayer
└─ World
    ├─ MapRoot
    ├─ EntityRoot
    └─ EffectRoot
```
新增节点时，必须从上述容器中选择挂载点，不自行选择。

---

## 3. 预制体（Prefab）划分

### 3.1 总则
- Prefab 是**可复用、可动态创建、可按需加载的结构单元**，不是节点的收纳盒。
- **默认直接放在场景里，满足明确条件才拆成 Prefab。**
- 新增或拆分 Prefab 前，必须说明：属于哪一类条件、Prefab 路径、根脚本是什么。

### 3.2 必须做成 Prefab
满足任意一条：
1. **运行时动态创建**：子弹、敌人、飘字、特效、列表项、弹窗。
2. **需要多次实例化**：背包格子、关卡单元、任务条目。
3. **多个场景或界面复用**：通用弹窗、通用按钮样式、通用货币栏。
4. **需要懒加载或按需加载**：低频弹窗、活动界面、大型特效、后期关卡内容。

### 3.3 应该做成 Prefab（需说明理由）
- 内部结构复杂（子节点多、脚本多），拆出来便于单独编辑和维护。
- 多人协作时某部分需要独立修改，避免场景文件冲突。
- 该结构有清晰的对外接口，可以用一个根脚本封装。

### 3.4 不应该做成 Prefab
- **场景中唯一存在、不复用、启动即用**的节点（固定 HUD 容器、`UILayer`、`EffectRoot` 等层级容器）。
- 只有一两个节点、没有脚本、没有复用价值的结构。
- 仅为"让场景文件变小"而拆分。
- 嵌套过深（Prefab 内再嵌多层 Prefab），一般不超过两层。

### 3.5 Prefab 结构规则
1. **根节点挂一个同名脚本**，作为唯一对外入口（`ShopItem.prefab` ↔ `ShopItem.ts`）。
2. 内部节点引用在 Prefab 编辑器中通过 `@property` 绑定到根脚本，外部不得穿透内部结构。
3. 提供明确的初始化接口，如 `init(data, callbacks)`；外部依赖（数据、回调、目标节点）通过它传入，Prefab 内部不去外部找节点。
4. 不依赖所在位置的上级节点类型，与外部通信走回调或事件。
5. 根节点的位置、缩放、锚点使用通用默认值，位置由创建方决定。
6. 命名：文件名 `PascalCase`，与根脚本同名；按用途分目录，如 `prefabs/ui/`、`prefabs/entity/`、`prefabs/effect/`。

### 3.6 动态创建规则
- 通过 `@property(Prefab)` 在编辑器绑定 Prefab 引用，不在代码里写死路径字符串。
- **高频创建销毁的对象必须使用 `NodePool`**（子弹、飘字、特效、列表项），并明确回收到哪个容器，不得每次 `instantiate` 再 `destroy`。
- 父节点来自 `@property` 注入的容器（见 2.3）。

### 3.7 懒加载规则
- 懒加载的 Prefab 放入 `resources` 目录或指定 Asset Bundle，使用 `resources.load` / `bundle.load`（若项目有自己的资源管理封装，必须使用封装，不得绕过）。
- 此时无法用 `@property` 绑定，路径字符串必须**集中定义为常量**（如 `PrefabPaths.ts`），不得多处散写。
- 加载必须处理：**加载中状态、加载失败、重复加载**（正在加载时不重复请求，已加载则复用缓存）。
- 用完必须释放（`assetManager.releaseAsset` 或对应 bundle 的 `release`），并说明释放时机。
- 不要把所有 Prefab 都放进 `resources`：启动即用的用 `@property` 绑定，只有懒加载的才走路径加载，避免首包体积和加载时间膨胀。

### 3.8 修改已有 Prefab 时
- 不得擅自改变 Prefab 根节点结构或根脚本的公开接口，这会影响所有使用方；确需修改，先说明影响范围。
- 把场景内节点拆成 Prefab 时，AI 无法在编辑器内完成，必须给出**手动操作步骤**并标明"需要你在编辑器里完成"。

---

## 4. 事件通信

### 4.1 总则
- 事件基于引擎自带的 `EventTarget` 或 `Node` 事件体系。
- **禁止自己实现订阅发布容器**：不得手写 `Map<string, Function[]>`、`listeners`、`subscribers` 之类的结构，不得创建名为 `EventBus` / `EventManager` / `Dispatcher` 的自定义类；跨模块全局通知使用项目统一提供的、基于 `EventTarget` 的事件封装（项目尚未提供时，先建立统一封装再使用）。
- 事件只用于"发送方不应该知道接收方是谁"的场景。能直接调用就不发事件。

### 4.2 选型
| 场景 | 使用方式 |
|---|---|
| 父 → 子 | 直接调用子组件方法或属性，不用事件 |
| 子 → 父、同一节点树内 | `node.emit` / `node.on`，或回调函数 |
| 跨模块、跨场景的全局通知 | 项目统一的全局事件封装（基于 `EventTarget`） |
| 引擎生命周期相关 | `director.on` / `input.on` 等引擎原生接口 |
| 两个明确的模块之间 | 直接依赖 + 接口，不硬解耦 |

### 4.3 全局事件写法
1. 所有全局事件必须先在统一的事件定义（接口或常量文件）中声明事件名和参数类型再使用；新增事件先改定义，不得在调用处直接写未声明的字符串。
2. 发送：通过统一封装 emit，如 `events.emit('coin-changed', value)`。
3. **订阅与取消必须成对**：
   - `onEnable` 中 `on`，`onDisable` 中 `targetOff(this)`；
   - 或 `onLoad` 中 `on`，`onDestroy` 中 `targetOff(this)`；
   - 两者择一，同一组件内保持一致。
4. `on` 时必须传入 `target`（即 `this`），以便 `targetOff` 统一清理。
5. 回调使用类的成员方法，不使用匿名箭头函数订阅（无法精确移除）。
6. 事件名采用 `kebab-case`，语义为"已发生的事实"（`coin-changed`、`level-up`），不用命令式名称（`add-coin`）。

### 4.4 节点事件写法
- 自定义节点事件名集中定义为常量，不在多处重复写字符串。
- 需要事件向上传递时使用 `emit` 并说明原因，不用 `dispatchEvent` 做全局广播。
- 节点销毁前，订阅者必须 `off` 或 `targetOff`。

### 4.5 禁止项
- 禁止在 `update` / `lateUpdate` 中高频 `emit` 全局事件；高频数据用属性读取或直接引用。
- 禁止在事件回调中同步 `emit` 触发同一事件（避免循环触发）。
- 禁止用事件传递大对象或可变引用后被接收方修改；需要时传只读数据或副本。
- 禁止用全局事件代替本可直接依赖的两个明确模块之间的调用。

---

## 5. 交付要求（每次回复末尾必须附带）

涉及以下改动时，回复末尾必须附上对应清单，开发者据此在编辑器中完成手动操作。

### 5.1 编辑器绑定清单（新增或修改了 `@property` 时）
| 脚本 | 属性 | 类型 | 应绑定到的节点 |
|---|---|---|---|
| ShopPanel | titleLabel | Label | Title |
| ShopPanel | buyButton | Button | BuyButton |

### 5.2 Prefab 清单（新增或调整了 Prefab 时）
| Prefab | 路径 | 根脚本 | 归类（必须/应该） | 理由 | 加载方式 |
|---|---|---|---|---|---|
| ShopItem | prefabs/ui/ShopItem.prefab | ShopItem | 必须 | 列表项，多实例 | `@property` 绑定 |
| ActivityPopup | resources/prefabs/ui/ActivityPopup | ActivityPopup | 必须 | 低频弹窗，懒加载 | `resources.load` |

### 5.3 需要在编辑器中手动完成的操作
明确列出：重新绑定哪些属性、拆分哪些节点为 Prefab、新增哪些容器节点、调整哪些层级。没有则写"无"。

---

## 6. 提交前自检

**引用**
- [ ] 是否出现 `find(`、`getChildByName(`、`.children[数字]`、`.parent.parent`
- [ ] 能用 `@property` 的地方是否在 `onLoad` 里查找了
- [ ] `@property` 是否尽量使用具体组件类型而非一律 `Node`
- [ ] 必填引用是否做了空值校验

**层级**
- [ ] 每个新增节点是否都能说清归属和生命周期
- [ ] 是否把节点直接挂到 Canvas 或场景根节点
- [ ] 是否为改显示顺序使用了 `setParent` / 频繁 `setSiblingIndex`
- [ ] 是否擅自改变了既有层级结构

**Prefab**
- [ ] 每个新增 Prefab 是否属于"必须 / 应该"并写明理由
- [ ] 是否把唯一、启动即用、不复用的节点错误拆成了 Prefab
- [ ] 高频创建的对象是否用了 `NodePool`
- [ ] 懒加载是否处理了失败、重复加载和释放
- [ ] Prefab 根节点是否有同名脚本，外部是否穿透了内部结构

**事件**
- [ ] 是否有未配对的 `on` / `off`
- [ ] 是否有未在统一事件定义中声明的事件名
- [ ] 是否出现自定义的事件容器类
- [ ] 是否可以改为直接调用而不必发事件

**交付**
- [ ] 是否附带绑定清单、Prefab 清单和编辑器手动操作说明

---

## 7. MCP 操作通道实测坑位（3.8.8，批量搭场景前必读）

以下行为与直觉不符且**多数静默失败**（返回 ok 但没生效），动手前先对照：

| 操作 | 坑 | 可靠做法 |
|---|---|---|
| `node.setProperty` | **设 `parent` 换父会半生效**（`_parent` 改了、新父 `_children` 没挂上），节点从场景树脱落、之后任何通道都找不到它，保存时被静默丢弃 | **MCP 不做 re-parent**：在新父节点下重建节点（照抄原组件属性）后删除原节点 |
| `node.setProperty.engine` | 不传 `component` 时赋值落在 Node 实例上——`contentSize` 等组件属性是**假生效**（往节点上挂了个无用 JS 属性，回读 applied 显示成功） | 改组件属性必须传 `component`（如 `cc.UITransform`）；写入后读 `.scene` 落盘验证 |
| `node.setProperty.engine`（直连工具） | 对象 value（`{"__uuid":...}`）会被字符串化存进去，引用字段变成垃圾字符串 | 引用赋值走 `batch_run`（对象参数保真）；赋组件引用后回读会因循环引用报 Maximum call stack，属无害——写值在报错前已完成 |
| Sprite 组件 | `sizeMode` 默认 TRIMMED：赋 `spriteFrame` 时自动把 UITransform 改成裁剪尺寸，覆盖你设的 contentSize | 图标先设 `components.<i>.sizeMode=0`（CUSTOM）再设 contentSize |
| 场景校验 | 节点/组件引用在 `.scene` 里序列化为 `{"__id__": N}`（不是 uuid），按 `__uuid__` 校验会误判为 null | 校验绑定时解析 `__id__` 指向的对象再比对 |
| `node.setProperty` | `uuid` 不解析节点路径，传路径静默无效 | 只传真实 uuid（从 scene_tree / batch 结果取） |
| `node.setProperty` | 多组件节点设 `contentSize` 静默失败 | 用 `node.setProperty.engine` 传 `{"__size":[w,h]}`（带 applied 回读，scene.save 后落盘） |
| `node.bindProperty` | `bindings` 多条数组只有第一条生效 | 每条绑定单独一次调用（可并行发） |
| `batch.run` | `"$N"` 引用仅限同一次调用内；`node.create` 的 parent 引用无效时节点被静默建到场景根 | 跨批先取回真实 uuid 再引用；每批之后审计场景根孤儿 |
| `node.addComponent` | 自定义脚本解析不到类名；参数名是 `node` 不是 `uuid` | 先 `script.list` 查 cid 再传 |
| 节点颜色 | 节点级 `color` 对渲染无效 | 设 `components.<索引>.color` |
| `scene.capture` | 异步 repaint，刚切换节点激活状态会拿到旧帧（连续两次字节量相同即旧帧） | sleep ~1.5s 后重拍；outPath 用绝对路径 |
| `scene.reopen` | 外部写入的 .ts 不会因此编译注册 | 对每个改动过的脚本调一次 `asset.import`（纯刷新模式，uuid 不变、cid 稳定） |
| 新建场景 | `asset-db create-asset(url, null)` 在 3.8.8 创建的是**目录**不是场景文件（meta importer=directory），返回 ok 但资产不可用；另：当前场景无标题未保存时 `open-scene` 会弹保存对话框阻塞流程 | 用 `scene_create` op（内部走 `asset-db/new-asset` + 内置模板 `db://internal/default_file_content/scene/scene-2d.scene`，与编辑器右键新建同通道，open=true 轮询确认切换）；不要先 load-empty-scene 再 open |
| `scene.open` | 会先保存当前场景再切换；先切空场景强制干净重载，避免复用内存脏场景 | 崩溃恢复后先 scene_tree 查重名/孤儿再继续 |
| 打开预制体 | `scene/open-scene` 对 prefab uuid **无效**（返回 undefined、场景不切换）；用 `scene.open` 打开预制体还会因内部 load-empty-scene 弹保存对话框 | 用 `prefab_open` op（`asset-db/open-asset` + `query-node-tree` 根 uuid 变化轮询确认；包裹场景 uuid 每次打开都重新生成，只能做前后变化判定） |
| 预制体编辑模式盲区 | 判定：`query-node-tree` 根为 `<名字>-scene` 且首个子节点名 `should_hide_in_hierarchy`。该模式下：`query-current-scene` 仍返回场景页签 uuid（盲）；`query-dirty` 恒 false；`save-scene` 会弹「保存」框并返回 null（2026-10 实测堵 24s 直到人工取消）；`close-scene` 无声无效；`open-scene` 只对**未加载**的场景 uuid 有效、对已加载的（背后的场景页签）被忽略。且在此模式下 `asset.import` 导脚本触发编译会弄脏文档，之后任何切换都弹保存框 | 进：`prefab_open`；脱离：`scene_open(assumeClean=true)` 先开任意**未加载**场景（如另一个 .scene），再正常切回目标；`scene_save`/`scene_open`/`scene_create`/`prefab_open` 已内置守卫（该模式下直接报错并提示 assumeClean）；**导脚本前先脱离预制体模式** |
| 默认值陷阱 | Label 默认 `string='label'`、`fontSize=40`；UITransform 默认 `100×100`；ui/Label 模板默认**白色文字**，放浅色背景看不清 | 批量搭建后按这几类默认值审计漏设节点；浅底上 `cc.Label.color` 改深色 |
| ui/Button 模板坑 | 按钮子 `Label` 的 UITransform 固定在模板默认 `100×40`（overflow=RESIZE_HEIGHT 钉死宽度），**改按钮根节点尺寸不会带子标签**——文字在 100px 处被裁（`走东侧小路` 只显示前 4 字） | 缩放按钮时把子 Label 的 `cc.UITransform.contentSize` 一起设成同尺寸；模板子树用 `node_create` 返回的 `nodes[1].uuid` 定位 |
| 外改 .scene 后重开 | 场景文档**切走后仍驻留内存（页签缓存）**：`scene.open` 对已加载文档只激活不重新解析文件，asset-db refresh / library 重导（盘+library 都确认有改动）也无效；`close-scene` 实测返回 false 关不掉；`scene.reopen` 会先保存（内存态覆盖盘上修改）再重开，等于白改（2026-10 实测） | 外部直改 .scene 的可靠流程：**复制成新资产**（新文件 + .meta 换新 uuid）→ `asset.import` 刷新 → `scene.open` 新路径（新 uuid 无缓存，强制全新解析）；或编辑器重启后重开 |
| ScrollView 模板坑 | 内置 `ui/ScrollView` 模板实例化后 `_content`、`ScrollBar.handle` 已接好，但 **`ScrollView.verticalBar`/`horizontalBar` 是空的**；且 3.8.8 编辑器所有写入通道都无法给它绑组件引用——`set-property` 提交后回读恒 null、引擎通道赋值触发编辑器属性钩子栈溢出（循环引用组件）、盘上直改 `_verticalBar:{__id__}` 在源文件/library 均正确却被反序列化拒绝（ScrollBar 组件实例正常创建，唯独该属性不进活文档，全新 uuid 文档同样复现）（2026-10 实测） | 运行时代码补线：`sv.verticalBar = barNode.getComponent(ScrollBar)`（运行时普通 JS 赋值，无编辑器钩子，必成）；参考 `assets/scripts/ScrollTestDriver.ts` |
| 验证 | 消息通道多数属性无回读；`node.debug` 路径解析不稳 | 落盘 ground truth：直接读 `.scene` 文件（JSON，组件在 `_components[].__id__`） |

组件索引规则：`create-node` 自动附 `cc.UITransform`（`components.0`），后续 `addComponent` 依次追加（Sprite/Label/Button=1，Mask 节点的 Button=2）；追加组件会改变既有索引，多组件节点操作前先 `node.listComponents` 确认。

UI 批量搭建（列表/网格/滚动容器）的模板选择与 Layout 坑位另见第 9 节。

---

## 8. 资源导入参数：九宫格

图片的九宫格边框不必在编辑器里切，直接改该图 `.meta` 中 spriteFrame 子资源（`subMetas.f9941`）`userData` 里的 `borderTop / borderBottom / borderLeft / borderRight`（单位：原始图像素）即可；改完调 `asset.import`（纯刷新模式）重新导入后生效。注意边框仅在 Sprite 组件 `type = 1`（SLICED 九宫格，0 SIMPLE / 2 TILED / 3 FILLED）时生效，设值用 `node.setProperty` 传 `components.<索引>.type = 1`。

---

## 9. UI 布局适配：内置模板 + Widget / Layout，禁止手摆坐标

> 官方文档：《自动布局（Layout）》 https://docs.cocos.com/creator/3.8/manual/zh/ui-system/components/editor/layout.html ｜《对齐策略（Widget）》 https://docs.cocos.com/creator/3.8/manual/zh/ui-system/components/editor/widget.html
> 搭 UI 前先读本节：能自动适配的不要手摆，能用内置模板的不要空节点手拼。

### 9.1 优先用内置模板起步

MCP `node_create` 的 `builtin` 参数直接实例化引擎自带模板（含默认组件与子结构），常用 UI 模板：

| builtin 短名 | 内容 | 典型用途 |
|---|---|---|
| `ui/Canvas` | Canvas + Camera 完整结构 | UI 场景根 |
| `ui/Widget` | 挂好 cc.Widget 的节点 | 贴边、居中、拉伸、分辨率适配 |
| `ui/Layout` | 挂好 cc.Layout 的节点 | 列表 / 行列 / 网格容器 |
| `ui/ScrollView` | view + content + Mask + 滚动条完整结构 | 可滚动列表 |
| `ui/Button`、`ui/Label`、`ui/Sprite`、`ui/RichText` | 常用控件与显示节点 | 按钮、文本、底图、富文本 |
| `ui/ProgressBar`、`ui/Slider`、`ui/Toggle`、`ui/ToggleContainer`、`ui/EditBox`、`ui/pageView` | 功能控件 | 血条、滑条、开关、输入、翻页 |
| `ui/Mask`、`ui/Graphics`、`ui/ParticleSystem2D` | 裁剪、矢量绘制、2D 粒子 | 特殊显示 |

注意：
- 裸短名（`Button`）不存在，必须带 `ui/`、`3d/`、`light/` 等前缀；`pageView` 是小写 p。
- 全量清单用 `asset_list(pattern="db://internal/default_prefab/**/*.prefab")` 查询。
- 模板只含引擎默认值（Layout 模板默认 `type=NONE`，见 9.5），创建后必须按需求改属性。

### 9.2 Widget 与 Layout 的分工

两者都是"自动适配"，但职责不同，按职责选用，不互相替代：

- **Widget 管节点自身相对父节点的对齐与拉伸**：贴边、居中、按百分比填满、随屏幕分辨率适配。竖屏 720×1280 的界面适配主要靠 Widget（`ui/Widget` 模板或直接加 cc.Widget）。
- **Layout 管容器内子节点的排列**：横向 / 纵向 / 网格等间距排列子项，子项增删后自动重排。
- 组合套路：面板根节点挂 Widget 适配分辨率 → 内部列表容器挂 Layout 排子项 → 需要滚动时套 `ui/ScrollView`（其 content 自带 Layout）。

### 9.3 必须用 Layout 的场景（禁止手摆）

同类元素等间距排列（背包格子、技能项、排行榜行、按钮组等），**一律用 Layout，禁止逐个摆坐标**——编辑器里不逐个 `node_move`，代码里不写 `setPosition(x * i, y)` 手算：
- 网格用 `type=GRID`，需要固定行/列数加 `constraint`。
- 动态增删子项的容器必须用 Layout：`instantiate` 的子项 `setParent` 进容器后由 Layout 自动重排，不许也不需要自己设位置。
- 例外：纯静态、位置各不相同的装饰摆放可以直接定位；但同类元素超过 3 个时仍应改用 Layout。
- Layout 容器的子项上**不要再挂 Widget**：Layout 接管子项位置/尺寸，两者互相拉扯。

### 9.4 Layout 属性速查（枚举传数值）

经 `node_set_property` 设 `components.<索引>.<字段>`，枚举字段传数值：

| 字段 | 取值（数值） | 说明 |
|---|---|---|
| `type` | NONE=0 / HORIZONTAL=1 / VERTICAL=2 / GRID=3 | 布局方向，**默认 NONE＝无任何布局效果** |
| `resizeMode` | NONE=0 / CONTAINER=1（容器随子项）/ CHILDREN=2（子项随容器） | 尺寸联动，**默认 NONE** |
| `spacingX` / `spacingY` | 数字 | 子项间距 |
| `paddingLeft` / `paddingRight` / `paddingTop` / `paddingBottom` | 数字 | 容器四边内边距 |
| `startAxis` | HORIZONTAL=0 / VERTICAL=1 | 仅 GRID：先排哪根轴 |
| `cellSize` | `{"width":w,"height":h}` | 仅 GRID＋CHILDREN：格子尺寸 |
| `constraint` | NONE=0 / FIXED_ROW=1 / FIXED_COL=2 | 仅 GRID：固定行数/列数 |
| `constraintNum` | 数字 | 配合 constraint 的行/列数 |
| `horizontalDirection` | LEFT_TO_RIGHT=0 / RIGHT_TO_LEFT=1 | 默认从左往右 |
| `verticalDirection` | BOTTOM_TO_TOP=0 / TOP_TO_BOTTOM=1 | 默认从上到下 |
| `affectedByScale` | true/false | 子项缩放是否参与布局 |

常用组合：
- 竖向列表：`type=2`（VERTICAL）＋ `resizeMode=1`（CONTAINER，高度随子项自适应，配合 ScrollView）。
- 固定 4 列网格：`type=3`＋`constraint=2`（FIXED_COL）＋`constraintNum=4`。
- 固定尺寸格子：`type=3`＋`resizeMode=2`（CHILDREN）＋`cellSize`。

### 9.5 Layout 坑位

| 坑 | 说明 / 可靠做法 |
|---|---|
| 模板默认无效 | `ui/Layout` 创建出来 `type=NONE`、`resizeMode=NONE`，不排任何东西，看着像普通空节点；创建后第一步先设 `type`，必要时设 `resizeMode` |
| 手摆子项被覆盖 | Layout 接管容器内子节点的位置（和尺寸），`node_move` 摆完会被布局重置；容器内子项位置一律交给 Layout |
| 布局下一帧生效 | 属性设置后布局结果到下一帧才更新（引擎 API `layout.updateLayout()` 可立即刷新）；`scene_capture` 验证按第 7 节规则延时重拍 |
| 子项要求 | 只有带 UITransform 的 UI 节点参与布局；不要在 Layout 子项上再挂 Widget（见 9.3） |
| 落盘字段名 | `.scene` 文件里序列化为 `_layoutType` / `_resizeMode` / `_spacingX` 等 `_` 前缀名，读文件校验时按该名找 |

---

## 附录：项目路径约定（按实际情况修改）

| 内容 | 路径 |
|---|---|
| Prefab 路径常量 | `assets/scripts/core/PrefabPaths.ts` |
| UI Prefab | `assets/prefabs/ui/` |
| 实体 Prefab | `assets/prefabs/entity/` |
| 特效 Prefab | `assets/prefabs/effect/` |
| 懒加载 Prefab | `assets/resources/prefabs/` 或指定 Bundle |
