# WP5 开发计划：类型保真与 SSL（Type Fidelity & SSL）

> 项目：DiTing PG AI（Tauri 2.0 + Rust + React 18）
> 评审形式：十次多角色团队会议（产品经理 / 系统架构师 / Rust后端 / React前端 / DBA / 安全工程师 / QA测试 / UX设计 / DevOps / 发布经理 各主持一场）
> 涉及文件：`src-tauri/src/services/db_service.rs`、`src-tauri/src/models/mod.rs`、`src/components/DataGrid.tsx`、`src/components/RowDetailDrawer.tsx`、`src/types/index.ts`、`src/components/ConnectionModal.tsx`
> 状态：计划评审完毕，待开发。本文档仅为计划，不含源码改动。

---

## 背景与问题陈述

1. **类型全丢（P0）**：`db_service.rs` 的 `execute_query` 中，MySql 分支（L293-297）与 Sqlite 分支（L340-344）对**所有列**统一执行 `try_get::<String>`，失败即回填字符串 `"NULL"`，再包装成 `DbValue::Text`。后果：
   - 数字变字符串（INT/BIGINT/DECIMAL/FLOAT 全部以 Text 传输，前端无法右对齐、无法数值排序/编辑校验）；
   - **真 NULL 与字符串 'NULL' 无法区分**（前端 `DataGrid.tsx` L476、`RowDetailDrawer.tsx` L196 均用 `displayVal === 'NULL'` 判断，业务数据里恰好存了 "NULL" 文本会被误渲染为斜体灰色空值）；
   - bool 丢失（MySQL TINYINT(1) 变 "0"/"1" 文本）；
   - BLOB/二进制被强转 String 失败后显示 "NULL"，数据不可见。
   Postgres 分支（L207-250）已有按 `type_info().name()` 映射 DbValue 的先例，但覆盖不全（缺 NUMERIC→StringDecimal、FLOAT4/8→Float、BYTEA→BytesHex、JSON/JSONB→Json），且 catch-all 分支同样存在 try_get 失败静默变 Null 的问题。
2. **ssl_mode 形同虚设（P1）**：`ConnectionConfig.ssl_mode: Option<String>`（models/mod.rs L73）与前端 `ConnectionModal.tsx`（默认 'disable'，四档枚举）已存在，但 `connect()`（L100-153）拼 URL 时完全忽略该字段——Postgres 未拼 `?sslmode=`，MySQL 未映射 `MySqlSslMode`，用户以为开了 SSL 实际是明文。
3. **可测试性差**：映射逻辑内联在 match 分支里，依赖 `sqlx::Row` 具体类型，无法单测；URL 拼装同样内联。

WP5 目标：三栈（PG/MySQL/SQLite）类型保真映射到 `DbValue` 枚举 + ssl_mode 真实生效 + 纯函数化可单测。

---

## 会议一：产品经理主持 —— WP5 范围界定与优先级

**议题**：类型丢失与 SSL 未生效对用户意味着什么？WP5 边界在哪里？

**角色发言要点**：
- **产品经理**：DiTing 定位是数据库管理工具，"看到的值不是库里的值"是信任级缺陷，必须 P0。两个用户可感知场景：① 表格里数字列无法与文本列区分，NULL 单元格与 'NULL' 字符串渲染相同，用户可能基于错误数据做生产决策；② 用户勾选了 SSL 却明文传输密码（connect URL 里含密码），属于安全承诺违约。范围界定：本 WP 只做**读取路径**（execute_query 结果映射）与**连接路径**（ssl 参数生效），不做写入路径的类型反向绑定（UPDATE/INSERT 参数化留 WP6），不做列 nullable/主键元数据精确化（ColumnMetadata 里 nullable 恒为 true 的问题登记为已知债务）。
- **DBA**：补充一个高频场景——MySQL 的 BIGINT UNSIGNED（如雪花 ID）超过 i64 范围时不能静默截断，必须走 StringDecimal 或明确策略，这是数据正确性问题不是体验问题。
- **安全工程师**：SSL 不是"锦上添花"，当前 `connect()` 把明文密码放进 URL，disable 模式下整条链路可被嗅探。要求 WP5 至少做到：ssl_mode 被真实消费 + 不向后兼容地"假装安全"。
- **QA测试**：要求验收标准里明确"真 NULL vs 字符串 'NULL'"的可区分性测试用例，这是回归重点。
- **发布经理**：范围同意，但要求 ssl 默认值策略（会议六）在开发前定案，避免发布前一天返工。

**决议**：
1. WP5 范围锁定四项：MySql/Sqlite/PG 三栈 DbValue 类型映射、前端渲染核对、ssl_mode 连接串生效、单元测试。写路径与元数据精确化出范围。
2. 优先级：类型映射 P0，SSL 生效 P1（同版本内完成）。
3. 验收以"用户在网格中能区分 NULL/'NULL'/数字/布尔/JSON/二进制"为产品级标准。

---

## 会议二：系统架构师主持 —— DbValue 映射总体架构

**议题**：如何组织三栈的类型映射层？纯函数抽取到什么粒度？

**角色发言要点**：
- **系统架构师**：核心原则——**映射决策与行数据读取分离**。sqlx 的 `Row::try_get` 绑定具体数据库泛型（PgRow/MySqlRow/SqliteRow），mock 成本极高；但"类型名 → 用哪种读取器/转换器"这个**决策**是纯字符串函数，完全可测。建议三层结构：
  - 层1（纯函数，可单测）：`fn plan_pg(type_name: &str) -> TypePlan`、`fn plan_mysql(...)`、`fn plan_sqlite(...)`，返回枚举 `TypePlan { Int64, Int32, Int16, UInt64AsDecimal, Float64, Float32, Bool, DecimalStr, Timestamp, Date, Time, Uuid, Json, BytesHex, Text, Fallback }`；
  - 层2（薄胶水，集成测）：各分支按 TypePlan 调对应 `try_get::<T>` 并包装 DbValue；
  - 层3：**先判 NULL 再判类型**。sqlx 提供 `Row::try_get::<Option<T>, _>`，用 Option 包装可以区分 SQL NULL（None）与解码失败（Err）。统一模式：`try_get::<Option<T>>(i)` → `Ok(None) => DbValue::Null`，`Ok(Some(v)) => 转换`，`Err(_) => 降级链`。
