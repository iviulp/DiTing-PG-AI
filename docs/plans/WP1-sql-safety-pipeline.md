# WP1『SQL 安全管道』开发计划

> 项目：DiTing PG AI（Tauri 2.0 + Rust + React）
> 工作包：WP1 SQL 安全管道
> 产出方式：十次多角色评审会议纪要 + 开发步骤清单
> 参与角色：产品经理（PM）、系统架构师（ARCH）、Rust 后端（RUST）、React 前端（FE）、安全工程师（SEC）、DBA、QA 测试（QA）、UX 设计（UX）、DevOps、发布经理（RM）
> 状态：评审完成，待开发

## 现状基线（代码勘察结论）

- `src-tauri/src/services/safety_checker.rs`：已实现 `SqlSafetyChecker::inspect_safety(sql, is_postgres) -> Result<RiskLevel, AppError>`，基于 sqlparser 0.54，可识别 Safe/Warning/Critical 三级；但整个模块标注 `#[allow(dead_code)]`，**未接入任何执行链路**。存在缺口：无 SQLite 方言分支（`is_postgres=false` 一律用 MySqlDialect）；`RiskLevel` 未派生 `Serialize`/`PartialEq`；未显式处理 `GRANT`/`REVOKE`/`ALTER`/`CREATE`（落入 `_ => Warning` 兜底，与需求"Critical 拦截一切 DDL"不一致）。
- `src-tauri/src/services/db_service.rs` L164-170：read_only 拦截仅做 `sql.trim().to_lowercase().starts_with("insert"/"update"/"delete"/"drop")` 前缀判断——可被 `WITH x AS (...) DELETE ...`、注释前缀 `/*c*/ UPDATE`、`truncate`/`alter`/`grant` 未覆盖等方式绕过；且 MySQL/SQLite 分支执行时用的是原始 `sql` 而非 `effective_sql`（psql 元命令转译只对 Pg 生效，属既有问题，本 WP 顺带记录不扩大范围）。
- `src-tauri/src/commands/mod.rs` L39-47：IPC `execute_sql(conn_id, sql)` 直接透传 `db_service.execute_query`，无风险预检、无 force 参数。
- `src-tauri/src/error/app_error.rs`：已有 `AppError::SafetyBlocked` → DTO code `SAFETY_BLOCKED`，可扩展承载结构化风险信息。
- 前端调用链：`src/services/ipc.ts` `executeSql(connId, sql)` → 调用方共 4 处：`src/store/useAppStore.ts` `runQuery`（主编辑器）、`src/components/CliConsoleModal.tsx`（CLI 控制台）、`src/components/AiSidebar.tsx`（AI 生成的只读 SQL 自动执行，L253 有前端 startsWith 白名单）、DataGrid 相关内联执行路径。
- `Cargo.toml`：sqlparser 0.54、serde（derive）已就位，无需新增依赖。

---

## 会议一：WP1 范围界定与验收口径

**议题**：确认 WP1 四项范围边界、非目标（Out of Scope）、整体验收标准。

**发言要点**：
- **PM**：WP1 的用户价值是"防误删库"。四项范围：① safety_checker 接入执行链路；② read_only AST 化；③ Critical 二次确认闭环；④ 全量 cargo 单测。非目标：SQL 审计日志持久化、多语句事务回滚、AI 生成 SQL 的自动修复，均放 WP2+。
- **ARCH**：确认 `db_service.execute_query` 是唯一 SQL 入口，安全管道必须收敛在该函数内，禁止在 commands 层或前端做旁路判断（前端判断只做体验优化，不做安全依据）。
- **SEC**：验收口径必须是"绕过测试全绿"：注释前缀、大小写混合、WITH 包裹、多语句拼接（`SELECT 1; DROP TABLE x`）四类绕过向量都要有用例。
- **DBA**：三种方言（Pg/MySQL/SQLite）行为要一致，尤其 SQLite 目前没有方言分支，MySqlDialect 解析 SQLite 特有语法可能误报，需要评估。
- **QA**：验收标准要可自动化：`cargo test` 全绿 + 手工验收清单（每条含操作步骤与预期）。
- **RM**：WP1 属安全增强，随下一个 minor 版本发布；发布说明必须写明"read_only 行为变更"（原来能跑的边缘 SQL 现在会被拦）。

**决议**：
1. 范围锁定为四项，安全判定唯一收敛点是 `db_service.execute_query`（含 `force` 参数扩展）。
2. 验收总口径：`cargo test` 全绿；四类绕过向量测试通过；read_only 下 INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/GRANT 全部拦截、SELECT/EXPLAIN/SHOW/WITH...SELECT 全部放行；Critical 二次确认在 4 个前端调用点全部生效。
3. 非目标明确记录：审计日志、事务补偿、MySQL/SQLite 分支的 effective_sql 既有 bug（单独开 issue，不阻塞 WP1）。

