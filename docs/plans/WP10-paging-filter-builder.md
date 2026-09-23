# WP10 服务端分页 + 可视化过滤构建器 — 开发章程（待用户审批）

> 项目：DiTing PG AI（谛听）v2.0.0 — Tauri 2.0 + Rust + React18 + Tailwind
> 需求来源（用户原话）："我执行的SQL现在都是limit 100, 能不能做分页，你自动根据我翻页执行第二个SQL，相当于你先给总数我知道有多少条，然后每次翻页你在用类似于limit那种优化内存。再加上过滤，现在的where语句得自己写，你整个按钮输入框点击点击的，当然能自动带出来的东西你要带出来不要让我自己输入。"
> 文档状态：**用户已批准（D2 改为手写 SQL 也分页），开发完成**
> 提交记录：S1 `e3932df` / S2~S5 `849f059` / S6 `6badba0` / 收尾（速查表+右键入口）见下一提交
> 最终基线：vitest 192 / cargo 155 / clippy 0 / tsc 0 / build ✓
> 测试库约束：只用本地 PG17 `ux_demo`（shop.orders 6 行 / customers / active_customers 视图 / shop_reader / shop_writer）。禁用 12.0.216.216 与 127.0.0.1 gbrain。
> 原则：真实数据、该弹错弹错、不假数据兜底。

---

## 0. 现状事实（已核实，带行号）

| 事实 | 证据 |
|------|------|
| SchemaTree 单击表 → 硬编码 `SELECT * FROM "表" LIMIT 100;` | `App.tsx` L664-665 |
| 执行链：`runQuery(sql)` → `executeSqlWithGuard`（WP1 安全管道）→ `queryResult` | `useAppStore.ts` L174-190 |
| 列元数据已有现成 IPC：`getTableColumnsMetaData(connId, table, schema)` 返回 column_name / data_type / is_nullable / column_comment | `ipc.ts` L184 |
| 已有 WP4 双端转义工具：`quoteIdentifier` / `escapeSqlLiteral`（TS）+ `sql_escape.rs`（Rust） | `utils/sqlEscape.ts` |
| 已有 P2-1 列头**客户端**筛选（仅过滤已加载行，横幅已明示） | `DataGrid.tsx` |
| QueryResult 结构：columns / rows / rows_affected / elapsed_ms / is_read_only | `types/index.ts` L15 |

---

## 1. 十场角色会议纪要

### 会议一：资深 DBA（主导：COUNT 与排序稳定性）
1. **count(*) 在大表上可能很慢**（全表扫描）。方案：默认发真实 `SELECT count(*)`；同时先取 `pg_class.reltuples` 估算值立即显示"约 N 行（估算）"，真实 COUNT 返回后替换为精确值。用户始终知道看的是估算还是精确。
2. **翻页必须有稳定排序**，否则两页之间数据会漂移/重复。方案：ORDER BY 优先用主键列（元数据可查 `pg_index` 获取 PK）；无 PK 的表用"全部列"作 tie-breaker 排序并提示"该表无主键，翻页顺序按全列排序，性能可能较低"。
3. **OFFSET 深翻页性能**（OFFSET 100000 会扫过前 10 万行）。本工具定位是运维/调试 GUI，页大小 ≤500、常规翻页深度可接受 OFFSET；不做 keyset 分页（复杂度不值）。章程明示此取舍。
4. 过滤条件生成的 WHERE 必须走参数化或严格转义（复用 WP4），列名过 `quoteIdentifier`，值过 `escapeSqlLiteral`。

### 会议二：后端开发工程师（主导：SQL 生成器设计）
1. **核心是一个纯函数 SQL 生成器**（新文件 `src/utils/browseSqlBuilder.ts`），输入 `{schema, table, filters[], combinator, page, pageSize, orderBy}`，输出 `{countSql, pageSql, previewSql}`。纯函数可全量单测，不碰 IPC。
2. 生成示例（ux_demo 真实表）：
   - COUNT：`SELECT count(*) AS total FROM "shop"."orders" WHERE "status" = 'cancelled';`
   - 翻页：`SELECT * FROM "shop"."orders" WHERE "status" = 'cancelled' ORDER BY "id" ASC LIMIT 100 OFFSET 200;`
