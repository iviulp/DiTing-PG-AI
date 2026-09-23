/**
 * WP10-S1: browseSqlBuilder 纯函数全矩阵单测
 * 转义语义复用 WP4 sqlEscape; 数据形状对齐 ux_demo (shop.orders 等)
 */
import { describe, it, expect } from 'vitest';
import {
  buildWhere,
  buildTableCountSql,
  buildTablePageSql,
  buildRelTuplesSql,
  buildPrimaryKeySql,
  buildHandwrittenPaging,
  totalPages,
  BrowseFilter,
} from '../src/utils/browseSqlBuilder';

const baseReq = {
  schema: 'shop',
  table: 'orders',
  filters: [] as BrowseFilter[],
  combinator: 'AND' as const,
  orderByColumns: ['id'],
  orderByDirection: 'ASC' as const,
  page: 1,
  pageSize: 100,
};

describe('S1: buildWhere — 操作符×类型矩阵', () => {
  it('空 filters → 空串', () => {
    expect(buildWhere([], 'AND')).toBe('');
  });

  it('= 文本值', () => {
    expect(buildWhere([{ column: 'status', operator: '=', value: 'cancelled' }], 'AND'))
      .toBe(`"status" = 'cancelled'`);
  });

  it('!= / > / >= / < / <=', () => {
    expect(buildWhere([{ column: 'total', operator: '>', value: '88' }], 'AND')).toBe(`"total" > '88'`);
    expect(buildWhere([{ column: 'total', operator: '<=', value: '299' }], 'AND')).toBe(`"total" <= '299'`);
  });

  it('LIKE / NOT LIKE', () => {
    expect(buildWhere([{ column: 'status', operator: 'LIKE', value: '%can%' }], 'AND'))
      .toBe(`"status" LIKE '%can%'`);
    expect(buildWhere([{ column: 'status', operator: 'NOT LIKE', value: 'new%' }], 'AND'))
      .toBe(`"status" NOT LIKE 'new%'`);
  });

  it('IN / NOT IN 多值', () => {
    expect(buildWhere([{ column: 'status', operator: 'IN', value: ['paid', 'done'] }], 'AND'))
      .toBe(`"status" IN ('paid', 'done')`);
    expect(buildWhere([{ column: 'status', operator: 'NOT IN', value: ['cancelled'] }], 'AND'))
      .toBe(`"status" NOT IN ('cancelled')`);
  });

  it('IN 空数组 → 抛错 (不静默生成非法 SQL)', () => {
    expect(() => buildWhere([{ column: 'status', operator: 'IN', value: [] }], 'AND')).toThrow(/至少一个值/);
  });

  it('BETWEEN 双边界', () => {
    expect(buildWhere([{ column: 'total', operator: 'BETWEEN', value: ['88', '299'] }], 'AND'))
      .toBe(`"total" BETWEEN '88' AND '299'`);
  });

  it('BETWEEN 缺边界 → 抛错', () => {
    expect(() => buildWhere([{ column: 'total', operator: 'BETWEEN', value: ['88'] as any }], 'AND')).toThrow(/两个边界值/);
  });

  it('IS NULL / IS NOT NULL 无需值', () => {
    expect(buildWhere([{ column: 'customer_id', operator: 'IS NULL' }], 'AND')).toBe(`"customer_id" IS NULL`);
    expect(buildWhere([{ column: 'customer_id', operator: 'IS NOT NULL' }], 'AND')).toBe(`"customer_id" IS NOT NULL`);
  });

  it('jsonb @> 包含 + ::jsonb cast', () => {
    expect(buildWhere([{ column: 'meta', operator: '@>', value: '{"a":1}' }], 'AND'))
      .toBe(`"meta" @> '{"a":1}'::jsonb`);
  });

  it('jsonb ? 存在键', () => {
    expect(buildWhere([{ column: 'meta', operator: '?', value: 'email' }], 'AND'))
      .toBe(`"meta" ? 'email'`);
  });

  it('多条件 AND / OR 组合', () => {
    const w = buildWhere([
      { column: 'status', operator: '=', value: 'new' },
      { column: 'customer_id', operator: '=', value: '2' },
    ], 'AND');
    expect(w).toBe(`"status" = 'new' AND "customer_id" = '2'`);
    const wOr = buildWhere([
      { column: 'status', operator: '=', value: 'new' },
      { column: 'status', operator: '=', value: 'paid' },
    ], 'OR');
    expect(wOr).toBe(`"status" = 'new' OR "status" = 'paid'`);
  });

  it('带 schema 前缀列名分段引用', () => {
    expect(buildWhere([{ column: 'o.status', operator: '=', value: 'x' }], 'AND'))
      .toBe(`"o"."status" = 'x'`);
  });

  it('单值操作符缺值 → 抛错', () => {
    expect(() => buildWhere([{ column: 'status', operator: '=' }], 'AND')).toThrow(/缺少值/);
  });
});

