/**
 * WP9-P2-9: 快捷键与功能速查表 (新手画像: 三个月用一次, 每次都像第一次)
 * 单页纸弹窗 — 快捷键 + 核心功能入口导览
 */
import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: 'Cmd/Ctrl + Enter', desc: '执行编辑器中的 SQL（Monaco 焦点内或全局）' },
  { keys: 'Cmd/Ctrl + R', desc: '执行 SQL（全局兜底，任意焦点）' },
  { keys: 'Cmd/Ctrl + B', desc: '显示 / 隐藏 AI 协同侧栏' },
  { keys: 'Esc', desc: '关闭最上层弹窗（按打开优先级逐个关闭）' },
];

const TIPS: Array<{ icon: string; title: string; desc: string }> = [
  { icon: '🖱️', title: '双击网格单元格', desc: '进入单元格编辑；右键单元格可复制值 / 整行 CSV / 列名' },
  { icon: '📋', title: '网格粘贴造数', desc: '点击工具条"粘贴行"，从 Excel/表格复制的多行 TSV 自动按列对位入暂存区（表头自动跳过，列数不符会明示提示）' },
  { icon: '🔍', title: '列头筛选行', desc: '表头下方每列有筛选框，子串匹配（仅过滤已加载行）' },
  { icon: '🌲', title: 'Schema 树搜索', desc: '左树顶部过滤框即时筛选表/视图；单击表 = SELECT 前 100 行' },
  { icon: '🤖', title: 'AI 协同', desc: '@ 引用表名字段；SQL 块可覆盖/追加到编辑器或直接执行；报错横幅可让 AI 解释' },
  { icon: '👥', title: '用户管理', desc: '右键连接 → 用户管理：左侧面板可拖宽、可搜索、可按 SUPERUSER/可登录筛选；变更历史可导出审计' },
  { icon: '🔒', title: '安全管道', desc: '高危 SQL（DROP/TRUNCATE 等）后端 AST 判定并二次确认；只读模式强制 SELECT' },
  { icon: '📡', title: 'SSH 隧道', desc: '头部"隧道断开"角标可直接点击一键重连' },
];

export const ShortcutsHelpModal: React.FC<ShortcutsHelpModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#151821] border border-slate-700/80 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto text-slate-200 text-xs shadow-2xl font-sans"
        onClick={(e) => e.stopPropagation()}
        data-testid="shortcuts-help"
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-[#151821]">
          <span className="font-bold text-sm text-white flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-blue-400" />
            快捷键与功能速查
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <div className="text-[11px] font-bold text-slate-400 mb-2">⌨️ 键盘快捷键</div>
            <div className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center gap-3">
                  <kbd className="shrink-0 px-2 py-0.5 bg-slate-800 border border-slate-600 rounded text-[10px] font-mono text-amber-300 min-w-[110px] text-center">
                    {s.keys}
                  </kbd>
                  <span className="text-slate-300">{s.desc}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400 mb-2">💡 高频功能</div>
            <div className="space-y-2">
              {TIPS.map((t) => (
                <div key={t.title} className="flex gap-2 items-start">
                  <span className="shrink-0">{t.icon}</span>
                  <div>
                    <span className="font-semibold text-slate-200">{t.title}</span>
                    <span className="text-slate-400"> — {t.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
