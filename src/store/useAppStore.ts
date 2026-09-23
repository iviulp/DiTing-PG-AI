import { create } from 'zustand';
import { showConfirm } from '../services/appDialog';
import { ConnectionConfig, QueryResult, AiConfig, SafetyBlockedPayload } from '../types';
import {
  executeSqlWithGuard,
  aiChat,
  aiChatStream,
  ChatMessage,
  updateAiConfig,
  getAiConfig,
  vaultListConnections,
  vaultUpsertConnection,
  vaultDeleteConnection,
  vaultConnectDb,
  vaultMigrateFromLocalStorage
, errToStr,
  executeSql,
  getPrimaryKeyColumns,
  getRelTuplesEstimate } from '../services/ipc';
import {
  BrowseFilter,
  FilterCombinator,
  buildTableCountSql,
  buildTablePageSql,
  buildHandwrittenPaging,
} from '../utils/browseSqlBuilder';

// WP10-S6: 浏览偏好持久化 (按 conn+table 记忆过滤器/组合/页大小 — 全栈会议 #2)
const BROWSE_PREFS_KEY = 'aidb_browse_prefs';
export interface BrowsePrefs {
  filters?: BrowseFilter[];
  combinator?: FilterCombinator;
  pageSize?: number;
}
function loadBrowsePrefs(connId: string, schema: string, table: string): BrowsePrefs {
  try {
    const all = JSON.parse(localStorage.getItem(BROWSE_PREFS_KEY) || '{}');
    return all[`${connId}|${schema}|${table}`] || {};
  } catch { return {}; }
}
function saveBrowsePrefs(connId: string, schema: string, table: string, prefs: BrowsePrefs): void {
  try {
    const all = JSON.parse(localStorage.getItem(BROWSE_PREFS_KEY) || '{}');
    all[`${connId}|${schema}|${table}`] = prefs;
    localStorage.setItem(BROWSE_PREFS_KEY, JSON.stringify(all));
  } catch { /* 存储满/隐私模式 — 偏好丢失不阻塞功能 */ }
}

/** WP1: 待确认的 Critical SQL (全局确认对话框状态) */
export interface PendingSafetyConfirm {
  connId: string;
  sql: string;
  payload: SafetyBlockedPayload;
  resolve: (approved: boolean) => void;
}

/** WP10: 分页状态机 — 浏览表模式 / 手写 SQL 模式统一 */
export interface PagingState {
  mode: 'table' | 'sql';
  /** table 模式 */
  schema?: string;
  table?: string;
  orderByColumns?: string[];
  orderByDirection?: 'ASC' | 'DESC';
  allColumns?: string[];
  filters: BrowseFilter[];
  combinator: FilterCombinator;
  /** sql 模式 (规范化后的 SQL, 已剥尾部 LIMIT/OFFSET) */
  normalizedSql?: string;
  /** 共用 */
  page: number;          // 1-based
  pageSize: number;
  total: number | null;  // null = 尚未取到
  totalIsEstimate: boolean;
  loading: boolean;
  /** 当前页真实 SQL (编辑器同步显示用) */
  currentPageSql: string;
  /** 手写 SQL 自带 LIMIT 被剥离提示 */
  strippedOwnLimit?: boolean;
}

interface AppState {
  connections: ConnectionConfig[];
  activeConnId: string | null;
  activeTab: string;
  queryResult: QueryResult | null;
  aiConfig: AiConfig;
  isExecuting: boolean;
  errorMsg: string | null;
  /** WP1: 当前等待用户确认的高危 SQL (null = 无) */
  pendingSafetyConfirm: PendingSafetyConfirm | null;
  /** WP10: 分页状态 (null = 非分页模式 — 普通执行/写操作) */
  paging: PagingState | null;

