/**
 * WP10-S4: 分页条 — 首页/上下页/末页/跳页/页大小/总数(精确-估算双态)/当前页SQL
 * 数据全部来自 store.paging 真实状态; 总数不可用时降级显示 (分析师会议 #4)
 */
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Database } from 'lucide-react';
import { PagingState, useAppStore } from '../store/useAppStore';
import { totalPages } from '../utils/browseSqlBuilder';

const PAGE_SIZES = [50, 100, 200, 500];

interface PaginationBarProps {
  paging: PagingState;
  /** 当前页实际行数 (渲染自 queryResult) */
  currentRowCount: number;
}

export const PaginationBar: React.FC<PaginationBarProps> = ({ paging, currentRowCount }) => {
  const pagingGotoPage = useAppStore((s) => s.pagingGotoPage);
  const pagingSetPageSize = useAppStore((s) => s.pagingSetPageSize);
  const [jumpText, setJumpText] = useState('');
  const [showSql, setShowSql] = useState(false);

  const knownTotal = paging.total !== null && !paging.totalIsEstimate;
  const pages = knownTotal ? totalPages(paging.total!, paging.pageSize) : null;
  const atFirst = paging.page <= 1;
  // 总数已知 → 与末页比较; 未知 → 本页不满即视为末页 (真实行数判断, 不猜测)
  const atLast = pages !== null ? paging.page >= pages : currentRowCount < paging.pageSize;

  const btnCls =
    'px-1.5 py-1 rounded bg-[#1a1d26] hover:bg-[#242a38] disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 border border-[#272d3b] transition-colors';

  const doJump = () => {
    const n = parseInt(jumpText, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const capped = pages !== null ? Math.min(n, pages) : n;
    pagingGotoPage(capped);
    setJumpText('');
  };

  return (
    <div className="border-t border-[#1c202a] bg-[#0f1116] px-3 py-1.5 flex items-center gap-2 text-[11px] text-slate-400 font-sans select-none shrink-0" data-testid="pagination-bar">
      <Database className="w-3.5 h-3.5 text-blue-400 shrink-0" />

      {/* 总数 (精确/估算双态) */}
      <span className="font-mono" data-testid="paging-total">
        {paging.total === null
          ? '总数不可用'
          : paging.totalIsEstimate
          ? `约 ${paging.total.toLocaleString()} 行 (估算)`
          : `共 ${paging.total!.toLocaleString()} 行`}
      </span>
      <span className="text-slate-600">|</span>

      {/* 翻页按钮组 */}
      <div className="flex items-center gap-1">
        <button className={btnCls} disabled={atFirst || paging.loading} onClick={() => pagingGotoPage(1)} title="首页" aria-label="首页">
          <ChevronsLeft className="w-3.5 h-3.5" />
        </button>
        <button className={btnCls} disabled={atFirst || paging.loading} onClick={() => pagingGotoPage(paging.page - 1)} title="上一页 (Cmd+←)" aria-label="上一页">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="px-1 font-mono text-slate-200" data-testid="paging-pageinfo">
          第 {paging.page}{pages !== null ? ` / ${pages}` : ''} 页
        </span>
        <button className={btnCls} disabled={atLast || paging.loading} onClick={() => pagingGotoPage(paging.page + 1)} title="下一页 (Cmd+→)" aria-label="下一页">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <button className={btnCls} disabled={atLast || pages === null || paging.loading} onClick={() => pagingGotoPage(pages!)} title="末页" aria-label="末页">
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 跳页 */}
      <span className="flex items-center gap-1">
        跳至
        <input
          type="text"
          inputMode="numeric"
          value={jumpText}
          onChange={(e) => setJumpText(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') doJump(); }}
          className="w-12 bg-[#1a1d26] border border-[#272d3b] rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-blue-500"
          aria-label="跳转到页"
          data-testid="paging-jump-input"
          placeholder={String(paging.page)}
        />
        <button className={btnCls + ' px-2'} onClick={doJump} disabled={paging.loading || !jumpText}>
          Go
        </button>
      </span>

      <span className="text-slate-600">|</span>

      {/* 页大小 */}
      <label className="flex items-center gap-1">
        每页
        <select
          value={paging.pageSize}
          onChange={(e) => pagingSetPageSize(Number(e.target.value))}
          disabled={paging.loading}
          className="bg-[#1a1d26] border border-[#272d3b] rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-blue-500"
          aria-label="每页行数"
          data-testid="paging-size-select"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>

      <span className="text-slate-600">|</span>
      <span className="font-mono" data-testid="paging-rowcount">本页 {currentRowCount} 行</span>

      {paging.strippedOwnLimit && (
        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[10px]" title="你 SQL 里自带的 LIMIT/OFFSET 已被剥离, 由分页接管">
          原 LIMIT 已接管
        </span>
      )}

      {/* 当前页真实 SQL (透明不黑盒 — 前端开发会议 #2) */}
      <button
        className="ml-auto px-1.5 py-0.5 rounded text-slate-500 hover:text-blue-300 hover:bg-[#1a1d26] transition-colors font-mono text-[10px]"
        onClick={() => setShowSql((v) => !v)}
        title="查看当前页真实执行的 SQL"
        data-testid="paging-sql-toggle"
      >
        {showSql ? '隐藏 SQL ▾' : '查看本页 SQL ▸'}
      </button>
      {showSql && paging.currentPageSql && (
        <span className="max-w-[380px] truncate font-mono text-[10px] text-emerald-400/90 bg-[#0a0c10] px-2 py-0.5 rounded border border-[#1c202a]" title={paging.currentPageSql} data-testid="paging-current-sql">
          {paging.currentPageSql}
        </span>
      )}
    </div>
  );
};
