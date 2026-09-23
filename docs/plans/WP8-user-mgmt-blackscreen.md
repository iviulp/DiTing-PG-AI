# WP8 修复计划：用户管理弹窗黑屏

> 项目：DiTing PG AI（Tauri 2.0 + Rust + React18）
> 工作包：WP8『用户管理弹窗黑屏』缺陷修复
> 评审形式：十角色团队会议 ×10 场（产品经理、系统架构师、Rust后端、React前端、AI工程师、安全工程师、QA测试、UX设计、DevOps、发布经理）
> 文档状态：评审完成，进入开发排期
> 缺陷现象：用户右键头部连接栏 → 点「User & Privileges (用户权限管理)」→ **整个窗口黑屏**。
> 约束：本地有真实 PG17（Homebrew，库 `itsmorderopsdb`，角色 `yuguosheng`/`readonly_user`/`app_writer`，表 `app.orders`/`app.users`/`public.config`/`public.audit_log`）做真实场景验证；**禁止用假数据兜底**。

## 0. 现状盘点（评审输入）

| # | 事实 | 位置 | 说明 |
|---|------|------|------|
| 1 | 弹窗挂载点 | `src/App.tsx` L822：`<UserManagementModal isOpen={isUserMgmtOpen} connId={activeConnId \|\| ''} ...>` | 组件本体 `src/components/UserManagementModal.tsx`，1091 行 |
| 2 | 遮罩层样式 | 组件 L531：`fixed inset-0 bg-black/60 backdrop-blur-sm z-50`；内层 `bg-[#101216]`；body 背景 `#090b0e` | L989 还有一层嵌套遮罩 `absolute inset-0 bg-black/75 backdrop-blur-md z-50`（重置密码对话框） |
| 3 | 全项目无 ErrorBoundary | `grep -rn ErrorBoundary src/` 零命中 | 任一渲染期未捕获异常 → React 18 整树卸载 → 只剩 body 的 `#090b0e` 深色背景 = 「黑屏」 |
| 4 | 12 处 `window.alert/confirm` | 组件 L232/L278/L298/L303/L308/L427/L448/L451/L455/L512/L516 等 | Tauri v2 WKWebView 中 alert/confirm 是 **no-op**：错误被静默吞掉，且 `confirm` 恒返回假值使删除用户等流程直接短路；违反「该弹错弹错」要求 |
| 5 | 数据链路 | `reloadUsers`（L238）/ `fetchRealPrivileges`（L100）→ `executeSql`（`src/services/ipc.ts` L17，invoke `execute_sql`） | WP5 后返回 `DbValue {type,val}` 结构（`src/types/index.ts` L10-L17），组件已用 `r[0]?.val` 消费；**错误时 invoke reject 的是 `AppErrorDto` 普通对象，无 `.message` 时 `String(err)` 得 `[object Object]`** |
| 6 | WP6 迁移副作用 | 连接列表从 localStorage 迁到后端 vault | connId 语义未变，但 `activeConnId` 可能与后端连接池键不一致 → `execute_sql` 报 connection not found |
| 7 | 渲染期重计算 | `generateSqlStatements`（L324）在 footer **每次 render 都执行**（L958 `generateSqlStatements()[0]`），无 try/catch | 渲染期抛异常 = 整树卸载的头号候选 |
| 8 | 测试基线 | cargo test 154 passed；vitest 44 passed（`environment: 'node'`，仅 `tests/**/*.test.ts`）；tsc 0 error | 现无 jsdom 组件测试能力，需扩展 vitest 配置 |
| 9 | 可复用资产 | `src/components/SafetyConfirmDialog.tsx`（WP1） | 应用内确认对话框模式可直接复用/泛化，替代 confirm |

---

## 1. 会议一（主持人：产品经理）——缺陷定级与 WP8 范围界定

**议题**：黑屏缺陷的用户影响如何定级？WP8 修到什么边界算完？

**角色发言要点**：
- **产品经理**：这是 P0 级阻断缺陷——用户权限管理是 DBA 高频入口，黑屏意味着功能 100% 不可用且**无任何错误提示**（alert 被 WKWebView 吞掉），用户只能杀进程。定级 P0，进当前迭代必修。范围界定：WP8 = ① 黑屏根因修复；② 全局 ErrorBoundary；③ alert/confirm 全量替换为应用内对话框；④ 错误显式化（inline banner）；⑤ 真机可复现验证流程。**不做**：弹窗 UI 改版、权限模型重构、非本组件的 alert 清理（记入技术债 backlog，但 `grep` 审计范围要覆盖全仓以防同类雷）。
- **系统架构师**：同意范围。强调「黑屏」不是单点 bug 而是**系统性脆弱**的暴露：无 ErrorBoundary + no-op alert + `[object Object]` 错误串三者叠加，让任何后端异常都表现为整窗黑屏。修复必须治系统而非只治这一个弹窗，否则下一个弹窗照样黑。
- **React前端**：补充一个产品语义问题——L303 `if (!confirm(...)) return;` 在 WKWebView 下 confirm 恒返回假值/undefined，意味着「删除用户」功能其实**从未真正可用过**，只是没人发现。替换为应用内对话框后该功能首次真实生效，需要 QA 按新功能标准测，不是回归测。
- **QA测试**：要求验收标准明确「黑屏不可再现」的判定方法：真实 macOS 27 beta 环境 + 真实 PG17 + 浏览器驱动完整点击路径，且注入后端错误时弹窗内必须看到可读错误文案。
- **发布经理**：P0 缺陷走 hotfix 通道，但 WP8 改动面涉及全局（ErrorBoundary 包根组件），建议随下一个 patch 版本发布而非紧急单发，给回归留时间。
- **UX设计**：黑屏期间用户零反馈是最伤信任的。即使根因修复了，也要保证「任何失败路径都有可见文案」作为 UX 层验收线。

**决议**：
1. WP8 定级 P0，范围冻结为上述 ①-⑤，随下个 patch 版本发布。
2. 修复原则：治系统（ErrorBoundary + 错误契约 + 对话框体系）优先于治单点。
3. 「删除用户」confirm 短路问题按新功能标准纳入测试范围。
4. 全仓 `window.alert/confirm` 审计一次，本组件 12 处必修，其余组件命中记 backlog 并在本 WP 顺手替换（成本低）。

---

## 2. 会议二（主持人：系统架构师）——根因假设树与排查协议

