# WP9 使用者体验优化计划（UX Polish）

> 项目：DiTing PG AI（谛听）v2.0.0 — Tauri 2.0 + Rust + React18 + Tailwind
> 评审形式：**十位使用者画像 × 十场会议**（每场一个画像主导，从自己真实工作场景挑毛病）
> 文档状态：评审完成，进入开发
> 测试库约束：**只用本地 PG17 的 `ux_demo` 库**（shop schema：customers/orders/active_customers 视图/order_count 函数 + shop_reader/shop_writer 角色 + 多类型真实数据）。**禁止**使用 12.0.216.216 的任何库，**禁止**使用 127.0.0.1 的 gbrain 库。
> 原则：所有渲染必须基于真实数据，**该弹错弹错，禁止托底假数据混淆视听**。

---

## 0. 已完成项（本 WP 进行中顺手交付）

| 项 | 提交 | 说明 |
|----|------|------|
| **P0-用户点名** 用户管理弹窗左侧面板可拖宽(160-480px)+搜索+空状态+角色名完整显示 | `af4b5c4` | vitest P0-1~P0-5 五用例 |
| **P0-AI崩溃** 流式输出半截报错 `undefined is not an object (Gt.match)` — StreamEvent serde 字段名契约 bug 三层修复 | `6c8d99f` | cargo RED→GREEN + vitest 5 用例 |

---

## 1. 十场使用者画像会议纪要

### 会议一：资深 DBA（每天管多个生产库）

**视角**：权限矩阵、锁监控、批量运维是日常；最烦"找不到"和"不敢点"。

发现的问题（带证据）：
1. **[已修 P0]** 用户管理左侧角色列表固定 256px 不可拖宽、无搜索（`UserManagementModal.tsx` 原 L673 `w-64`）——生产库几十个角色时翻找痛苦。→ `af4b5c4` 已解决。
2. **SchemaTree 无过滤框**（`SchemaTree.tsx` L70-71 仅按 table/view 分组渲染全量）——几百张表的库要肉眼滚动找表。**期望**：树顶部加搜索框即时过滤表/视图名。
3. **DataGrid 排序是纯前端内存排序**（`DataGrid.tsx` L159-191 对已加载行 sort）——DBA 会误以为是 `ORDER BY` 全库排序，大表下结论错误。**期望**：排序图标旁明示"仅排序已加载的 N 行"，或提供生成 `ORDER BY` SQL 的入口。
4. **查询无行数保护**（`useAppStore.ts runQuery` 原样执行用户 SQL）——手滑 `SELECT * FROM big_table` 无 LIMIT，几十万行全量渲染会卡死界面。**期望**：结果超过阈值（如 5000 行）时横幅警示"已加载 N 行，建议加 LIMIT"，或前端只渲染前 N 行+提示。
5. ProcessListModal 缺自动刷新开关（`ProcessListModal.tsx` 仅打开时 fetch 一次）——盯锁等待要手动狂点刷新。**期望**：可选 2s/5s 自动刷新。

**价值最大项**：#2 SchemaTree 过滤、#4 大结果集保护。

### 会议二：后端开发工程师（频繁写 SQL 调试）

**视角**：编辑器就是主战场，键不离键盘。

发现的问题：
1. **全局快捷键缺失**（`App.tsx` 无任何 keydown 监听；仅 Monaco 内 Cmd+Enter 执行 `SqlEditor.tsx` L50）——Cmd+R 执行、Cmd+S 存脚本、Esc 关弹窗等肌肉记忆全部落空。**期望**：全局快捷键层（Cmd+Enter/Cmd+R 执行、Esc 关闭最上层弹窗、Cmd+K 聚焦 AI）。
2. **编辑器字号固定 14**（`SqlEditor.tsx` L140 硬编码）——投屏/高分屏看不清。**期望**：Cmd+= / Cmd+- 缩放，或设置项持久化。
3. **结果网格无法复制单元格/行**（`DataGrid.tsx` L392 只有列名可复制）——调试时想把某行数据贴到 issue 里，只能肉眼手打。**期望**：单元格双击复制值、右键菜单（复制值/复制行 CSV/复制列名）、行号点击复制整行。
4. DataGrid 编辑回写后无"变更行高亮"的持久提示（有 edits state 但保存后清除）——多次编辑易迷失。**期望**：未保存变更的行号侧标黄点 + 底部"X 行未保存"计数（若已有则确认醒目）。

**价值最大项**：#1 全局快捷键、#3 网格复制。

### 会议三：数据分析师（导出/排序/筛选/大结果集）

**视角**：查询→整理→导出是主流程。

