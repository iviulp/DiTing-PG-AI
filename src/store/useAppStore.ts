import { create } from 'zustand';
import { ConnectionConfig, QueryResult, AiConfig, SafetyBlockedPayload } from '../types';
import {
  connectDb,
  executeSqlWithGuard,
  aiChat,
  aiChatStream,
  ChatMessage,
  updateAiConfig,
  getAiConfig
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
  addConnection: (config: ConnectionConfig) => Promise<void>;
  updateConnection: (config: ConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => void;
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


const DEFAULT_CONNECTIONS: ConnectionConfig[] = [];

const savedConns = localStorage.getItem('aidb_connections');
const initialConnections = savedConns ? JSON.parse(savedConns) : DEFAULT_CONNECTIONS;

export const useAppStore = create<AppState>((set, get) => ({
  connections: initialConnections,
  activeConnId: initialConnections[0]?.id || null,
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

  addConnection: async (config) => {
    try {
      await connectDb(config);
      set((state) => {
        const next = [...state.connections, config];
        localStorage.setItem('aidb_connections', JSON.stringify(next));
        return {
          connections: next,
          activeConnId: config.id,
          errorMsg: null
        };
      });
    } catch (err: any) {
      set((state) => {
        const next = [...state.connections, config];
        localStorage.setItem('aidb_connections', JSON.stringify(next));
        return {
          connections: next,
          activeConnId: config.id,
          errorMsg: `Connection saved with warning: ${err.message || String(err)}`
        };
      });
    }
  },

  updateConnection: async (config) => {
    try {
      await connectDb(config);
      set((state) => {
        const next = state.connections.map((c) => (c.id === config.id ? config : c));
        localStorage.setItem('aidb_connections', JSON.stringify(next));
        return {
          connections: next,
          errorMsg: null
        };
      });
    } catch (err: any) {
      set((state) => {
        const next = state.connections.map((c) => (c.id === config.id ? config : c));
        localStorage.setItem('aidb_connections', JSON.stringify(next));
        return {
          connections: next,
          errorMsg: `Updated with warning: ${err.message || String(err)}`
        };
      });
    }
  },

  deleteConnection: (id) => {
    set((state) => {
      const next = state.connections.filter((c) => c.id !== id);
      localStorage.setItem('aidb_connections', JSON.stringify(next));
      return {
        connections: next,
        activeConnId: state.activeConnId === id ? (next[0]?.id || null) : state.activeConnId
      };
    });
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

