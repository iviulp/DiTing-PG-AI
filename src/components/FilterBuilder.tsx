/**
 * WP10-S5: 可视化过滤构建器 — 列名下拉自动带出 (元数据), 操作符按列类型适配,
 * 值输入按类型特化 (bool 下拉 / BETWEEN 双框 / IN 标签式 / IS NULL 隐藏值框),
 * 底部实时预览生成的 WHERE SQL (新手会议: 点选即学 SQL)。
 * 所有值经 WP4 escapeSqlLiteral, 列名经 quoteIdentifier (注入免疫)。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Filter, Calendar } from 'lucide-react';
import { BrowseFilter, FilterCombinator, FilterOperator, buildWhere } from '../utils/browseSqlBuilder';

export interface ColumnMetaLite {
  column_name: string;
  data_type: string;
  column_comment?: string | null;
}

interface FilterBuilderProps {
  isOpen: boolean;
  onClose: () => void;
  /** 内联折叠面板模式 (嵌在 DataGrid 工具条下方展开, 无遮罩) — 用户要求就地填过滤信息 */
  inline?: boolean;
  /** 元数据自动带出 (getTableColumnsMetaData 结果) */
  columns: ColumnMetaLite[];
  initialFilters: BrowseFilter[];
  initialCombinator: FilterCombinator;
  /** 应用: 交给 store.pagingSetFilters (回第 1 页重查) */
  onApply: (filters: BrowseFilter[], combinator: FilterCombinator) => void;
}

type ColKind = 'text' | 'number' | 'bool' | 'time' | 'json' | 'other';

function kindOf(dataType: string): ColKind {
  const t = (dataType || '').toLowerCase();
  if (/(int|numeric|decimal|real|double|money|oid|serial)/.test(t)) return 'number';
  if (/^bool/.test(t)) return 'bool';
  if (/(timestamp|date|time|interval)/.test(t)) return 'time';
  if (/json/.test(t)) return 'json';
  if (/(char|text|uuid|enum|name|inet|cidr|macaddr)/.test(t)) return 'text';
  return 'other';
}

const OPS_BY_KIND: Record<ColKind, FilterOperator[]> = {
  text: ['=', '!=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'],
  number: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL'],
  bool: ['=', 'IS NULL', 'IS NOT NULL'],
  time: ['=', '>', '>=', '<', '<=', 'BETWEEN', 'IS NULL', 'IS NOT NULL'],
  json: ['=', '@>', '?', 'IS NULL', 'IS NOT NULL'],
  other: ['=', '!=', 'IS NULL', 'IS NOT NULL'],
};

const NO_VALUE_OPS: FilterOperator[] = ['IS NULL', 'IS NOT NULL'];

/** 时间快捷按钮 → 真实边界值 (数据科学家会议 #2) */
function timeShortcut(kind: 'today' | '7d' | 'month'): [string, string] {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === 'today') return [fmt(startOfDay), fmt(new Date(startOfDay.getTime() + 86400000 - 1))];
  if (kind === '7d') return [fmt(new Date(startOfDay.getTime() - 6 * 86400000)), fmt(new Date(startOfDay.getTime() + 86400000 - 1))];
  return [fmt(new Date(now.getFullYear(), now.getMonth(), 1)), fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
}

interface DraftRow {
  id: number;
  column: string;
  operator: FilterOperator;
  valueText: string;       // 单值 / json 值 / 键名
  value2Text: string;      // BETWEEN 上界
  inTags: string[];        // IN 标签
  inInput: string;
}

let draftSeq = 1;