---

## 会议二：安全管道总体架构

**议题**：风险分级信息如何在 后端 checker → db_service → IPC command → 前端 store → 组件 之间流动；force 确认协议设计。

**发言要点**：
- **ARCH**：提出管道分层——L1 解析（sqlparser AST）→ L2 分级（Safe/Warning/Critical + 原因列表）→ L3 策略（read_only 拦截 / Critical 需确认 / 其余放行）→ L4 执行。`execute_query` 签名扩展为 `execute_query(conn_id, sql, force: bool)`。
- **RUST**：`execute_sql` IPC command 增加 `force: Option<bool>` 参数（默认 false），Tauri 2.0 对 Option 参数序列化兼容良好，老前端调用不传 force 也不会 break。
- **SEC**：Critical 且 `force=false` 时**不得执行 SQL**，返回结构化风险 DTO；`force=true` 时执行但仍需记录 tracing 日志。关键原则：force 只豁免"需要用户确认"这一策略，**不豁免 read_only 拦截**——read_only 是物理约束，force 也不可绕过。
- **FE**：前端收到 `SAFETY_BLOCKED` 且 payload 含 `risk_level: "critical"` + `requires_confirmation: true` 时弹确认框；确认后携带原 SQL + `force: true` 重新 invoke。需要把确认状态收敛到一处（建议在 ipc.ts 封装 `executeSqlWithGuard`），避免 4 个调用点各写一套。
- **PM**：确认协议要防止"确认框疲劳"——Warning 级不弹框（只在结果区显示黄色徽标），只有 Critical 弹框。

**决议**：
1. 数据流：`SqlSafetyChecker::inspect_safety` 返回 `SafetyVerdict { level, reasons: Vec<String>, requires_confirmation }`；`execute_query(conn_id, sql, force)` 内联执行策略；Critical && !force → `Err(AppError::SafetyBlocked)` 且 DTO 扩展携带结构化字段。
2. `AppErrorDto` 增加可选字段 `risk_level: Option<String>`、`requires_confirmation: Option<bool>`、`reasons: Option<Vec<String>>`（serde `skip_serializing_if = "Option::is_none"`，保持对现有前端向后兼容）。
3. force 语义：仅豁免 Critical 确认，不豁免 read_only 与语法解析失败。
4. 前端统一封装 `executeSqlWithGuard(connId, sql, confirmFn)` 于 `src/services/ipc.ts`，4 个调用点全部改用该封装。

---

## 会议三：read_only 拦截 AST 化设计

**议题**：用 AST 白名单/黑名单替换 `starts_with` 前缀判断的具体规则。