  // Actions
  /** WP6: 启动引导 — localStorage 幂等迁移 + 从 vault 拉取脱敏列表 */
  bootstrapVaultData: () => Promise<void>;
  /** WP6: 从 vault 刷新脱敏连接列表 */
  refreshConnections: () => Promise<void>;
  addConnection: (config: ConnectionConfig) => Promise<void>;
  updateConnection: (config: ConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  setActiveConn: (id: string) => void;
  runQuery: (sql: string) => Promise<void>;
  setAiConfig: (config: AiConfig) => Promise<void>;
  loadAiConfig: () => Promise<void>;
  askAi: (
    prompt: string,
    schemaContext?: string,
    history?: ChatMessage[],
    onDelta?: (text: string) => void
  ) => Promise<string>;
  /** WP1: 用户在全局确认框做出选择 */
  resolveSafetyConfirm: (approved: boolean) => void;

  // ===== WP10 分页 actions =====
  /** 浏览表模式入口 (SchemaTree 单击表): 估算→PK→COUNT→第1页 */
  browseTable: (schema: string, table: string) => Promise<void>;
  /** 手写 SQL 分页执行 (runQuery 检测到单条 SELECT 时自动进入) */
  runQueryPaged: (sql: string, pageSize?: number) => Promise<void>;
  /** 翻页 / 改页大小 (自动重发 SQL — 用户要的"自动执行第二个 SQL") */
  pagingGotoPage: (page: number) => Promise<void>;
  pagingSetPageSize: (size: number) => Promise<void>;
  /** 过滤器变更 → 回第 1 页重查 (QA 矩阵第 5 条) */
  pagingSetFilters: (filters: BrowseFilter[], combinator: FilterCombinator) => Promise<void>;
  /** 排序变更 → 回第 1 页 */
  pagingSetOrderBy: (columns: string[], direction: 'ASC' | 'DESC') => Promise<void>;
  /** 退出分页模式 (回到普通执行) */
  clearPaging: () => void;
}


// WP6: 连接数据源 = 后端 vault (~/.aidb/connections.enc); 初始为空, bootstrapVaultData 拉取
export const useAppStore = create<AppState>((set, get) => ({
  connections: [],
  activeConnId: null,
  activeTab: 'editor',
  queryResult: null,
  paging: null,
  aiConfig: {
    provider_name: 'Custom BaseURL',
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model_name: 'gpt-4o-mini',
    temperature: 0.2
  },
  isExecuting: false,
  errorMsg: null,
  pendingSafetyConfirm: null,

  bootstrapVaultData: async () => {
    // WP6-S5: 一次性迁移 — localStorage 旧明文数据吸入 vault, 成功后才删除明文
    try {
      if (!localStorage.getItem('aidb_vault_migrated')) {
        const legacyConns = localStorage.getItem('aidb_connections');
        const legacyAi = localStorage.getItem('aidb_ai_config');
        if (legacyConns || legacyAi) {
          const outcome = await vaultMigrateFromLocalStorage(legacyConns || '[]', legacyAi);
          // 迁移调用成功才清明文 (T15: 失败不删)
          localStorage.removeItem('aidb_connections');
          localStorage.removeItem('aidb_ai_config');
          localStorage.setItem('aidb_vault_migrated', '1');
          if (outcome.status === 'migrated' && (outcome.dirty_skipped ?? 0) > 0) {
            set({ errorMsg: `迁移完成: ${outcome.count} 个连接已加密入库, ${outcome.dirty_skipped} 条脏数据被跳过` });
          }
        } else {
          localStorage.setItem('aidb_vault_migrated', '1');
        }
      }
    } catch (err: any) {
      // 迁移失败: 保留 localStorage 明文不清除, 显示横幅, 下次启动重试
      set({ errorMsg: `配置迁移失败 (数据未丢失, 重启将重试): ${errToStr(err)}` });
      return;
    }
    await get().refreshConnections();
  },

  refreshConnections: async () => {
    try {
      const views = await vaultListConnections();
      set((state) => ({
        connections: views,
        activeConnId:
          state.activeConnId && views.some((c) => c.id === state.activeConnId)
            ? state.activeConnId
            : null
      }));
    } catch (err: any) {
      set({ errorMsg: `加载连接列表失败: ${errToStr(err)}` });
    }
  },

  addConnection: async (config) => {
    // WP6: 密码只经 vaultUpsertConnection 进加密存储; 连接测试走 conn_id (密码不回前端)
    let warnMsg: string | null = null;
    try {
      await vaultUpsertConnection(config);
    } catch (err: any) {
      set({ errorMsg: `保存连接失败: ${errToStr(err)}` });
      return;
    }
    try {
      await vaultConnectDb(config.id);
    } catch (err: any) {
      warnMsg = `Connection saved with warning: ${errToStr(err)}`;
    }
    await get().refreshConnections();
    set((state) => ({
      activeConnId: config.id,
      errorMsg: warnMsg ?? null,
      connections: state.connections
    }));
  },

  updateConnection: async (config) => {
    let warnMsg: string | null = null;
    try {
      // 密码留空 → 后端保留原密码 (占位保留语义)
      await vaultUpsertConnection(config);
    } catch (err: any) {
      set({ errorMsg: `更新连接失败: ${errToStr(err)}` });
      return;
    }
    try {
      await vaultConnectDb(config.id);
    } catch (err: any) {
      warnMsg = `Updated with warning: ${errToStr(err)}`;
    }
    await get().refreshConnections();
    set({ errorMsg: warnMsg });
  },

  deleteConnection: async (id) => {
    try {
      await vaultDeleteConnection(id);
    } catch (err: any) {
      set({ errorMsg: `删除连接失败: ${errToStr(err)}` });
      return;
    }
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      activeConnId: state.activeConnId === id ? null : state.activeConnId
    }));
  },