export const FilterBuilder: React.FC<FilterBuilderProps> = ({
  isOpen, onClose, columns, initialFilters, initialCombinator, onApply, inline = false,
}) => {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [combinator, setCombinator] = useState<FilterCombinator>(initialCombinator);
  const [buildError, setBuildError] = useState<string | null>(null);

  // 打开时用现有 filters 初始化草稿 (再次编辑场景)
  useEffect(() => {
    if (!isOpen) return;
    setBuildError(null);
    setCombinator(initialCombinator);
    setRows(
      initialFilters.length > 0
        ? initialFilters.map((f) => ({
            id: draftSeq++,
            column: f.column,
            operator: f.operator,
            valueText:
              f.operator === 'BETWEEN' && Array.isArray(f.value) ? String(f.value[0]) :
              f.operator === 'IN' || f.operator === 'NOT IN' ? '' :
              typeof f.value === 'string' ? f.value : '',
            value2Text: f.operator === 'BETWEEN' && Array.isArray(f.value) ? String(f.value[1]) : '',
            inTags: (f.operator === 'IN' || f.operator === 'NOT IN') && Array.isArray(f.value) ? [...f.value] : [],
            inInput: '',
          }))
        : columns.length > 0
        ? [{ id: draftSeq++, column: columns[0].column_name, operator: '=', valueText: '', value2Text: '', inTags: [], inInput: '' }]
        : []
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const metaOf = useMemo(() => {
    const m = new Map<string, ColumnMetaLite>();
    columns.forEach((c) => m.set(c.column_name, c));
    return m;
  }, [columns]);

  const patchRow = (id: number, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const changeColumn = (id: number, col: string) => {
    const meta = metaOf.get(col);
    const kind = meta ? kindOf(meta.data_type) : 'other';
    const ops = OPS_BY_KIND[kind];
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const nextOp = ops.includes(r.operator) ? r.operator : ops[0];
      return { ...r, column: col, operator: nextOp, valueText: nextOp === '=' && kind === 'bool' ? 'true' : r.valueText };
    }));
  };

  const toFilters = (): BrowseFilter[] => {
    return rows.map((r) => {
      if (NO_VALUE_OPS.includes(r.operator)) return { column: r.column, operator: r.operator };
      if (r.operator === 'IN' || r.operator === 'NOT IN') {
        return { column: r.column, operator: r.operator, value: [...r.inTags] };
      }
      if (r.operator === 'BETWEEN') {
        return { column: r.column, operator: r.operator, value: [r.valueText, r.value2Text] as [string, string] };
      }
      return { column: r.column, operator: r.operator, value: r.valueText };
    });
  };

  // 实时 SQL 预览 (构建失败显示真实原因 — 不静默)
  const preview = useMemo(() => {
    try {
      const w = buildWhere(toFilters(), combinator);
      return { sql: w, error: null as string | null };
    } catch (e: any) {
      return { sql: '', error: e?.message || String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, combinator]);

  // WP8 教训: 所有 hooks (useState/useEffect/useMemo) 必须无条件执行完毕后才能早返回
  if (!isOpen) return null;

  const handleApply = () => {
    if (preview.error) { setBuildError(preview.error); return; }
    setBuildError(null);
    onApply(toFilters(), combinator);
    onClose();
  };

  // 内联模式: 就地展开的折叠面板 (用户 2026-09-23 反馈: 点过滤直接在这里填, 不要弹窗)
  if (inline) {
    return (
      <div
        className="bg-[#151821] border-b-2 border-purple-500/40 w-full max-h-[50vh] overflow-auto flex flex-col font-sans text-xs text-slate-200"
        data-testid="filter-builder"
      >
        {renderInner()}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 bg-black/40 backdrop-blur-[1px] flex items-start justify-center pt-8" onClick={onClose}>
      <div
        className="bg-[#151821] border border-slate-700/80 rounded-2xl w-full max-w-2xl max-h-[80%] overflow-hidden shadow-2xl flex flex-col font-sans text-xs text-slate-200"
        onClick={(e) => e.stopPropagation()}
        data-testid="filter-builder"
      >
        {renderInner()}
      </div>
    </div>
  );

  // 共用主体 (头/条件行/预览/按钮) — inline 与弹窗两种容器复用
  function renderInner() {
    return (
      <>
        {/* 头 */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-[#181b22]">
          <span className="font-bold text-sm text-white flex items-center gap-2">
            <Filter className="w-4 h-4 text-blue-400" />
            过滤条件构建器
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              条件组合
              <select
                value={combinator}
                onChange={(e) => setCombinator(e.target.value as FilterCombinator)}
                className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-blue-500"
                data-testid="fb-combinator"
              >
                <option value="AND">AND (全部满足)</option>
                <option value="OR">OR (任一满足)</option>
              </select>
            </label>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1" aria-label="关闭">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 条件行 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {columns.length === 0 && (
            <div className="text-slate-500 text-center py-6">
              未获取到列元数据 — 无法自动带出列名。请先确认连接正常后重新打开。
            </div>
          )}
          {rows.map((r) => {
            const meta = metaOf.get(r.column);
            const kind = meta ? kindOf(meta.data_type) : 'other';
            const ops = OPS_BY_KIND[kind];
            const needValue = !NO_VALUE_OPS.includes(r.operator);
            const needSecond = r.operator === 'BETWEEN';
            const isMulti = r.operator === 'IN' || r.operator === 'NOT IN';
            return (
              <div key={r.id} className="flex items-center gap-1.5 bg-[#12141a] border border-slate-800 rounded-xl px-2 py-1.5" data-testid="fb-row">
                {/* 列 (自动带出: 名称+类型+注释) */}
                <select
                  value={r.column}
                  onChange={(e) => changeColumn(r.id, e.target.value)}
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-blue-500 max-w-[160px]"
                  aria-label="过滤列"
                >
                  {columns.map((c) => (
                    <option key={c.column_name} value={c.column_name}>
                      {c.column_name} ({c.data_type}){c.column_comment ? ` — ${c.column_comment}` : ''}
                    </option>
                  ))}
                </select>

                {/* 操作符 (按类型适配) */}
                <select
                  value={r.operator}
                  onChange={(e) => patchRow(r.id, { operator: e.target.value as FilterOperator })}
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-blue-500 w-[110px]"
                  aria-label="操作符"
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>

                {/* 值输入 (类型特化) */}
                {needValue && !isMulti && kind === 'bool' && (
                  <select
                    value={r.valueText || 'true'}
                    onChange={(e) => patchRow(r.id, { valueText: e.target.value })}
                    className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-mono text-emerald-300 focus:outline-none focus:border-blue-500 w-[80px]"
                    aria-label="布尔值"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                )}
                {needValue && !isMulti && kind !== 'bool' && (
                  <input
                    type="text"
                    value={r.valueText}
                    onChange={(e) => patchRow(r.id, { valueText: e.target.value })}
                    placeholder={kind === 'time' ? '2026-01-01 / 2026-01-01 00:00' : kind === 'json' ? (r.operator === '?' ? '键名' : '{"key": "value"}') : '值'}
                    className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-mono text-emerald-300 focus:outline-none focus:border-blue-500 flex-1 min-w-[100px]"
                    aria-label="过滤值"
                    spellCheck={false}
                  />
                )}
                {needSecond && (
                  <>
                    <span className="text-slate-500">~</span>
                    <input
                      type="text"
                      value={r.value2Text}
                      onChange={(e) => patchRow(r.id, { value2Text: e.target.value })}
                      placeholder="上界"
                      className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] font-mono text-emerald-300 focus:outline-none focus:border-blue-500 w-[100px]"
                      aria-label="BETWEEN 上界"
                      spellCheck={false}
                    />
                  </>
                )}
                {isMulti && (
                  <div className="flex-1 min-w-[140px] flex flex-wrap items-center gap-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-1">
                    {r.inTags.map((tag, i) => (
                      <span key={i} className="px-1.5 py-0.5 bg-blue-600/25 border border-blue-500/40 rounded text-[10px] font-mono text-blue-300 flex items-center gap-1">
                        {tag}
                        <button
                          onClick={() => patchRow(r.id, { inTags: r.inTags.filter((_, j) => j !== i) })}
                          className="text-blue-400 hover:text-white"
                          aria-label={`移除 ${tag}`}
                        >×</button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={r.inInput}
                      onChange={(e) => patchRow(r.id, { inInput: e.target.value })}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ',') && r.inInput.trim()) {
                          patchRow(r.id, { inTags: [...r.inTags, r.inInput.trim()], inInput: '' });
                        }
                      }}
                      placeholder="输入后回车添加"
                      className="flex-1 min-w-[80px] bg-transparent text-[11px] font-mono text-emerald-300 focus:outline-none"
                      aria-label="IN 值输入"
                      spellCheck={false}
                    />
                  </div>
                )}

                {/* 时间快捷按钮 */}
                {kind === 'time' && needValue && (
                  <div className="flex gap-0.5 shrink-0">
                    {([['今天', 'today'], ['近7天', '7d'], ['本月', 'month']] as const).map(([label, k]) => (
                      <button
                        key={k}
                        onClick={() => {
                          const [a, b] = timeShortcut(k);
                          patchRow(r.id, r.operator === 'BETWEEN' ? { valueText: a, value2Text: b } : { operator: 'BETWEEN', valueText: a, value2Text: b });
                        }}
                        className="px-1 py-0.5 rounded bg-slate-800 hover:bg-blue-600/40 text-slate-400 hover:text-blue-300 text-[9px] border border-slate-700 flex items-center gap-0.5"
                        title={`BETWEEN ${label} (生成真实日期边界)`}
                      >
                        <Calendar className="w-2.5 h-2.5" />{label}
                      </button>
                    ))}
                  </div>
                )}

                {/* 删除行 */}
                <button
                  onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
                  className="p-1 text-slate-500 hover:text-red-400 shrink-0"
                  aria-label="删除条件"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}

          {columns.length > 0 && (
            <button
              onClick={() => setRows((prev) => [...prev, { id: draftSeq++, column: columns[0].column_name, operator: '=', valueText: '', value2Text: '', inTags: [], inInput: '' }])}
              className="px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 text-[11px] font-semibold flex items-center gap-1 border border-blue-500/30 transition-colors"
              data-testid="fb-add-row"
            >
              <Plus className="w-3 h-3" /> 添加条件
            </button>
          )}
        </div>

        {/* SQL 实时预览 (新手会议: 点选即学 SQL) */}
        <div className="border-t border-slate-800 px-3 py-2 bg-[#0d0f14]">
          <div className="text-[9px] text-slate-500 mb-1 font-semibold">生成的 WHERE (实时预览):</div>
          {preview.error ? (
            <div className="font-mono text-[10px] text-red-400 break-all" data-testid="fb-preview-error">⚠️ {preview.error}</div>
          ) : (
            <div className="font-mono text-[10px] text-emerald-300/90 break-all min-h-[14px]" data-testid="fb-preview">
              {preview.sql || <span className="text-slate-600">(无条件 — 将查询全部行)</span>}
            </div>
          )}
          {(rows.some((r) => r.operator === '!=')) && (
            <div className="text-[9px] text-amber-400/80 mt-1">💡 注意: SQL 的 ≠ 不匹配 NULL 行</div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-3 py-2.5 border-t border-slate-800 flex justify-between items-center bg-[#151821]">
          <span className="text-[10px] text-red-400 font-mono break-all max-w-[60%]">{buildError}</span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => { setRows([]); setBuildError(null); }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold"
              data-testid="fb-clear"
            >
              清除全部
            </button>
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold">
              取消
            </button>
            <button
              onClick={handleApply}
              disabled={!!preview.error}
              className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-bold shadow transition-colors"
              data-testid="fb-apply"
            >
              应用过滤
            </button>
          </div>
        </div>
      </>
    );
  }
};