**发言要点**：
- **DBA**：建议**白名单制**而非黑名单：read_only 模式下只放行 `Statement::Query`（覆盖 SELECT 与 WITH...SELECT，sqlparser 中 CTE 属 Query）、`Statement::Explain`（且内层必须是 Query）、`Statement::ShowVariable`/`ShowFunctions` 等 SHOW 族、`Statement::SetVariable` 中的只读会话设置可选放行（决议：不放行，从严）。其余一律拦截。
- **SEC**：白名单制天然免疫未知语句类型（GRANT/REVOKE/COPY/ALTER/CREATE/TRUNCATE/CALL/EXECUTE 全部落入默认拦截）。特别验证 `WITH x AS (SELECT..) DELETE FROM t WHERE id IN (SELECT..)` 这类 PG 数据修改 CTE——sqlparser 0.54 中该形态解析为 `Statement::Delete`，白名单制会正确拦截。
- **RUST**：多语句处理：`Parser::parse_sql` 返回 Vec，read_only 判定必须对**每一条**语句做白名单检查，任何一条不在白名单即整体拒绝（不部分执行）。psql 元命令（`\dt` 等）在 read_only 检查**之后**才转译，转译产物全是 SELECT，但要保证检查对象是转译后的 effective_sql 或对元命令单独放行——决议：先识别 `\` 前缀元命令并转译，再对转译后的 SQL 做 AST 检查，统一入口。
- **DBA**：SQLite 的 `PRAGMA table_info(...)` 是只读元数据查询但 sqlparser 解析为 `Statement::Pragma`，需加入白名单，否则 SQLite 浏览表结构会挂。
- **QA**：拦截时的错误信息要说明具体被拦的语句类型（如 "Read-Only mode: TRUNCATE is not allowed"），便于测试断言与用户理解。

**决议**：
1. read_only 采用 AST 白名单：放行 `Query`（含 WITH...SELECT）、`Explain`（内层为 Query）、`ShowVariable`/`ShowFunctions`/`ShowStatus` 等 SHOW 族、`Pragma`（只读用途，SQLite）；其余全部 `SafetyBlocked`，错误消息含语句类型。
2. 多语句逐条检查，一条违规整体拒绝。
3. psql 元命令先转译后检查，统一走 AST 管道；删除 db_service.rs L165-170 的 starts_with 代码。
4. SQLite 使用 `SQLiteDialect`，方言选择改为按 `config.db_type` 三分支。

---

## 会议四：safety_checker.rs 重构与分级规则细化

**议题**：checker 本体改造——去 dead_code、方言三分支、RiskLevel 序列化、分级规则补全。

**发言要点**：
- **RUST**：具体改造清单：① 移除三处 `#[allow(dead_code)]`；② `RiskLevel` 派生 `Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize`，serde rename 为小写 `"safe"/"warning"/"critical"`；③ `inspect_safety(sql, db_type: DatabaseType)` 签名改为接收枚举，内部映射 PostgreSqlDialect/MySqlDialect/SQLiteDialect；④ 返回类型升级为 `SafetyVerdict { level, reasons, requires_confirmation }`。
- **SEC**：分级规则表（最终版）：
  - **Safe**：`Query`（SELECT/WITH...SELECT）、`Explain`、SHOW 族、`Pragma`。
  - **Warning**：`Insert`、带 WHERE 的 `Update`/`Delete`、`CreateIndex`（非破坏性 DDL 归 Warning 供徽标提示，不弹框）。
  - **Critical**：无 WHERE（selection 为 None）的 `Update`/`Delete`、`Drop`、`Truncate`、`AlterTable`（含 DROP COLUMN 等破坏性子句）、`Grant`/`Revoke`（权限变更视同高危）、`Statement::Copy`（PG COPY FROM 可写文件/写表）。
  - **兜底**：未显式列出的语句类型（`_ =>`）一律按 **Critical** 处理（fail-safe 原则，替换现在的 Warning 兜底）。
- **DBA**：`UPDATE ... WHERE true` / `WHERE 1=1` 语义上等同全表更新，AST 层面 selection 是 Some——决议：WP1 不做常量真值检测（复杂度高、误报风险），记录到 WP2 候选；但 reasons 中当 WHERE 存在时标注"带 WHERE 条件"供 UI 展示。
- **RUST**：解析失败（语法错误）不返回 Critical 拦截，而是透传解析错误为 `SafetyBlocked("SQL Syntax Parse Error...")`——保持现状，让数据库本身去报语法错；read_only 模式下解析失败必须拦截（无法证明只读就不放行）。
- **QA**：分级规则表逐条转化为参数化单测用例（见会议九）。

**决议**：
1. 通过 RUST 提出的四点改造清单。
2. 通过 SEC 分级规则表，兜底 `_ => Critical`（fail-safe）。
3. 解析失败处理：非 read_only 模式透传语法错误交由 DB 报；read_only 模式解析失败一律拦截。
4. `WHERE true` 常量真值检测列入 WP2 backlog。

---

## 会议五：IPC 契约与 execute_sql 改造

**议题**：Tauri command 层参数与错误契约。

**发言要点**：
- **RUST**：`execute_sql(conn_id: String, sql: String, force: Option<bool>, db_service: State<DbService>)`。内部：`db_service.execute_query(&conn_id, &sql, force.unwrap_or(false))`。
- **ARCH**：是否需要独立的 `check_sql_safety` 预检 command？——决议：**不需要**。预检+确认+执行合并为"先调用 execute_sql，Critical 时拿结构化错误，确认后 force 重试"单一路径，减少 IPC 面积与时序竞态（预检与执行之间 SQL 可能被改）。
- **SEC**：force=true 的请求必须与原请求 SQL **完全一致**地重发（前端不得改写 SQL）；后端对 force=true 的 Critical 执行打 `tracing::warn!(target: "DB::SAFETY", force = true, ...)` 日志，含 conn_id 与 SQL 前 200 字符（脱敏，不记完整参数值）。
- **FE**：TypeScript 侧 `executeSql(connId, sql, force?)` 签名扩展；错误对象解析：Tauri invoke reject 的 error 是 `AppErrorDto` 序列化结果 `{ code, message, risk_level?, requires_confirmation?, reasons? }`，在 `src/types/index.ts` 增加 `SafetyBlockedPayload` 接口。
- **QA**：契约测试点——不传 force（老调用方式）必须仍然编译/运行通过，默认 false。