- **Rust后端**：同意。补充两点：① 现有 PG 分支的 bug——`try_get::<i64>(i)` 遇到 NULL 返回 Err 被 unwrap_or 成 DbValue::Null，恰好行为正确但语义错误（解码失败也变 Null），改 Option 模式后语义才干净；② MySQL 的 `type_info().name()` 返回如 "BIGINT"、"DECIMAL"、"TINYINT"、"DATETIME"，**是否 UNSIGNED 需查 `column.type_info().is_unsigned()`**（sqlx MySQL TypeInfo 提供），不能只看名字；③ TINYINT(1) 在 sqlx MySQL 里报 "TINYINT"，是否当 bool 需要看 `column_type_info` 的 display width——sqlx 0.8 不直接暴露 (1)，决议按 TINYINT→Int 处理，bool 语义交给列注释/前端展示，不猜。
- **DBA**：SQLite 注意——`type_info().name()` 返回的是**声明类型**（如 "INTEGER"、"TEXT"、"REAL"、"BLOB"、"NUMERIC"，也可能是空/任意字符串，因为 SQLite 类型亲和性是建议性的），实际存储类型可能不同（动态类型）。决议：SQLite 用声明类型选计划，但每个读取器失败后走**动态降级链**：`i64 → f64 → bool → String → hex(bytes)`，全部失败才是 Null（配合 Option 判 NULL 先行）。
- **系统架构师**：三栈各自一个 `plan_*` 函数 + 一个共享的 `DbValue` 降级链约定，不引入 trait object 抽象（三个数据库的 Row 类型异构，泛型抽象得不偿失）。映射表集中在 `db_service.rs` 内新模块 `mod value_mapping`（或独立文件 `services/value_mapping.rs`），便于单测引用。

**决议**：
1. 采用"TypePlan 纯函数（决策）+ 薄胶水（读取）+ Option 判 NULL 先行"三层架构。
2. `TypePlan` 枚举成员：Int64/Int32/Int16/UInt64Decimal/Float64/Float32/Bool/DecimalStr/Timestamp/Date/Time/Uuid/Json/BytesHex/Text/Fallback。
3. MySQL unsigned 用 `type_info().is_unsigned()` 判定；MySQL TINYINT 按 Int 处理不当 bool。
4. SQLite 声明类型选计划 + 动态降级链兜底。
5. 新代码放独立模块（`services/value_mapping.rs`），`plan_pg/plan_mysql/plan_sqlite` 与 URL 拼装函数均为 `pub` 纯函数。

---

## 会议三：Rust后端主持 —— MySQL 分支类型映射细则

**议题**：MySQL 各类型 → DbValue 的精确映射表，BIGINT UNSIGNED / DECIMAL / 日期时间 / BLOB 处理。

**角色发言要点**：
- **Rust后端**：给出映射表草案（sqlx 0.8 MySQL `type_info().name()` 返回值）：

  | MySQL 类型名 | 读取类型 | DbValue |
  |---|---|---|
  | BIGINT（signed） | `Option<i64>` | Int |
  | BIGINT UNSIGNED | `Option<bigdecimal::BigDecimal>` 或 `Option<u64>`→超限转 String | **StringDecimal**（防 JS Number 精度丢失，见下） |
  | INT / INTEGER | `Option<i32>` | Int |
  | INT UNSIGNED | `Option<u32>`→i64 | Int |
  | MEDIUMINT / SMALLINT / TINYINT / YEAR | `Option<i16/i32>` | Int |
  | FLOAT | `Option<f32>`→f64 | Float |
  | DOUBLE / REAL | `Option<f64>` | Float |
  | DECIMAL / NUMERIC | `Option<bigdecimal::BigDecimal>` | **StringDecimal**（to_string，保精度） |
  | BIT(1) | `Option<bool>` | Bool |
  | CHAR / VARCHAR / TEXT 系 / ENUM / SET | `Option<String>` | Text |
  | JSON | `Option<serde_json::Value>` 或 String | Json（紧凑序列化字符串） |
  | DATE | `Option<chrono::NaiveDate>` | Timestamp（格式 `%Y-%m-%d`，复用现有枚举不加新 tag，前端已支持） |
  | DATETIME / TIMESTAMP | `Option<chrono::NaiveDateTime>` | Timestamp（`%Y-%m-%d %H:%M:%S%.3f`） |
  | TIME | `Option<chrono::NaiveTime>` 或 `std::time::Duration`（负值/超24h） | Timestamp（`%H:%M:%S`；sqlx MySQL TIME 映射为 NaiveTime 失败时用 String 兜底） |
  | BINARY / VARBINARY / BLOB 系 | `Option<Vec<u8>>` | BytesHex（hex 编码） |
  | NULL 类型 | — | Null |
  | 未识别 | 降级链 String→bytes-hex | Text / BytesHex |

- **DBA**：三点修正：① **BIGINT UNSIGNED** 最大值 2^64-1 超 i64，也超 JS `Number.MAX_SAFE_INTEGER`，必须 StringDecimal 传字符串，否则前端 JSON.parse 后精度丢失——雪花 ID 是常见受害场景；② DECIMAL 精度可达 65 位，BigDecimal→String 是唯一无损方案，同意；③ MySQL 的 `sql_mode` 影响 ZERO DATE（'0000-00-00'）——chrono 会解码失败，降级链要保证失败时回退 `Option<String>` 再 hex，不能直接吞成 Null（丢数据）。
- **系统架构师**：JSON 列注意 sqlx MySQL 解码 `serde_json::Value` 需要 feature `json`（Cargo.toml 已有 features 列表，开发时核对，若无则加）；若解码失败降级 Text。
- **Rust后端**：确认 `bigdecimal` feature 已在 Cargo.toml sqlx features 中（L34），chrono 已有（L31）。DATE/DATETIME 解码需要 sqlx 的 chrono feature，已具备。TIME 超范围（MySQL TIME 可到 ±838:59:59）chrono::NaiveTime 装不下，决议：TIME 直接用 `Option<String>` 读取（sqlx 支持 TIME→String 的文本解码路径不稳，保险做法是 try NaiveTime 失败后 try String 再失败 hex），TypePlan::Time 的胶水层实现降级链。
- **QA测试**：要求映射表每一行至少一个单测用例（plan_mysql 纯函数层面）+ 一个集成用例（真实 MySQL 容器，DevOps 提供）。

**决议**：
1. 通过上述映射表；BIGINT UNSIGNED 与 DECIMAL/NUMERIC 一律 → StringDecimal（字符串传输，杜绝精度丢失）。
2. DATE/DATETIME/TIME 复用 `DbValue::Timestamp` tag，仅格式串不同（不新增前端 tag，降低破坏面）。
3. 所有读取器统一降级链：目标类型 → String → Vec<u8>(hex) → （仅当 `Option::None` 时）Null；**解码失败不得静默变 Null**，最后兜底 `Text(format!("<decode error: {}>", e))` 并 tracing::warn，宁可显式报错不可静默丢数据。
4. 开发时核对 sqlx features：`json`、`bigdecimal`、`chrono` 齐备。