describe('S1: 注入转义 (QA 会议攻击向量)', () => {
  it("值含单引号 → 转义为 ''", () => {
    expect(buildWhere([{ column: 'status', operator: '=', value: "can'celled" }], 'AND'))
      .toBe(`"status" = 'can''celled'`);
  });

  it('列名注入 "; DROP TABLE → quoteIdentifier 双引号安全化', () => {
    const w = buildWhere([{ column: 'x"; DROP TABLE orders; --', operator: '=', value: '1' }], 'AND');
    // quoteIdentifier 语义: 内部 " 变 ""，整体包裹 → 不可能逃逸成独立语句
    expect(w).toContain('""');
    expect(w.startsWith('"')).toBe(true);
  });

  it('值含反斜杠 → 保留原样 (PG 标准字符串反斜杠无特殊含义)', () => {
    expect(buildWhere([{ column: 'status', operator: '=', value: 'a\\b' }], 'AND'))
      .toBe(`"status" = 'a\\b'`);
  });

  it('值含控制字符 (换行) → WP4 语义直接抛错拒绝', () => {
    expect(() => buildWhere([{ column: 'status', operator: '=', value: 'a\nb' }], 'AND')).toThrow();
  });

  it('中文值', () => {
    expect(buildWhere([{ column: 'status', operator: '=', value: '已取消' }], 'AND'))
      .toBe(`"status" = '已取消'`);
  });
});

describe('S1: 浏览表模式 SQL 生成', () => {
  it('COUNT (无过滤)', () => {
    expect(buildTableCountSql(baseReq)).toBe('SELECT count(*) AS total FROM "shop"."orders";');
  });

  it('COUNT (带过滤)', () => {
    expect(buildTableCountSql({ ...baseReq, filters: [{ column: 'status', operator: '=', value: 'cancelled' }] }))
      .toBe(`SELECT count(*) AS total FROM "shop"."orders" WHERE "status" = 'cancelled';`);
  });

  it('第 1 页 → OFFSET 0, PK 排序', () => {
    expect(buildTablePageSql(baseReq))
      .toBe('SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 100 OFFSET 0;');
  });

  it('第 3 页 size=50 → OFFSET 100', () => {
    expect(buildTablePageSql({ ...baseReq, page: 3, pageSize: 50 }))
      .toBe('SELECT * FROM "shop"."orders" ORDER BY "id" ASC LIMIT 50 OFFSET 100;');
  });

  it('page=0 防御 → 按第 1 页 (OFFSET 0)', () => {
    expect(buildTablePageSql({ ...baseReq, page: 0 })).toContain('OFFSET 0');
  });

  it('无 PK → 全列 tie-breaker 排序 (D3)', () => {
    const sql = buildTablePageSql({ ...baseReq, orderByColumns: [] }, ['id', 'customer_id', 'total', 'status']);
    expect(sql).toContain('ORDER BY "id", "customer_id", "total", "status" ASC');
  });

  it('reltuples 估算 SQL', () => {
    const sql = buildRelTuplesSql('shop', 'orders');
    expect(sql).toContain('reltuples');
    expect(sql).toContain(`nspname = 'shop'`);
  });

  it('PK 查询 SQL', () => {
    const sql = buildPrimaryKeySql('shop', 'orders');
    expect(sql).toContain('indisprimary');
  });

  it('DESC 排序', () => {
    expect(buildTablePageSql({ ...baseReq, orderByDirection: 'DESC' })).toContain('ORDER BY "id" DESC');
  });
});