  setActiveConn: (id) => set({ activeConnId: id }),

  runQuery: async (sql) => {
    const { activeConnId } = get();
    if (!activeConnId) return;

    set({ isExecuting: true, errorMsg: null });
    try {
      // WP1: Critical SQL 弹全局确认框, 用户批准后 force 重发 (安全判定以后端为准)
      const res = await executeSqlWithGuard(activeConnId, sql, (payload) => {
        return new Promise<boolean>((resolve) => {
          set({ pendingSafetyConfirm: { connId: activeConnId, sql, payload, resolve } });
        });
      });
      set({ queryResult: res, isExecuting: false });
    } catch (err: any) {
      set({ errorMsg: errToStr(err), isExecuting: false });
    }
  },

  resolveSafetyConfirm: (approved) => {
    const pending = get().pendingSafetyConfirm;
    if (pending) {
      set({ pendingSafetyConfirm: null });
      pending.resolve(approved);
    }
  },

  setAiConfig: async (config) => {
    try {
      // WP2: 完整配置 (含 key/__KEEP__ 占位符) 只送后端加密落盘;
      // localStorage 仅存非敏感字段, 绝不再缓存明文 api_key
      const { api_key: _key, ...nonSensitive } = config;
      localStorage.setItem('aidb_ai_config', JSON.stringify(nonSensitive));
      // 留空 + 原本已存 key → 传占位符, 后端保留原 key
      let outConfig = config;
      if (config.api_key.trim() === '' && get().aiConfig.api_key === '__KEEP__') {
        outConfig = { ...config, api_key: '__KEEP__' };
      }
      await updateAiConfig(outConfig);
      set({ aiConfig: { ...outConfig, key_tail4: outConfig.api_key === '__KEEP__' ? get().aiConfig.key_tail4 : (outConfig.api_key.slice(-4) || null) } });
    } catch (err: any) {
      set({ errorMsg: errToStr(err) });
    }
  },

  loadAiConfig: async () => {
    try {
      // WP2: 后端返回脱敏视图 (无完整 api_key); 前端本地不再缓存明文 key,
      // 保存时若用户未改 key 输入框则传 "__KEEP__" 占位符由后端保留原值。
      const view: any = await getAiConfig();
      if (view) {
        const cfg: AiConfig = {
          provider_name: view.provider_name,
          base_url: view.base_url,
          api_key: view.has_key ? '__KEEP__' : '',
          model_name: view.model_name,
          temperature: view.temperature,
          max_context_tokens: view.max_context_tokens,
          reserved_output_tokens: view.reserved_output_tokens,
          key_tail4: view.key_tail4
        };
        set({ aiConfig: cfg });
      }
    } catch (err) {
      // 后端不可用时静默保持默认配置
      console.warn('loadAiConfig failed:', err);
    }
  },