---

## 会议四：DBA主持 —— SQLite 动态类型与 Postgres 分支补全

**议题**：SQLite 类型亲和性怎么处理？PG 分支现存缺口一并修复吗？

**角色发言要点**：
- **DBA**：SQLite 五存储类（NULL/INTEGER/REAL/TEXT/BLOB）+ 声明类型亲和性（INTEGER/TEXT/REAL/NUMERIC/BLOB 五亲和）。sqlx SQLite 的 `type_info().name()` 给的是**声明类型名**，可能是 "INTEGER"、"VARCHAR(255)"、"BOOLEAN"、"DATETIME"、任意自定义串、甚至空。映射策略：
  - 声明名归一化（大写、剥括号内长度、剥 UNSIGNED 等修饰）后匹配：INT/INTEGER/BIGINT/SMALLINT/TINYINT/MEDIUMINT → Int64 计划；REAL/DOUBLE/FLOAT/NUMERIC/DECIMAL → 先试 i64 再 f64（SQLite NUMERIC 亲和会整存）→ Float，DECIMAL 声明的建议 DecimalStr（读 String 保精度）；BOOLEAN/BOOL → Bool（SQLite 存 0/1，读 i64 转 bool）；DATE/DATETIME/TIMESTAMP → Timestamp（SQLite 无原生日期，存储可能是 TEXT ISO8601 或 INTEGER 秒/毫秒——胶水层按 String 读，原样进 Timestamp）；BLOB → BytesHex；TEXT/CLOB/CHAR/VARCHAR/JSON → 声明含 JSON 走 Json，其余 Text。
  - **关键**：声明类型只是提示，运行时以实际值为准。降级链必须完整：`Option<i64> → Option<f64> → Option<bool> → Option<String> → Option<Vec<u8>>(hex)`，全 Err 才兜底错误文本。SQLite 的 try_get 对类型不匹配会 Err（不像某些驱动自动转），所以降级链在 SQLite 分支是主路径不是异常路径。
- **Rust后端**：SQLite bool 注意坑——sqlx SQLite 读 `bool` 只对 INTEGER 0/1 有效，REAL 1.0 会 Err，降级链顺序保证覆盖。JSON 声明列实际存 TEXT，直接 `Option<String>` → Json。
- **DBA**：PG 分支现存缺口，建议本 WP 顺手补全（同属"类型保真"主题，改动同一函数，拆开做两次回归不划算）：
  - NUMERIC/DECIMAL → 现在落到 catch-all 变 Text，应改 `Option<bigdecimal::BigDecimal>` → StringDecimal；
  - FLOAT4 → Float(f32 as f64)、FLOAT8 → Float，现在也是 Text；
  - BYTEA → BytesHex，现在 catch-all try String 失败变 Null（**二进制数据当前完全丢失**）；
  - JSON/JSONB → Json，现在是 Text（勉强可用但前端 JSON 高亮/tab 判断依赖 tag）；
  - DATE → Timestamp（NaiveDate），TIME/TIMETZ → Timestamp，INTERVAL → Text；
  - INET/CIDR/MACADDR 等 → Text（try_get String 可行）；
  - catch-all 分支先 `Option<String>`，失败 `Option<Vec<u8>>` hex，再失败显式错误文本；去掉"try bool 再 try String"的猜测式 catch-all。
  - 现有 BOOL 分支的 `s == "t"` 字符串兜底可保留（PG bool 的文本表示）。
- **系统架构师**：同意合并处理。plan_pg 同样纯函数化，三个 plan 函数返回同一个 TypePlan 枚举，Glue 层三栈共享降级链工具函数（能共享的部分抽 `fn decode_fallback`）。
- **QA测试**：SQLite 集成测试建库脚本需覆盖：同列混存 INTEGER/TEXT/REAL/BLOB/NULL（动态类型极端场景）、声明类型与实际存储不符的列、JSON1 扩展列。

**决议**：
1. SQLite 采用"声明类型归一化选计划 + 完整动态降级链"策略，降级链是常规路径。
2. PG 分支缺口（NUMERIC/FLOAT4/8/BYTEA/JSON/JSONB/DATE/TIME/INTERVAL/catch-all）纳入 WP5 一并修复。
3. 三栈共享 TypePlan 枚举与降级链约定；每个 plan 函数独立可测。
4. SQLite 日期列不解析，原样字符串进 Timestamp tag。

---

## 会议五：React前端主持 —— DataGrid / RowDetailDrawer 渲染核对

**议题**：新类型值进入前端后，现有渲染逻辑哪些会被破坏？

**角色发言要点**：
- **React前端**：核对结论（基于 `src/types/index.ts` L10-12 的 tag 枚举 `Null/Int/Float/StringDecimal/Bool/Text/Json/BytesHex/Timestamp`，与 Rust `DbValue` serde `tag="type", content="val"` 一致，**本次不新增 tag，前端类型定义零改动**）。逐点排查：
  - `DataGrid.tsx` L475-476：`String(cell.val)` + `displayVal === 'NULL'` 判空。**破坏点1**：`DbValue::Null` 的 `val` 是 undefined（serde 单元变体 `{"type":"Null"}` 无 content 字段），`String(undefined)` = "undefined" 而非 "NULL"——当前 MySQL/SQLite 因为全走 Text("NULL") 碰巧显示对，改造后真 Null tag 会显示 "undefined"。**必须修**：渲染前按 `cell.type === 'Null' || cell.val == null` 判空。
  - **破坏点2**：字符串 'NULL' 误判——业务值恰好是 "NULL" 字符串时 `isNull` 为 true 被渲染成灰色斜体。改造后真 Null 有独立 tag，判空逻辑改为只看 tag，此 bug 自然消除。
  - **破坏点3**：Bool——`String(true)` = "true"，可显示但无差异化；建议 type==='Bool' 时渲染 ✓/✗ 或 true/false 徽章（UX 会议定样式，最小实现保持文本 "true"/"false"）。
  - **破坏点4**：BytesHex——`String(val)` 直出 hex 串，长 BLOB 会把 title/单元格撑爆；现有 `truncate max-w-xs` 能兜住显示，但 RowDetailDrawer 里应加"hex 预览 + 长度提示"。最小实现：不改，登记优化项。
  - StringDecimal：`String(val)` 直出字符串，无损，OK；数值右对齐可作为增强（type==='Int'||'Float'||'StringDecimal' 时 `text-right font-mono`）。
  - Timestamp：直出字符串 OK。Json：直出字符串，RowDetailDrawer 已有 JSON tab 逻辑（按 data_type 判断），需核对是否改按 cell.type==='Json' 判断更可靠——列 data_type 来自 `type_info().name()` 仍准确，两者皆可，决议用 `cell.type === 'Json' || data_type 含 json` 双条件。
  - 编辑路径（edits/handleCellChange）：单元格编辑把值当字符串提交，本 WP 不动写路径，编辑后本地显示仍走 String，不受影响。
  - `RowDetailDrawer.tsx` L195-197：同样的 `String(rawCellVal)` + 'NULL' 判空 + `rawCellVal === null` 检查（该检查目前恒 false，因为 Null tag 的 val 是 undefined 不是 null）——同步修破坏点1/2。
