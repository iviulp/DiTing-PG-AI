# WP4 开发计划：SQL 注入面加固

> 项目：DiTing PG AI（Tauri 2.0 + Rust + React 18）
> 工作包：WP4『SQL 注入面加固』
> 文档状态：评审定稿（十次会议纪要 + 开发步骤清单）
> 日期：2026-09-22
> 产出方式：仅计划文档，本 WP 评审阶段不改动源码

---

## 0. 背景与现实约束（全体共识）

- 后端 `DbService::execute_query` 最终以 `sqlx::query(&effective_sql)` 执行**纯字符串 SQL，无 bind 参数**。这是数据库客户端工具的固有现实：用户本身就在编辑器里写任意 SQL，产品定位就是"执行用户输入的 SQL"。
- 因此本 WP 的目标**不是**消灭"用户能执行任意 SQL"（那是功能本身），而是：**所有由程序代替用户拼接 SQL 的代码点（元命令翻译、前端元数据查询、行内编辑/导出 SQL 生成、进程管理等），拼接进去的动态值必须全部经过统一转义函数**，杜绝"用户只想 `\dt foo` 却意外/被动触发注入语义"的攻击面与畸形 SQL 面。
- 威胁模型：
  1. 表名/schema 名来自侧栏、AI 生成、CLI 控制台输入，可能含单引号、反斜杠、双引号、控制字符；
  2. `translate_psql_command` 的 `\c <db>`、`\dt <pattern>`、`\d <table>` 分支用 `format!` 直接插值；
  3. 前端 `ipc.ts getTableColumnsMetaData` 模板字符串直接插值表名，且硬编码 `table_schema='public'`；
  4. `App.tsx` 内联的 `sanitizeIdentifier`/`escapeSqlString` 逻辑正确但**作用域局部、未复用、未覆盖反斜杠与控制字符场景（依赖 standard_conforming_strings 假设）**；
  5. `commands/mod.rs kill_process` 的 pid 虽是 `i64`（类型安全），但需确认并保持；
  6. `ExportWizardModal.tsx:126` 的 `SELECT * FROM "${tableName || 'user'}"` 双引号标识符未做 `""` 翻倍转义。

---

## 会议一：WP4 范围界定与威胁建模

**议题**：确认注入面清单、威胁模型与"不做什么"边界。

**角色发言要点**
- 产品经理：WP4 是质量/安全工作包，不新增用户可见功能，但 `getTableColumnsMetaData` 支持任意 schema 是顺带修复的功能缺陷（非 public schema 的表拿不到列注释），一并纳入验收。
- 安全工程师（注入主攻）：给出注入面清单初稿——(a) `db_service.rs translate_psql_command` 三处 `format!`（L47 `\c`、L54 `\dt` ILIKE、L77-90 `\d` relname）；(b) `ipc.ts getTableColumnsMetaData` L51 表名插值 + 硬编码 public；(c) `App.tsx` L629-690 行内编辑/INSERT/UPDATE SQL 生成；(d) `ExportWizardModal.tsx` L126；(e) `commands/mod.rs` L362 kill_process。强调 `\d` 分支 `arg.replace('"', "")` 只删双引号、完全不防单引号，`'; DROP TABLE ...--` 类输入可原样进入 SQL 字符串。
- 系统架构师：确认边界——用户在 SQL 编辑器里主动敲的任意 SQL **不属于**注入面（那是功能）；`safety_checker.rs` 已有解析层拦截，属纵深防御，不在本 WP 改动范围。
- QA：要求每个注入点在修复前有"可复现的失败用例"，修复后同一用例转绿。
- 发布经理：WP4 应随下一个 patch 版本发布，无迁移、无配置变更、无破坏性 API。

**决议**
1. 注入面清单按上述 (a)-(e) 冻结，新增点须走变更评审。
2. 明确非目标：不改 `execute_query` 为 bind 参数架构（见会议二）、不改 safety_checker、不限制编辑器自由 SQL。
3. 威胁模型与验收原则：**"程序拼接的每个动态值都必须可追溯到一次转义函数调用"**。

---

## 会议二：Rust 端 translate_psql_command 的修复方案选型

**议题**：translate 返回 `String` 交由 `execute_query` 统一执行，无法直接 bind 参数——选哪种可行方案。

**角色发言要点**
- Rust 后端：现状 `translate_psql_command(cmd) -> String`，L174 由 `execute_query` 前置调用。三个候选方案：
  1. 改返回 `(String, Vec<Value>)` 并让 execute_query 走 `sqlx::query(...).bind(...)`——改动大，`execute_query` 是 PG/MySQL/SQLite 三库共用入口，Value 类型跨库不统一；
  2. 在 translate 内部对字面量做**安全转义**（单引号翻倍 `' -> ''`、反斜杠按 standard_conforming_strings=on 处理或显式校验、拒绝控制字符）——改动最小，与现状架构一致；
  3. 对标识符场景改用**白名单校验**（合法 PG 标识符正则）。
