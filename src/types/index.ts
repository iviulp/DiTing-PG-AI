export type DatabaseType = 'postgres' | 'mysql' | 'sqlite';

export interface ColumnMetadata {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
}

export interface DbValue {
  type: 'Null' | 'Int' | 'Float' | 'StringDecimal' | 'Bool' | 'Text' | 'Json' | 'BytesHex' | 'Timestamp';
  val: any;
}

export interface QueryResult {
  columns: ColumnMetadata[];
  rows: DbValue[][];
  rows_affected: number;
  elapsed_ms: number;
  is_read_only: boolean;
}

export interface QueryResultTabItem {
  id: string;
  title: string;
  sql: string;
  result: QueryResult | null;
  error?: string | null;
}

export interface SchemaItem {
  name: string;
  item_type: 'table' | 'view' | 'function';
  schema_name: string;
  comment?: string;
}

export interface TableColumnDetail {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  default_val?: string;
  comment?: string;
}

export interface ProcessItem {
  pid: number;
  user: string;
  db: string;
  client_ip?: string;
  query: string;
  state: string;
  duration_seconds: number;
}

export interface SshTunnelConfig {
  enabled: boolean;
  // 模式：单跳 SSH 代理 或 堡垒机二级跳板 (Double-Hop / Jump Server)
  tunnel_type: 'direct' | 'bastion_jump';
  
  // 第一重：堡垒机 / 跳板机 (Bastion Server / Jump Host)
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  auth_type: 'password' | 'private_key';
  ssh_password?: string;
  ssh_private_key_path?: string;
  passphrase?: string;
  otp_secret?: string;
  otp_code?: string;

  // 第二重：目标内网中转机器 (Target Internal Host - 堡垒机登录后才能访问的机器)
  target_ssh_host?: string;
  target_ssh_port?: number;
  target_ssh_user?: string;
  target_auth_type?: 'password' | 'private_key';
  target_ssh_password?: string;
  target_ssh_private_key_path?: string;
}



export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: DatabaseType;
  group_name?: string;
  color_label?: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  schema?: string;
  env_tag?: 'PROD' | 'DEV' | 'TEST';
  ssl_mode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  read_only: boolean;
  ssh_tunnel?: SshTunnelConfig;
}

export interface AiConfig {
  provider_name: string;
  base_url: string;
  api_key: string;
  model_name: string;
  temperature: number;
}

export interface SavedSqlSnippet {
  id: string;
  conn_id: string;
  title: string;
  sql: string;
  database?: string;
  description?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  last_executed_at?: string;
}