- **UX设计**：Null 单元格当前"灰色斜体 NULL"样式保留；Bool 用文本 true/false + 轻微配色（true 绿 / false 灰）即可，不引入图标避免与 ✕ 删除标记混淆；BytesHex 详情面板显示前 64 hex + "…(N bytes)"。
- **QA测试**：前端回归清单：三栈各查一张含全类型的表，核对 9 种 tag 渲染；重点用例——单元格存字符串 'NULL'（应正常黑色显示）与真 NULL（灰色斜体）并排一列。
- **系统架构师**：建议前端抽一个 `formatDbValue(cell: DbValue): { display: string; kind: 'null'|'bool'|'numeric'|'json'|'hex'|'text' }` 纯函数放 `src/utils/`，DataGrid 与 Drawer 共用，vitest 可测（任务书说 vitest 可选，做了纯函数就顺手测）。

**决议**：
1. 前端不新增 tag、不改 `types/index.ts`；必改两处判空逻辑（DataGrid L476、RowDetailDrawer L196）：`isNull = cell.type === 'Null' || cell.val === undefined || cell.val === null`。
2. 抽公共 `formatDbValue` 纯函数（display + kind），两组件共用；Bool 文本渲染 true/false 加轻量配色；StringDecimal/Int/Float 右对齐等距字体。
3. BytesHex 详情面板截断显示前 64 hex + 字节数；Json 判断用 cell.type 优先。
4. 字符串 'NULL' 误判 bug 随 tag 判空修复自然消除，列入回归验证。

---

## 会议六：安全工程师主持 —— ssl_mode 支持矩阵与默认值策略

**议题**：各驱动 ssl 参数矩阵；默认值取 require（安全）还是 disable（向后兼容）？

**角色发言要点**：
- **安全工程师**：现状定性——`ConnectionModal.tsx` 给用户四档选择（disable/require/verify-ca/verify-full），但 `connect()` 全部忽略，等于 UI 欺骗用户；且 URL 内嵌明文密码，disable 时凭据可被中间人截获。支持矩阵（sqlx 0.8）：

  | ssl_mode 值 | Postgres（URL `?sslmode=`） | MySQL（MySqlSslMode / URL `?ssl-mode=`） | SQLite |
  |---|---|---|---|
  | disable | `sslmode=disable` | `ssl-mode=disabled`（MySqlSslMode::Disabled） | 不适用（本地文件，忽略该字段） |
  | require | `sslmode=require`（加密不验证证书） | `ssl-mode=required`（MySqlSslMode::Required） | 不适用 |
  | verify-ca | `sslmode=verify-ca`（验证 CA 链） | `ssl-mode=verify_ca`（MySqlSslMode::VerifyCa，需系统信任库/CA） | 不适用 |
  | verify-full | `sslmode=verify-full`（CA + 主机名） | **MySQL 驱动无独立 verify-full**，`verify_identity`（MySqlSslMode::VerifyIdentity）为对应档 | 不适用 |

  注意术语差异：PG 用 `verify-full`，MySQL 用 `verify_identity`，映射函数必须做值翻译，不能透传。MySQL verify_ca/verify_identity 依赖系统 root 证书（sqlx 走 rustls/native-tls 按 feature，开发时核对 Cargo.toml 的 sqlx tls feature——当前 features 列表未见 tls 项，sqlx 0.8 MySQL 默认 native-tls 需显式 feature，**必须核对并按需补 `native-tls` 或 `rustls`**）。
- **Rust后端**：实现方式二选一：URL query 拼接（`?sslmode=` / `?ssl-mode=`，注意与已有 query 的 `&` 拼接、值需 urlencode）或 `MySqlConnectOptions::new().ssl_mode(...)` 结构化 API。**推荐 MySQL 用 MySqlConnectOptions（类型安全，MySqlSslMode 枚举直接映射）**，PG 用 `PgConnectOptions::new().ssl_mode(PgSslMode::from(...))` 同样结构化，避免手拼字符串的转义坑；但任务书要求"ssl 连接串拼装 roundtrip 测试"，故无论走哪条路，都抽纯函数 `build_pg_url(config) -> String` / `build_mysql_url(config) -> String`（或 `mysql_ssl_mode(s: &str) -> MySqlSslMode` + `pg_ssl_mode(s: &str) -> PgSslMode` 纯映射函数）供单测。
- **产品经理/发布经理（默认值辩论）**：
  - 安全派：默认 require——云数据库（RDS/CloudSQL/Azure）普遍支持 SSL，require 不验证证书也能防嗅探；用户显式选 disable 才明文。
  - 兼容派：本地开发（127.0.0.1 MySQL 无证书、内网 PG 关 SSL）极常见，默认 require 会让存量用户升级后**连不上**，工单爆炸。
  - **安全工程师折中方案**：`ssl_mode: None`（存量配置无此字段）时的默认值按目标区分——**host 为 localhost/127.0.0.1/::1 或 SQLite → disable；其他 host → require**。verify-ca/verify-full 永远只由用户显式选择。前端 ConnectionModal 新建连接时默认选中值同样按 host 智能提示（输入远程 host 时默认 require 并显示"未验证证书"说明）。
- **DevOps**：本机集成测试容器（MySQL/PG docker）默认无 TLS，测试矩阵需要一套带自签证书的容器配置，我来提供 docker-compose；CI 里 ssl 连接失败要能区分"证书问题"与"网络问题"，错误信息需透出 sqlx 原始错误。
- **DBA**：提醒 PG `sslmode=require` 下服务端未开 SSL 会连接失败（不是静默降级），错误信息要能指导用户；MySQL 8 默认生成自签证书，require 档直接可用。