  askAi: async (prompt, schemaContext, history, onDelta) => {
    try {
      // WP2: 优先流式 (Channel 逐 delta); 流式失败自动降级同步 aiChat 一次
      if (onDelta) {
        try {
          return await aiChatStream(prompt, schemaContext, history, onDelta);
        } catch (streamErr) {
          console.warn('AI stream failed, falling back to sync aiChat:', streamErr);
        }
      }
      return await aiChat(prompt, schemaContext, history);
    } catch (err: any) {
      throw new Error(errToStr(err));
    }
  },

  // ===================== WP10 分页状态机 =====================

  browseTable: async (schema, table) => {
    const { activeConnId } = get();
    if (!activeConnId) return;
    // WP10-S6: 恢复该 conn+table 的浏览偏好 (过滤器/组合/页大小)
    const prefs = loadBrowsePrefs(activeConnId, schema, table);
    const pageSize = prefs.pageSize ?? (get().paging?.mode === 'table' && get().paging?.pageSize
      ? get().paging!.pageSize : 100);
    const restoredFilters = prefs.filters ?? [];
    const restoredCombinator = prefs.combinator ?? 'AND';

    set({
      isExecuting: true,
      errorMsg: null,
      paging: {
        mode: 'table', schema, table,
        orderByColumns: [], orderByDirection: 'ASC', allColumns: [],
        filters: restoredFilters, combinator: restoredCombinator,
        page: 1, pageSize,
        total: null, totalIsEstimate: true, loading: true,
        currentPageSql: '',
      },
    });

    try {
      // ① reltuples 估算立刻上屏 (SRE 会议: 估算先行, COUNT 慢也不白屏)
      const est = await getRelTuplesEstimate(activeConnId, table, schema);
      if (est !== null) {
        set((st) => st.paging ? { paging: { ...st.paging, total: est, totalIsEstimate: true } } : {});
      }
      // WP10-D1 (SRE 会议): 估算 > 500 万行 → 精确 COUNT 可能慢, 先征得同意
      let wantExactCount = true;
      if (est !== null && est > 5_000_000) {
        wantExactCount = await showConfirm(
          `表 "${schema}.${table}" 估算约 ${est.toLocaleString()} 行。\n\n精确计数 (SELECT count(*)) 在大表上可能较慢。\n\n要执行精确计数吗？（取消则只用估算，仍可正常翻页，末页/跳页按钮会禁用）`,
          { title: '大表精确计数确认', confirmText: '精确计数 (可能较慢)' }
        );
      }

      // ② PK 列 (翻页稳定排序)
      let pk: string[] = [];
      try {
        pk = await getPrimaryKeyColumns(activeConnId, table, schema);
      } catch { pk = []; } // 无权限查 PK → 走全列排序分支, 不阻塞

      const p = get().paging!;
      const req = { schema, table, filters: p.filters, combinator: p.combinator,
                    orderByColumns: pk, orderByDirection: 'ASC' as const, page: 1, pageSize };

      // ③ 精确 COUNT (替换估算; D1: 大表用户选"只用估算"则跳过, 保持估算态)
      if (wantExactCount) {
        const countSql = buildTableCountSql(req);
        try {
          const cntRes = await executeSql(activeConnId, countSql);
          const totalVal = cntRes?.rows?.[0]?.[0]?.val;
          const total = totalVal === null || totalVal === undefined ? null : Number(totalVal);
          set((st) => st.paging ? { paging: { ...st.paging, total: Number.isFinite(total as number) ? total : null, totalIsEstimate: false } } : {});
        } catch (err) {
          // COUNT 失败 (如无权限): 有估算则保留估算, 否则"总数不可用"; 翻页仍可用 (分析师会议 #4)
          console.warn('count failed:', err);
          set((st) => st.paging ? { paging: { ...st.paging, total: st.paging.total, totalIsEstimate: st.paging.totalIsEstimate } } : {});
        }
      }

      // ④ 第 1 页数据
      const pageSql = buildTablePageSql(req, p.allColumns && p.allColumns.length ? p.allColumns : undefined);
      const res = await executeSqlWithGuard(activeConnId, pageSql, (payload) =>
        new Promise<boolean>((resolve) => {
          set({ pendingSafetyConfirm: { connId: activeConnId, sql: pageSql, payload, resolve } });
        })
      );
      // 列清单回填 (无 PK 时全列排序用)
      const allCols = (res?.columns || []).map((c: any) => c.name);
      set((st) => ({
        queryResult: res,
        isExecuting: false,
        paging: st.paging ? {
          ...st.paging,
          orderByColumns: pk,
          allColumns: allCols,
          currentPageSql: pageSql,
          loading: false,
        } : null,
      }));
    } catch (err: any) {
      set((st) => ({
        errorMsg: errToStr(err),
        isExecuting: false,
        paging: st.paging ? { ...st.paging, loading: false } : null,
      }));
    }
  },

