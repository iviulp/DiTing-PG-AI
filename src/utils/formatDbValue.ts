/// WP5 T11: DbValue 单点渲染工具 — 9 tag 全覆盖
/// 后端 DbValue 序列化为 { type: tag, val: payload } (serde tag/content)
/// 规则:
/// - Null → 'NULL' (网格判空哨兵, 与既有 isNull 逻辑对齐)
/// - Int/Float/StringDecimal → 原样字符串 (StringDecimal 高精度无损显示)
/// - Bool → 'true'/'false'
/// - Text/Json/Timestamp → 原样字符串
/// - BytesHex → '0x' 前缀 + 截断 (网格显示上限, 详情面板全量)
/// - decode error 文本 (<decode error: …>) 原样透出, 便于用户上报

import type { DbValue } from '../types';

const HEX_TRUNCATE_LEN = 64; // 32 字节

export function formatDbValue(cell: DbValue | null | undefined, opts?: { full?: boolean }): string {
  if (cell === null || cell === undefined) return 'NULL';
  const { type, val } = cell;
  switch (type) {
    case 'Null':
      return 'NULL';
    case 'Int':
    case 'Float':
    case 'StringDecimal':
      return val === null || val === undefined ? 'NULL' : String(val);
    case 'Bool':
      return val ? 'true' : 'false';
    case 'Text':
    case 'Json':
    case 'Timestamp':
      return val === null || val === undefined ? 'NULL' : String(val);
    case 'BytesHex': {
      const hex = val === null || val === undefined ? '' : String(val);
      if (!hex) return '0x';
      if (opts?.full) return `0x${hex}`; // 详情面板: 全量 hex 不截断
      return hex.length > HEX_TRUNCATE_LEN
        ? `0x${hex.slice(0, HEX_TRUNCATE_LEN)}…(${hex.length / 2}B)`
        : `0x${hex}`;
    }
    default:
      // 未知 tag: 保守透出
      return val === null || val === undefined ? 'NULL' : String(val);
  }
}

/** 判断单元格是否真 NULL (tag 级判定, 非 'NULL' 字符串比较) */
export function isDbValueNull(cell: DbValue | null | undefined): boolean {
  return cell === null || cell === undefined || cell.type === 'Null';
}
