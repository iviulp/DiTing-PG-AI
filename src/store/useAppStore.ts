import { create } from 'zustand';
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
} from '../services/ipc';

/** WP1: 待确认的 Critical SQL (全局确认对话框状态) */
export interface PendingSafetyConfirm {
  connId: string;
  sql: string;
  payload: SafetyBlockedPayload;
  resolve: (approved: boolean) => void;
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
}


// WP6: 连接数据源 = 后端 vault (~/.aidb/connections.enc); 初始为空, bootstrapVaultData 拉取
export const useAppStore = create<AppState>((set, get) => ({
  connections: [],
  activeConnId: null,
  activeTab: 'editor',
  queryResult: null,
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
      set({ errorMsg: `配置迁移失败 (数据未丢失, 重启将重试): ${err.message || String(err)}` });
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
      set({ errorMsg: `加载连接列表失败: ${err.message || String(err)}` });
    }
  },

  addConnection: async (config) => {
    // WP6: 密码只经 vaultUpsertConnection 进加密存储; 连接测试走 conn_id (密码不回前端)
    let warnMsg: string | null = null;
    try {
      await vaultUpsertConnection(config);
    } catch (err: any) {
      set({ errorMsg: `保存连接失败: ${err.message || String(err)}` });
      return;
    }
    try {
      await vaultConnectDb(config.id);
    } catch (err: any) {
      warnMsg = `Connection saved with warning: ${err.message || String(err)}`;
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
      set({ errorMsg: `更新连接失败: ${err.message || String(err)}` });
      return;
    }
    try {
      await vaultConnectDb(config.id);
    } catch (err: any) {
      warnMsg = `Updated with warning: ${err.message || String(err)}`;
    }
    await get().refreshConnections();
    set({ errorMsg: warnMsg });
  },

  deleteConnection: async (id) => {
    try {
      await vaultDeleteConnection(id);
    } catch (err: any) {
      set({ errorMsg: `删除连接失败: ${err.message || String(err)}` });
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
      set({ errorMsg: err.message || String(err), isExecuting: false });
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
      set({ errorMsg: err.message || String(err) });
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
      throw new Error(err.message || String(err));
    }
  }
}));

