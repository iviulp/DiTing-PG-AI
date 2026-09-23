# SQL 动态拼接点排查基线 (WP4)

> 来源: WP4 计划会议四 (安全工程师主导) 的 10 点定性表。长期维护: 新增任何 SQL 动态插值点必须在此登记并定性。
> 口径: 每个插值点要么 (A) 有转义调用可追溯, 要么 (B) 类型安全 (数字/枚举), 要么 (C) 常量路径零插值, 要么 (D) 登记为技术债。

## 后端 (src-tauri)

| # | 位置 | 插值内容 | 定性 | 说明 |
|---|------|---------|------|------|
| 1 | db_service.rs `\c <db>` | 目标库名 | A | escape_sql_literal; 失败返回常量 Error SQL |
| 2 | db_service.rs `\dt <pattern>` | ILIKE 模式 | A | escape_sql_literal (保留 % 通配, psql 兼容语义) |
| 3 | db_service.rs `\d <table>` | 表名 / schema.table | A | 双段各自 escape_sql_literal; 已删除原 `replace('"',"")` 伪清洗 |
| 4 | db_service.rs `\d` 无参及其余元命令 | 无 | C | 常量 SQL 零插值 |
| 5 | db_service.rs connect() URL | user/password/host/db | 技术债 | password 已 urlencoding; user/host 未编码 → WP4 技术债登记, 计划后续 bind 化或严格编码 |
| 6 | commands/mod.rs kill_process | pid: i64 | B + 范围断言 | `pid <= 0 \|\| pid > i32::MAX` 拒绝; i64 格式化无注入面 |
| 7 | commands/mod.rs get_process_list / get_db_users | 无用户输入 | C | 常量 SQL |
| 8 | execute_query 全链路 | sql 整体 | 说明 | 用户 SQL 本体不做转义 (客户端语义即执行任意 SQL); 安全边界由 WP1 safety_checker AST 管道 + read_only 白名单承担 |

## 前端 (src)

| # | 位置 | 插值内容 | 定性 | 说明 |
|---|------|---------|------|------|
| 9 | ipc.ts getTableColumnsMetaData | tableName / schemaName | A | escapeSqlLiteral (src/utils/sqlEscape.ts); col_description 改 `%I.%I` regclass |
| 10 | App.tsx onSelectTable | 表名 (SchemaTree 元数据) | A | quoteIdentifier, schema.table 分段引用 |
| 11 | App.tsx onCommitChanges (DELETE/UPDATE/INSERT) | 表名/列名/单元格值 | A | 统一 sqlEscape.ts: sanitizeIdentifier + escapeSqlLiteral; 数字须 Number.isFinite; 控制字符拒绝且不丢编辑态 |
| 12 | App.tsx 正则反解 FROM 表名 | targetTable | A | 反解结果过 sanitizeIdentifier (含 try/catch 拒绝路径); 技术债: 改为元数据携带表名 |
| 13 | ExportWizardModal.tsx 全表导出 | tableName | A | sanitizeIdentifier |
| 14 | UserManagementModal.tsx DCL/DDL | 角色名/权限 | A+B | 角色名 sanitizeIdentifier; 权限项来自枚举常量 |

## 技术债登记 (计划 WP4 步骤6)

1. **execute_query bind 化**: 内部系统查询 (pg_stat_activity 过滤等) 改 sqlx bind 参数, 消除格式化拼接。
2. **连接 URL 编码**: user/host/database 统一走 urlencoding 或改 PgConnectOptions 结构体构造。
3. **App.tsx L609 正则反解表名**: 由查询结果元数据 (后端回传 source table) 替代正则猜测。

## 终审口径 (安全工程师)

- 全库 grep `format!(.*SELECT\|format!(.*INSERT\|format!(.*UPDATE\|format!(.*DELETE` 与前端 `` `SELECT ``/`` `INSERT `` 等模板串, 每个命中点必须能映射到上表某一行。
- 新增插值点未登记 → CI 评审拒绝。