**决议**：
1. `execute_sql` 增加 `force: Option<bool>`，不新增预检 command。
2. force=true 执行时后端打 WARN 级安全日志（SQL 截断 200 字符脱敏）。
3. 前端类型：`src/types/index.ts` 新增 `RiskLevel = 'safe'|'warning'|'critical'`、`SafetyBlockedPayload { code; message; risk_level?; requires_confirmation?; reasons? }`；`AppErrorDto` 序列化字段命名保持 snake_case 与 Rust 端一致。

---

## 会议六：前端确认流程与调用点改造

**议题**：`executeSqlWithGuard` 封装与 4 个调用点（useAppStore.runQuery / CliConsoleModal / AiSidebar / DataGrid 内联）的接入方式。

**发言要点**：
- **FE**：`executeSqlWithGuard(connId, sql, opts: { confirm: (payload) => Promise<boolean>, onWarning?: (v) => void })`：先 `executeSql(connId, sql)`；catch 到 `code === 'SAFETY_BLOCKED' && requires_confirmation === true` 时调 `confirm(payload)`，用户同意后 `executeSql(connId, sql, true)`（**原始 sql 字符串原样重发**）；`read_only` 拦截（requires_confirmation 缺省/false）直接 throw 给调用方显示错误，不提供 force 通道。
- **FE**：调用点策略——① `useAppStore.runQuery`：confirm 用全局确认对话框（zustand 增加 `pendingSafetyConfirm` 状态 + 顶层渲染 `<SafetyConfirmDialog>`）；② `CliConsoleModal`：终端风格内联确认，输出 `⚠ CRITICAL: <reasons>` 后提示输入 `y` 重发（保持 CLI 交互习惯）；③ `AiSidebar`：AI 自动执行路径已有 select/with/explain 前端白名单（L253），**保持只自动执行只读语句**，若用户点"执行"按钮走通用 guard；④ DataGrid 内联编辑生成的 UPDATE/DELETE：带 WHERE 属 Warning 不弹框，但生成的 SQL 必须先经 guard。
- **UX**：见会议七的确认框设计；关键点是 CliConsoleModal 的 `y` 确认要与主对话框共用同一套文案逻辑（reasons 列表复用）。
- **ARCH**：前端 startsWith 白名单（AiSidebar L253）保留为**体验层快捷判断**，但注释标明"安全判定以后端为准"。
- **QA**：4 个调用点各需一条手工验收路径 + guard 封装的 vitest 单测（mock invoke）。

**决议**：
1. 新增 `src/services/ipc.ts::executeSqlWithGuard`，为唯一带确认语义的执行封装；`executeSql` 保留为低层原语。
2. 4 个调用点全部接入：runQuery → 全局 SafetyConfirmDialog；CliConsoleModal → 内联 y/N 确认；AiSidebar → 手动执行走 guard、自动执行保持只读白名单；DataGrid → 内联 SQL 走 guard。
3. useAppStore 新增 `pendingSafetyConfirm: { sql, connId, payload } | null`、`resolveSafetyConfirm(approved: boolean)`。

---

## 会议七：确认对话框 UX 设计

**议题**：Critical 二次确认的视觉与交互规格。

**发言要点**：
- **UX**：全局 `<SafetyConfirmDialog>` 规格——标题"⚠ 高危 SQL 确认"；正文分区：① 风险等级徽标（红色 CRITICAL）；② reasons 列表（如"UPDATE 语句缺少 WHERE 条件，将影响全表"）；③ 只读展示原始 SQL（等宽字体，max-height 200px 滚动，语法高亮可后补）；④ 目标连接名 + env_tag（PROD 连接额外显示红色"生产环境"角标）。
- **UX**：交互：取消（Esc/点击遮罩/取消按钮，默认焦点在取消上，防回车误确认）；确认按钮文案"我已知悉风险，强制执行"，**要求按住 ≥1 秒或二次点击激活**（防误触，决议：采用"首次点击后按钮进入 3 秒倒计时激活态"的轻量方案，不做长按）。确认按钮红色警示样式。
- **PM**：CLI 内联确认文案与对话框一致：`⚠ CRITICAL: <reason>` + `确认执行请输入 y，其他任意输入取消:`。
- **FE**：组件放 `src/components/SafetyConfirmDialog.tsx`，复用项目现有 Dialog 样式体系；倒计时逻辑用局部 state + useEffect。
- **QA**：可用性验收：Esc 关闭不执行；倒计时未结束时点击无效；确认后原 SQL 原样重发（网络面板核对）。

**决议**：
1. 通过 SafetyConfirmDialog 规格（徽标/reasons/SQL 只读展示/连接名+env_tag/PROD 角标）。
2. 确认按钮采用"首次点击 → 3 秒倒计时激活 → 再点击生效"防误触方案；默认焦点在取消。
3. CLI 内联确认文案统一：`⚠ CRITICAL: <reasons>`，输入 `y` 确认。