发现的问题：
1. **导出向导入口单一**（`App.tsx` L542 仅工具栏按钮）——从结果网格右键无法直达导出。**期望**：DataGrid 工具条加"导出当前结果"按钮。
2. **无结果内筛选**——分析师常想"只看 status=cancelled 的行"，目前要改 SQL 重跑。**期望**：列头加快速筛选输入框（前端过滤已加载行，明示"仅筛选已加载数据"）。
3. **大结果集无分页渲染**（`DataGrid.tsx` 无 virtual/slice，全量 DOM 渲染）——1 万行 × 20 列 = 20 万 DOM 节点，滚动卡顿。**期望**：前端分页（每页 100/500 行）或虚拟滚动。
4. NULL 与空字符串在网格中视觉不可区分（formatDbValue 有 NULL 哨兵但样式差异弱）——数据质量分析会误判。**期望**：NULL 显示为斜体灰色 `NULL` 徽标，空串显示为 `''`。

**价值最大项**：#3 分页/虚拟化、#2 列筛选。

### 会议四：运维 SRE（SSH 隧道/连接管理/故障排查）

**视角**：半夜排障，一切以快和明确为准。

发现的问题：
1. **隧道断开只有角标提示，无一键重连**（`App.tsx` L441-445 title="SSH 隧道已断开，请重新连接"）——用户还要自己找到连接按钮。**期望**：角标可点击，直接触发该连接重连。
2. ConnectionModal 723 行、SSH/SSL/基础字段全部平铺——SRE 只改隧道参数时要滚动找。**期望**：分区折叠（基础/SSH 隧道/SSL/高级），记住上次展开状态。
3. **连接失败错误文案未场景化**——`errToStr` 已统一，但"Connection refused"这类裸文案对 SRE 可用，对其他人不可用。**期望**：常见 PG 错误码（28000 认证失败/3D000 库不存在/08001 连不上）附加一句人话建议。
4. kill 进程后列表不自动刷新（`ProcessListModal.tsx` handleKill 后有 fetchProcesses，确认即可）。

**价值最大项**：#1 一键重连、#3 错误场景化。

### 会议五：前端开发（偶尔查库，重上手）

**视角**：三个月用一次，每次都像第一次。

发现的问题：
1. **无 onboarding/帮助入口**——菜单里没有"快捷键说明""功能导览"。**期望**：设置或 `?` 按钮弹出快捷键与功能速查表（一页纸）。
2. 右键菜单只有两项（User & Privileges / Process & Locks），发现性差——表设计器、已存 SQL、CLI 控制台入口分散。**期望**：右键菜单补充常用入口分组。
3. 术语无解释（ACL/USAGE/REFERENCES 直接抛给用户）——**期望**：权限矩阵列头已有 title 提示（确认覆盖完整），关键术语加 tooltip。

**价值最大项**：#1 快捷键速查表（与会议二 #1 联动）。

### 会议六：数据科学家（JSON/大字段/AI 辅助）

**视角**：meta jsonb 列是常态，AI 是主力。

发现的问题：
1. **AI 会话无法清空**（`AiSidebar.tsx` chatLog 无清空按钮）——上下文越滚越长污染后续回答（history 取最近 20 条），想开新话题只能重启应用。**期望**：AI 面板头部"新会话"按钮。
2. **AI 生成 SQL 后无"插入编辑器"按钮**（有执行结果内嵌但 SQL 只在气泡里）——想把生成的 SQL 拿去改，要手动复制。**期望**：SQL 代码块角上加"复制/插入编辑器/直接执行"三连。
3. JSON 大字段在网格里截断后，RowDetailDrawer 里是否美化展示（`RowDetailDrawer.tsx` 有 formatDbValue，确认 JSON 是否 pretty-print）——**期望**：Json 类型在详情抽屉里格式化缩进显示。
4. AI 回答中的表格渲染 max-w-[120px] 截断（`AiSidebar.tsx` L597）——宽表看不到全貌。**期望**：单元格点击展开全文。

**价值最大项**：#1 AI 新会话、#2 SQL 三连按钮。

### 会议七：技术主管/架构师（全局视图/审计/协作）

**视角**：要给团队定规范，要审计谁动了什么。

发现的问题：
1. **权限变更无审计痕迹**（UserManagementModal 执行 GRANT/REVOKE 后只有 alert 成功）——出了事故无法回溯。**期望**：弹窗内"本次会话变更历史"折叠面板（时间+SQL+结果），可导出。
2. 用户列表无"按属性筛选"（只看可登录/只看超级用户）——几十个角色里找 LOGIN 角色费劲。**期望**：搜索框旁加属性 chips（全部/SUPERUSER/可登录）。
3. 导出 .ditingvault 给同事时无"选择性导出"——只能全量。**期望**（低优先）：勾选连接导出。

**价值最大项**：#2 属性筛选（并入 P0 搜索框区域）、#1 变更历史。