3. **手写的任意 SQL 不做自动分页**（重要边界）：用户 SQL 可能含聚合/CTE/JOIN/已有 LIMIT，盲目包 COUNT 和追加 OFFSET 语义会错。分页只在"浏览表模式"（从 SchemaTree 点表进入）生效；手写 SQL 保持现状。架构师会议确认此边界。
4. 后端**不需要新 Rust 命令**——COUNT 与翻页 SQL 都走既有 `execute_sql`（WP1 管道天然覆盖：SELECT 只读、注入已被转义消灭）。减少改动面。

### 会议三：数据分析师（主导：分页条交互）
1. 分页条放 DataGrid 底部：`首页 ‹ 第 X/Y 页 › 末页 | 跳至[ ]页 | 每页[100▾] | 共 N 行 (精确/估算) | 本页耗时`。
2. 页大小可选 50/100/200/500，默认 100（与现状一致，行为不突变）。
3. 改页大小/跳页 → 自动重发 SQL（就是用户说的"自动根据我翻页执行第二个 SQL"）。
4. 总数显示：估算值灰色"约"字前缀，精确值正常显示；COUNT 失败（如无权限）→ 分页条显示"总数不可用"，翻页功能仍可用（禁用末页/跳页，保留下一页）。

### 会议四：运维 SRE（主导：大表与超时）
1. COUNT 慢查询保护：浏览表模式发 COUNT 前先看 `reltuples`，若估算 > 500 万行，弹一次性确认"该表约 N 行，精确计数可能较慢，继续？[精确计数/只用估算]"（appDialog，不用 alert）。
2. 翻页请求期间分页条禁用 + 加载态，防止连点风暴。
3. 连接断开/隧道断开时翻页报错走既有 errToStr + P2-4 人话建议链路。

### 会议五：前端开发（主导：上手默认值）
1. 单击表进入浏览模式后**零配置可用**：默认第 1 页、每页 100、无过滤，等价于现在的 LIMIT 100 —— 老用户无感知，只是多了分页条。
2. 编辑器里的 SQL 文本同步显示当前页真实 SQL（用户随时能看到"第二个 SQL"长什么样，可复制去改）——透明不黑盒。

### 会议六：数据科学家（主导：过滤构建器类型感知）
1. **列名下拉自动带出**：进入浏览模式即调 `getTableColumnsMetaData` 拿全部列（名称+类型+注释），过滤器里选列不用手打。
2. **操作符按列类型自动适配**：
   - text/varchar/char/uuid/enum → `=` `≠` `LIKE` `NOT LIKE` `IN` `IS NULL` `IS NOT NULL`
   - int/numeric/float/oid → `=` `≠` `>` `≥` `<` `≤` `BETWEEN` `IN` `IS NULL` `IS NOT NULL`
   - bool → `= true` `= false` `IS NULL`（下拉三选，不用输入）
   - date/timestamp/time → `=` `>` `≥` `<` `≤` `BETWEEN` `IS NULL`；附快捷按钮"今天/最近7天/本月"（生成真实边界值）
   - jsonb/json → `=`（文本比较）`@>`（包含，值输入 JSON）`?`（存在键）`IS NULL`
3. **值输入按类型特化**：bool 下拉、BETWEEN 双输入、IN 逗号分隔标签式输入、IS NULL 不需要值输入框（自动隐藏）。
4. NULL 语义正确性：`≠` 在 SQL 里不含 NULL 行——构建器在选 `≠` 时给一行小字提示"注意：SQL 的 ≠ 不匹配 NULL 行"。

