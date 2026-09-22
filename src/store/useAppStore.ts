import { create } from 'zustand';
import { ConnectionConfig, QueryResult, AiConfig, SafetyBlockedPayload } from '../types';
import { connectDb, executeSqlWithGuard, aiChat, updateAiConfig, getAiConfig } from '../services/ipc';

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
  askAi: (prompt: string, schemaContext?: string) => Promise<string>;
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
      localStorage.setItem('aidb_ai_config', JSON.stringify(config));
      await updateAiConfig(config);
      set({ aiConfig: config });
    } catch (err: any) {
      set({ errorMsg: err.message || String(err) });
    }
  },

  loadAiConfig: async () => {
    try {
      const cfg = await getAiConfig();
      if (cfg && cfg.api_key) {
        set({ aiConfig: cfg });
        localStorage.setItem('aidb_ai_config', JSON.stringify(cfg));
      } else {
        const localCfg = localStorage.getItem('aidb_ai_config');
        if (localCfg) {
          const parsed = JSON.parse(localCfg);
          set({ aiConfig: parsed });
          await updateAiConfig(parsed);
        }
      }
    } catch (err) {
      const localCfg = localStorage.getItem('aidb_ai_config');
      if (localCfg) {
        try {
          const parsed = JSON.parse(localCfg);
          set({ aiConfig: parsed });
        } catch {}
      }
    }
  },

  askAi: async (prompt, schemaContext) => {
    try {
      return await aiChat(prompt, schemaContext);
    } catch (err: any) {
      throw new Error(err.message || String(err));
    }
  }
}));

