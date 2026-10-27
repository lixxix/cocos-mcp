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
| `node.setProperty` | `uuid` 不解析节点路径，传路径静默无效 | 只传真实 uuid（从 scene_tree / batch 结果取） |
| `node.setProperty` | 多组件节点设 `contentSize` 静默失败 | 用 `node.setProperty.engine` 传 `{"__size":[w,h]}`（带 applied 回读，scene.save 后落盘） |
| `node.bindProperty` | `bindings` 多条数组只有第一条生效 | 每条绑定单独一次调用（可并行发） |
| `batch.run` | `"$N"` 引用仅限同一次调用内；`node.create` 的 parent 引用无效时节点被静默建到场景根 | 跨批先取回真实 uuid 再引用；每批之后审计场景根孤儿 |
| `node.addComponent` | 自定义脚本解析不到类名；参数名是 `node` 不是 `uuid` | 先 `script.list` 查 cid 再传 |
| 节点颜色 | 节点级 `color` 对渲染无效 | 设 `components.<索引>.color` |
| `scene.capture` | 异步 repaint，刚切换节点激活状态会拿到旧帧（连续两次字节量相同即旧帧） | sleep ~1.5s 后重拍；outPath 用绝对路径 |
| `scene.reopen` | 外部写入的 .ts 不会因此编译注册 | 对每个改动过的脚本调一次 `asset.import`（纯刷新模式，uuid 不变、cid 稳定） |
| `scene.open` | 会先保存当前场景再切换；先切空场景强制干净重载，避免复用内存脏场景 | 崩溃恢复后先 scene_tree 查重名/孤儿再继续 |
| 默认值陷阱 | Label 默认 `string='label'`、`fontSize=40`；UITransform 默认 `100×100` | 批量搭建后按这两类默认值审计漏设节点 |
| 验证 | 消息通道多数属性无回读；`node.debug` 路径解析不稳 | 落盘 ground truth：直接读 `.scene` 文件（JSON，组件在 `_components[].__id__`） |

组件索引规则：`create-node` 自动附 `cc.UITransform`（`components.0`），后续 `addComponent` 依次追加（Sprite/Label/Button=1，Mask 节点的 Button=2）；追加组件会改变既有索引，多组件节点操作前先 `node.listComponents` 确认。

---

## 附录：项目路径约定（按实际情况修改）

| 内容 | 路径 |
|---|---|
| Prefab 路径常量 | `assets/scripts/core/PrefabPaths.ts` |
| UI Prefab | `assets/prefabs/ui/` |
| 实体 Prefab | `assets/prefabs/entity/` |
| 特效 Prefab | `assets/prefabs/effect/` |
| 懒加载 Prefab | `assets/resources/prefabs/` 或指定 Bundle |