- 安全工程师：推荐组合拳——`\d <table>` 的 `relname = '{}'` 是**字符串字面量比较**（不是标识符），用方案 2 的字面量转义即可；更稳的做法是转义后仍保留 `'...'` 字面量形式。`\dt <pattern>` 的 `ILIKE '%{}%'` 除单引号外还必须转义 LIKE 通配符 `%` `_` 与转义符 `\`（加 `ESCAPE '\'` 子句或先清洗），否则用户输入 `%` 会改变查询语义（语义污染，非提权，但需修）。`\c <db>` 的 `'{}'` 只是回显提示字面量，同样走字面量转义。三处统一调用新增的 `escape_sql_literal()`。
- 系统架构师：反对在本 WP 引入方案 1（bind 化 execute_query）：三数据库方言占位符不同（`$1`/`?`），且编辑器自由 SQL 本来就无法 bind，投入产出比低。**决议采用方案 2+3**：字面量一律 `escape_sql_literal`，并叠加"拒绝控制字符（0x00-0x1F 除 \t\n\r 可选）"的输入校验，畸形输入直接返回错误提示字符串（translate 无法返回 Result，可返回 `SELECT '...' AS error` 形式的友好报错——见下）。
- Rust 后端：translate 返回类型是 String 不便改 Result；建议畸形输入时返回一条**安全常量 SQL**：`SELECT 'Invalid table name: control characters are not allowed' AS "Error";`，参数本身不进入 SQL，无注入。
- DBA：提醒 PG 默认 `standard_conforming_strings=on`，反斜杠在普通字面量中不是转义符，`''` 翻倍足够；但不能假设服务端配置，遇到含反斜杠的输入可选择性使用 `E''` 语法并同步翻倍 `\`，或最简单：字面量转义统一 `' -> ''`，同时把 `\` -> `\\` 且用 `E'...'` 包裹——两方案需单元测试锁定。DBA 倾向前者（保持普通字面量，仅翻倍单引号），因为 standard_conforming_strings=off 属于古老配置，客户端可在连接后检测一次并记录。
- QA：恶意用例矩阵见会议八。

**决议**
1. `translate_psql_command` 不改签名、不 bind；三处 `format!` 动态值全部过新增的 `escape_sql_literal()`（`' -> ''`，普通字面量语义）。
2. `\dt` 的 ILIKE 模式额外做 LIKE 元字符转义（`%`、`_`、`\` → 前缀 `\`，并追加 `ESCAPE '\'`）。
3. 输入含控制字符（NUL、换行内的 `;--` 不需特判，但 0x00 等必须拒绝）时，返回常量错误提示 SQL，绝不拼接原输入。
4. `\d` 分支删除现有 `arg.replace('"', "")` 的伪清洗，改为完整转义；同时支持 `schema.table` 形式（切分后各自转义，relname/nspname 双条件）——与前端 schema 支持（会议三）对齐，此项列为 P2 可裁剪。
5. 记录技术债：execute_query bind 化列为长期演进项，不入本 WP。

---

## 会议三：前端 ipc.ts getTableColumnsMetaData 改造

**议题**：表名插值注入 + 硬编码 `table_schema='public'` 的功能缺陷。

**角色发言要点**
- React 前端：现状 L44-53 模板字符串直接 `${tableName}` 插值。改造：函数签名扩为 `getTableColumnsMetaData(connId, tableName, schemaName = 'public')`；SQL 中 `c.table_schema = '<escaped schema>' AND c.table_name = '<escaped table>'`，两者走新增 TS 工具 `escapeSqlLiteral()`。
- 系统架构师：调用方 `AiSidebar.tsx` L99/L206 需同步传 schema。SchemaTree 数据源（`get_table_schema` 返回 `table_schema` 字段，见 `commands/mod.rs` L56）已携带 schema_name，前端类型 `SchemaItem`/表节点需补 `schema` 字段透传；缺省回退 'public' 保证旧调用不破坏。
- 安全工程师：`col_description(format('%s.%s', ...)::regclass::oid, ...)` 中 schema/table 也参与 regclass 拼接——同样必须转义；regclass 对含特殊字符的表名需要双引号标识符形式（`"schema"."table"`），建议改为 `format('%I.%I', schema, table)`（PG 的 `%I` 自动做标识符引用），一步到位且天然防注入。
- DBA：认可 `%I`；information_schema 列名本身是常量无需动。另提醒 MySQL/SQLite 连接不会走此函数（当前该函数是 PG 专用 information_schema + pg_catalog 混合查询），保持 PG-only 并在函数注释注明。
- UX 设计：AiSidebar 选表交互中，同名表出现在多 schema 时应显示 `schema.table` 消歧；错误提示（如转义拒绝）需以 toast 呈现而非静默 catch——现状 L64-66 `console.warn` 后返回空数组，用户无感知，顺带改进为区分"查询失败"与"确实无注释"。
- QA：用例——表名含 `'`、`%`、`;`、双引号、中文、超长名；schema 传 `public` 以外值（如 `app_data`）验证功能修复。