### 会议八：新手开发者（第一次用数据库 GUI）

**视角**：错误信息是我的老师，空状态是我的向导。

发现的问题：
1. **空结果与查询失败视觉相似**——DataGrid 空状态文案（L250 区域）需确认区分"0 行"与"未执行"与"执行失败"。**期望**：三态分明：未执行（提示怎么开始）/0 行（查询成功但无数据）/失败（红色+原因+建议）。
2. **SQL 报错无修复引导闭环**——README 宣传"AI 一键自愈"，确认编辑器报错旁是否有"让 AI 解释此错误"入口。**期望**：错误横幅上加按钮，自动把报错+SQL 发给 AI。
3. 连接表单必填项无即时校验（ConnectionModal 提交才报错）——**期望**：host/port/user 失焦即校验提示。

**价值最大项**：#1 三态空状态、#2 AI 解释错误。

### 会议九：QA 测试工程师（造数/批量插入/校验）

**视角**：天天造边界数据。

发现的问题：
1. **DataGrid 新增行体验待确认**（有 addedRows 机制）——批量造 20 行数据是否要一行一行点"+"？**期望**：支持从剪贴板粘贴多行（TSV 自动分列）。
2. 无"生成测试数据"辅助（AI 可以但入口不明显）——**期望**：表右键菜单加"用 AI 造 N 行测试数据"。
3. 布尔/NULL 编辑是否便捷（网格内 checkbox 直接切换 vs 手打 true）——确认 DataGrid 编辑控件按类型特化。

**价值最大项**：#1 剪贴板粘贴多行。

### 会议十：独立全栈开发者（效率/快捷键/CLI/AI 一体化）

**视角**：一个人干所有活，秒级切换是刚需。

发现的问题：
1. **CLI 控制台与主编辑器状态不互通**——CLI 里验证过的 SQL 要手动搬回编辑器。**期望**：CLI 历史条目右键"发送到主编辑器"（若已有确认）。
2. 综合会议二 #1：全局快捷键是第一优先级——一个人干活全靠键盘流。
3. 窗口布局无记忆（面板宽度/侧栏开合重启还原）——react-resizable-panels 支持持久化，接 localStorage。**期望**：布局状态持久化。
4. 快速切库：头部连接栏点击行为确认——切库要几次点击？目标 ≤2 次。

**价值最大项**：#2 快捷键（联动）、#3 布局持久化。

---

## 2. 优化项清单（按影响顺手度排序）

> 工作量：S ≤1h / M ≤半天 / L ≤1天。测试一律 vitest jsdom（真实 ux_demo 数据形状）+ 必要时 cargo。

### P0（用户点名，已完成 ✅）
| # | 项 | 状态 |
|---|----|------|
| P0-1 | 用户管理左侧面板可拖宽 + 搜索 + 空状态 + 角色名完整显示 | ✅ `af4b5c4`（vitest 5 用例）|
| P0-2 | AI 流式半截崩溃（serde 契约）三层修复 | ✅ `6c8d99f`（cargo+vitest 6 用例）|

### P1（高频痛点，本轮实施）
| # | 项 | 组件/行号 | 改法 | 工作量 | 价值画像 |
|---|----|-----------|------|--------|----------|
| P1-1 | 全局快捷键：Cmd+Enter/Cmd+R 执行 SQL、Esc 关最上层弹窗、Cmd+=/- 编辑器字号 | App.tsx（新增 keydown 层）、SqlEditor.tsx L140 | App 挂全局 keydown；维护弹窗栈（z-index 顺序即关闭顺序）；字号 state 持久化 localStorage | M | 后端/全栈 |
| P1-2 | AI 面板"新会话"清空按钮 + 快捷键 Cmd+K 聚焦 | AiSidebar.tsx L56 chatLog | 头部按钮 setChatLog([欢迎语])；清空前若内容有未复制 SQL 给 showConfirm | S | 数据科学家/全栈 |
| P1-3 | AI 回复 SQL 代码块"复制/插入编辑器/执行"三连按钮 | AiSidebar.tsx L281 sqlMatch 渲染区 | 气泡内代码块角上按钮组；插入编辑器走既有 setSqlText | M | 数据科学家/后端 |
| P1-4 | SchemaTree 顶部搜索过滤框 | SchemaTree.tsx L70 | 输入即时 filter tables/views（大小写不敏感），空结果显示提示 | S | DBA |
| P1-5 | DataGrid 单元格双击复制 + 右键菜单（复制值/复制行 CSV/复制列名） | DataGrid.tsx（现仅 L392 列名复制） | onDoubleClick 复制值；自绘 contextmenu（WKWebView 原生菜单被禁）；复制成功格内瞬时 ✓ | M | 后端/分析师 |
| P1-6 | 大结果集保护：渲染上限 + 警示横幅 | DataGrid.tsx（无 slice） | 行数 > 2000 只渲染前 2000 + 顶部横幅"已加载 N 行，仅渲染前 2000，建议 SQL 加 LIMIT"（真实提示不假装全量） | S | DBA/分析师 |
| P1-7 | 结果网格三态空状态（未执行/0行/失败） | DataGrid.tsx L250 | 按 queryResult/error 状态区分文案与图标 | S | 新手 |
| P1-8 | 隧道断开角标可点击一键重连 | App.tsx L441-445 | 角标 onClick 触发该 conn 重连流程（复用既有 handleSelectConnection） | S | SRE |
| P1-9 | 面板布局持久化（宽度/AI 侧栏开合） | App.tsx react-resizable-panels | Group 加 autoSaveId（库内置 localStorage 持久化） | S | 全栈 |