**议题**：黑屏的机理是什么？假设如何排序、如何用最小成本逐一证伪？

**角色发言要点**：
- **系统架构师**：先明确「整个窗口黑屏」的两种机理：**A. React 树整体卸载**（React 18 无 ErrorBoundary 时任一渲染/生命周期异常 → unmount 全树 → 只剩 body `#090b0e`，与现象吻合度最高）；**B. 树还活着但被视觉遮盖/合成失败**（WKWebView backdrop-filter bug、嵌套遮罩误显示、CSS 失效）。区分 A/B 只需一个观察点：黑屏时 DOM 是否还在——用浏览器驱动或 Safari Web Inspector 查 `#root` 子节点数即可二分。据此建立假设树（见 §12 根因假设清单），按概率排序逐一验证。
- **React前端**：A 机理下最可疑触发点是 `generateSqlStatements` 在 footer 每次 render 裸执行（L958）：它读 `selectedUser`、`privilegeMatrix`、`initialPrivilegeRef.current`，其中 `Object.entries(privilegeMatrix)` 与 `initial` 对象的字段访问（`initial.usage` 等）若因 WP5 数据形状变化（`DbValue` 包装层）导致某字段为 `undefined`，`.map`/解构即抛 TypeError。另外 `fetchRealPrivileges` 里 `schemaRes.rows.forEach` 若 `rows` 为 undefined（错误对象被当成功返回消费）也会抛。
- **Rust后端**：B 类里的 connection not found 值得单独说：WP6 后 `execute_sql` 以 connId 查后端连接池，若 `activeConnId`（前端 vault 列表里的 id）与池键不一致，**每次打开弹窗必 reject**。reject 本身不黑屏，但 reject 的 `AppErrorDto` 无 `.message` → 组件 catch 里 `alert(...String(err))` 是 no-op → 状态停留在 loading/空数据 → 若后续渲染代码假定数据存在则转入 A 机理。即 H3 可能是 H1 的**触发器**，两者不互斥。
- **QA测试**：验证协议要求可重复：搭 bridge stub（浏览器里 mock `@tauri-apps/api/core` 的 invoke，转发到本地 node 小服务，用 pg 驱动查真实 PG17），vite dev 起前端，浏览器驱动执行「右键连接栏 → User & Privileges」路径，采集 console 错误 + `#root` 子树快照。同一套 harness 分别注入：真实成功数据、AppErrorDto 形状错误、connection not found、畸形 DbValue，四组对照。
- **AI工程师**：提醒一个交叉点——弹窗关闭/黑屏后 AI 面板若依赖同一 React 树，树卸载会连带 AI 会话 UI 消失，用户报告可能把两个症状混在一起。排查时以 DOM 快照为准，不采信口头描述。
- **DevOps**：macOS 27 beta 的 WKWebView backdrop-filter 合成问题（H2）验证成本高（要真机 + 可能要 WebKit nightly 对比），建议放最后：先用 bridge stub 在稳定版 Chrome/Safari 上排除 A 类，剩下的才归因 B 类。

**决议**：
1. 排查协议定稿：bridge stub + vite dev + 浏览器驱动，四组数据注入对照（成功 / AppErrorDto / connection not found / 畸形 DbValue），每步记录 console + DOM 快照。
2. 二分判定：黑屏时 `#root` 是否空 → A（树卸载）/ B（视觉遮盖）分叉。
3. 假设按概率排序见 §12；H3（connId 不一致）按「H1 触发器」处理，验证时合并考察。
4. 无论根因是哪个，ErrorBoundary、错误契约、alert 替换三项**无条件执行**（它们是黑屏「不可诊断、无反馈」的共因，修复不依赖根因结论）。

---

## 3. 会议三（主持人：React前端）——ErrorBoundary 架构与渲染期防御

**议题**：ErrorBoundary 放几层、捕获后渲染什么？`generateSqlStatements` 等渲染期计算如何防御？

**角色发言要点**：
- **React前端**：方案两层——① **全局层**：`src/components/ErrorBoundary.tsx`（class 组件，`getDerivedStateFromError` + `componentDidCatch`），包住 `App` 根内容；fallback 渲染深色错误页：错误 message + 可展开 stack + 「复制错误详情」按钮 + 「恢复应用」按钮（重置 state 重挂载子树）。② **弹窗层**：`UserManagementModal` 外再包一个独立 ErrorBoundary 实例，fallback 是**弹窗形态**的错误卡片（保留遮罩与关闭按钮），保证弹窗崩了主界面还活着——这正是本次黑屏最痛的点：一个弹窗的异常杀掉了整个应用。
- **系统架构师**：注意 ErrorBoundary 不捕获事件处理器/异步回调里的异常（只捕获渲染期与生命周期）。所以 `fetchRealPrivileges` 的 catch 路径必须自己把错误写进 state 显式渲染（inline banner，见会议五），Boundary 只兜渲染期的底。两层职责要在代码注释里写清，防止后人误以为 Boundary 管一切。
- **React前端**：渲染期防御三件事：
  1. `generateSqlStatements` 用 `useMemo`（deps: `selectedUser`, `privilegeMatrix`, `tablePrivileges`, `initialPrivilegeRef` 的快照值）替代 footer 每次 render 裸调（L958）；函数体整体 try/catch，异常时返回 `[]` 并把错误写入 banner state（**不允许静默返回空**，空数组只用于「无变更」合法场景，两者要可区分）。
  2. 所有消费 `DbValue` 的位置统一走 null-safe 读取工具（如 `dbVal(row, i)`），杜绝 `r[0].val` 直取；对 `rows` 先判 `Array.isArray`。
  3. L989 嵌套遮罩（重置密码对话框）检查其显示条件 state（`resetPwdUser`）是否存在残留误显示可能，必要时加 `z-index` 与条件渲染审计。
- **QA测试**：要求给「渲染期抛异常」写单测：jsdom 下渲染一个必抛子组件包在 ErrorBoundary 里，断言 fallback 出现、兄弟节点仍挂载、`componentDidCatch` 收到 error。`generateSqlStatements` 单测：喂畸形 `privilegeMatrix`（字段 undefined）断言不抛且 banner state 被置。
- **UX设计**：全局 fallback 文案不要「Something went wrong」式敷衍，中文写明「应用遇到内部错误」+ 复制按钮 + 「您的数据库连接与数据不受影响」安抚句；弹窗层 fallback 保留「关闭」出口。
- **DevOps**：ErrorBoundary 的 `componentDidCatch` 里 `console.error` 保留完整 stack，并在 dev 模式把最近一次错误存 `window.__lastBoundaryError`，方便浏览器驱动断言采集。