**决议**：
1. 支持矩阵按上表定案；**MySQL verify-full → verify_identity 值翻译**在映射函数内完成；SQLite 忽略 ssl_mode。
2. 默认值策略（结论）：**`ssl_mode` 缺失/为空时，localhost/127.0.0.1/::1 默认 `disable`，其余 host 默认 `require`**；verify-ca/verify-full 仅显式选择生效。前端新建连接的默认选中值同步此策略。此策略在设置页/连接弹窗以文案明示，不做静默行为。
3. 实现优先结构化 API（PgConnectOptions/MySqlConnectOptions），同时抽纯函数 `pg_ssl_mode(&str) -> PgSslMode`、`mysql_ssl_mode(&str) -> MySqlSslMode`、`default_ssl_mode(host, db_type) -> &str` 供单测与 roundtrip 验证。
4. 开发首项任务：核对/补齐 Cargo.toml sqlx 的 TLS feature（native-tls），MySQL verify_ca/verify_identity 无 TLS feature 会 panic 或编译不过。
5. ssl 相关连接错误必须透出底层原因（AppError 携带 sqlx 错误文本），不得笼统报 "connection failed"。

---

## 会议七：QA测试主持 —— 测试策略与用例矩阵

**议题**：单测/集成测/手工回归三层怎么布？mock 不可行时的替代方案？

**角色发言要点**：
- **QA测试**：任务书明确"mock 行难测则至少测类型名→转换器选择的映射逻辑"，与会议二的架构决议正好咬合。三层测试策略：
  - **L1 纯函数单测（Rust，无 DB）**：`plan_pg/plan_mysql/plan_sqlite`（类型名→TypePlan 断言，覆盖会议三/四映射表全部行 + 未知类型名 + 大小写/带修饰变体如 "VARCHAR(255)"、"INT UNSIGNED"）；`pg_ssl_mode/mysql_ssl_mode`（四档映射 + 非法值回退）；`default_ssl_mode`（localhost vs 远程）；`build_pg_url/build_mysql_url`（含密码特殊字符 urlencode、ssl 参数拼接、**roundtrip**：url::Url 解析回来断言 scheme/user/host/port/db/query 各字段与原 config 一致）。
  - **L2 集成测试（Rust，真实容器，`#[ignore]` 标记 + CI docker-compose 拉起）**：三栈各建一张 `all_types` 表（PG：int2/4/8、float4/8、numeric(38,10)、bool、text、json/jsonb、bytea、date/timestamp/timestamptz/time、uuid、inet；MySQL：tinyint/smallint/int/bigint、bigint unsigned（插入 > i64::MAX 的值如 18446744073709551615）、decimal(65,30)、float/double、bit(1)、char/varchar/text、json、binary/varbinary/blob、date/datetime/timestamp/time（含 '838:59:59' 边界）、雪花 ID 列；SQLite：INTEGER/REAL/TEXT/BLOB 声明列 + 同列混存动态类型 + 无声明类型列 + JSON 文本列）。断言每个单元格 DbValue tag 与值精确匹配，**含真 NULL 列与存 'NULL' 字符串列并存断言两者 tag 不同**。
  - **L3 前端 vitest（可选→决议做）**：`formatDbValue` 纯函数 9 种 tag 的 display/kind 断言 + Null/'NULL' 字符串区分用例。
  - **L4 手工回归清单**（发布前）：三栈连接各执行 `SELECT * FROM all_types`，肉眼核对网格渲染；SSL 矩阵手工验证（本地容器 disable/require，带自签证书容器 require/verify-ca 预期失败原因正确）。
- **Rust后端**：L1 全部放 `#[cfg(test)] mod tests` 于 value_mapping 模块内；L2 用 `tests/integration_db.rs`，环境变量 `DITING_TEST_DB_*` 提供连接串，缺省 skip。roundtrip 测试用 `url` crate 解析（Cargo.toml 已有 urlencoding，需确认 url crate，若无则手断言字符串前缀+query 包含）。
- **DBA**：MySQL '0000-00-00' 零日期与 TIME '838:59:59' 必须进 L2 用例；SQLite 动态类型混存列（一列里同时有 INTEGER 1、TEXT 'abc'、REAL 1.5、BLOB、NULL 五行）是降级链的黄金用例。
- **QA测试**：回归红线——Postgres 分支现有行为不得回退：现有能正确显示的表（int/text/timestamp/bool）改造后 tag 可能从 Text 变 Int/Timestamp，前端排序/显示依赖处需全量过一遍 L4。
- **DevOps**：CI 加 job：`cargo test`（L1）+ docker-compose 起三库跑 L2 + `npm run test`（L3，若 vitest 未配置则本 WP 顺手配置，成本低）。

**决议**：
1. 四层测试策略通过；L1 为硬性验收（映射表全覆盖 + ssl roundtrip），L2 为 CI 验收，L3 做（vitest 若缺则补配置），L4 发布前手工执行。
2. L2 建表脚本与种子数据（含边界值：u64 上限、decimal(65,30)、零日期、838:59:59、混存动态列、'NULL' 字符串 vs 真 NULL）由 DBA 出稿、DevOps 容器化。
3. 验收标准量化：L1 用例数 ≥ 40；三栈 all_types 表所有列 tag 断言 100% 通过；无任何 "unwrap_or Null" 式静默降级路径残留（代码审查项）。

---

## 会议八：UX设计主持 —— 类型可视化与 NULL 语义呈现

**议题**：9 种 DbValue 在网格与详情面板的视觉规范。

**角色发言要点**：
- **UX设计**：规范提案（暗色主题延续现有 slate/amber 体系）：
  - Null：灰色斜体 `NULL`（现状保留，slate-600）；
  - 'NULL' 字符串及其他 Text：正常 slate-200 黑色系，**与 Null 视觉必须可区分**（这是本 WP 的 UX 核心收益）；
  - Int/Float/StringDecimal：右对齐 + font-mono（数字列扫读效率），StringDecimal 不加引号不加修饰（它看起来就是数字，精度由字符串保住）；
  - Bool：`true` 绿（emerald-400）/ `false` 灰（slate-500），font-mono 小写；不用图标（避免与行首 ✕ 删除标记冲突——前端会议已定）；
  - Timestamp：slate-300 font-mono，不截断日期部分；
  - Json：琥珀色（amber-300/80）提示可展开，详情面板保留现有 preview/raw 双 tab；
  - BytesHex：紫色系（violet-400）前缀 `0x` + 前 32 hex + `…`，title 提示完整长度 "(N bytes)"；详情面板显示前 64 hex + 字节数 + "复制完整 hex" 按钮（可选增强）；
  - 列头 data_type 徽标（现有小字类型名）保留，作为第二信号源。
