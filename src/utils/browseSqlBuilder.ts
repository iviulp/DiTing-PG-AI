/**
 * WP10: 浏览/分页 SQL 生成器 — 纯函数, 全量单测对象, 不碰 IPC。
 *
 * 两种模式:
 * 1. 浏览表模式 (SchemaTree 点表): buildTableCountSql / buildTablePageSql
 *    — 列名 quoteIdentifier, 值 escapeSqlLiteral (WP4 工具), PK/全列排序保证翻页稳定。
 * 2. 手写 SQL 模式 (D2 用户拍板: 手写 SQL 也分页): buildHandwrittenPaging
 *    — COUNT: SELECT count(*) FROM ( <用户SQL> ) AS _diting_cnt   (子查询包裹, 语义安全)
 *    — 翻页: <用户SQL(剥离尾部 LIMIT/OFFSET/分号)> LIMIT n OFFSET m
 *    — 不适用场景显式返回 supported=false + reason (该弹错弹错, 不硬包)。
 */
import { quoteIdentifier, escapeSqlLiteral } from './sqlEscape';

// ===================== 类型 =====================

export type FilterOperator =
  | '=' | '!=' | '>' | '>=' | '<' | '<='
  | 'LIKE' | 'NOT LIKE'
  | 'IN' | 'NOT IN'
  | 'BETWEEN'
  | 'IS NULL' | 'IS NOT NULL'
  | '@>' | '?'; // jsonb: 包含 / 存在键

export interface BrowseFilter {
  column: string;
  operator: FilterOperator;
  /** 单值操作符的值; BETWEEN 用 [a, b]; IN/NOT IN 用字符串数组 */
  value?: string | [string, string] | string[];
}

export type FilterCombinator = 'AND' | 'OR';

export interface TableBrowseRequest {
  schema: string;
  table: string;
  filters: BrowseFilter[];
  combinator: FilterCombinator;
  /** 排序列 (通常为主键列); 空 = 无主键表, 用全列 tie-breaker */
  orderByColumns: string[];
  orderByDirection: 'ASC' | 'DESC';
  page: number;      // 1-based
  pageSize: number;
}

// ===================== WHERE 构建 =====================

function quoteCol(col: string): string {
  // schema 前缀形式 (a.b) 分段引用
  return col.includes('.')
    ? col.split('.').map((seg) => quoteIdentifier(seg)).join('.')
    : quoteIdentifier(col);
}

/**
 * 生成 WHERE 子句 (不含 WHERE 关键字); filters 为空返回 ''。
 * 无效过滤器 (缺值/类型不对) 抛错 — 调用方捕获并明示, 不静默忽略。
 */
export function buildWhere(filters: BrowseFilter[], combinator: FilterCombinator): string {
  if (filters.length === 0) return '';
  const parts = filters.map((f) => {
    const col = quoteCol(f.column);
    switch (f.operator) {
      case 'IS NULL':
        return `${col} IS NULL`;
      case 'IS NOT NULL':
        return `${col} IS NOT NULL`;
      case 'IN':
      case 'NOT IN': {
        if (!Array.isArray(f.value) || f.value.length === 0) {
          throw new Error(`过滤器 ${f.column} ${f.operator}: 需要至少一个值`);
        }
        const lits = f.value.map((v) => `'${escapeSqlLiteral(v)}'`).join(', ');
        return `${col} ${f.operator} (${lits})`;
      }
      case 'BETWEEN': {
        if (!Array.isArray(f.value) || f.value.length !== 2) {
          throw new Error(`过滤器 ${f.column} BETWEEN: 需要两个边界值`);
        }
        return `${col} BETWEEN '${escapeSqlLiteral(f.value[0])}' AND '${escapeSqlLiteral(f.value[1])}'`;
      }
      case '@>': {
        if (typeof f.value !== 'string' || !f.value.trim()) {
          throw new Error(`过滤器 ${f.column} @>: 需要 JSON 值`);
        }
        return `${col} @> '${escapeSqlLiteral(f.value)}'::jsonb`;
      }
      case '?': {
        if (typeof f.value !== 'string' || !f.value.trim()) {
          throw new Error(`过滤器 ${f.column} ?: 需要键名`);
        }
        return `${col} ? '${escapeSqlLiteral(f.value)}'`;
      }
      default: {
        // = != > >= < <= LIKE NOT LIKE — 单值
        if (typeof f.value !== 'string') {
          throw new Error(`过滤器 ${f.column} ${f.operator}: 缺少值`);
        }
        const lit = `'${escapeSqlLiteral(f.value)}'`;
        // LIKE 走 ILIKE? 不 — 保持用户所选操作符字面语义; LIKE 模式中的 % _ 由用户自己写
        return `${col} ${f.operator} ${lit}`;
      }
    }
  });
  return parts.join(` ${combinator} `);
}

// ===================== 浏览表模式 =====================

function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function buildTableCountSql(req: TableBrowseRequest): string {
  const where = buildWhere(req.filters, req.combinator);
  return `SELECT count(*) AS total FROM ${qualifiedTable(req.schema, req.table)}${where ? ` WHERE ${where}` : ''};`;
}

export function buildTablePageSql(req: TableBrowseRequest, allColumns?: string[]): string {
  const where = buildWhere(req.filters, req.combinator);
  // 排序稳定性: PK 列优先; 无 PK 用全列 tie-breaker (架构师会议 D3)
  let orderBy = '';
  if (req.orderByColumns.length > 0) {
    orderBy = ` ORDER BY ${req.orderByColumns.map(quoteCol).join(', ')} ${req.orderByDirection}`;
  } else if (allColumns && allColumns.length > 0) {
    orderBy = ` ORDER BY ${allColumns.map(quoteCol).join(', ')} ${req.orderByDirection}`;
  }
  const offset = (Math.max(1, req.page) - 1) * req.pageSize;
  return `SELECT * FROM ${qualifiedTable(req.schema, req.table)}${where ? ` WHERE ${where}` : ''}${orderBy} LIMIT ${req.pageSize} OFFSET ${offset};`;
}