**决议**：
1. 新增 `src/components/ErrorBoundary.tsx`，两层部署（全局根 + 弹窗独立包裹）；fallback 含错误详情、复制、恢复/关闭出口。
2. `generateSqlStatements` 改 `useMemo` + try/catch + 错误上报 banner，「异常空」与「无变更空」可区分。
3. 新增 `dbVal` null-safe 读取工具，组件内所有 `DbValue` 消费点统一接入。
4. Boundary 不兜异步错误——异步 catch 一律写 banner state（与会议五联动）。

---

## 4. 会议四（主持人：Rust后端）——错误契约规范化：AppErrorDto 与 connection not found

**议题**：invoke reject 的错误对象形状如何规范，前端才能可靠渲染？connId 与连接池键不一致怎么治？

**角色发言要点**：
- **Rust后端**：现状是 `execute_sql` 失败 reject 一个 `AppErrorDto` 序列化对象，字段不保证含 `message`，前端 `String(err)` 得 `[object Object]`。规范：`AppErrorDto` 固定为 `{ code: string, message: string, detail?: string }`，`message` 为**必填**、人类可读（中文或英文均可但要具体）；所有命令的错误出口统一走同一转换（`impl From<anyhow::Error>` / 现有 AppError 枚举的 `Serialize`），杜绝裸字符串或结构缺字段。connection not found 定专属 code `CONNECTION_NOT_FOUND`，message 含收到的 connId 便于排查。
- **系统架构师**：connId 不一致（事实 6）要治本：WP6 迁移后连接池的键应**就是** vault 里的 connection id，`connect_db`/`execute_sql` 全链路以该 id 为唯一键。加一条启动自检：前端拿到 `vault_list_connections` 后，对 `activeConnId` 做存在性校验；后端 `execute_sql` 收到未知 connId 时返回 `CONNECTION_NOT_FOUND` 而非 panic/泛化错误。
- **React前端**：前端配套两件事：① `ipc.ts` 加 `errToStr(err)` 统一函数——`err?.message ?? err?.error ?? (typeof err === 'string' ? err : JSON.stringify(err))`，全组件替换 `err.message || String(err)`；② 弹窗打开时先校验 connId 在 vault 列表中，不在则直接 inline error「连接已失效，请重新选择连接」，**不发任何 SQL**。
- **安全工程师**：`message` 必填但要脱敏——不得含连接密码、完整 DSN；`CONNECTION_NOT_FOUND` 的 message 带 connId 可以（本机工具，id 非敏感），带 host/port 也可以，密码绝不。detail 字段同样过脱敏审查。
- **QA测试**：Rust 侧补单测：未知 connId → 断言返回体 `{code:"CONNECTION_NOT_FOUND", message: 非空}`；每种 AppError 变体序列化后必含非空 `message`（可用宏/遍历枚举变体做穷举测试）。前端 vitest：`errToStr` 对 `{}`、`{message}`、字符串、`{error}` 四种输入的输出断言。
- **DevOps**：后端错误日志继续走现有 log 通道；新增约定：凡 reject 给前端的错误，服务端日志必须有一条对应记录（含 code），保证真机排查时前后端日志可对上。

**决议**：
1. `AppErrorDto` 契约冻结：`{code, message(必填), detail?}`，全命令统一错误出口；新增 `CONNECTION_NOT_FOUND` code。
2. 连接池键 = vault connection id，全链路一致；弹窗打开时前端做 connId 存在性预检，失败不发 SQL、直接 inline error。
3. `ipc.ts` 新增 `errToStr`，全仓替换 `err.message || String(err)` 模式。
4. 错误 message 脱敏规则：可含 code/connId/host，禁止密码与 DSN。
5. 测试：Rust 错误序列化穷举单测 + `errToStr` vitest。

---

## 5. 会议五（主持人：UX设计）——alert/confirm 全量替换为应用内对话框

**议题**：12 处 `window.alert/confirm` 的替换方案、交互模式与文案规范。

**角色发言要点**：
- **UX设计**：WKWebView 下 alert/confirm 是 no-op，等于**所有错误提示与确认关卡都是假的**。替换方案：泛化 WP1 的 `SafetyConfirmDialog` 模式，新建两个轻量组件——① `AppConfirmDialog`（确认类：标题 + 正文 + 危险操作红按钮 + 取消，返回 Promise<boolean>，供「删除用户」「批量应用权限」等 5 处 confirm 使用）；② `AppInfoDialog` / **inline error banner**（告知类：成功/失败消息）。原则：**错误优先 inline banner**（弹窗顶部常驻、可关闭、红色左边条、含具体错误文案），只有「需要用户决策才能继续」的场景才用模态确认框；成功提示用轻量 toast/banner，不阻断操作。12 处逐一映射：L232/L278/L298/L308/L448/L451/L516（错误 alert）→ inline banner；L455/L512（成功 alert）→ 成功 banner；L303/L427（危险 confirm）→ AppConfirmDialog；其余按同规则归类。
- **React前端**：实现上给组件加 `dialog` state（`{kind:'confirm'|'info', title, body, danger?, resolve?}`），`confirmInApp(opts): Promise<boolean>` 用 Promise 封装，调用点改动最小（`if (!await confirmInApp({...})) return;`）。banner state：`{type:'error'|'success', text}`，新错误覆盖旧错误，成功操作清空。所有异步 catch 统一 `setBanner({type:'error', text: errToStr(err)})`。
- **产品经理**：文案要求：错误 banner 必须说「发生了什么 + 建议动作」，例如「加载用户列表失败：连接不存在（CONNECTION_NOT_FOUND）。请关闭弹窗后重新选择连接。」禁止只贴 `[object Object]` 或裸英文堆栈（堆栈放可展开的 detail 区）。
- **安全工程师**：L303 删除用户的 confirm 替换后**首次真实生效**，确认框必须复述将被删除的角色名，且 `DROP ROLE` 走 WP1 的 `executeSqlWithGuard` 通道（Critical 二次确认由 SafetyConfirmDialog 承接），不得因「上面已有 confirm」而继续裸 `force=true`（现 L305 注释即此隐患，需改造）。
- **QA测试**：用例：错误注入 → banner 出现且文案含错误信息、弹窗不关闭、树不卸载；删除用户 → AppConfirmDialog 出现 → 取消则无 SQL 发出 → 确认则走 guard 通道；grep 断言全仓 `window.alert(`/`window.confirm(` 及裸 `alert(`/`confirm(` 调用清零。
- **发布经理**：这是用户可感知改进（终于能看到错误了），发布说明里单列一条。