describe('S1: 手写 SQL 分页 (D2 — 用户拍板必须支持)', () => {
  it('简单 SELECT → 子查询 COUNT + LIMIT/OFFSET 翻页', () => {
    const r = buildHandwrittenPaging('SELECT * FROM shop.customers', 2, 50);
    expect(r.supported).toBe(true);
    expect(r.countSql).toBe('SELECT count(*) AS total FROM (\nSELECT * FROM shop.customers\n) AS _diting_cnt;');
    expect(r.pageSql).toBe('SELECT * FROM shop.customers\nLIMIT 50 OFFSET 50;');
    expect(r.strippedOwnLimit).toBe(false);
  });

  it('带尾分号 → 规范化剥离', () => {
    const r = buildHandwrittenPaging('SELECT 1;  ', 1, 10);
    expect(r.supported).toBe(true);
    expect(r.normalizedSql).toBe('SELECT 1');
  });

  it('用户自带 LIMIT 100 → 剥离并标记 strippedOwnLimit (UI 提示)', () => {
    const r = buildHandwrittenPaging('SELECT * FROM shop.orders LIMIT 100', 3, 50);
    expect(r.supported).toBe(true);
    expect(r.strippedOwnLimit).toBe(true);
    expect(r.normalizedSql).toBe('SELECT * FROM shop.orders');
    expect(r.pageSql).toBe('SELECT * FROM shop.orders\nLIMIT 50 OFFSET 100;');
  });

  it('用户自带 LIMIT+OFFSET → 都剥离', () => {
    const r = buildHandwrittenPaging('SELECT * FROM t LIMIT 10 OFFSET 20', 1, 10);
    expect(r.strippedOwnLimit).toBe(true);
    expect(r.normalizedSql).toBe('SELECT * FROM t');
  });

  it('LIMIT ALL → 剥离', () => {
    const r = buildHandwrittenPaging('SELECT * FROM t LIMIT ALL', 1, 10);
    expect(r.strippedOwnLimit).toBe(true);
    expect(r.normalizedSql).toBe('SELECT * FROM t');
  });

  it('WHERE + ORDER BY 保留', () => {
    const sql = "SELECT * FROM shop.orders WHERE status = 'cancelled' ORDER BY total DESC";
    const r = buildHandwrittenPaging(sql, 1, 10);
    expect(r.pageSql).toBe(`${sql}\nLIMIT 10 OFFSET 0;`);
  });

  it('CTE (WITH ... SELECT) 支持', () => {
    const sql = 'WITH t AS (SELECT * FROM shop.orders) SELECT * FROM t';
    const r = buildHandwrittenPaging(sql, 1, 10);
    expect(r.supported).toBe(true);
    expect(r.countSql).toContain('WITH t AS');
  });

  it('UNION 支持', () => {
    const r = buildHandwrittenPaging('SELECT 1 UNION SELECT 2', 1, 10);
    expect(r.supported).toBe(true);
  });

  it('聚合查询支持 (COUNT 包子查询语义安全)', () => {
    const sql = 'SELECT status, count(*) FROM shop.orders GROUP BY status';
    const r = buildHandwrittenPaging(sql, 1, 10);
    expect(r.supported).toBe(true);
    expect(r.countSql).toContain('SELECT count(*) AS total FROM (');
  });

  it('多语句 → 拒绝并给原因 (顶层分号检测)', () => {
    const r = buildHandwrittenPaging('SELECT 1; SELECT 2', 1, 10);
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('多条语句');
  });

  it('字符串内分号不误判为多语句', () => {
    const r = buildHandwrittenPaging("SELECT * FROM t WHERE note = 'a;b'", 1, 10);
    expect(r.supported).toBe(true);
  });

  it('注释内分号不误判', () => {
    const r = buildHandwrittenPaging('SELECT 1 -- ; not a separator\n', 1, 10);
    expect(r.supported).toBe(true);
  });

  it('写操作 → 拒绝 (INSERT/UPDATE/DELETE)', () => {
    expect(buildHandwrittenPaging('DELETE FROM shop.orders', 1, 10).supported).toBe(false);
    expect(buildHandwrittenPaging('UPDATE t SET a=1', 1, 10).supported).toBe(false);
    expect(buildHandwrittenPaging('INSERT INTO t VALUES (1)', 1, 10).supported).toBe(false);
  });

  it('写操作 CTE → 拒绝', () => {
    const r = buildHandwrittenPaging('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 1, 10);
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('写操作');
  });

  it('FOR UPDATE → 拒绝 (LIMIT 不能追加在锁后)', () => {
    const r = buildHandwrittenPaging('SELECT * FROM t FOR UPDATE', 1, 10);
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('FOR UPDATE');
  });

  it('空 SQL → 拒绝', () => {
    expect(buildHandwrittenPaging('   ', 1, 10).supported).toBe(false);
  });
});

describe('S1: totalPages 边界 (QA 矩阵)', () => {
  it('total=250 size=100 → 3 页', () => expect(totalPages(250, 100)).toBe(3));
  it('total=200 size=100 → 2 页 (整除不多出空页)', () => expect(totalPages(200, 100)).toBe(2));
  it('total=0 → 1 页', () => expect(totalPages(0, 100)).toBe(1));
  it('total=1 size=500 → 1 页', () => expect(totalPages(1, 500)).toBe(1));
});