---

## 会议八：DBA 专项——三方言兼容与边界语句

**议题**：Pg/MySQL/SQLite 方言差异、psql 元命令、多语句、边界 SQL 清单。

**发言要点**：
- **DBA**：方言差异清单——① MySQL 的 `SHOW TABLES` 解析为 `Statement::ShowTables`（0.54 中属独立变体），SHOW 族白名单要按变体枚举而非笼统匹配；② SQLite `PRAGMA` 放行但 `PRAGMA foreign_keys = ON` 是写设置——决议：read_only 下 Pragma 带赋值（value 非空）拦截，纯查询放行；③ PG `COPY ... TO STDOUT` 只读、`COPY ... FROM` 写入——统一按 Critical 处理（从严），read_only 白名单不含 Copy。
- **DBA**：psql 元命令：`\dt` 等转译产物是 SELECT，安全；但未知元命令走 `_ => cmd.to_string()` 原样透传（L95），read_only 下无法解析的 `\` 命令必须拦截而非透传。
- **SEC**：边界 SQL 测试向量（必须全部有单测）：
  - 绕过类：`/*c*/UPDATE t SET a=1`、`  UpDaTe t SET a=1`、`WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`、`SELECT 1; DROP TABLE users`、`EXPLAIN DELETE FROM t`（Explain 内层是 Delete，read_only 必须拦）。
  - 分级类：`UPDATE t SET a=1 WHERE id=1`→Warning、`DELETE FROM t`→Critical、`TRUNCATE t`→Critical、`ALTER TABLE t DROP COLUMN c`→Critical、`GRANT ALL ON t TO u`→Critical、`CREATE TABLE t(a int)`→read_only 拦截/非 read_only 按兜底 Critical、`SHOW TABLES`→Safe（MySQL）、`PRAGMA table_info(t)`→Safe（SQLite）、`PRAGMA journal_mode=WAL`→read_only 拦截。
- **RUST**：`EXPLAIN` 处理——sqlparser 的 `Statement::Explain { analyze, statement }` 可取内层 statement 递归分级；read_only 下 `EXPLAIN ANALYZE DELETE ...` 会真实执行，必须按内层语句判定拦截。
- **DBA**：MySQL 分支目前执行原始 sql 不含元命令转译——与 WP1 无关但确认：元命令仅 Pg 连接使用，保持现状。

**决议**：
1. SHOW 族白名单按 sqlparser 0.54 具体变体枚举（ShowVariable/ShowFunctions/ShowTables/ShowColumns 等），编译期穷举防漏。
2. Pragma：无赋值放行，带赋值 read_only 拦截。
3. `Explain` 递归检查内层 statement；read_only 下内层非只读即拦截。
4. 未知 `\` 元命令在 read_only 下拦截。
5. SEC 边界向量清单（11 条）全部纳入单测。

---

## 会议九：测试策略与验收标准

**议题**：cargo 单测矩阵、前端测试、手工验收清单。

**发言要点**：
- **QA**：Rust 单测矩阵（`safety_checker.rs` 内 `#[cfg(test)] mod tests`）：
  - A. 分级正确性：Safe/Warning/Critical 每级 ≥4 条用例（含会议八 11 条边界向量）。
  - B. read_only 白名单：放行集（SELECT/EXPLAIN SELECT/SHOW/PRAGMA 查询/WITH SELECT/psql \dt 转译产物）与拦截集（INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/GRANT/REVOKE/COPY/PRAGMA 赋值/未知语句兜底）各 ≥8 条。
  - C. 绕过向量：注释前缀、大小写、数据修改 CTE、多语句拼接 4 类。
  - D. 方言：同一 SQL 在 Pg/MySQL/SQLite 三方言下解析结果断言。
  - E. 多语句聚合：`SELECT 1; UPDATE t SET a=1 WHERE id=1` → 整体 Warning（取最高级）。
- **RUST**：read_only 拦截逻辑若放在 db_service 内需要连接池才能测——重构为纯函数 `evaluate_read_only(ast_or_verdict) -> Result<(), AppError>` 与 `SqlSafetyChecker::is_read_only_allowed(sql, db_type)`，纯函数可直接单测，不依赖数据库。
- **QA**：前端 vitest：`executeSqlWithGuard` 的 4 条路径（成功/Critical确认执行/Critical取消/read_only直接throw）mock invoke 测试；SafetyConfirmDialog 组件测试（倒计时、Esc）。
- **FE**：项目当前无 vitest 配置——决议：WP1 引入 vitest（devDependency），仅覆盖新增 guard 逻辑，不为存量代码补测（控制范围）。
- **DevOps**：CI 增加 `cargo test --manifest-path src-tauri/Cargo.toml` 与 `npm run test`（vitest run）两道门禁；clippy 对 safety_checker/db_service 零 warning。
- **QA**：手工验收清单（发布前执行）：① 主编辑器执行 `DELETE FROM test_table`（无 WHERE）→ 弹确认框 → 取消 → 未执行；② 再执行 → 确认 → 执行成功且日志有 WARN；③ read_only 连接执行 UPDATE → 报"Read-Only mode"且无确认按钮；④ CLI 输入 DROP TABLE → 内联 y 确认流程；⑤ SQLite 连接浏览表结构（PRAGMA）正常。