**决议**：
1. 新增 `AppConfirmDialog`（Promise 化确认框，复用 SafetyConfirmDialog 视觉语言）+ inline error/success banner 体系；12 处 alert/confirm 按会议映射表全量替换，grep 清零。
2. 错误展示分层：决策类 → 模态确认；错误类 → inline banner（含 code 与建议动作，detail 可展开）；成功类 → 非阻断 banner。
3. `DROP ROLE` 路径改走 `executeSqlWithGuard`，移除 `force=true` 直发（L305），确认框复述角色名。
4. 文案规范：「发生了什么 + 建议动作」，禁止 `[object Object]`。

---

## 6. 会议六（主持人：安全工程师）——错误显式化的信息泄露边界与权限 SQL 注入面

**议题**：把错误「弹出来」会不会引入新的信息泄露？组件里字符串拼接的权限 SQL 是否安全？

**角色发言要点**：
- **安全工程师**：两个议题。**其一，错误显式化边界**：本项目是本地单机工具，威胁模型不含远程攻击者，错误文案泄露 SQL 文本/表名/角色名可接受（用户本来就是 DBA）；但**连接密码、DSN、vault 密钥材料**绝不允许出现在任何 banner/对话框/console 输出中——这与会议四的 message 脱敏规则一致，前端 `errToStr` 的 `JSON.stringify` 兜底分支要注意：若后端违约把敏感字段塞进 detail，前端会原样展示，故以后端脱敏为第一道防线，前端对 `detail` 做已知敏感 key 过滤为第二道。**其二，SQL 注入面**：`fetchRealPrivileges` 的 `WHERE r.rolname = '${username}'`（L139/L180 附近）与 `generateSqlStatements` 的 `ALTER ROLE "${username}"`、`GRANT ... ON SCHEMA "${schema}"` 均为字符串拼接。username/schema 来自数据库自身（pg_roles/pg_namespace），二次注入风险低但非零（恶意角色名含 `'` 或 `"` 即可破坏语句）。要求：查询路径改用**参数化**或至少 `escapeSqlLiteral`（`src/utils/sqlEscape.ts` 已有）；DDL 生成路径对标识符做双引号转义（`"` → `""`）并校验 `^[A-Za-z0-9_$\u4e00-\u9fa5]+$` 白名单外的名字给出警告 banner 而非直接拼。
- **Rust后端**：确认 `execute_sql` 对写操作已有 WP1 安全管线兜底，但只读探测 SQL 也应参数化的话需要后端支持绑定参数——当前 `execute_sql` 无参数绑定接口。折中：本 WP 前端先用 `escapeSqlLiteral` 处理字面量、标识符转义处理 quote，参数化接口记 backlog（涉及后端命令签名变更，超 WP8 范围）。
- **React前端**：接受折中。改动点小：`${username}` → `${escapeSqlLiteral(username)}`（两处查询），标识符封装 `quoteIdent(name)` 工具函数用于 `generateSqlStatements` 全部拼接点。
- **产品经理**：注入加固属「顺手必修」（改动小、风险真实），但不扩范围：只改本组件，全仓同类模式审计记 backlog。
- **QA测试**：单测：`quoteIdent('a"b')` → `"a""b"`；含引号 username 注入 fixture → 探测 SQL 不破损、不越权；banner/console/日志跑查无密码字段。
- **UX设计**：非法/可疑角色名的警告 banner 文案要说明「该角色名含特殊字符，为安全起见未自动生成 DDL」，给用户明确预期。

**决议**：
1. 错误展示脱敏双防线：后端 message/detail 不含敏感材料（第一道）+ 前端 detail 敏感 key 过滤（第二道）；banner/console 全链路跑查纳入 DoD。
2. 本组件字面量拼接全部接 `escapeSqlLiteral`，标识符拼接新增 `quoteIdent`（双引号翻倍）；可疑角色名走警告 banner 不生成 DDL。
3. `execute_sql` 参数绑定接口记 backlog，不在 WP8 扩范围。

---

## 7. 会议七（主持人：AI工程师）——错误状态下 AI 链路的降级行为

**议题**：黑屏/树卸载对 AI 功能有何连带影响？弹窗错误状态与 AI 权限问答如何不互相污染？

**角色发言要点**：
- **AI工程师**：三个交叉点。**①** 现状树整体卸载时 AI 面板同归于尽，会话 UI 状态丢失（zustand store 若挂在被卸载子树内的 Provider 下会重置）——ErrorBoundary 全局层落地后此问题消失，但要验证 store 位于 Boundary 之外或状态可恢复。**②** 用户可能用 AI 问「给 readonly_user 授 app.orders 的 SELECT」，AI 生成 SQL 走 `executeSqlWithGuard`，与本弹窗是两条独立写路径；弹窗修好后要确认两条路径对同一角色并发操作不产生「弹窗显示的权限矩阵过期」问题——最小方案：弹窗每次打开/应用权限成功后强制 `reloadUsers`（现有逻辑保留），并在 AI 侧执行 DDL 后无义务通知弹窗（弹窗打开即刷新，可接受）。**③** AI 生成的错误若也 reject `AppErrorDto`，AI 面板的错误渲染应复用会议四的 `errToStr`，避免 AI 面板出现 `[object Object]`。
- **React前端**：确认 zustand store（`useAppStore`）在组件树顶层独立于弹窗，Boundary 卸载弹窗子树不影响 store；AI 面板错误展示接入 `errToStr` 属一行改动，纳入本 WP。
- **系统架构师**：并发写冲突不做锁——单机单用户场景，PG 自身的事务/锁已保证正确性，弹窗「打开即刷新」的乐观一致性足够，避免过度设计。
- **QA测试**：用例：弹窗崩溃注入（Boundary fallback 出现）→ AI 面板仍可输入并得到响应；AI 执行 GRANT 后重新打开弹窗 → 权限矩阵反映最新状态（真实 PG17 验证：AI 路径授 `readonly_user` 对 `app.orders` SELECT → 弹窗矩阵 can_select=true）。
- **产品经理**：②③ 纳入，AI 与弹窗的联动只做「打开即刷新」，不加实时同步。