**决议**
1. 函数签名增加 `schemaName` 参数，默认 `'public'`，调用方（AiSidebar 两处）从 SchemaTree 节点透传真实 schema。
2. 字面量比较用 TS 端统一 `escapeSqlLiteral()`；`col_description` 的 regclass 构造改用 `format('%I.%I', ...)` 由 PG 服务端做标识符引用。
3. SchemaTree → AiSidebar 的类型链路补 schema 字段（`SchemaItemDto` 已返回 table_schema，确认前端未丢弃即可）。
4. 失败路径从静默 `[]` 改为带原因的返回/提示（P2）。

---

## 会议四：全库拼接点排查（commands/mod.rs、ExportWizardModal、DataGrid、App.tsx）

**议题**：逐点定性——注入风险 / 语义污染 / 类型安全 / 无需处理。

**角色发言要点**
- 安全工程师：主持排查，基于 `format!` 与模板字符串全库 grep 结果逐点定性：
  1. `commands/mod.rs` L362 `kill_process`：`pid: i64`，Rust 类型系统保证只能是整数，`format!` 无注入可能。**定性：安全，无需改**；但建议加一行 `(0..=i32::MAX)` 范围断言防负数/越界误杀（PG pid 为正 int32），属健壮性非安全。
  2. `commands/mod.rs` `get_db_users`/`get_process_list`/`get_table_schema`：全为常量 SQL 字符串，无拼接。**定性：安全**。
  3. `db_service.rs` L47/L54/L77：会议二已覆盖。
  4. `db_service.rs` L106/L123 连接 URL format!：密码已 urlencoding，host/user/database 来自连接表单——**定性：连接串注入不属于 SQL 注入面**，但 user/host 未编码可能在极端输入下破坏 URL 语义，记为独立观察项（P3，不阻塞 WP4）。
  5. `App.tsx` L545-546 `SELECT * FROM "${tbl}" LIMIT 100;`：`tbl` 来自侧栏双击（源头是 information_schema 真实表名），但表名含 `"` 时双引号标识符会被破坏。**定性：需修**——过 `sanitizeIdentifier`（`"` → `""`）。
  6. `App.tsx` L629-690：局部定义的 `sanitizeIdentifier`/`escapeSqlString` 逻辑本身正确（标识符翻倍双引号、字面量翻倍单引号），但 (i) 定义在组件回调内部无法复用；(ii) L643/L675 `typeof pkCell.val === 'number'` 分支直接内插数字——JS number 安全，但 `NaN`/`Infinity` 会产生非法 SQL，需排除；(iii) 未处理反斜杠（同会议二 DBA 结论：standard_conforming_strings=on 下可接受，需注释声明假设）；(iv) L609 用正则从 sqlText 反解表名再拼 UPDATE——正则提取本身脆弱，提取结果必须再过 sanitizeIdentifier。**定性：逻辑保留、位置上收、边界补强**。
  7. `ExportWizardModal.tsx` L126 `SELECT * FROM "${tableName || 'user'}"`：tableName 未做 `""` 翻倍。**定性：需修**，改调统一 `sanitizeIdentifier`。
  8. `DataGrid.tsx`：grep 确认不自行生成 SQL（仅展示 tab.sql），行编辑 SQL 生成在 App.tsx。**定性：无需改**。
  9. `CliConsoleModal.tsx`：用户输入原样送 execute_sql/translate，属功能本身，translate 侧加固即覆盖。**定性：无需改**。
  10. `SavedSqlModal.tsx` L99：常量默认值。**定性：无需改**。
- Rust 后端：确认 `services/` 下其余 `format!`（auth_service、ai_service、备份加密相关）不产出 SQL，排除。
- QA：要求把上述定性表落入计划附录，作为回归排查基线；未来新增拼接点须对照此表评审。

**决议**
1. 采纳安全工程师的 10 点定性表（本节即基线）。
2. 需修点：App.tsx L545/L609 链路、ExportWizardModal L126、App.tsx number 分支 NaN/Infinity 防御。
3. kill_process 不改 SQL 拼接，加 pid 范围断言（P2）。
4. 连接 URL 编码观察项记入技术债清单（P3），不阻塞。

---

## 会议五：统一转义工具函数 API 设计（Rust + TS）

**议题**：两端工具函数的模块位置、签名、语义契约。

**角色发言要点**
- 系统架构师：Rust 端新建 `src-tauri/src/services/sql_escape.rs`（或并入现有 utils），导出两个纯函数：
  - `escape_sql_literal(s: &str) -> String`：`' -> ''`；含控制字符（`\0`、0x01-0x08、0x0B、0x0C、0x0E-0x1F）时——见安全工程师意见；
  - `quote_identifier(s: &str) -> String`：`" -> ""` 并整体包 `"..."`，供未来 Rust 侧拼标识符使用。
  TS 端新建 `src/utils/sqlEscape.ts`，导出 `escapeSqlLiteral(s: string): string`、`sanitizeIdentifier(s: string): string`（仅翻倍，不包裹，保持与 App.tsx 现有语义一致）、`quoteIdentifier(s)`（翻倍+包裹），App.tsx/ExportWizardModal/ipc.ts 全部改从此导入，删除局部定义。
