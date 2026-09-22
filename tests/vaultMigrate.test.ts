/// WP6 T15: localStorage → vault 迁移顺序测试
/// 核心契约: vaultMigrateFromLocalStorage 成功才 removeItem 明文; 失败保留明文不删 (下次重启重试)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 整个 ipc 模块 (store 依赖)
vi.mock('../src/services/ipc', () => ({
  executeSqlWithGuard: vi.fn(),
  aiChat: vi.fn(),
  aiChatStream: vi.fn(),
  updateAiConfig: vi.fn(),
  getAiConfig: vi.fn(async () => ({
    provider_name: 'p',
    base_url: 'b',
    model_name: 'm',
    temperature: 0.2,
    has_key: false,
    key_tail4: ''
  })),
  vaultListConnections: vi.fn(async () => []),
  vaultUpsertConnection: vi.fn(async () => {}),
  vaultDeleteConnection: vi.fn(async () => {}),
  vaultConnectDb: vi.fn(async () => {}),
  vaultTestConnection: vi.fn(async () => {}),
  vaultMigrateFromLocalStorage: vi.fn(async () => ({ status: 'migrated', count: 1, dirty_skipped: 0 })),
  vaultExportBundle: vi.fn(async () => '/tmp/x.ditingvault')
}));

// zustand create 直通
vi.mock('zustand', () => ({
  create: (fn: any) => {
    const store: any = fn((partial: any) => {
      if (typeof partial === 'function') Object.assign(state, partial(state));
      else Object.assign(state, partial);
    }, () => state);
    const state = store;
    store.getState = () => state;
    store.setState = (partial: any) => {
      if (typeof partial === 'function') Object.assign(state, partial(state));
      else Object.assign(state, partial);
    };
    return store;
  }
}));

import * as ipc from '../src/services/ipc';
import { useAppStore } from '../src/store/useAppStore';

const migrate = ipc.vaultMigrateFromLocalStorage as unknown as ReturnType<typeof vi.fn>;
const list = ipc.vaultListConnections as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  list.mockResolvedValue([]);
});

describe('WP6 T15 迁移顺序', () => {
  it('成功迁移后才 removeItem 明文 + 写迁移标记', async () => {
    localStorage.setItem('aidb_connections', JSON.stringify([{ id: 'a', host: 'h' }]));
    migrate.mockResolvedValueOnce({ status: 'migrated', count: 1, dirty_skipped: 0 });

    await useAppStore.getState().bootstrapVaultData();

    expect(migrate).toHaveBeenCalledTimes(1);
    // 迁移成功后明文被清除
    expect(localStorage.getItem('aidb_connections')).toBeNull();
    expect(localStorage.getItem('aidb_vault_migrated')).toBe('1');
  });

  it('迁移失败 → 保留明文不删 + 设错误横幅 + 不写标记', async () => {
    localStorage.setItem('aidb_connections', JSON.stringify([{ id: 'a', host: 'h' }]));
    migrate.mockRejectedValueOnce(new Error('KEK 不可用'));

    await useAppStore.getState().bootstrapVaultData();

    // 失败: 明文必须保留 (下次重启重试)
    expect(localStorage.getItem('aidb_connections')).not.toBeNull();
    expect(localStorage.getItem('aidb_vault_migrated')).toBeNull();
    expect(useAppStore.getState().errorMsg).toContain('迁移失败');
  });

  it('已迁移标记存在 → 跳过迁移直接拉 vault 列表', async () => {
    localStorage.setItem('aidb_vault_migrated', '1');
    await useAppStore.getState().bootstrapVaultData();
    expect(migrate).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
  });

  it('无 localStorage 旧数据 → 不迁移, 直接写标记 + 拉列表', async () => {
    await useAppStore.getState().bootstrapVaultData();
    expect(migrate).not.toHaveBeenCalled();
    expect(localStorage.getItem('aidb_vault_migrated')).toBe('1');
    expect(list).toHaveBeenCalled();
  });

  it('脏数据计数透传到 errorMsg 提示', async () => {
    localStorage.setItem('aidb_connections', '[{"id":"a"}]');
    migrate.mockResolvedValueOnce({ status: 'migrated', count: 1, dirty_skipped: 2 });
    await useAppStore.getState().bootstrapVaultData();
    expect(useAppStore.getState().errorMsg).toContain('2 条脏数据被跳过');
  });
});