**决议**：
1. 验证并保证 zustand store 与 AI 面板位于弹窗层 Boundary 之外；全局 Boundary fallback 出现时 AI 会话状态不丢（写入测试用例）。
2. AI 面板错误渲染统一接 `errToStr`。
3. 权限一致性策略 = 「弹窗打开/应用成功后强制 reloadUsers」，不做跨路径实时同步。

---

## 8. 会议八（主持人：QA测试）——vitest jsdom 组件测试策略与真实 PG 数据形状

**议题**：组件级测试怎么搭（现 vitest 是 node 环境）？fixture 如何来自真实 PG17 而非手写假数据？

**角色发言要点**：
- **QA测试**：现状 `vitest.config.ts` 为 `environment: 'node'`、仅 `tests/**/*.test.ts`。改造：新增组件测试目录 `tests/components/**/*.test.tsx`，用 vitest 的 `environmentMatchGlobs`（或 workspace/projects）给该目录配 `jsdom`，node 环境测试不受影响（保住现有 44 个）。需新增 devDependencies：`jsdom`、`@testing-library/react`、`@testing-library/user-event`（版本与 React 18 匹配）。mock 边界：只 mock `@tauri-apps/api/core` 的 `invoke`（返回 fixture），不 mock 组件内部逻辑。
- **QA测试**（fixture 原则）：**禁止手写假数据**。fixture 生成流程：用会议九的 bridge stub 对真实 PG17（`itsmorderopsdb`）执行组件同款 SQL（pg_roles 列表、has_schema_privilege 矩阵、information_schema.tables 表级权限、pg_default_acl），把后端序列化后的 `QueryResult`（`DbValue {type,val}` 完整结构，含 `t`/`f` 布尔文本、NULL、`information_schema` 系统 schema 行）落成 `tests/fixtures/pg17-*.json`；错误 fixture 同样来自真实后端：对不存在的 connId 调 `execute_sql` 抓真实 `AppErrorDto` reject 体。fixture 文件头注释记录生成命令与日期，可再生。
- **React前端**：核心用例清单（组件测试）：
  1. 成功路径：invoke 返回 pg17 fixture → 渲染用户列表（yuguosheng/readonly_user/app_writer）、选中 readonly_user → 矩阵显示 app schema 权限；
  2. 错误路径 A：invoke reject 真实 `CONNECTION_NOT_FOUND` dto → inline banner 显示可读文案、无 alert 调用（spy 断言 `window.alert` 零调用）、组件不卸载；
  3. 错误路径 B：invoke reject `{}`（无 message 的畸形 dto）→ banner 显示 errToStr 兜底文案，不出现 `[object Object]`；
  4. 渲染防御：喂字段缺失的 privilegeMatrix → `generateSqlStatements` 不抛，footer 渲染安全；
  5. 删除用户：点击 → AppConfirmDialog 出现 → 取消无 SQL / 确认走 guard 通道（invoke 参数断言）；
  6. ErrorBoundary：必抛子组件 → fallback 渲染、兄弟子树存活。
- **DevOps**：CI 上跑不了真实 PG17，fixture 一次生成入库即可（本地 Homebrew PG 生成，CI 只读 fixture）；jsdom 测试进 CI 矩阵。
- **发布经理**：新测试全绿 + 基线不回退（cargo 154 / vitest 44 / tsc 0）是发布门禁。

**决议**：
1. vitest 配置扩展：`tests/components/` 走 jsdom，新增 testing-library 依赖；现有 node 测试不动。
2. fixture 一律来自真实 PG17 + 真实后端错误体，经 bridge stub 生成入库（`tests/fixtures/`），文件头注明生成方式；**手写假数据视为违规**。
3. 用例清单 ①-⑥ 定稿为组件测试最小集，全部纳入 DoD。
4. `window.alert`/`window.confirm` 在测试 setup 中挂 spy，任何用例触发即 fail（机制性防回归）。

---

## 9. 会议九（主持人：DevOps）——真机验证流程：bridge stub + vite dev + 浏览器驱动

**议题**：如何在不开 Tauri 壳的情况下用真实后端数据复现与验证？真机（macOS 27 beta WKWebView）验证怎么做？

**角色发言要点**：
- **DevOps**：三段式验证管线。**第一段（日常/CI，Chrome）**：bridge stub——一个 node 小服务（`tools/bridge-stub/`），用 `pg` 驱动直连本地 PG17 `itsmorderopsdb`，实现 `execute_sql`/`vault_list_connections` 等命令的等价语义（含 WP5 `DbValue` 序列化与 `AppErrorDto` 错误形状）；vite dev 下通过 alias/条件注入把 `@tauri-apps/api/core` 的 `invoke` 替换为 fetch 到 stub 的实现。浏览器驱动（Playwright 或 Chrome DevTools MCP）执行复现脚本：加载页面 → 右键头部连接栏 → 点「User & Privileges」→ 断言弹窗可见（非黑屏）→ 采集 console 与 `#root` 快照。**第二段（错误注入）**：stub 切到故障模式（未知 connId / 空 rows / 畸形 DbValue），重放脚本，断言 inline banner 出现、树不卸载。**第三段（真机）**：`npm run tauri dev` 在 macOS 27 beta 真机跑原始复现路径；若前两段已绿而真机仍黑屏 → 归因 WKWebView 合成（H2），启用降级开关：给弹窗遮罩加 `@supports not (backdrop-filter: blur(2px))` 回退纯色遮罩，并提供设置项「禁用毛玻璃效果」作 beta 系统逃生门。
- **React前端**：invoke 替换点收敛在 `src/services/ipc.ts` 唯一入口，stub 注入用 `import.meta.env.DEV && window.__AIDB_BRIDGE__` 探测，生产构建 tree-shake 掉，不留后门。
- **Rust后端**：stub 的 `DbValue` 序列化必须对照 `src-tauri` 真实序列化代码生成（可从 Rust 端导一份样例 JSON 对拍），防止 stub 与真后端形状漂移——漂移会让第一段验证失真。
- **QA测试**：复现脚本本身入库（`tools/bridge-stub/repro.mjs` 或 Playwright spec），修复前先跑一次**留存黑屏证据**（截图 + DOM 快照 + console），修复后同脚本跑绿，前后对照归档。
- **安全工程师**：stub 只监听 127.0.0.1，PG 凭证从环境变量读，不落盘不入仓。
- **发布经理**：第三段真机验证通过是发布签核项，验证记录（截图/日志）附在 PR。