- 安全工程师：控制字符策略必须两端一致：`escape_sql_literal` 对 NUL（0x00）**无条件拒绝**（PG 文本协议本身不允许）；其余控制字符建议同样拒绝而非转义（转义它们没有标准形式）。签名上 Rust 返回 `Result<String, EscapeError>` 或 `Option<String>`，调用方（translate）失败时走"常量错误 SQL"路径；TS 端抛异常或返回 null，调用方 toast。反对"静默剥离控制字符"——剥离会造成语义漂移且掩盖攻击痕迹。
- Rust 后端：同意 `Result` 签名；translate 内 `match` 失败分支返回 `SELECT 'Invalid input: ...' AS "Error";`（错误消息为常量文案，不回显原始输入，避免二次注入与日志污染）。
- React 前端：TS 端为减少调用方负担，提供 `tryEscapeSqlLiteral(s): string | null`；`sanitizeIdentifier` 保持同步纯函数（现有调用点均为同步）。
- DBA：LIKE 转义单独设函数 `escape_like_pattern(s) -> String`（`\`→`\\`、`%`→`\%`、`_`→`\_`），与字面量转义**先后顺序固定：先 LIKE 后 literal**，两端注释写明；调用侧 SQL 追加 `ESCAPE '\'`。
- QA：函数为纯函数，100% 单测覆盖无难度，要求行覆盖 + 分支覆盖全绿。

**决议**
1. Rust：`sql_escape.rs` 提供 `escape_sql_literal -> Result<String, SqlEscapeError>`、`quote_identifier`、`escape_like_pattern`；控制字符（含 NUL）一律 Err，调用方转常量错误 SQL。
2. TS：`src/utils/sqlEscape.ts` 提供 `escapeSqlLiteral`（控制字符抛错）、`tryEscapeSqlLiteral`、`sanitizeIdentifier`、`quoteIdentifier`、`escapeLikePattern`；语义与 Rust 端逐条对齐并写入两端 doc comment。
3. LIKE 转义顺序契约：先 `escape_like_pattern` 再 `escape_sql_literal`。
4. 所有既有局部实现（App.tsx L629-630）删除，统一改 import；grep `escapeSqlString|sanitizeIdentifier` 应仅命中 utils 与 import 行。

---

## 会议六：DBA 视角——PostgreSQL 转义语义与 special cases

**议题**：转义规则在 PG 语义下的正确性审查。

**角色发言要点**
- DBA：主讲。
  1. `standard_conforming_strings=on`（PG 9.1+ 默认）下，普通字面量 `'...'` 中反斜杠是普通字符，唯一需要的转义是 `' -> ''`；连接后可执行 `SHOW standard_conforming_strings` 记录一次，若为 off（极罕见），含 `\` 的字面量需改 `E'...'` 且 `\ -> \\`。建议工具函数保持简单（仅翻倍单引号），在连接建立时检测该 GUC，若 off 则在应用层日志告警并拒绝含反斜杠的动态值——把复杂度挡在罕见路径外。
  2. 标识符：双引号形式 `"..."` 内仅需 `"` → `""`；注意 PG 标识符上限 63 字节（NAMEDATALEN-1），超长静默截断——工具函数应校验长度 ≤63 字节并报错，防止"转义正确但截断后撞上另一张表"的语义事故。
  3. `format('%I', x)` / `format('%L', x)` 是服务端等价物，凡 SQL 已在 PG 执行且值可作为参数传入 format 的场景（如 ipc.ts 的 regclass 构造），**优先用 %I/%L 而非客户端转义**——服务端实现永远不会错。
  4. LIKE/ILIKE 模式：`%` `_` 是通配符，`\` 是默认转义符；`\dt` 语义上 psql 自己把 `*` 映射为 `%`，我们可保持原样传 `%`（用户预期），但必须防"模式注入改变结果集"以外的问题——结论：转义 LIKE 元字符会**改变 `\dt` 用户预期行为**（用户敲 `\dt user*` 期待通配）。折中：`\dt` 场景仅做字面量转义（防注入），保留 `%`/`_` 通配语义（psql 兼容），文档注明"pattern 按 ILIKE 通配符解释"。
  5. `\d schema.table` 支持：psql 语义，切分最后一个 `.`，两段分别字面量转义，SQL 加 `n.nspname = '<schema>'` 条件。
- 安全工程师：接受第 4 点折中——LIKE 通配符属功能语义，不构成注入（结果集仍是 pg_class 只读查询）；撤回会议五中"translate 必须 escape_like_pattern"的强制要求，改为：`escape_like_pattern` 函数照常提供并单测，但 `\dt` 分支不启用，启用点留给未来"按名过滤"类 UI 功能。
- Rust 后端：63 字节校验、standard_conforming_strings 连接期检测记入实现注意事项；检测失败不阻塞连接，仅告警 + 启用保守模式（拒绝含 `\` 动态值）。
- QA：补充用例——63/64 字节边界表名、`\dt user*` 通配行为回归、`SHOW standard_conforming_strings` off 的模拟（可用测试库 SET）。

**决议**
1. 字面量转义仅 `' -> ''`；反斜杠依赖 standard_conforming_strings=on，连接期检测 GUC，off 时进入保守模式（拒绝含 `\` 动态值 + 告警日志）。
2. `quote_identifier` 增加 63 字节长度校验，超限 Err。
3. `\dt` 保留 ILIKE 通配语义（psql 兼容），只做字面量转义；`escape_like_pattern` 仍实现并单测，供未来 UI 过滤功能使用。
4. `\d schema.table` 支持列入实现（切分 + 双条件），优先级 P2，可裁剪不影响 WP4 验收。
5. 服务端可用的场景优先 `format('%I'/'%L')`（ipc.ts 已采纳）。

