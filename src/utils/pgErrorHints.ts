/**
 * WP9-P2-4: PostgreSQL 常见错误人话建议映射
 * 原则: 只做"附加建议", 不吞不改原始报错 (该弹错弹错 — 原文永远完整展示)
 *
 * 匹配语义: groups 是 string[][] — 组内 AND (全部子串命中), 组间 OR (任一组命中)。
 * 例: [['42703'], ['column', 'does not exist']] 表示
 *     "含 SQLSTATE 42703" 或 "同时含 column 与 does not exist" 都算命中。
 * 声明顺序 = 优先级: 更具体的条目放前面 (42703 列不存在 → 42p01 表不存在 → 3d000 库不存在)。
 */

interface PgHint {
  /** 匹配组: 组内 AND, 组间 OR (子串匹配, 大小写不敏感) */
  groups: string[][];
  /** 人话解释 */
  explain: string;
  /** 可操作建议 */
  suggestion: string;
}

const PG_HINTS: PgHint[] = [
  {
    groups: [['28000'], ['28p01'], ['password authentication failed'], ['no pg_hba.conf entry']],
    explain: '认证失败 — 用户名/密码不对, 或服务器 pg_hba.conf 不允许此主机/方式连接。',
    suggestion: '检查连接配置里的账号密码; 若确认无误, 联系 DBA 查看服务器端 pg_hba.conf 是否放行了你的 IP 与认证方式。',
  },
  {
    groups: [['53300'], ['too many connections']],
    explain: '连接数已满 — 服务器达到 max_connections 上限。',
    suggestion: '打开「Process List」查看并 kill 空闲会话; 长期方案是调大 max_connections 或引入连接池 (pgbouncer)。',
  },
  {
    groups: [['57014'], ['statement timeout']],
    explain: '语句超时被服务器取消。',
    suggestion: "优化查询 (加索引/缩小范围), 或会话级临时调大: SET statement_timeout = '60s';",
  },
  {
    groups: [['40001'], ['deadlock detected']],
    explain: '检测到死锁 — 两个以上事务互相等待对方的锁, 服务器已牺牲其中一个。',
    suggestion: '让应用按一致顺序访问表; 打开「Process List」观察锁等待; 缩小事务粒度。',
  },
  {
    groups: [['55006'], ['is being accessed by other users']],
    explain: '对象正被其他会话占用, 无法执行 DROP/ALTER。',
    suggestion: '在「Process List」中找到并 kill 占用会话后重试 (注意会中断对方事务)。',
  },
  {
    groups: [['42501'], ['permission denied']],
    explain: '权限不足 — 当前角色缺少执行此操作所需的权限。',
    suggestion: '用超级用户打开「用户管理」为当前角色授予对应 schema USAGE / 表级 SELECT 等权限。',
  },
  {
    groups: [['23505'], ['duplicate key value']],
    explain: '唯一约束冲突 — 插入/更新的值与已有行重复。',
    suggestion: '检查主键/唯一索引列的取值; 批量导入可改用 ON CONFLICT DO UPDATE/NOTHING。',
  },
  {
    groups: [['23503'], ['foreign key constraint']],
    explain: '外键约束冲突 — 引用了不存在的父行, 或父行仍被子行引用。',
    suggestion: '先插入父表行/清理子表引用; 删除父行前确认级联策略。',
  },
  {
    groups: [['23502'], ['null value in column']],
    explain: '非空约束冲突 — NOT NULL 列收到了 NULL。',
    suggestion: '为该列提供值, 或确认列定义是否需要 NOT NULL / DEFAULT。',
  },
  {
    groups: [['23514'], ['check constraint']],
    explain: 'CHECK 约束冲突 — 值不满足表定义的检查条件。',
    suggestion: '查看表的 CHECK 约束定义确认可接受的值域 (如 status 枚举); 修正数据后重试。',
  },
  {
    groups: [['22p02'], ['invalid input syntax']],
    explain: '值与列类型不匹配 (如把文本塞进 integer 列)。',
    suggestion: '检查数据类型转换; 必要时显式 CAST。',
  },
  {
    // 列不存在 — 必须在 relation/database 泛化条目之前 (更具体)
    groups: [['42703'], ['column', 'does not exist']],
    explain: '列不存在 — 拼写错误或表结构与预期不一致。',
    suggestion: '在左侧 Schema 树双击表查看真实列名核对结构。',
  },
  {
    groups: [['42p01'], ['relation', 'does not exist']],
    explain: '表/视图不存在 — 常见原因: 表名拼写、schema 前缀缺失、或当前用户无 USAGE 权限导致不可见。',
    suggestion: '检查 search_path 与 schema 前缀 (如 shop.orders); 权限问题可在「用户管理」里查看该角色的 schema/表级 ACL。',
  },
  {
    groups: [['3d000'], ['database', 'does not exist']],
    explain: '目标数据库不存在 (或当前账号看不到它)。',
    suggestion: '确认库名拼写; 可先连到 postgres 库查看可用数据库列表。',
  },
  {
    groups: [['42601'], ['syntax error']],
    explain: 'SQL 语法错误。',
    suggestion: '检查报错位置附近的拼写/引号/逗号; 也可以点「让 AI 解释此错误」自动诊断。',
  },
  {
    groups: [['08001'], ['08003'], ['08006'], ['could not connect'], ['connection refused'], ['server closed the connection'], ['no connection to the server']],
    explain: '连不上服务器 — 网络不通、服务未启动、端口错误或连接被中断。',
    suggestion: '确认主机/端口可达 (SSH 隧道用户先看隧道状态角标, 点击可一键重连); 本地库确认 postgres 服务已启动。',
  },
];

/**
 * 为原始错误文本附加人话解释与建议; 无匹配返回 null (原文照常展示, 不编造)
 */
export function explainPgError(rawError: string): { explain: string; suggestion: string } | null {
  if (!rawError) return null;
  const lower = rawError.toLowerCase();
  for (const hint of PG_HINTS) {
    const hit = hint.groups.some((group) =>
      group.every((p) => lower.includes(p.toLowerCase()))
    );
    if (hit) return { explain: hint.explain, suggestion: hint.suggestion };
  }
  return null;
}