**决议**：
1. 建 `tools/bridge-stub/`（node + pg 驱动，127.0.0.1，凭证走环境变量），命令语义与 Rust 端对拍；注入点收敛在 `ipc.ts`，DEV-only。
2. 浏览器驱动复现脚本入库，修复前后各跑一次并归档证据。
3. 真机验证（tauri dev @ macOS 27 beta）为发布签核项；若且仅若前两段绿而真机黑屏，实施 backdrop-filter 降级（@supports 回退 + 「禁用毛玻璃」设置项）。
4. stub 与 fixture 生成（会议八）共用同一管线，一次搭建两处受益。

---

## 10. 会议十（主持人：发布经理）——验收标准、回归门禁与发布检查单

**议题**：WP8 怎样算修完？回归风险在哪？发布说明写什么？

**角色发言要点**：
- **发布经理**：验收以「原始复现路径在真机不再黑屏 + 任何故障注入都有可见反馈」为两条主线。回归门禁：cargo test 154 不回退（本 WP 若改 Rust 错误序列化则只增不减）、vitest 44 + 新增用例全绿、tsc 0 error、clippy 零新增警告。发布说明三条：① 修复用户权限管理弹窗黑屏；② 错误提示全面可见化（不再静默失败）；③ 「删除用户」等危险操作确认框首次真实生效（此前被系统吞掉）。
- **QA测试**：回归风险点排查清单：ErrorBoundary 包根后的首次挂载/热更新行为；`generateSqlStatements` 改 useMemo 后「应用权限」流程的 SQL 与改前逐条 diff（用真实 PG17 跑一遍授权 → 用 psql 验证权限确实生效）；`DROP ROLE` 改走 guard 后 WP1 SafetyConfirmDialog 流程联动；alert spy 机制不影响其他组件既有测试。
- **Rust后端**：本 WP 后端改动集中在 `AppErrorDto` 契约与 `CONNECTION_NOT_FOUND`，波及所有命令的错误出口——用穷举序列化单测护栏；连接池键一致性若需改 `connect_db`，端到端回归「连接 → 查询 → 断开」全链路。
- **React前端**：`errToStr` 替换波及多组件，tsc + 全量 vitest 兜底；`SafetyConfirmDialog` 泛化时保持 WP1 既有 props 兼容，不动其调用方。
- **产品经理**：DoD 增补一条产品语义：弹窗内所有「成功」提示也必须真实（此前 alert 成功提示同样是 no-op，用户从没看到过「权限已生效」的确认）——修复后成功 banner 必须出现，这直接影响用户信任。
- **UX设计**：验收时人工走查一遍所有 banner/对话框文案，按会议五规范（发生了什么 + 建议动作）逐条过。
- **DevOps**：CI 矩阵新增 jsdom 测试项；bridge stub 不进 CI（依赖本地 PG），但 fixture 进 CI。

**决议**：
1. DoD 定稿见 §15，两条主线 + 基线不回退 + 真机签核。
2. 回归清单：权限 SQL 逐条 diff、DROP ROLE guard 联动、连接全链路、热更新、alert spy 无副作用。
3. 发布说明三条必读（黑屏修复 / 错误可见化 / 危险确认首次生效）。
4. 验证证据（修复前黑屏截图 + 修复后同路径截图 + console 日志）归档 PR。

---

## 11. 修复步骤清单

> 依赖顺序：S1 → S2 → (S3 ∥ S4 ∥ S5) → S6 → S7 → S8 → S9 → S10。每步含改动点、测试适配与验收标准。

### S1 验证管线搭建（bridge stub + 复现脚本 + 黑屏证据留存）
- 建 `tools/bridge-stub/`：node + `pg` 驱动直连本地 PG17 `itsmorderopsdb`，实现 `execute_sql`（WP5 `DbValue` 序列化，与 Rust 端对拍）、`vault_list_connections`、`connect_db` 等价语义；支持故障注入模式（未知 connId / 空 rows / 畸形 DbValue / 真实 `AppErrorDto`）；仅监听 127.0.0.1，凭证走环境变量。
- `src/services/ipc.ts` 加 DEV-only 注入点（`import.meta.env.DEV && window.__AIDB_BRIDGE__`），生产构建 tree-shake。
- 浏览器驱动复现脚本入库（Playwright spec 或 DevTools MCP 脚本）：加载 → 右键头部连接栏 → 「User & Privileges」→ 截图 + `#root` 快照 + console 采集。
- **先于一切修复跑一次，留存黑屏证据**（同时完成 §12 假设的 A/B 二分判定：黑屏时 `#root` 是否为空）。
- **测试适配**：无（工具链）。**验收**：复现脚本稳定复现或稳定证伪黑屏，证据归档；二分判定结论写入 PR。

### S2 全局 + 弹窗层 ErrorBoundary
- 新增 `src/components/ErrorBoundary.tsx`（class 组件）：fallback 含错误 message、可展开 stack、复制按钮、恢复/关闭出口；`componentDidCatch` 在 dev 下写 `window.__lastBoundaryError`。
- 部署两层：包 `App` 根内容；`UserManagementModal`（及其他 z-50 弹窗）各自独立包裹，fallback 为弹窗形态错误卡片。
- 确认 zustand store Provider 位于 Boundary 之外。
- **测试适配**：`tests/components/ErrorBoundary.test.tsx`（jsdom）：必抛子组件 → fallback 出现、兄弟子树存活、`window.__lastBoundaryError` 可断言。**验收**：DoD ③；单测绿。

### S3 错误契约：AppErrorDto 规范 + errToStr + connId 预检
- Rust：`AppErrorDto` 冻结为 `{code, message(必填), detail?}`，全命令统一错误出口；新增 `CONNECTION_NOT_FOUND` code（message 含收到的 connId）；message/detail 脱敏（无密码/DSN）。
- 前端：`ipc.ts` 新增 `errToStr(err)`；全仓替换 `err.message || String(err)`；弹窗打开时校验 `connId ∈ vault_list_connections`，缺失则 inline error 且不发 SQL。
- **测试适配**：Rust 穷举单测（每个 AppError 变体序列化含非空 message；未知 connId → `CONNECTION_NOT_FOUND`）；vitest `errToStr` 四输入断言；cargo 154 不回退。**验收**：DoD ②④相关项；单测绿。