---

## 会议七：QA 测试策略与恶意输入用例矩阵

**议题**：单元测试 + 集成测试 + 手工回归的分层与用例清单。

**角色发言要点**
- QA 测试：主讲，提出三层：
  1. **单元测试（Rust `#[cfg(test)]` + TS vitest/jest）**：纯函数全矩阵——
     - `'; DROP TABLE users; --` → 期望输出 `'''; DROP TABLE users; --'`（单引号全部翻倍，整体仍是单一字面量）；
     - `O'Brien`、`a'b'c`（多单引号）；
     - `back\slash`（standard_conforming_strings=on 下原样保留）；
     - `tab"le`（双引号：literal 场景不动；identifier 场景 → `"tab""le"`）；
     - `"; DROP TABLE x; --`（标识符双引号翻倍）；
     - 控制字符：`tab\u0000name`、`\n`、`\r`、0x1B → 期望 Err/throw；
     - 空字符串、纯空白、63/64 字节边界、UTF-8 中文/emoji 表名；
     - LIKE：`100%_done\` → `\`/`%`/`_` 正确加转义（函数级验证，即使 translate 未启用）。
  2. **translate 集成测试（Rust）**：对 `translate_psql_command` 直接断言输出 SQL 字符串——`\dt it's`、`\d evil'; DROP--`、`\c db'x` 生成的 SQL 中动态段单引号全部翻倍、含控制字符时返回常量 Error SQL；用 sqlparser（safety_checker 已依赖）解析输出确认是**单条 SELECT**。
  3. **前端组件/函数测试（TS）**：`getTableColumnsMetaData` 用 mock invoke 捕获 sql 参数，断言转义生效、schema 参数进入 WHERE；App.tsx 行编辑生成的 UPDATE/INSERT 快照测试。
- 安全工程师：追加"红队用例"——二次注入模拟：真实建表 `"weird''name"`（含单引号的合法表名），走完 侧栏双击 → SELECT → 行编辑 → UPDATE 全链路应无 SQL 错误；`\d "weird''name"` 在 CLI 控制台应返回该表结构。
- Rust 后端：集成测试不需要真实 PG（translate 是纯函数）；红队用例需要测试库，提供 docker-compose PG 测试环境说明（若 CI 已有则复用）。
- QA：手工回归清单——CLI 控制台 `\l \dt \dt <pat> \d <tbl> \dn \du \df \c <db>`、侧栏双击表、AI 侧栏选表取注释、行内编辑保存、新增行、导出向导、进程页 kill。
- DevOps：CI 增加 `cargo test` 与 `npm run test` 门禁（若尚无 test script 则本 WP 补齐 vitest 配置）；覆盖率阈值仅对新增 utils 文件设 100%。

**决议**
1. 三层测试全部纳入验收；恶意用例矩阵（含 `'; DROP TABLE`、单引号、反斜杠、双引号标识符、控制字符、边界长度、Unicode）为必测集。
2. translate 输出用 sqlparser 断言"单条语句"，防止多语句拼接。
3. 红队二次注入用例在真实 PG 测试库执行一次并记录。
4. CI 门禁：cargo test + 前端单测通过方可合并。

---

## 会议八：UX 与错误反馈设计

**议题**：转义拒绝/错误 SQL 的用户可见反馈。

**角色发言要点**
- UX 设计：主讲。
  1. CLI 控制台输入 `\d bad\u0000name`：结果区应显示一行友好的 `Error: 表名包含非法控制字符` 而非空白或原始 SQL 报错堆栈；错误 SQL 常量文案中文本地化。
  2. AiSidebar 取列注释失败：现状静默返回空（用户以为表没有注释），改为在 schema context 中标注"(列注释获取失败)"，不弹打断式 toast（属次要信息）。
  3. 行内编辑保存时若列值含控制字符被拒：toast 明确指出"值包含不可见控制字符，已阻止提交"，保留用户编辑态不丢失。
  4. 多 schema 同名表：侧栏与 AI 选表列表显示 `schema.table`，消除歧义（配合会议三）。