### P2（次轮实施）
| # | 项 | 说明 | 工作量 |
|---|----|------|--------|
| P2-1 | DataGrid 列头快速筛选（前端过滤已加载行，明示范围） | M |
| P2-2 | 权限变更会话历史面板（UserManagementModal 内折叠，可导出） | M |
| P2-3 | 用户列表属性 chips 筛选（全部/SUPERUSER/可登录） | S |
| P2-4 | 常见 PG 错误码人话建议映射（28000/3D000/08001…） | M |
| P2-5 | 编辑器报错旁"让 AI 解释此错误"按钮（自动带 SQL+报错） | M |
| P2-6 | RowDetailDrawer JSON pretty-print | S |
| P2-7 | DataGrid 粘贴多行 TSV 造数 | M |
| P2-8 | ProcessListModal 自动刷新开关（2s/5s/关） | S |
| P2-9 | 快捷键速查表弹窗（? 按钮） | S |
| P2-10 | ConnectionModal 分区折叠 | M |

### P3（backlog）
- 导出 .ditingvault 选择性勾选连接；表右键"AI 造测试数据"；AI 表格单元格点击展开；DataGrid 虚拟滚动（若 P1-6 不够）；CLI 历史发送到主编辑器（确认现状后定）。

---

## 3. 测试适配方案（每项对应）

| 项 | 测试 |
|----|------|
| P1-1 | vitest：keydown Cmd+Enter 触发 onExecute spy；Esc 关闭最上层弹窗（先开后关顺序断言）；字号 localStorage 持久化 |
| P1-2 | vitest：点击新会话 → chatLog 重置为欢迎语；有内容时先出 showConfirm（mock appDialog） |
| P1-3 | vitest：AI 回复含 ```sql 块 → 三按钮出现；点击插入编辑器 → setSqlText 收到真实 SQL |
| P1-4 | vitest：ux_demo 真实表名 fixture（customers/orders/active_customers/audit_trail）输入 "order" → 只剩 orders/active_customers；无匹配 → 空状态文案 |
| P1-5 | vitest：双击单元格 → clipboard.writeText 收到真实值；右键 → 菜单出现；复制行 CSV 格式断言 |
| P1-6 | vitest：构造 3000 行真实形状 DbValue → 渲染行数 ≤2000 且横幅显示"3000" |
| P1-7 | vitest：三态各自渲染断言（null result / rows=[] / error） |
| P1-8 | vitest：角标 click → 重连函数被调（mock ipc） |
| P1-9 | vitest：autoSaveId 存在性断言 + localStorage 写入验证 |
| 全部 | tsc 0 / vitest 全绿不回退（现 74）/ cargo 155 不回退 / clippy 0 / npm run build 成功 |

**端到端（手动，ux_demo）**：连接 ux_demo → SchemaTree 搜 "order" → 双击 orders → DataGrid 显示 6 行真实数据 → 双击单元格复制 → AI 问"找出已取消的订单" → 生成 SQL → 三连按钮插入编辑器 → Cmd+Enter 执行 → 结果含 cancelled 行 → Esc 关弹窗 → 重启应用布局保持。

---

## 4. 验收标准（DoD）

1. P0 两项已交付且测试守护（✅ 已完成）。
2. P1-1~P1-9 全部实现，每项带对应 vitest/cargo 测试，全量基线不回退：cargo ≥155、vitest ≥74+新增、tsc 0、clippy 0、vite build + tauri build 成功。
3. 所有新增渲染基于真实数据形状（ux_demo / 真实 DbValue fixture），错误路径显式呈现（复用 InlineBanner/showAlert），无任何假数据托底。
4. 端到端手动流程（§3 所列）在打包后的 app 上走通。
5. 用户点名痛点复验：左侧面板可拖宽+可搜索（✅）；AI 流式完整输出不中断（✅ 待真机复验）。
6. P2/P3 项登记在案不丢失，本 WP 结束时无未记录的口头承诺。