**决议**：
1. 通过 A-E 五组 Rust 单测矩阵；read_only 判定重构为可独立单测的纯函数。
2. 引入 vitest 覆盖 guard 与确认框（新代码 only）。
3. CI 双门禁（cargo test + vitest run）+ clippy 零 warning。
4. 5 条手工验收路径纳入发布检查单。

---

## 会议十：发布计划与风险回滚

**议题**：合并顺序、feature 开关、行为变更公告、回滚预案。

**发言要点**：
- **RM**：分三个 PR 递进合并，每个 PR 独立可回滚：PR1（checker 重构+单测，纯内部无行为变更）→ PR2（db_service/IPC 接入，行为变更）→ PR3（前端 guard+确认框）。PR2 合并后旧前端仍可运行（force 缺省 false，Critical 会被拦但错误消息可读），PR3 补齐体验。
- **DevOps**：是否需要运行时 feature 开关（如 settings 里"启用严格安全模式"）？——决议：**不加开关**。安全管道默认强制开启，开关会成为绕过通道；read_only 语义收紧属修复而非可选项。
- **SEC**：残余风险登记：① `WHERE true` 恒真条件不识别（WP2）；② sqlparser 0.54 对极冷僻语法解析失败时非 read_only 模式放行给 DB 报错（DB 层自身会拒绝非法语法，风险可接受）；③ 存储过程/函数内部写操作无法 AST 识别（`SELECT dangerous_func()`）——登记 WP2 候选（函数黑名单）。
- **RM**：发布说明要点：read_only 行为变更清单（新增拦截的语句类型）、Critical 确认流程说明、已知限制（残余风险①③）。
- **PM**：回归重点：AiSidebar 自动执行、DataGrid 内联编辑两个存量高频路径不得因 guard 接入出现交互回归。
- **DevOps**：回滚预案：PR2/PR3 均为增量代码，revert 即回滚；PR1 无行为变更无需回滚。发布后监控 `DB::SAFETY` target 的 WARN 日志量一周，异常升高说明误拦。

**决议**：
1. 三 PR 递进：PR1 checker 重构（无行为变更）→ PR2 后端接入（行为变更）→ PR3 前端确认流。
2. 不加运行时开关，安全管道强制启用。
3. 残余风险三项登记 WP2 backlog（恒真 WHERE、冷僻语法、函数内写操作）。
4. 发布说明含 read_only 行为变更清单；发布后一周监控 DB::SAFETY WARN 日志。

---

## 开发步骤清单

> 依赖顺序：Step 1-4 = PR1（后端 checker，无行为变更）；Step 5-7 = PR2（后端接入）；Step 8-11 = PR3（前端）。每步附验收标准与测试。

### Step 1：重构 `safety_checker.rs` 类型与签名
- 内容：移除 3 处 `#[allow(dead_code)]`；`RiskLevel` 派生 `Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize`（serde rename_all = "lowercase"）；新增 `SafetyVerdict { level: RiskLevel, reasons: Vec<String>, requires_confirmation: bool }`；`inspect_safety` 签名改为 `(sql: &str, db_type: DatabaseType) -> Result<SafetyVerdict, AppError>`，方言三分支（PostgreSqlDialect/MySqlDialect/SQLiteDialect）。
- 文件：`src-tauri/src/services/safety_checker.rs`、`src-tauri/src/models/mod.rs`（如需导出 DatabaseType）。
- 验收：编译通过；clippy 零 warning；无 `dead_code` 标注残留。
- 测试：方言选择单测（Pg/MySQL/SQLite 各解析一条 SELECT 成功）。