- 产品经理：确认 1/3 为 P1（安全反馈必须可见），2/4 为 P2。文案由 UX 给出中英双语表，随代码提交。
- React 前端：错误呈现复用现有 toast/结果区组件，无新 UI 组件成本。
- QA：反馈路径纳入手工回归：非法输入 → 可见、可理解、非泄露（不回显原始恶意串到 UI 之外的日志——tracing 日志中 pid/conn_id 可留，原始畸形输入以 debug 级别记录且脱敏换行符）。

**决议**
1. 非法输入必须有用户可见的友好错误（P1），文案不回显原始输入全文。
2. 日志策略：warn 级别记录"发生了转义拒绝 + 来源点位"，原始输入降为 debug 且控制字符转义显示。
3. schema 消歧显示与 AiSidebar 失败标注列 P2。

---

## 会议九：DevOps——CI 门禁、依赖与回归保障

**议题**：测试基建、CI 流水线与合并门禁。

**角色发言要点**
- DevOps：主讲。
  1. Rust 侧：`cargo test` 已可运行（safety_checker 有 sqlparser 依赖，无新增 crate——工具函数纯 std 实现，**不引入新依赖**）；CI 增加 `cargo clippy -- -D warnings` 对新增文件生效。
  2. TS 侧：确认项目现有测试框架；若无，引入 vitest（Vite 项目天然契合），仅 devDependency，配置最小化（`src/utils/__tests__/`）。
  3. PG 测试库：本地 `docker run postgres:16` 一键脚本写入 `docs/dev-test-db.md`；CI 可选 service container，红队用例标记 `#[ignore]`/`it.skip` 仅在有库环境跑（nightly）。
  4. 回归保障：WP4 改动的文件清单固定（db_service.rs、新增 sql_escape.rs、commands/mod.rs（仅断言）、ipc.ts、App.tsx、ExportWizardModal.tsx、新增 sqlEscape.ts、测试文件），code review 时 diff 范围超出即打回。
- 发布经理：patch 版本号 +1（如 0.x.y → 0.x.y+1），changelog 安全条目用模糊表述（"加固了元命令与元数据查询的输入处理"），不公开注入细节，遵循协调披露惯例。
- 安全工程师：同意模糊化 changelog；内部 issue 保留完整细节。
- Rust 后端 / React 前端：确认无 breaking change，`getTableColumnsMetaData` 新参数带默认值，其余签名不变。

**决议**
1. 不新增运行时依赖；TS 测试框架若无则引入 vitest（dev only）。
2. CI 门禁：cargo test + clippy（新文件零警告）+ vitest；红队集成用例 nightly 跑。
3. 提供 PG 测试库启动脚本与文档。
4. 发布走 patch 通道，changelog 模糊化安全描述。

---

## 会议十：发布计划与验收终审

**议题**：验收标准逐条过堂、发布顺序、回滚预案。

**角色发言要点**
- 发布经理：主讲。发布顺序：utils（Rust+TS）与单测 → translate 加固 → ipc.ts/SchemaTree 链路 → App.tsx/ExportWizardModal 收编 → kill_process 断言与 P2 项 → 全量回归 → patch 发布。每步独立 commit，可单独 revert。
- 产品经理：逐条宣读验收标准（见下文清单），确认无遗漏；schema 支持（会议三）随本 WP 发布并在 release note 中作为功能改进提及。
- 安全工程师：终审要求——合并前执行一次全库 grep 审计：`rg "format!.*SELECT|format!.*INSERT|format!.*UPDATE" src-tauri` 与 `rg "\\$\{.*\\}" src --glob '*.ts*'|过滤模板 SQL`，输出中每一处动态插值必须能对应到转义函数调用或"类型安全/常量"定性记录（会议四基线表）；无法对应即阻塞发布。
- QA：全量手工回归（会议七清单）+ 自动化全绿 + 红队用例通过，三者齐备签发。
- DevOps：回滚预案——纯代码变更无数据迁移，revert commit 即回滚；风险最低档。
- 架构师：确认技术债登记：(1) execute_query bind 化长期演进；(2) 连接 URL user/host 编码观察项；(3) App.tsx L609 正则反解表名的脆弱性（长期应改为从结果集元数据携带表名，而非解析 SQL 文本）。
- 全体：通过。

**决议**
1. 按下文《开发步骤清单》执行，验收标准与测试清单为发布门禁。
2. 合并前完成安全工程师的 grep 终审。
3. 三项技术债入 backlog。

---

## 开发步骤清单