### 会议七：技术主管/架构师（主导：边界与兼容）
1. **边界确认**：分页+过滤构建器只属于"浏览表模式"。手写 SQL 执行 = 现状不变（P1-6 的 2000 行渲染保护继续兜底）。两种模式在 UI 上可区分（浏览模式显示分页条 + 过滤栏；手写 SQL 结果不显示）。
2. **与 P2-1 客户端列筛选的关系**：并存、职责分明。服务端过滤（新）= 改 WHERE 少拉数据；客户端筛选（旧）= 过滤已拉的当页行。横幅文案已各自明示范围，不混淆。
3. 多语句/写操作永不进浏览模式（`is_read_only=false` 的结果集不显示分页条）。
4. 视图也可以浏览分页（active_customers 视图验证）；无 PK 视图走"全列排序"分支。

### 会议八：新手开发者（主导：可读与引导）
1. 过滤器生成的 WHERE **实时预览 SQL**（面板底部灰色等宽字体），点选每个条件都立刻看到 SQL 变化——顺便学 SQL。
2. 空结果时提示"当前过滤条件下 0 行"+ 一键"清除全部过滤"。
3. 术语 tooltip：OFFSET/LIKE/IS NULL 等给中文悬浮解释。

### 会议九：QA 测试工程师（主导：边界用例）
测试矩阵（全部 vitest 纯函数单测 + ux_demo psql 实跑）：
1. SQL 生成：每种操作符 × 每种类型；含单引号/反斜杠/中文/控制字符的值必须正确转义（复用 sqlEscape.test.ts 风格）。
2. 列名注入攻击：列名含 `"; DROP TABLE` → quoteIdentifier 拒绝或转义（沿用 WP4 语义）。
3. OFFSET 计算：page=1→OFFSET 0；page=3,size=50→OFFSET 100；末页边界（total=250,size=100→3 页，第 3 页 50 行）。
4. COUNT 失败/为 0/权限拒绝三分支。
5. 过滤条件变更后必须回第 1 页（防止停在第 5 页看空数据）。
6. ux_demo 实跑：`status='cancelled'` 过滤 → COUNT=1、当页 1 行；`customer_id IS NULL` → 1 行（第 6 行真实 NULL）；BETWEEN total 88~299 → 3 行。

### 会议十：独立全栈开发者（主导：效率整合）
1. 快捷键：浏览模式下 `Cmd+←/→` 上一页/下一页（不与 Monaco 冲突：焦点在网格/分页条时才响应）。
2. 过滤条件 + 页大小持久化到 localStorage（按 conn+table 记忆，下次打开同表还原）。
3. 过滤器面板入口：DataGrid 工具条"漏斗"按钮 + SchemaTree 表右键菜单"筛选浏览"。

---

## 2. 实施方案（章程主体）

### 新增文件
| 文件 | 职责 |
|------|------|
| `src/utils/browseSqlBuilder.ts` | 纯函数 SQL 生成器：filters→WHERE、countSql、pageSql、预览 SQL（全量单测对象） |
| `src/components/FilterBuilder.tsx` | 可视化过滤面板：列下拉(元数据自动带出)/类型感知操作符/特化值输入/AND-OR 组合/SQL 实时预览 |
| `src/components/PaginationBar.tsx` | 分页条：首页/上下页/末页/跳页/页大小/总数(精确-估算双态)/耗时 |
| `tests/browseSqlBuilder.test.ts` | SQL 生成纯函数全矩阵单测 |
| `tests/wp10Paging.test.tsx` | 分页条+过滤器组件测试（ux_demo 真实形状） |

### 修改文件
| 文件 | 改动 |
|------|------|
| `src/store/useAppStore.ts` | 新增 `browseState`（schema/table/page/pageSize/total/totalIsEstimate/filters/combinator/orderBy）+ `browseTable()`/`browseSetPage()`/`browseSetFilters()` actions（内部调生成器→runQuery 链路复用 WP1 guard） |
| `src/App.tsx` | SchemaTree 单击表 → 从硬编码 `LIMIT 100` 改为进入浏览模式 `browseTable(schema, table)`；编辑器 SQL 文本同步显示当前页真实 SQL |
| `src/components/DataGrid.tsx` | 底部挂 PaginationBar（仅浏览模式且 is_read_only 时显示）；工具条加"漏斗"按钮开 FilterBuilder |
| `src/components/SchemaTree.tsx` | 表右键菜单加"筛选浏览" |
| `src/services/ipc.ts` | 加 `getPrimaryKeyColumns(connId, schema, table)`（查 pg_index/pg_attribute，纯 SELECT）与 `getRelTuplesEstimate(connId, schema, table)`（查 pg_class.reltuples） |