/** reltuples 估算 (立即显示"约 N 行", 精确 COUNT 返回后替换) */
export function buildRelTuplesSql(schema: string, table: string): string {
  return `SELECT c.reltuples::bigint AS estimate FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${escapeSqlLiteral(schema)}' AND c.relname = '${escapeSqlLiteral(table)}';`;
}

/** 主键列查询 (翻页稳定排序用) */
export function buildPrimaryKeySql(schema: string, table: string): string {
  return `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = format('%I.%I', '${escapeSqlLiteral(schema)}', '${escapeSqlLiteral(table)}')::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum);`;
}

// ===================== 手写 SQL 分页 (D2) =====================

export interface HandwrittenPaging {
  supported: boolean;
  /** 不支持时的原因 (展示给用户, 不静默) */
  reason?: string;
  countSql?: string;
  pageSql?: string;
  /** 剥离后的规范化 SQL (无尾分号/尾部 LIMIT/OFFSET) */
  normalizedSql?: string;
  /** 用户 SQL 原本自带 LIMIT/OFFSET 被剥离 (UI 需提示) */
  strippedOwnLimit?: boolean;
}

/**
 * 手写 SQL 分页支持判定与生成。
 * 支持: 单条 SELECT / WITH...SELECT / UNION 等集合操作。
 * 不支持 (显式 reason): 多条语句 / 写操作 / FOR UPDATE (LIMIT 不能追加在其后)。
 */
export function buildHandwrittenPaging(rawSql: string, page: number, pageSize: number): HandwrittenPaging {
  const fail = (reason: string): HandwrittenPaging => ({ supported: false, reason });

  let sql = rawSql.trim();
  if (!sql) return fail('SQL 为空');

  // 尾分号剥离; 多语句检测 (剥掉尾分号后内部还有分号 = 多条语句)
  sql = sql.replace(/;+\s*$/, '');
  // 字符串字面量内的分号不算语句分隔 — 简单扫描
  if (containsTopLevelSemicolon(sql)) {
    return fail('多条语句不支持自动分页 — 请单条执行, 或改用浏览表模式');
  }

  const head = sql.replace(/^\s+/, '').toUpperCase();
  if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
    return fail('仅 SELECT 查询支持自动分页 — 写操作按原样执行');
  }
  // 剥离字符串字面量/注释后做关键字检测 (避免字面量里的词误判)
  const bare = stripLiteralsAndComments(sql);
  // FOR UPDATE/SHARE 先检测 — 否则其中的 UPDATE 会被 DML 检测误分类
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(bare)) {
    return fail('带 FOR UPDATE/SHARE 锁定的查询不支持追加分页');
  }
  // 写操作检测 (含写操作 CTE: WITH d AS (DELETE ...) SELECT ...)
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(bare)) {
    return fail('查询中含写操作 (INSERT/UPDATE/DELETE/TRUNCATE, 含写操作 CTE) — 不支持自动分页');
  }

  // 剥离用户自带尾部 LIMIT/OFFSET (迭代剥, 顺序任意)
  let normalized = sql;
  let stripped = false;
  for (;;) {
    const before = normalized;
    normalized = normalized.replace(/\s+LIMIT\s+(ALL|\d+)\s*$/i, '');
    normalized = normalized.replace(/\s+OFFSET\s+\d+\s*$/i, '');
    if (normalized === before) break;
    stripped = true;
  }
  normalized = normalized.trim();

  const offset = (Math.max(1, page) - 1) * pageSize;
  return {
    supported: true,
    countSql: `SELECT count(*) AS total FROM (\n${normalized}\n) AS _diting_cnt;`,
    pageSql: `${normalized}\nLIMIT ${pageSize} OFFSET ${offset};`,
    normalizedSql: normalized,
    strippedOwnLimit: stripped,
  };
}

/** 剥离字符串字面量/美元引用/注释 → 只剩结构关键字 (DML 检测用) */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDollar: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) { if (c === '\n') { inLineComment = false; out += ' '; } continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; out += ' '; } continue; }
    if (inSingle) {
      if (c === "'") { if (next === "'") { i++; } else { inSingle = false; out += ' '; } }
      continue;
    }
    if (inDollar) {
      if (c === '$' && sql.startsWith(inDollar, i)) { i += inDollar.length - 1; inDollar = null; out += ' '; }
      continue;
    }
    if (c === '-' && next === '-') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '$') {
      const m = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
      if (m) { inDollar = m[0]; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return out;
}

/** 扫描字符串字面量/美元引用之外的顶层分号 */
function containsTopLevelSemicolon(sql: string): boolean {
  let inSingle = false;
  let inDollar: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (next === "'") { i++; } else { inSingle = false; }
      }
      continue;
    }
    if (inDollar) {
      if (c === '$' && sql.startsWith(inDollar, i)) { i += inDollar.length - 1; inDollar = null; }
      continue;
    }
    if (c === '-' && next === '-') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '$') {
      const m = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
      if (m) { inDollar = m[0]; i += m[0].length - 1; continue; }
    }
    if (c === ';') return true;
  }
  return false;
}

// ===================== 分页计算 =====================

export function totalPages(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}