### S4 alert/confirm 全量替换（12 处）+ inline banner 体系
- 新增 `AppConfirmDialog`（Promise 化，复用 SafetyConfirmDialog 视觉）与弹窗内 banner（error/success，顶部常驻可关闭）。
- 按会议五映射表替换 12 处：错误 alert → banner（`errToStr` 文案）；成功 alert → success banner；危险 confirm（L303/L427）→ AppConfirmDialog。
- `DROP ROLE`（L305）改走 `executeSqlWithGuard`，移除 `force=true` 直发；确认框复述角色名。
- **测试适配**：组件用例 ⑤（删除用户取消/确认两分支）；`tests/setup.ts` 挂 `window.alert/confirm` spy，触发即 fail；全仓 grep `alert(`/`confirm(` 清零（SafetyConfirmDialog 内部实现除外）。**验收**：DoD ④；单测绿。

### S5 渲染期防御：generateSqlStatements useMemo + dbVal 工具
- `generateSqlStatements` 改 `useMemo`（deps 明确），函数体 try/catch，异常写 banner 且与「无变更空」可区分（返回 `{sqls, error?}` 或等价结构）；footer L958 消费 memo 值。
- 新增 `dbVal(row, i)` null-safe 读取工具，替换组件内所有 `r[n]?.val` 直取；`rows` 消费前 `Array.isArray` 判定。
- **测试适配**：组件用例 ④（畸形 privilegeMatrix 不抛）；`dbVal` 单测（缺列/NULL/非数组 rows）。**验收**：useMemo 生效（render 计数断言或 React DevTools 佐证）；单测绿。

### S6 注入加固（顺手必修）
- `fetchRealPrivileges` 两处 `rolname = '${username}'` 接 `escapeSqlLiteral`；`generateSqlStatements` 全部标识符拼接接新增 `quoteIdent`（`"` → `""`）；白名单外可疑角色名 → 警告 banner，不生成 DDL。
- **测试适配**：`quoteIdent` 单测；含引号 username fixture → 探测 SQL 不破损。**验收**：单测绿；psql 对拍生成的 DDL 语法有效。

### S7 vitest jsdom 组件测试 + 真实 PG fixture
- `vitest.config.ts` 扩展（environmentMatchGlobs / projects）：`tests/components/` 走 jsdom；新增 `jsdom`、`@testing-library/react`、`@testing-library/user-event` devDependencies。
- 经 S1 管线从真实 PG17 生成 fixture 入 `tests/fixtures/`（pg_roles 列表、schema 权限矩阵、表级权限、pg_default_acl、真实 `AppErrorDto` 错误体），文件头注明生成命令与日期。
- 落地会议八用例 ①-⑥。
- **测试适配**：本步即测试建设。**验收**：DoD ⑥；vitest 44 + 新增全绿；tsc 0 error。

### S8 WKWebView backdrop-filter 降级（条件执行）
- 仅当 S1-S7 完成后真机（macOS 27 beta，`npm run tauri dev`）仍黑屏才执行：遮罩加 `@supports not (backdrop-filter: blur(2px))` 纯色回退；设置项「禁用毛玻璃效果」（持久化，作用于全部 `backdrop-blur-*` 遮罩）。
- **测试适配**：设置项开关的组件渲染断言（class 切换）。**验收**：真机复现路径不再黑屏；若未触发本步，记录真机验证通过证据后关闭。

### S9 AI 面板联动
- AI 面板错误渲染接 `errToStr`；验证弹窗 Boundary fallback 出现时 AI 会话不丢。
- **测试适配**：AI 面板错误文案用例（畸形 dto → 无 `[object Object]`）。**验收**：会议七用例全过。

### S10 回归与发布收尾
- 真实 PG17 端到端：弹窗授权 `readonly_user` 对 `app.orders` SELECT → psql 验证生效 → 弹窗矩阵反映；AI 路径授权与弹窗路径互验；连接全链路（连接→查询→断开）回归。
- 全量基线：cargo test ≥154、vitest ≥44+新增、tsc 0 error、clippy 零新增警告、CI 矩阵（含新 jsdom 项）绿。
- 修复后复现脚本重跑，前后证据对照归档 PR；发布说明三条必读（会议十）。
- **验收**：DoD 全项签核。

### 测试清单（自动化）
| # | 用例 | 层级 |
|---|------|------|
| T1 | 必抛子组件 → Boundary fallback 出现，兄弟子树存活 | vitest jsdom |
| T2 | 弹窗层 Boundary：弹窗崩 → 弹窗错误卡片，主界面存活 | vitest jsdom |
| T3 | 成功路径：pg17 fixture → 用户列表 + readonly_user 权限矩阵正确渲染 | vitest jsdom |
| T4 | 真实 `CONNECTION_NOT_FOUND` dto → inline banner 可读文案，无 alert，树不卸载 | vitest jsdom |
| T5 | 畸形 dto `{}` → errToStr 兜底，无 `[object Object]` | vitest jsdom |
| T6 | 字段缺失 privilegeMatrix → generateSqlStatements 不抛且错误可区分 | vitest jsdom |
| T7 | 删除用户：确认框出现；取消无 SQL；确认走 guard 通道（invoke 参数断言） | vitest jsdom |
| T8 | `window.alert/confirm` spy：任何用例触发即 fail | vitest setup |
| T9 | errToStr 四输入（`{}`/`{message}`/字符串/`{error}`）输出断言 | vitest node |
| T10 | quoteIdent：`a"b` → `"a""b"`；含引号 username 探测 SQL 不破损 | vitest node |
| T11 | dbVal：缺列/NULL/非数组 rows 安全返回 | vitest node |
| T12 | AppError 全变体序列化含非空 message；未知 connId → CONNECTION_NOT_FOUND | Rust 单测 |
| T13 | 错误 message/detail 无密码/DSN（穷举 + 字符串扫描） | Rust 单测 |
| T14 | 复现脚本：修复前黑屏证据 / 修复后弹窗可见断言 | 浏览器驱动 |
| T15 | 端到端：弹窗授权 → psql 验证生效；AI 授权 → 弹窗矩阵刷新 | 真机/手动 |
| T16 | 全仓 grep `window.alert(`/`window.confirm(` 清零 | CI |

## 12. 根因假设清单（按概率排序）