### Step 2：实现分级规则表（会议四决议）
- 内容：Safe = Query/Explain(内层Query)/SHOW 族/无赋值 Pragma；Warning = Insert/带WHERE的Update与Delete/CreateIndex；Critical = 无WHERE的Update与Delete/Drop/Truncate/AlterTable/Grant/Revoke/Copy；兜底 `_ => Critical`（fail-safe）；Explain 递归内层 statement；多语句取最高级并聚合 reasons。
- 文件：`safety_checker.rs`。
- 验收：会议八 SEC 分级类向量全部断言正确；`requires_confirmation = (level == Critical)`。
- 测试：单测矩阵 A 组（每级 ≥4 条）+ E 组（多语句聚合）+ 边界向量 `DELETE FROM t`→Critical、`GRANT ALL ON t TO u`→Critical、`ALTER TABLE t DROP COLUMN c`→Critical、`PRAGMA journal_mode=WAL`→Critical(read_only 语境拦截)。

### Step 3：实现 read_only AST 白名单纯函数
- 内容：新增 `SqlSafetyChecker::is_read_only_allowed(sql: &str, db_type: DatabaseType) -> Result<(), AppError>`（纯函数，不依赖连接池）：白名单 = Query/Explain(内层只读)/SHOW 族变体穷举/无赋值 Pragma；多语句逐条检查，一条违规整体拒绝并返回含语句类型的 `SafetyBlocked`；解析失败在 read_only 语境一律拦截。
- 文件：`safety_checker.rs`。
- 验收：放行集与拦截集各 ≥8 条用例通过；错误消息含被拦语句类型。
- 测试：单测矩阵 B 组 + C 组绕过向量 4 类（`/*c*/UPDATE`、大小写混合、`WITH d AS (DELETE...) SELECT`、`SELECT 1; DROP TABLE users`）+ `EXPLAIN DELETE FROM t` 拦截 + `PRAGMA table_info(t)` 放行。

