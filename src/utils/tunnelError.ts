/// WP3 (Step 12): SSH 隧道错误码 → 用户友好中文文案映射
/// 与后端 src-tauri/src/services/tunnel_service.rs 的 tunnel_err 冻结清单保持一致

export type TunnelErrorCode =
  | 'TUNNEL_AUTH_FAILED'
  | 'TUNNEL_HOST_KEY_MISMATCH'
  | 'TUNNEL_CHANNEL_REFUSED'
  | 'TUNNEL_TIMEOUT'
  | 'TUNNEL_PORT_EXHAUSTED'
  | 'TUNNEL_OTP_FAILED'
  | 'TUNNEL_KEY_FILE_ERROR'
  | 'TUNNEL_INVALID_CONFIG'
  | 'TUNNEL_DISCONNECTED';

const TUNNEL_ERROR_MESSAGES: Record<string, string> = {
  TUNNEL_AUTH_FAILED: 'SSH 认证失败：用户名/密码/私钥或验证码不正确，请检查凭据。',
  TUNNEL_HOST_KEY_MISMATCH:
    'SSH 主机密钥已变更，可能存在中间人攻击。若确认服务器已重装，请在 known_hosts 中移除旧记录后重连。',
  TUNNEL_CHANNEL_REFUSED: 'SSH 服务器拒绝了端口转发（可能禁用了 AllowTcpForwarding）。',
  TUNNEL_TIMEOUT: 'SSH 连接/认证超时，请检查网络、主机地址与端口是否可达。',
  TUNNEL_PORT_EXHAUSTED: '本地端口分配失败，请关闭部分连接后重试。',
  TUNNEL_OTP_FAILED: 'OTP 验证码生成失败：Secret 非法或验证码已过期，请重新获取。',
  TUNNEL_KEY_FILE_ERROR: 'SSH 私钥读取失败：文件不存在、格式错误或 passphrase 不正确。',
  TUNNEL_INVALID_CONFIG: 'SSH 隧道配置不完整，请检查主机、用户、认证方式等必填项。',
  TUNNEL_DISCONNECTED: 'SSH 隧道已断开（远端关闭或网络中断），请重新连接。',
};

/** 将后端隧道错误码映射为中文提示; 未知码回退到原始 message */
export function mapTunnelError(code: string | undefined, fallbackMessage?: string): string {
  if (code && TUNNEL_ERROR_MESSAGES[code]) {
    return TUNNEL_ERROR_MESSAGES[code];
  }
  return fallbackMessage || 'SSH 隧道发生未知错误。';
}

/** 判断一个错误码是否属于隧道错误 (用于前端分类展示) */
export function isTunnelErrorCode(code: string | undefined): code is TunnelErrorCode {
  return !!code && code.startsWith('TUNNEL_');
}