  runQueryPaged: async (sql, pageSize) => {
    const { activeConnId } = get();
    if (!activeConnId) return;
    const cur = get().paging;
    const size = pageSize ?? (cur?.mode === 'sql' ? cur.pageSize : undefined) ?? 100;
    const built = buildHandwrittenPaging(sql, 1, size);

    if (!built.supported) {
      // 显式告知原因后按普通模式执行 (不静默降级 — 该弹错弹错语义)
      set({ errorMsg: null });
      console.warn('paging not supported:', built.reason);
      await get().runQuery(sql);
      return;
    }

    set({
      isExecuting: true,
      errorMsg: null,
      paging: {
        mode: 'sql',
        normalizedSql: built.normalizedSql,
        filters: [], combinator: 'AND',
        page: 1, pageSize: size,
        total: null, totalIsEstimate: false, loading: true,
        currentPageSql: built.pageSql!,
        strippedOwnLimit: built.strippedOwnLimit,
      },
    });

    try {
      // COUNT (子查询包裹) — 失败不阻塞翻页
      try {
        const cntRes = await executeSql(activeConnId, built.countSql!);
        const totalVal = cntRes?.rows?.[0]?.[0]?.val;
        const total = totalVal === null || totalVal === undefined ? null : Number(totalVal);
        set((st) => st.paging ? { paging: { ...st.paging, total: Number.isFinite(total as number) ? total : null } } : {});
      } catch (err) {
        console.warn('paged count failed:', err);
      }
      const res = await executeSqlWithGuard(activeConnId, built.pageSql!, (payload) =>
        new Promise<boolean>((resolve) => {
          set({ pendingSafetyConfirm: { connId: activeConnId, sql: built.pageSql!, payload, resolve } });
        })
      );
      set((st) => ({
        queryResult: res,
        isExecuting: false,
        paging: st.paging ? { ...st.paging, loading: false } : null,
      }));
    } catch (err: any) {
      set((st) => ({
        errorMsg: errToStr(err),
        isExecuting: false,
        paging: st.paging ? { ...st.paging, loading: false } : null,
      }));
    }
  },