| 排序 | 假设 | 概率 | 机理 | 验证方法 |
|------|------|------|------|----------|
| H1 | React 树因未捕获渲染期异常整体卸载（无 ErrorBoundary） | ~55% | React 18 无 Boundary 时任一渲染异常 → 全树 unmount → 只剩 body `#090b0e` = 全窗黑。最可疑触发点：`generateSqlStatements` footer 每 render 裸执行（L958）读取形状不符的数据；`rows.forEach` 消费 undefined | 黑屏时查 `#root` 子节点数（浏览器驱动/Safari Inspector）：空 → H1 成立。bridge stub 注入畸形 DbValue/undefined rows 复现；console 捕获具体 TypeError |
| H2 | activeConnId 与后端连接池键不一致（WP6 迁移副作用）→ execute_sql 必 reject | ~20%（常为 H1 触发器） | reject 的 AppErrorDto 无 `.message` → alert no-op 静默 → 后续渲染代码消费失败数据 → 转入 H1；单独也可能停在空弹窗（非全黑） | stub/真机日志对拍 `activeConnId` vs `vault_list_connections` ids vs 连接池键；注入 `CONNECTION_NOT_FOUND` 观察是否黑屏 |
| H3 | WKWebView backdrop-filter 合成 bug（macOS 27 beta） | ~12% | `bg-black/60 backdrop-blur-sm`（L531）在 beta WebKit 合成异常 → 遮罩层全屏不透明黑，树仍活着 | 仅在 H1/H2 排除后验证：真机黑屏时 DOM 仍在且可交互 → H3；Safari 稳定版对照；临时移除 backdrop-blur 观察恢复 |
| H4 | L989 嵌套遮罩（`absolute inset-0 bg-black/75 backdrop-blur-md`）误显示 | ~8% | 重置密码对话框的显示 state（`resetPwdUser` 等）残留/误置 → 深色遮罩盖住弹窗内容，表现为「黑屏」（但仅弹窗区域，非整窗——与现象部分吻合） | DOM inspect 该节点 display/条件；state 审计；注入 resetPwd 流程中断场景 |
| H5 | 构建期 CSS 缺失（`bg-[#101216]` 等 Tailwind 任意值未生成） | ~5% | 生产构建 purge 误删 → 内层容器透明，叠加遮罩后整体近黑 | computed style 检查；dev vs 生产构建对照 |

> 判定协议：H1/H2 用 S1 管线在稳定版浏览器先行二分（`#root` 空否 + console 错误）；H3-H5 仅当前两者排除后按序验证。无论结论如何，S2-S5（Boundary/契约/对话框/渲染防御）无条件执行——它们同时消除「黑屏不可诊断、无反馈」的共因。

## 13. 风险与不做清单

- **不做**：弹窗 UI 改版；权限模型重构；`execute_sql` 参数绑定接口（backlog）；跨路径权限实时同步；其他组件 alert 深度清理（本 WP 仅顺手替换 + 审计记录）。
- **风险 1**：`generateSqlStatements` 改 useMemo 后依赖数组遗漏 → SQL 过期。缓解：S10 用真实 PG17 对改前/改后生成的 SQL 逐条 diff + psql 实际生效验证。
- **风险 2**：`AppErrorDto` 契约变更波及其他命令调用方。缓解：Rust 穷举序列化单测 + 全量 cargo test 回归 + `errToStr` 前端兜底兼容旧形状。
- **风险 3**：jsdom 与 WKWebView 行为差异导致「测试绿但真机黑」（尤其 H3）。缓解：DoD 强制真机签核项；S8 条件降级预案。
- **风险 4**：confirm 替换后「删除用户」首次真实可用，误删风险上升。缓解：AppConfirmDialog 复述角色名 + DROP ROLE 走 WP1 guard 双确认。

## 14. 里程碑

| 阶段 | 内容 | 产出 |
|------|------|------|
| M1（0.5d） | S1 验证管线 + 黑屏证据 + A/B 二分判定 | 复现脚本、stub、根因判定结论 |
| M2（1.5d） | S2-S5 核心修复（Boundary/契约/对话框/渲染防御） | 代码 + 对应单测 |
| M3（1d） | S6-S7 加固与测试建设（注入加固、jsdom 组件测试、fixture） | T1-T13 全绿 |
| M4（0.5d） | S8-S10 真机验证、AI 联动、回归与发布收尾 | DoD 签核、证据归档、发布说明 |

## 15. 验收标准（DoD）

1. **原始路径真机不再黑屏**：macOS 27 beta + Tauri dev + 真实 PG17（itsmorderopsdb），右键头部连接栏 → 「User & Privileges」→ 弹窗正常渲染用户列表（yuguosheng/readonly_user/app_writer）与权限矩阵。
2. **任何故障都有可见反馈**：注入 connection not found / SQL 错误 / 畸形数据 / 无 message 的 dto → 弹窗内 inline error banner 显示可读文案（发生了什么 + 建议动作），React 树不卸载，全窗口不黑，无 `[object Object]`。
3. **ErrorBoundary 生效**：人为令弹窗渲染期抛异常 → 弹窗层 fallback 错误卡片出现（含详情/复制/关闭），主界面与 AI 会话存活可用。
4. **alert/confirm 清零**：全仓 grep `window.alert(`/`window.confirm(` 及裸调用为 0；12 处全部替换为应用内对话框/banner；测试 setup 的 spy 机制防回归。
5. **危险操作双确认**：删除用户 → AppConfirmDialog（复述角色名）→ 确认后 DROP ROLE 走 `executeSqlWithGuard`（SafetyConfirmDialog），无 `force=true` 直发。
6. **渲染期防御**：`generateSqlStatements` 经 useMemo 不再每 render 执行；畸形数据单测不抛；改前/改后生成 SQL 逐条 diff 一致（合法输入下）。
7. **测试全绿不回退**：cargo test ≥154；vitest 44 + T1-T13 新增全绿（fixture 全部来自真实 PG17 与真实后端错误体，无手写假数据）；tsc 0 error；clippy 零新增警告；CI 矩阵含 jsdom 项通过。
8. **端到端真实生效**：弹窗授权 `readonly_user` 对 `app.orders` SELECT → psql 验证权限确实生效 → 重开弹窗矩阵反映最新状态；AI 路径授权与弹窗路径互验一致。
9. **脱敏合规**：banner/对话框/console/日志全链路跑查，无密码、DSN、密钥材料。
10. **证据归档**：修复前黑屏证据 + 修复后同路径验证记录（截图/console/DOM 快照）归档 PR；发布说明含三条必读（黑屏修复 / 错误可见化 / 危险确认首次生效）。