- **React前端**：全部可用 Tailwind 类实现，`formatDbValue` 返回 kind 后组件里一个 switch 决定 className，改动集中、无新依赖。BytesHex 的 `0x` 前缀是显示层拼接，不进数据。
- **产品经理**：编辑态不改（本 WP 不做写路径），但要求编辑一个 Int 单元格时输入框预填 display 值不预填 "0x..." 之类装饰——formatDbValue 的 display 用于只读态，编辑态取 raw val 字符串，两态分离。
- **QA测试**：视觉验收纳入 L4 手工清单：一张 all_types 截图对照规范逐项打勾；色弱可辨性检查（Bool 绿/灰除颜色外文本本身不同，OK）。
- **UX设计**：详情面板（RowDetailDrawer）字段卡头部现有 `(data_type)` 小字保留；Json 字段默认 preview tab 行为不变。

**决议**：
1. 通过 9-tag 视觉规范；实现载体为 `formatDbValue` 的 kind + 组件 className switch，无新依赖。
2. 编辑态取 raw val、只读态取 display，两态分离。
3. BytesHex `0x` 前缀与截断为纯显示层行为。
4. 视觉验收进 L4 清单（all_types 全类型截图对照）。

---

## 会议九：DevOps主持 —— 测试基础设施、TLS feature 与 CI

**议题**：集成测试容器、证书环境、Cargo feature 核对、CI 流水线改造。

**角色发言要点**：
- **DevOps**：
  - **Cargo.toml 核对结果（阻塞项）**：当前 sqlx features 含 `chrono`、`bigdecimal`，未见 `json`、`native-tls`/`rustls`。行动：开发第一步补 features：`json`（MySQL/PG JSON 列解码为 serde_json::Value 所需）、TLS 二选一——推荐 `rustls`（纯 Rust，跨平台打包无 OpenSSL 依赖，Tauri 分发友好；macOS/Windows 用户无需系统 OpenSSL）。注意 sqlx 0.8 feature 名：`rustls`、`native-tls`；PG verify-ca/full 与 MySQL verify_ca/identity 均依赖所选 TLS 后端 + 系统根证书（rustls 走 webpki-roots/rustls-native-certs，需确认 sqlx rustls 集成的根证书来源，macOS 钥匙串兼容性问题记录在案，验证失败时错误信息透出）。
  - **docker-compose.test.yml**：services：`pg16`（带自签证书配置 ssl=on）、`mysql8`（默认自签证书即开即用）、`sqlite` 无需容器（测试内建临时文件）。另加 `mysql8-nossl`（--skip-ssl）用于 disable 档验证。种子 SQL 由 DBA 提供（会议七 all_types 建表脚本），容器健康检查后 `cargo test -- --ignored` 跑 L2。
  - **CI**：GitHub Actions（或现有 CI）新增 job `wp5-integration`：compose up → wait healthy → cargo test（L1+L2）→ npm test（L3）→ compose down。缓存 cargo registry 控时长；L2 失败附容器日志 artifact。
  - **本地开发体验**：`just test-db up / just test-db down` 或 npm script 封装，README 补一节。
- **Rust后端**：rustls 同意（Tauri 打包在 Windows 上带 OpenSSL 是噩梦）。补充：`urlencoding` crate 已在用（connect 里 encode 密码），URL 拼装纯函数继续用它，不引 `url` crate 也行——roundtrip 测试可用字符串断言 + 手写解析 query。决议：若 `url` crate 引入成本低（纯 Rust 无传递依赖问题）则用之，开发时定。
- **安全工程师**：自签证书容器的 verify-ca 测试需要把测试 CA 注入信任链或提供 sslrootcert 路径——**注意 ConnectionConfig 目前没有 CA 证书路径字段**，verify-ca/verify-full 档在自定义 CA 场景（企业内网常见）本期只能依赖系统信任库，文档中明示此限制，证书路径字段登记后续 WP。
- **QA测试**：CI 上 L2 的 MySQL '0000-00-00' 用例需要容器 sql_mode 允许零日期（去掉 NO_ZERO_DATE），compose 里配置 `--sql-mode=ALLOW_INVALID_DATES`。
- **发布经理**：CI 时长预算 ≤ 10 分钟增量；rustls 切换会重编 sqlx 依赖树，首次 CI 慢属预期。

**决议**：
1. Cargo features 补齐：sqlx 增加 `json`、`rustls`（TLS 后端定 rustls，理由：跨平台分发无 OpenSSL 依赖）。此项为**开发第一步阻塞项**。
2. 交付 `docker-compose.test.yml`（pg16+ssl、mysql8、mysql8-nossl）+ all_types 种子 SQL + CI job `wp5-integration`。
3. verify-ca/verify-full 本期仅支持系统信任库证书，自定义 CA 路径字段登记为后续 WP 债务，用户文档明示。
4. MySQL 零日期测试容器配置 sql_mode 放宽。

---

## 会议十：发布经理主持 —— 兼容性、发布节奏与风险登记

**议题**：本次改造的破坏面、迁移策略、发布检查单。

**角色发言要点**：
- **发布经理**：破坏面盘点：
  1. **数据面（预期内变化）**：MySQL/SQLite 用户的数字列从 Text tag 变 Int/Float/StringDecimal tag，NULL 从 Text("NULL") 变 Null tag——序列化 JSON 结构变化（`{"type":"Text","val":"123"}` → `{"type":"Int","val":123}`）。前端同步发版则无感知；**若有外部消费者（无）则无兼容负担**。Tauri 桌面应用前后端同包发布，风险可控。
  2. **行为面（SSL 默认值）**：存量已保存连接配置 ssl_mode 多为 'disable'（前端默认值写入），显式 disable 不受新默认策略影响；仅 ssl_mode 缺失（老版本配置无此字段）的远程连接会从明文变 require——**可能连不上未开 TLS 的远程库**。缓解：连接失败错误信息明确提示 "SSL required by default; set ssl_mode=disable in connection settings if the server has no TLS"，发布说明置顶此变更。
  3. **PG 分支修复面**：numeric/float/bytea/json 列 tag 变化同上，前端同版消化。
- **系统架构师**：版本策略——Rust DbValue serde 结构不动（tag 枚举不增不减），前后端契约稳定，无需版本协商。
- **安全工程师**：发布说明必须包含安全变更章节：SSL 默认策略、密码仍经 URL 传递（结构化 API 改造后不再手拼明文 URL，日志中确保不打印连接串——检查 tracing 是否有 url 泄漏，列为发布检查项）。
- **QA测试**：发布检查单：L1/L2/L3 全绿 + L4 手工三栈截图归档 + 存量连接配置升级冒烟（旧 config JSON 反序列化 → 连接 → 查询 all_types）+ SSL 错误提示文案核对。
- **DevOps**：灰度不适用（桌面应用），走正常版本通道；回滚策略 = 版本回退，无数据迁移无状态残留（连接配置 schema 未变）。
- **发布经理**：工作量评估汇总：Rust 映射层 ~2 人日、SSL ~1 人日、前端 ~1 人日、测试与 CI ~2 人日、联调回归 ~1 人日，合计 ~7 人日，单迭代内完成。风险登记：① rustls 在 macOS 系统证书读取的边角问题（预留 native-tls 回退开关，feature flag 切换）；② MySQL TIME 超范围解码（已有降级链兜底）；③ 零日期 sql_mode 差异（测试环境已配置，生产行为随用户库配置，降级链保证不崩）。

