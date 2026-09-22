import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ConnectionConfig, QueryResult, AiConfig, SafetyBlockedPayload } from '../types';
import { escapeSqlLiteral } from '../utils/sqlEscape';

/**
 * 建立与注册数据库连接
 */
export async function connectDb(config: ConnectionConfig): Promise<void> {
  return await invoke('connect_db', { config });
}

/**
 * 执行任意 SQL 语句并获取强类型结果集 (低层原语)
 * WP1: force=true 表示用户已确认 Critical 风险, 仅豁免确认策略, 不豁免 read_only
 */
export async function executeSql(connId: string, sql: string, force?: boolean): Promise<QueryResult> {
  return await invoke('execute_sql', { connId, sql, force: force ?? null });
}

/** 判断 invoke 错误是否为需二次确认的 Critical 安全拦截 */
export function isSafetyConfirmationError(err: any): err is SafetyBlockedPayload {
  return (
    err &&
    typeof err === 'object' &&
    err.code === 'SAFETY_BLOCKED' &&
    err.requires_confirmation === true
  );
}

/**
 * WP1: 带 Critical 二次确认语义的统一执行封装 (唯一入口, 安全判定以后端为准)
 * 流程: executeSql → 后端返回 SAFETY_BLOCKED+requires_confirmation → confirm(payload)
 *       用户同意后携带原始 SQL (一字不改) + force=true 重发; 拒绝则抛出原错误。
 * read_only 拦截 (无 requires_confirmation) 直接 throw, 不提供 force 通道。
 */
export async function executeSqlWithGuard(
  connId: string,
  sql: string,
  confirm: (payload: SafetyBlockedPayload) => Promise<boolean>
): Promise<QueryResult> {
  try {
    return await executeSql(connId, sql);
  } catch (err) {
    if (isSafetyConfirmationError(err)) {
      const approved = await confirm(err as SafetyBlockedPayload);
      if (approved) {
        // SEC 决议: 原始 sql 字符串原样重发, 前端不得改写
        return await executeSql(connId, sql, true);
      }
    }
    throw err;
  }
}

/**
 * 触发 AI Agent 自然语言问答转 SQL (WP2: 支持多轮 history; 保留为流式降级 fallback)
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** WP3: 隧道状态 (后端 TunnelState serde tag 形式) */
export type TunnelState =
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | { state: 'authenticating' }
  | { state: 'forwarding' }
  | { state: 'closing' }
  | { state: 'failed'; code: string; message: string };

export async function getTunnelState(connId: string): Promise<TunnelState> {
  return await invoke('get_tunnel_state', { connId });
}

export async function closeTunnel(connId: string): Promise<void> {
  await invoke('close_tunnel', { connId });
}

/** WP3: 订阅隧道被动断开事件 (后端 emit "tunnel-disconnected", payload = conn_id) */
export function onTunnelDisconnected(cb: (connId: string) => void): () => void {
  const unlistenPromise = listen<string>('tunnel-disconnected', (event) => {
    cb(event.payload);
  });
  return () => {
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
  };
}

export async function aiChat(prompt: string, schemaContext?: string, history?: ChatMessage[]): Promise<string> {
  return await invoke('ai_chat', { prompt, schemaContext, history: history ?? null });
}

/** WP2: 流式事件 (与后端 StreamEvent serde camelCase 对齐) */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string };

/**
 * WP2: AI 流式对话 — Tauri Channel 逐 delta 回调, resolve 完整文本;
 * 后端返回 error 事件时 reject, 由调用方决定是否降级 aiChat。
 */