### Step 4：psql 元命令 read_only 兼容
- 内容：未知 `\` 元命令在 read_only 下拦截（不透传）；已知元命令转译产物（全为 SELECT）经 Step 3 白名单自然放行。
- 文件：`safety_checker.rs`（或 db_service 中调用点约定，见 Step 5）。
- 验收：`\dt` 在 read_only 下放行；`\unknown_cmd` 在 read_only 下返回 SafetyBlocked。
- 测试：元命令转译产物 + 未知命令各 1 条单测。

### Step 5：`db_service.execute_query` 接入安全管道
- 内容：签名改为 `execute_query(&self, conn_id: &str, sql: &str, force: bool)`；删除 L165-170 starts_with 代码；新流程：① `db_type` 取自 `config`；② read_only 时：若 `\` 前缀先 `translate_psql_command` 再对转译产物调 `is_read_only_allowed`，否则直接对原 SQL 调用——read_only 拦截**不受 force 影响**；③ 非 read_only：调 `inspect_safety` 得 verdict，`Critical && !force` → 返回结构化 SafetyBlocked；`Critical && force` → `tracing::warn!(target: "DB::SAFETY", force=true, conn_id, sql前200字符)` 后执行；Warning → 执行（verdict 供日志）。
- 文件：`src-tauri/src/services/db_service.rs`。
- 验收：所有 `execute_query` 调用点编译通过（含 AI Agent 工具等其他内部调用，统一补 force 参数默认 false）；read_only 下 force=true 仍被拦。
- 测试：策略分支单测可用纯函数覆盖（Step 2-4），本步以集成冒烟为主：sqlite 内存池执行 `DELETE FROM t`（无 force）→ Err(SafetyBlocked)，force=true → Ok。

### Step 6：扩展 `AppError` 结构化安全 DTO
- 内容：`AppError::SafetyBlocked` 旁新增变体 `SafetyConfirmRequired { message: String, risk_level: String, reasons: Vec<String> }`（或为 SafetyBlocked 增加结构化载荷字段，二选一，倾向前者保持兼容）；`to_dto` 输出 `{ code: "SAFETY_BLOCKED", message, risk_level, requires_confirmation: true, reasons }`，可选字段 `skip_serializing_if = "Option::is_none"`。
- 文件：`src-tauri/src/error/app_error.rs`。
- 验收：Critical 拦截时前端收到 JSON 含 `requires_confirmation: true` 与 `reasons` 数组；read_only 拦截不含这两个字段（或 requires_confirmation: false）；存量 SAFETY_BLOCKED 消费方不受影响。
- 测试：DTO 序列化快照单测 2 条（read_only 拦截 / Critical 待确认）。

### Step 7：IPC command `execute_sql` 增加 force 参数
- 内容：`pub async fn execute_sql(conn_id: String, sql: String, force: Option<bool>, db_service: State<'_, DbService>)`，透传 `force.unwrap_or(false)`。
- 文件：`src-tauri/src/commands/mod.rs`。
- 验收：不传 force 的旧调用方式仍工作（默认 false）；`cargo test --manifest-path src-tauri/Cargo.toml` 全绿；clippy 零 warning。
- 测试：command 层无独立单测（薄封装），由 Step 5 集成冒烟 + Step 9 前端契约测试覆盖。

### Step 8：前端类型与 `executeSqlWithGuard` 封装
- 内容：`src/types/index.ts` 新增 `RiskLevel`、`SafetyBlockedPayload`；`src/services/ipc.ts`：`executeSql(connId, sql, force?)` 扩展第三参；新增 `executeSqlWithGuard(connId, sql, opts: { confirm: (p: SafetyBlockedPayload) => Promise<boolean>; onWarning?: (reasons: string[]) => void })`——Critical 待确认时调 confirm，同意后**原始 sql 原样**带 force=true 重发；read_only 拦截直接 throw。
- 文件：`src/types/index.ts`、`src/services/ipc.ts`。
- 验收：TypeScript 编译零错误；guard 4 条路径行为正确。
- 测试：引入 vitest；guard 单测 4 条（成功直通 / Critical→确认→force 重发（断言第二次 invoke 参数含 force:true 且 sql 与首次全等）/ Critical→取消→不重发 / SAFETY_BLOCKED 无 requires_confirmation→直接 throw）。

### Step 9：全局确认对话框 `SafetyConfirmDialog` + store 接线
- 内容：`src/components/SafetyConfirmDialog.tsx`（会议七规格：CRITICAL 徽标、reasons 列表、SQL 只读展示、连接名+env_tag、PROD 红色角标、默认焦点取消、确认按钮首击后 3 秒倒计时激活）；`useAppStore` 新增 `pendingSafetyConfirm` 状态与 `resolveSafetyConfirm(approved)`；`runQuery` 改用 `executeSqlWithGuard`，confirm 回调写入 pending 状态并等待用户决定。
- 文件：`src/components/SafetyConfirmDialog.tsx`、`src/store/useAppStore.ts`、渲染入口（App 顶层）。
- 验收：主编辑器执行无 WHERE DELETE → 弹框；取消 → errorMsg 提示未执行；确认（含倒计时）→ 执行成功；Esc 关闭等同取消。
- 测试：vitest 组件测试 3 条（倒计时未结束点击无效 / Esc 取消 / 确认后 resolve(true)）。

### Step 10：CliConsoleModal 与 AiSidebar、DataGrid 接入
- 内容：① CliConsoleModal：捕获 guard 的 confirm 回调，输出 `⚠ CRITICAL: <reasons>` + `确认执行请输入 y，其他任意输入取消:`，读取下一条用户输入决定 approved；② AiSidebar：手动"执行"按钮路径改走 guard；自动执行保留 select/with/explain 前端白名单并加注释"安全判定以后端为准"；③ DataGrid 内联执行路径改走 guard（Warning 级不弹框，onWarning 可显示黄色提示）。
- 文件：`src/components/CliConsoleModal.tsx`、`src/components/AiSidebar.tsx`、`src/components/DataGrid.tsx`（及其内联执行相关组件）。
- 验收：CLI 输入 DROP TABLE → 内联 y 确认流程可用；AI 自动执行仍只跑只读语句；DataGrid 内联 UPDATE（带 WHERE）不弹框直接执行、无 WHERE 场景弹框。
- 测试：CLI 确认流 vitest 1 条（mock executeSqlWithGuard 断言 y→approved=true / n→false）；其余走 Step 11 手工验收。

### Step 11：CI 门禁、手工验收与发布材料
- 内容：① CI 增加 `cargo test`、`cargo clippy -- -D warnings`（限改动文件零 warning）、`npm run test`（vitest run）门禁；② 执行会议九 5 条手工验收路径；③ 撰写发布说明（read_only 行为变更清单、Critical 确认流程、已知限制：恒真 WHERE / 函数内写操作不识别）；④ 发布后一周监控 `DB::SAFETY` WARN 日志量。
- 文件：CI 配置（`.github/workflows/*` 或现有流水线）、`docs/` 发布说明。
- 验收：CI 三道门禁全绿；5 条手工路径全部通过并记录；发布说明评审通过（RM 签核）；三 PR 按序合并（PR1: Step1-4 / PR2: Step5-7 / PR3: Step8-10）。
- 测试清单汇总（回归执行）：Rust 单测矩阵 A-E 全组；vitest guard 4 条 + Dialog 3 条 + CLI 1 条；手工验收 5 条。

### WP2 Backlog（本 WP 明确不做，登记备查）
1. `WHERE true` / `WHERE 1=1` 恒真条件检测。
2. 存储过程/自定义函数内写操作识别（函数黑名单）。
3. SQL 审计日志持久化。
4. MySQL/SQLite 分支 `effective_sql` 未生效的既有 bug（单独 issue）。
