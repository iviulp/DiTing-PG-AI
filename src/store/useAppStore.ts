import { create } from 'zustand';
import { ConnectionConfig, QueryResult, AiConfig } from '../types';
import { connectDb, executeSql, aiChat, updateAiConfig, getAiConfig } from '../services/ipc';

interface AppState {
  connections: ConnectionConfig[];
  activeConnId: string | null;
  activeTab: string;
  queryResult: QueryResult | null;
  aiConfig: AiConfig;
  isExecuting: boolean;
  errorMsg: string | null;

  // Actions
  addConnection: (config: ConnectionConfig) => Promise<void>;
  updateConnection: (config: ConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => void;
  setActiveConn: (id: string) => void;
  runQuery: (sql: string) => Promise<void>;
  setAiConfig: (config: AiConfig) => Promise<void>;
  loadAiConfig: () => Promise<void>;
  askAi: (prompt: string, schemaContext?: string) => Promise<string>;
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
      const res = await executeSql(activeConnId, sql);
      set({ queryResult: res, isExecuting: false });
    } catch (err: any) {
      set({ errorMsg: err.message || String(err), isExecuting: false });
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