export async function aiChatStream(
  prompt: string,
  schemaContext: string | undefined,
  history: ChatMessage[] | undefined,
  onDelta: (text: string) => void
): Promise<string> {
  const channel = new Channel<AiStreamEvent>();
  return await new Promise<string>((resolve, reject) => {
    channel.onmessage = (msg) => {
      if (msg.type === 'delta') {
        onDelta(msg.text);
      } else if (msg.type === 'done') {
        resolve(msg.fullText);
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    };
    invoke('ai_chat_stream', { prompt, schemaContext, history: history ?? null, channel }).catch(reject);
  });
}

/**
 * 更新自定义 AI Provider (BaseURL / Key) 配置
 */
export async function updateAiConfig(config: AiConfig): Promise<void> {
  return await invoke('update_ai_config', { config });
}

/**
 * 获取当前 AI Provider 配置
 */
export async function getAiConfig(): Promise<AiConfig> {
  return await invoke('get_ai_config');
}

export async function getTableSchema(connId: string): Promise<any[]> {
  return await invoke('get_table_schema', { connId });
}

/**
 * WP4 步骤4: 取表列元数据 (含注释)。
 * - schema 参数化 (默认 public), 支持多 schema 同名表
 * - WHERE 两个条件值过 escapeSqlLiteral (消除 tableName 注入面)
 * - col_description 改用 format('%I.%I', ...)::regclass (原 %s.%s 不加引号, 特殊标识符会解析错)
 */
export async function getTableColumnsMetaData(
  connId: string,
  tableName: string,
  schemaName: string = 'public'
): Promise<any[]> {
  const safeTable = escapeSqlLiteral(tableName);
  const safeSchema = escapeSqlLiteral(schemaName);
  const sql = `
    SELECT 
      c.column_name, 
      c.data_type, 
      c.is_nullable,
      pg_catalog.col_description(format('%I.%I', c.table_schema, c.table_name)::regclass::oid, c.ordinal_position) as column_comment
    FROM information_schema.columns c
    WHERE c.table_schema = '${safeSchema}' AND c.table_name = '${safeTable}'
    ORDER BY c.ordinal_position;
  `;
  try {
    const res: QueryResult = await invoke('execute_sql', { connId, sql });
    if (res && res.rows) {
      return res.rows.map((row) => ({
        column_name: String(row[0]?.val || ''),
        data_type: String(row[1]?.val || ''),
        is_nullable: String(row[2]?.val || ''),
        comment: String(row[3]?.val || ''),
      }));
    }
  } catch (err) {
    console.warn('Failed to query detailed column comments for table:', tableName, err);
  }
  return [];
}

export async function getProcessList(connId: string): Promise<any[]> {
  return await invoke('get_process_list', { connId });
}

export async function getDbUsers(connId: string): Promise<any[]> {
  return await invoke('get_db_users', { connId });
}


export async function killProcess(connId: string, pid: number): Promise<void> {
  return await invoke('kill_process', { connId, pid });
}

export async function openDownloadsFolder(dirPath?: string | null): Promise<void> {
  return await invoke('open_downloads_folder', { dirPath: dirPath || null });
}


/**
 * 原生唤起系统文件夹选择窗口
 */
export async function selectSaveDir(): Promise<string | null> {
  return await invoke('open_file_dialog');
}

/**
 * 将导出内容直接落盘写入用户选择的指定文件夹路径
 */
export async function saveFileDirectly(dirPath: string | null, fileName: string, content: string): Promise<string> {
  return await invoke('save_file_directly', { dirPath, fileName, content });
}

/**
 * WP6: 导出 v2 加密备份 (用户主密码 ≥8 位; 不再使用内置固定密钥)
 */
export async function exportEncryptedBundle(
  connectionsJson: string,
  aiConfigJson: string,
  masterPassword: string,
  saveDir?: string | null
): Promise<string> {
  return await invoke('export_encrypted_bundle', {
    connectionsJson,
    aiConfigJson,
    masterPassword,
    saveDir: saveDir || null,
  });
}

/**
 * WP6: 导入加密备份 — v2 需主密码; legacy v1 自动用旧密钥解密并返回 legacy_import:true
 */
export async function importEncryptedBundle(
  fileContent: string,
  masterPassword?: string | null
): Promise<any> {
  return await invoke('import_encrypted_bundle', {
    fileContent,
    masterPassword: masterPassword ?? null,
  });
}

// ============ WP6: Vault 命令 (密码永不出 Rust 边界) ============

/** 列出脱敏连接视图 (password_set 标记; 无明文密码) */
export async function vaultListConnections(): Promise<ConnectionConfig[]> {
  return await invoke('vault_list_connections');
}

/** 保存/更新连接 (加密落盘; 编辑时密码留空 → 后端保留原密码) */
export async function vaultUpsertConnection(config: ConnectionConfig): Promise<void> {
  return await invoke('vault_upsert_connection', { config });
}

/** 删除连接 */
export async function vaultDeleteConnection(connId: string): Promise<void> {
  return await invoke('vault_delete_connection', { connId });
}

/** WP6-S6: 按 conn_id 连接 — 后端从 vault 取真实密码 */
export async function vaultConnectDb(connId: string): Promise<void> {
  return await invoke('vault_connect_db', { connId });
}

/** WP6-S6: 一次性测试通道 (保存前测试; 密码留空自动合并 vault 原密码) */
export async function vaultTestConnection(config: ConnectionConfig): Promise<void> {
  return await invoke('vault_test_connection', { config });
}

export interface MigrateOutcome {
  status: 'already_migrated' | 'migrated';
  count?: number;
  dirty_skipped?: number;
}

/** WP6-S7: 后端组装 payload (真实密码不出 Rust) → v2 主密码加密导出 */
export async function vaultExportBundle(
  masterPassword: string,
  saveDir?: string | null
): Promise<string> {
  return await invoke('vault_export_bundle', {
    masterPassword,
    saveDir: saveDir ?? null,
  });
}

/** WP6-S5: localStorage → vault 幂等迁移 */
export async function vaultMigrateFromLocalStorage(
  connectionsJson: string,
  aiConfigJson?: string | null
): Promise<MigrateOutcome> {
  return await invoke('vault_migrate_from_localstorage', {
    connectionsJson,
    aiConfigJson: aiConfigJson ?? null,
  });
}