**决议**：
1. 前后端同版本发布，无兼容协商需求；发布说明含"SSL 默认策略变更"与"数字/NULL 显示变化"两节。
2. 发布检查单通过（见开发步骤清单第 10 步）；日志不得泄漏含密码的连接串列为代码审查项。
3. rustls 为主、native-tls 为回退预案（Cargo feature 可切换）。
4. 总工作量 ~7 人日，风险三项登记在案。

---

## 开发步骤清单

### 阶段 A：Rust 类型映射层（P0）

**A1. 依赖与模块骨架**
- Cargo.toml：sqlx features 补 `json`、`rustls`（回退预案 `native-tls`）；确认 chrono/bigdecimal/urlencoding 在位。
- 新建 `src-tauri/src/services/value_mapping.rs`：定义 `pub enum TypePlan { Int64, Int32, Int16, UInt64Decimal, UInt32, Float64, Float32, Bool, DecimalStr, Timestamp, Date, Time, Uuid, Json, BytesHex, Text, Fallback }` 与三个纯函数 `plan_pg / plan_mysql / plan_sqlite(type_name: &str, is_unsigned: bool) -> TypePlan`。

**A2. plan_mysql 实现**（按会议三映射表）
- BIGINT+unsigned→UInt64Decimal；BIGINT→Int64；INT+unsigned→UInt32；INT→Int32；TINYINT/SMALLINT/MEDIUMINT/YEAR→Int16/Int32；FLOAT→Float32；DOUBLE→Float64；DECIMAL/NUMERIC→DecimalStr；BIT→Bool；CHAR/VARCHAR/TEXT 系/ENUM/SET→Text；JSON→Json；DATE→Date；DATETIME/TIMESTAMP→Timestamp；TIME→Time；BINARY/VARBINARY/BLOB 系→BytesHex；未知→Fallback。类型名归一化：大写、剥 `(n)` 长度与修饰词。

**A3. plan_sqlite 实现**（按会议四）
- 声明类型归一化匹配：INT 系→Int64；REAL/DOUBLE/FLOAT→Float64；NUMERIC/DECIMAL→DecimalStr；BOOL/BOOLEAN→Bool；DATE/DATETIME/TIMESTAMP→Timestamp；BLOB→BytesHex；JSON→Json；TEXT/CHAR/VARCHAR/CLOB/空/未知→Text（Fallback 降级链兜底）。

**A4. plan_pg 补全**（按会议四决议）
- 新增：NUMERIC/DECIMAL→DecimalStr；FLOAT4→Float32；FLOAT8→Float64；BYTEA→BytesHex；JSON/JSONB→Json；DATE→Date；TIME/TIMETZ→Time；INTERVAL/INET/CIDR/MACADDR→Text。保留既有 INT2/4/8、BOOL、TIMESTAMP(TZ)、UUID 映射；catch-all→Fallback。

**A5. 胶水层改造 execute_query 三分支**
- 统一模式：`let is_null = r.try_get::<Option<T>>(i)` 先行判 NULL→`DbValue::Null`；按 TypePlan 调对应读取器；失败走降级链 目标类型→String→Vec<u8>(hex)→`Text("<decode error: …>")` + `tracing::warn!`（**禁止静默变 Null**）。
- MySql 分支：列循环改为 `for (i, col) in r.columns().iter().enumerate()`，取 `col.type_info().name()` 与 `col.type_info().is_unsigned()` 进 plan_mysql；删除 `try_get::<String> … unwrap_or("NULL")` 旧代码。
- Sqlite 分支：同上走 plan_sqlite + 动态降级链（降级链为常规路径）。
- Postgres 分支：改走 plan_pg；顺带修 MySql/Sqlite 分支 `sqlx::query(sql)` 应为 `sqlx::query(&effective_sql)` 的既有 bug（psql 元命令转译在这两分支当前不生效——登记确认后一并修）。
- 胶水层可共享部分抽 helper（如 `fn bytes_to_hex(v: &[u8]) -> String`）。

**验收标准（阶段 A）**：
- 三栈 all_types 表查询，每列 DbValue tag 与建表类型精确对应；
- 真 NULL → `{"type":"Null"}`；字符串 'NULL' → `{"type":"Text","val":"NULL"}`；
- MySQL bigint unsigned 存 18446744073709551615 → StringDecimal 原样字符串，无精度丢失；
- decimal(65,30) 全精度往返；blob → BytesHex 可还原原字节；MySQL time '838:59:59' 与零日期不崩溃、显式降级；
- SQLite 混存列五种存储类各归其 tag；
- 代码审查：无 `unwrap_or(DbValue::Null)` / `unwrap_or_else(|_| "NULL")` 残留。

### 阶段 B：SSL 生效（P1）

**B1. ssl 纯函数**
- `pg_ssl_mode(&str) -> PgSslMode`：disable/require/verify-ca/verify-full 映射，非法值回退 default 策略结果并 warn；
- `mysql_ssl_mode(&str) -> MySqlSslMode`：disable→Disabled、require→Required、verify-ca→VerifyCa、**verify-full→VerifyIdentity**；
- `default_ssl_mode(host: &str, db_type) -> &'static str`：localhost/127.0.0.1/::1/Sqlite→"disable"，其余→"require"；
- URL/Options 构建纯函数（`build_pg_options / build_mysql_options` 或字符串 URL 版本 + roundtrip 可测形式），密码 urlencode 保持。

**B2. connect() 改造**
- Postgres：`PgConnectOptions` 携带 ssl_mode（ssl_mode 为空时走 default_ssl_mode）；
- MySQL：`MySqlConnectOptions::new().ssl_mode(mysql_ssl_mode(...))`；
- SQLite：忽略 ssl_mode；
- 错误路径：连接失败时 AppError 附底层原因与 ssl 提示文案（"若服务端未启用 TLS，请在连接设置中将 SSL 模式改为 disable"）。

**B3. 前端 ConnectionModal 默认值**
- 新建连接时 sslMode 初始值由 host 智能决定（远程默认 require），编辑存量配置尊重已存值；弹窗内加一行说明文案（各档含义 + 默认策略）。