  pagingGotoPage: async (page) => {
    const { activeConnId, paging } = get();
    if (!activeConnId || !paging || paging.loading) return;
    const target = Math.max(1, page);
    set((st) => st.paging ? { paging: { ...st.paging, loading: true }, isExecuting: true, errorMsg: null } : {});

    try {
      let pageSql: string;
      if (paging.mode === 'table') {
        pageSql = buildTablePageSql({
          schema: paging.schema!, table: paging.table!,
          filters: paging.filters, combinator: paging.combinator,
          orderByColumns: paging.orderByColumns || [],
          orderByDirection: paging.orderByDirection || 'ASC',
          page: target, pageSize: paging.pageSize,
        }, paging.allColumns && paging.allColumns.length ? paging.allColumns : undefined);
      } else {
        pageSql = buildHandwrittenPaging(paging.normalizedSql!, target, paging.pageSize).pageSql!;
      }
      const res = await executeSqlWithGuard(activeConnId, pageSql, (payload) =>
        new Promise<boolean>((resolve) => {
          set({ pendingSafetyConfirm: { connId: activeConnId, sql: pageSql, payload, resolve } });
        })
      );
      set((st) => ({
        queryResult: res,
        isExecuting: false,
        paging: st.paging ? { ...st.paging, page: target, currentPageSql: pageSql, loading: false } : null,
      }));
    } catch (err: any) {
      set((st) => ({
        errorMsg: errToStr(err),
        isExecuting: false,
        paging: st.paging ? { ...st.paging, loading: false } : null,
      }));
    }
  },

  pagingSetPageSize: async (size) => {
    const { paging, activeConnId } = get();
    if (!paging) return;
    set((st) => st.paging ? { paging: { ...st.paging, pageSize: size } } : {});
    // WP10-S6: table 模式记忆页大小
    if (paging.mode === 'table' && activeConnId) {
      saveBrowsePrefs(activeConnId, paging.schema!, paging.table!, {
        filters: paging.filters, combinator: paging.combinator, pageSize: size,
      });
    }
    await get().pagingGotoPage(1); // 改页大小回第 1 页
  },

  pagingSetFilters: async (filters, combinator) => {
    const { activeConnId, paging } = get();
    if (!activeConnId || !paging || paging.mode !== 'table') return;
    set((st) => st.paging ? { paging: { ...st.paging, filters, combinator, loading: true }, isExecuting: true, errorMsg: null } : {});
    try {
      const req = {
        schema: paging.schema!, table: paging.table!,
        filters, combinator,
        orderByColumns: paging.orderByColumns || [],
        orderByDirection: paging.orderByDirection || 'ASC',
        page: 1, pageSize: paging.pageSize,
      };
      // 过滤变更 → COUNT 重算 + 回第 1 页 (QA 矩阵第 5 条)
      let total = paging.total;
      try {
        const cntRes = await executeSql(activeConnId, buildTableCountSql(req));
        const v = cntRes?.rows?.[0]?.[0]?.val;
        total = v === null || v === undefined ? null : Number(v);
      } catch { /* 保留旧 total */ }
      const pageSql = buildTablePageSql(req, paging.allColumns && paging.allColumns.length ? paging.allColumns : undefined);
      const res = await executeSqlWithGuard(activeConnId, pageSql, (payload) =>
        new Promise<boolean>((resolve) => {
          set({ pendingSafetyConfirm: { connId: activeConnId, sql: pageSql, payload, resolve } });
        })
      );
      // WP10-S6: 记忆该表过滤偏好
      const pp = get().paging;
      if (pp?.mode === 'table') {
        saveBrowsePrefs(activeConnId, pp.schema!, pp.table!, { filters, combinator, pageSize: pp.pageSize });
      }
      set((st) => ({
        queryResult: res,
        isExecuting: false,
        paging: st.paging ? { ...st.paging, filters, combinator, page: 1, total, totalIsEstimate: false, currentPageSql: pageSql, loading: false } : null,
      }));
    } catch (err: any) {
      set((st) => ({
        errorMsg: errToStr(err),
        isExecuting: false,
        paging: st.paging ? { ...st.paging, loading: false } : null,
      }));
    }
  },

  pagingSetOrderBy: async (columns, direction) => {
    const { paging } = get();
    if (!paging) return;
    set((st) => st.paging ? { paging: { ...st.paging, orderByColumns: columns, orderByDirection: direction } } : {});
    await get().pagingGotoPage(1);
  },

  clearPaging: () => set({ paging: null }),
}));