### 执行流程（用户视角）
```
单击 shop.orders
  → ① reltuples 估算立刻显示"约 6 行"
  → ② SELECT count(*) 精确总数替换显示
  → ③ SELECT * FROM "shop"."orders" ORDER BY "id" LIMIT 100 OFFSET 0   (第 1 页)
点"下一页"
  → 自动执行 ... LIMIT 100 OFFSET 100                                  (第二个 SQL, 无需手写)
点漏斗 → 选列 status (下拉自动带出全部列) → 操作符 = → 值 cancelled (输入)
  → 实时预览: WHERE "status" = 'cancelled'
  → 应用: COUNT 重算 + 回第 1 页拉数据
```

### 关键决策点（请用户确认，默认按 ★ 走）
| # | 决策 | 选项 | 默认 |
|---|------|------|------|
| D1 | 大表精确 COUNT 可能慢 | A. 总是精确 COUNT ★ / B. 估算>500万行时先问 / C. 只显示估算 | **B**（估算先行显示，>500 万才弹窗问，普通表无感） |
| D2 | 手写 SQL 是否也尝试分页 | A. 不分页，保持现状 / B. 检测到单条 SELECT 无 LIMIT 时提议分页 | **B ✅ 用户拍板：手写 SQL 也要分页**（已实现：单条 SELECT/WITH 自动分页，写操作/多语句/FOR UPDATE 显式回退） |
| D3 | 无主键表的翻页排序 | A. 全列 ORDER BY ★ / B. 不排序(可能页间漂移)并警告 | **A** |
| D4 | 页大小默认 | A. 100 ★（与现状一致） / B. 50 | **A** |
| D5 | 过滤条件组合逻辑 | A. 单一 AND/OR 全局开关 ★ / B. 嵌套条件组(括号) | **A**（"点击点击"的简单诉求；B 留 P3） |

### 工作量估算
- S1 browseSqlBuilder 纯函数 + 单测矩阵：0.5 天
- S2 元数据 IPC（PK/reltuples）+ psql 实跑验证：0.5 天
- S3 store 浏览模式状态机 + App/SchemaTree 接线：0.5 天
- S4 PaginationBar 组件 + 测试：0.5 天
- S5 FilterBuilder 组件（类型感知操作符/值特化/预览）+ 测试：1 天
- S6 持久化/快捷键/右键入口 + 全量回归 + tauri build：0.5 天
- 合计约 3.5 天，按 S1→S6 顺序逐个提交，每步测试全绿才进下一步。

### 测试适配（DoD）
1. `browseSqlBuilder.test.ts`：操作符×类型全矩阵、转义攻击向量、OFFSET 边界、COUNT 三分支（vitest，目标 ≥30 用例）。
2. `wp10Paging.test.tsx`：分页条渲染/翻页调用/过滤变更回第 1 页/总数双态（ux_demo 真实 6 行形状）。
3. psql 在 ux_demo 实跑生成的每条 SQL，验证 COUNT/OFFSET/过滤结果与预期一致（真实执行输出贴进验收记录）。
4. 基线不回退：cargo 155、vitest ≥119、tsc 0、clippy 0、vite build、tauri build 全过。
5. 端到端手动流（打包后 app + ux_demo）：点表→总数显示→翻页→过滤 cancelled→1 行→清除过滤→6 行。

---

## 3. 明确不做（本 WP 范围外，登记 P3）
- keyset/游标分页（深翻页优化）
- 嵌套条件组（括号 OR/AND 混合）
- 手写任意 SQL 的智能分页改造
- JOIN 多表可视化查询构建
- 分页数据导出合并（导出仍走既有 ExportWizard 全量通道）