### 步骤 1：Rust 统一转义工具 `src-tauri/src/services/sql_escape.rs`（P1）
- [ ] `escape_sql_literal(s: &str) -> Result<String, SqlEscapeError>`：`' -> ''`；含控制字符（0x00-0x1F 中除 `\t` 外全部拒绝，`\t` 是否放行按实现注释锁定；0x00 无条件拒绝）返回 Err。
- [ ] `quote_identifier(s: &str) -> Result<String, SqlEscapeError>`：`" -> ""` 并包裹 `"..."`；UTF-8 字节长度 >63 返回 Err；控制字符同规则拒绝。
- [ ] `escape_like_pattern(s: &str) -> String`：`\ -> \\`、`% -> \%`、`_ -> \_`（本 WP 提供并测试，translate 暂不启用）。
- [ ] doc comment 写明：standard_conforming_strings=on 假设、与 TS 端语义对齐表、LIKE 转义与字面量转义的调用顺序契约。
- **验收**：单元测试全矩阵通过（见测试清单 T1）；不引入新 crate。

### 步骤 2：`translate_psql_command` 三处拼接点加固（P1）
- [ ] L54 `\dt <pattern>`：`arg` 过 `escape_sql_literal`（保留 ILIKE `%...%` 通配语义，psql 兼容）；Err 时返回常量 `SELECT '...' AS "Error";`。
- [ ] L77-90 `\d <table>`：删除 `arg.replace('"', "")` 伪清洗；`arg` 过 `escape_sql_literal`；支持 `schema.table`（按最后一个 `.` 切分，双条件 `c.relname = '<t>' AND n.nspname = '<s>'`，各自转义；P2 可裁剪）。
- [ ] L47 `\c <db>`：提示字面量过 `escape_sql_literal`。
- [ ] 连接建立处（`connect()` PG 分支）执行 `SHOW standard_conforming_strings`，off 时 tracing 告警并置保守模式标志（拒绝含 `\` 的动态值）。
- **验收**：集成测试断言恶意输入产出的 SQL 单引号全部翻倍、控制字符输入产出常量 Error SQL、sqlparser 解析为单条 SELECT（T2）。

### 步骤 3：TS 统一转义工具 `src/utils/sqlEscape.ts`（P1）
- [ ] `escapeSqlLiteral(s: string): string`（控制字符 throw）、`tryEscapeSqlLiteral(s): string | null`、`sanitizeIdentifier(s): string`（`" -> ""`，不包裹）、`quoteIdentifier(s): string`（包裹）、`escapeLikePattern(s): string`。
- [ ] 语义与 Rust 端逐条一致，注释含对齐表。
- **验收**：vitest 全矩阵通过（T1 镜像用例）；若项目无测试框架，本步骤引入 vitest（devDependency）+ `npm run test` script。

### 步骤 4：`ipc.ts getTableColumnsMetaData` 改造（P1）
- [ ] 签名 `(connId, tableName, schemaName = 'public')`；WHERE 两个条件值过 `escapeSqlLiteral`；`col_description` 改用 `format('%I.%I', c.table_schema, c.table_name)::regclass`。
- [ ] `AiSidebar.tsx` L99/L206 调用透传 schema（来自 SchemaTree 节点的 `table_schema`；确认前端类型未丢弃该字段，缺省回退 'public'）。
- [ ] 多 schema 同名表消歧显示 `schema.table`（P2）；失败路径带原因返回（P2）。
- **验收**：mock invoke 捕获 SQL 断言转义与 schema 参数（T3）；真实库上非 public schema 表可取到列注释（功能回归）。

### 步骤 5：App.tsx / ExportWizardModal 拼接点收编（P1）
- [ ] 删除 App.tsx L629-630 局部函数，改 import `src/utils/sqlEscape.ts`。
- [ ] L545-546 `SELECT * FROM "${tbl}"` → `quoteIdentifier(tbl)` 或 `"${sanitizeIdentifier(tbl)}"`。
- [ ] L609 正则反解表名的结果必须过 `sanitizeIdentifier` 后才参与拼接。
- [ ] L643/L675 number 分支排除 `NaN`/`Infinity`（`Number.isFinite` 判断，否则走字符串转义路径）。
- [ ] ExportWizardModal L126 `${tableName || 'user'}` → `sanitizeIdentifier(tableName || 'user')`。
- [ ] 行编辑值含控制字符被拒时 toast 提示且不丢编辑态（会议八 P1）。
- **验收**：UPDATE/INSERT 生成 SQL 快照测试（T4）；手工回归行内编辑/新增行/导出全链路；含单引号表名红队用例通过。

### 步骤 6：kill_process 健壮性 + 排查基线固化（P2）
- [ ] `commands/mod.rs` L362 前加 pid 范围断言（`pid > 0 && pid <= i32::MAX as i64`，否则返回 Err），SQL 拼接保持（i64 类型安全）。
- [ ] 将会议四的 10 点定性表写入 `docs/security/sql-concat-inventory.md` 作为长期排查基线。
- [ ] 技术债登记：execute_query bind 化、连接 URL user/host 编码、L609 正则反解表名改元数据携带。
- **验收**：负数/越界 pid 返回错误不执行 SQL；基线文档入库。

