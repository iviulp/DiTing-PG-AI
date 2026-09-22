import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig, QueryResult, AiConfig, SafetyBlockedPayload } from '../types';

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
 * 触发 AI Agent 自然语言问答转 SQL
 */
export async function aiChat(prompt: string, schemaContext?: string): Promise<string> {
  return await invoke('ai_chat', { prompt, schemaContext });
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

export async function getTableColumnsMetaData(connId: string, tableName: string): Promise<any[]> {
  const sql = `
    SELECT 
      c.column_name, 
      c.data_type, 
      c.is_nullable,
      pg_catalog.col_description(format('%s.%s', c.table_schema, c.table_name)::regclass::oid, c.ordinal_position) as column_comment
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = '${tableName}'
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
 * 导出经过高强加密的数据库连接与 AI 配置数据包
 */
export async function exportEncryptedBundle(
  connectionsJson: string,
  aiConfigJson: string,
  saveDir?: string | null
): Promise<string> {
  return await invoke('export_encrypted_bundle', {
    connectionsJson,
    aiConfigJson,
    saveDir: saveDir || null,
  });
}

/**
 * 导入加密数据包并自动解密 (密码: yuguosheng)
 */
export async function importEncryptedBundle(fileContent: string): Promise<any> {
  return await invoke('import_encrypted_bundle', { fileContent });
}