**验收标准（阶段 B）**：
- 支持矩阵（会议六表格）每格有测试或手工验证记录；
- ssl_mode 缺失的远程 PG/MySQL 连接实际走 TLS（服务端日志/`SHOW STATUS LIKE 'Ssl_cipher'` / PG `SELECT ssl FROM pg_stat_ssl` 佐证）；
- localhost 缺省仍明文可连（向后兼容）；
- verify-ca 对自签证书容器失败且错误信息含证书原因；
- 日志与错误信息中不出现含密码的连接串。

### 阶段 C：前端渲染（P0，随阶段 A 同版）

**C1. formatDbValue 纯函数**（`src/utils/formatDbValue.ts`）
- 输入 DbValue，输出 `{ display: string; kind: 'null'|'bool'|'numeric'|'json'|'hex'|'text' }`；Null→display "NULL"；BytesHex→`0x`+前 32 hex 截断（详情面板 64）；其余 String(val)。

**C2. DataGrid.tsx 改造**
- L476 判空改 `cell.type === 'Null' || cell.val == null`；按 kind 应用样式（numeric 右对齐 font-mono、bool emerald/slate、json amber、hex violet、null 灰斜体）；编辑态取 raw val。

**C3. RowDetailDrawer.tsx 改造**
- L195-197 同步判空修复；BytesHex 字段显示截断 hex + "(N bytes)"；Json tab 判断优先 `cell.type === 'Json'`。

**验收标准（阶段 C）**：
- 9 种 tag 渲染符合会议八视觉规范；
- 同列并排真 NULL（灰斜体）与 'NULL' 字符串（正常黑色）视觉可区分；
- 字符串 'undefined'/'NaN' 不出现在任何单元格；
- 既有功能（编辑、行选中、删除标记、排序）无回归。

### 阶段 D：测试与 CI

**D1. Rust L1 单测**（value_mapping 模块 #[cfg(test)]，≥40 用例）
- plan_pg/plan_mysql/plan_sqlite：映射表全行 + 未知类型 + 大小写/长度修饰变体 + unsigned 组合；
- pg_ssl_mode/mysql_ssl_mode 四档 + 非法值；default_ssl_mode localhost/远程/sqlite；
- URL/Options roundtrip：特殊字符密码（`p@ss:w/rd?&=`）、含 ssl 参数的拼装→解析→字段一致。

**D2. Rust L2 集成测试**（`tests/integration_db.rs`，`#[ignore]` + 环境变量驱动）
- docker-compose.test.yml：pg16(ssl on, 自签)、mysql8、mysql8-nossl；种子 all_types 建表 + 边界数据（u64 上限、decimal(65,30)、零日期、time 838:59:59、混存动态列、'NULL' 字符串行、真 NULL 行、blob 随机字节）；
- 断言：每列 tag + 值精确匹配；NULL/'NULL' tag 不同；hex 可还原；StringDecimal 字符串等值。

**D3. 前端 L3 vitest**
- 若无 vitest 配置则补（vite 项目成本低）；formatDbValue 9 tag + Null/'NULL' 区分 + hex 截断用例。

**D4. CI job `wp5-integration`**
- compose up → healthcheck → cargo test（L1 + --ignored L2）→ npm test → compose down；容器日志 artifact。

**D5. L4 手工回归清单**（发布前执行并归档）
- 三栈 all_types 网格/详情截图对照视觉规范；SSL 矩阵手工四档 × PG/MySQL；存量配置升级冒烟；错误提示文案核对。

### 最终验收标准（WP5 整体）

1. L1 ≥40 用例、L2 三栈全列断言、L3 全绿，CI wp5-integration 通过；
2. MySQL/SQLite/PG 查询结果类型保真：数字为数值 tag、真 NULL 为 Null tag、bool/JSON/二进制/日期各归其位、大整数与高精度 decimal 字符串无损；
3. ssl_mode 四档在 PG/MySQL 真实生效，默认策略（localhost→disable，远程→require）落地且文案明示；
4. 前端无 'undefined' 泄漏、NULL 与 'NULL' 视觉可区分、9 tag 样式符合规范；
5. 发布检查单（会议十）全项通过：发布说明含 SSL 默认策略变更与显示变化章节、日志无连接串泄漏、回滚方案确认（版本回退即可）。

### 测试清单（汇总）

| 编号 | 层级 | 内容 | 阻塞发布 |
|---|---|---|---|
| T1 | L1 | plan_mysql 全类型名映射（含 unsigned/修饰变体/未知） | 是 |
| T2 | L1 | plan_sqlite 声明类型归一化 + 亲和映射 | 是 |
| T3 | L1 | plan_pg 补全类型映射 | 是 |
| T4 | L1 | pg_ssl_mode / mysql_ssl_mode（verify-full→verify_identity）/ default_ssl_mode | 是 |
| T5 | L1 | URL/Options 拼装 roundtrip（特殊字符密码 + ssl 参数） | 是 |
| T6 | L2 | PG all_types 全列 tag/值断言（含 bytea/numeric/json/uuid/inet） | 是 |
| T7 | L2 | MySQL all_types（含 u64 上限、decimal(65,30)、零日期、time 边界、bit、blob） | 是 |
| T8 | L2 | SQLite 混存动态列 + 无声明类型列 + JSON 文本列 | 是 |
| T9 | L2 | 真 NULL vs 'NULL' 字符串 tag 区分（三栈） | 是 |
| T10 | L2 | SSL 连接矩阵：disable/require 对 mysql8 与 mysql8-nossl；verify-ca 对自签失败原因正确 | 是 |
| T11 | L3 | vitest formatDbValue 9 tag + 判空 + hex 截断 | 否（可选→已决议做） |
| T12 | L4 | 手工：三栈网格/详情视觉对照 + 存量配置升级冒烟 + 错误文案 | 是 |

### 风险登记

| 风险 | 缓解 |
|---|---|
| rustls macOS 系统证书读取边角问题 | Cargo feature 可切 native-tls 回退 |
| 远程库存量连接因默认 require 连不上 | 错误提示明确指路 disable；发布说明置顶 |
| MySQL TIME 超范围/零日期解码失败 | 降级链显式兜底 + warn 日志，不崩溃不静默 |
| 前端 tag 变化引发隐性回归 | L4 全类型手工对照 + formatDbValue 单点收敛渲染逻辑 |

### 后续 WP 债务登记（本期不做）

- 写路径（INSERT/UPDATE）参数化类型反向绑定（WP6）；
- ColumnMetadata nullable/is_primary_key 精确化；
- ConnectionConfig 自定义 CA 证书路径字段（企业内网 verify-ca 场景）；
- BytesHex 详情面板"复制完整 hex / 下载二进制"增强。