### 步骤 7：CI 门禁与发布（P1）
- [ ] CI 增加/确认：`cargo test`、`cargo clippy`（新文件零警告）、`npm run test`；合并门禁生效。
- [ ] 全库 grep 终审（安全工程师口径）：所有 SQL 动态插值点可追溯到转义调用或基线表定性记录。
- [ ] `docs/dev-test-db.md`：PG16 docker 测试库启动脚本；红队用例 nightly。
- [ ] patch 版本发布，changelog 模糊化安全描述。
- **验收**：CI 全绿 + grep 终审无未覆盖点 + 发布完成。

---

### 测试清单

**T1 转义函数单元测试（Rust + TS 双端镜像）**
| # | 输入 | escape_sql_literal 期望 | quote/sanitize identifier 期望 |
|---|------|------------------------|-------------------------------|
| 1 | `'; DROP TABLE users; --` | `''; DROP TABLE users; --`（整体仍单字面量） | `""; DROP TABLE users; --` 包裹形式 |
| 2 | `O'Brien` | `O''Brien` | 原样（无双引号） |
| 3 | `a'b'c'd` | `a''b''c''d` | 原样 |
| 4 | `back\slash` | 原样保留（standard_conforming_strings=on） | 原样 |
| 5 | `tab"le` | 原样 | `tab""le` |
| 6 | `"; DROP TABLE x; --` | 原样 | `""; DROP TABLE x; --` |
| 7 | `bad\u0000name` | Err / throw | Err / throw |
| 8 | `new\nline`、`cr\r`、`esc\u001b` | Err / throw（控制字符） | Err / throw |
| 9 | ``（空串）/ 纯空白 | 空串合法返回 | 合法返回 |
| 10 | 63 字节名 / 64 字节名 | 均合法 | 63 合法，64 Err |
| 11 | `中文表名🚀` | 原样 | 原样（字节长度按 UTF-8 计） |
| 12 | escape_like_pattern：`100%_a\b` | — | `100\%\_a\\b` |

**T2 translate_psql_command 集成测试（Rust）**
- [ ] `\dt it's` → 输出含 `ILIKE '%it''s%'`，sqlparser 解析为单条 SELECT。
- [ ] `\d evil'; DROP TABLE t; --` → 单引号翻倍，单条 SELECT，无多语句。
- [ ] `\d bad\u0000name` → 常量 Error SQL，不含原始输入。
- [ ] `\c db'x` → `'db''x'`。
- [ ] `\dt user%` → 通配符保留（psql 兼容语义）。
- [ ] `\d myschema.mytable` → 双条件 nspname/relname（若实现 P2 项）。
- [ ] 无参 `\dt` `\d` `\l` `\dn` `\du` `\df` `\di` `\dv` 输出与改造前逐字节一致（常量路径零回归）。

**T3 前端 ipc.ts / AiSidebar（vitest + mock invoke）**
- [ ] `getTableColumnsMetaData(id, "tbl'name")` → 捕获 SQL 含 `table_name = 'tbl''name'`。
- [ ] 传 `schemaName='app_data'` → WHERE 含 `table_schema = 'app_data'`；不传 → `'public'`。
- [ ] 控制字符表名 → 抛出/返回失败且**不发起 invoke**。
- [ ] `col_description` 段使用 `format('%I.%I', ...)`。

**T4 App.tsx / ExportWizardModal SQL 生成**
- [ ] 行编辑 UPDATE：列值 `it's`、`back\slash`、`"quoted"`、含 `;` → 快照断言字面量翻倍、标识符双引号翻倍。
- [ ] number 分支：`NaN`/`Infinity` 值不产出裸 `NaN` 字面量。
- [ ] INSERT：多列含恶意值全转义。
- [ ] ExportWizard：`tableName='we"ird'` → `FROM "we""ird"`。
- [ ] 侧栏双击含 `"` 表名 → SELECT 语句标识符正确。

**T5 红队/端到端（真实 PG 测试库，nightly）**
- [ ] 建表 `"weird''name"`：侧栏双击 → 行编辑 → 保存，全链路无 SQL 错误。
- [ ] CLI：`\d weird''name` 返回结构；`\dt weird` 可搜到。
- [ ] 非 public schema 表：AI 侧栏可取到列注释（会议三功能修复验证）。
- [ ] kill_process：正常 pid 生效；构造非法 pid（负数）返回错误。

**手工回归清单（发布前）**
- [ ] CLI 控制台：`\l \dt \dt <pat> \d <tbl> \dn \du \df \di \dv \c <db>` 各一次。
- [ ] 侧栏双击表、AI 侧栏选表问答、行内编辑保存、新增行、删除行（若走同链路）、导出向导 CSV/JSON、进程列表 kill。
- [ ] 非法输入的错误提示可见、文案友好（UX 验收）。
