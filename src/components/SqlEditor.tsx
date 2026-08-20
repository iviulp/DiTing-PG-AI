import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { Play, CheckCircle2 } from 'lucide-react';

interface SqlEditorProps {
  value: string;
  onChange: (val: string) => void;
  onExecute: (selectedSql?: string) => void;
}

/**
 * 高性能 Monaco SQL 编辑器组件
 * 支持选中任意 SQL 文本右键或 ⌘Enter 仅执行选中 SQL / 全量执行
 */
export const SqlEditor: React.FC<SqlEditorProps> = ({ value, onChange, onExecute }) => {
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const [selectedText, setSelectedText] = useState<string>('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;

  const valueRef = useRef(value);
  valueRef.current = value;

  // 点击外侧关闭右键菜单
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const handleEditorMount = (editor: any, monaco: any) => {
    setEditorInstance(editor);

    // 监听选区变动
    editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (selection && model && !selection.isEmpty()) {
        const text = model.getValueInRange(selection);
        setSelectedText(text.trim());
      } else {
        setSelectedText('');
      }
    });

    // 绑定 ⌘Enter / Ctrl+Enter 快捷键：有选区则优先执行选中的 SQL，否则全量执行
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      let sqlToRun = '';
      if (selection && model && !selection.isEmpty()) {
        sqlToRun = model.getValueInRange(selection).trim();
      }
      const currentFullText = editor.getValue();
      onExecuteRef.current(sqlToRun || currentFullText || undefined);
    });

    // 注册右键菜单项目 (Monaco Context Menu Actions)
    editor.addAction({
      id: 'execute-selected-sql',
      label: '▶ 执行选中的 SQL (Run Selected SQL)',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: (ed: any) => {
        const selection = ed.getSelection();
        const model = ed.getModel();
        let sqlToRun = '';
        if (selection && model && !selection.isEmpty()) {
          sqlToRun = model.getValueInRange(selection).trim();
        }
        if (!sqlToRun) {
          alert('💡 提示：当前未选中任何 SQL 代码，请先用鼠标高亮选中需要单独执行的 SQL 语句！');
          return;
        }
        onExecuteRef.current(sqlToRun);
      }
    });

    editor.addAction({
      id: 'execute-all-sql',
      label: '⚡ 执行全部 SQL (Run All SQL Statements)',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: (ed: any) => {
        const fullSql = ed.getValue();
        onExecuteRef.current(fullSql);
      }
    });
  };

  const handleRunSelected = () => {
    if (selectedText) {
      onExecuteRef.current(selectedText);
    } else if (editorInstance) {
      const selection = editorInstance.getSelection();
      const model = editorInstance.getModel();
      if (selection && model && !selection.isEmpty()) {
        const text = model.getValueInRange(selection).trim();
        onExecuteRef.current(text);
      } else {
        alert('💡 提示：当前未选中任何 SQL 代码，请先用鼠标高亮选中需要单独执行的 SQL 语句！');
      }
    } else {
      alert('💡 提示：当前未选中任何 SQL 代码，请先用鼠标高亮选中需要单独执行的 SQL 语句！');
    }
    setContextMenu(null);
  };

  const handleRunAll = () => {
    const fullSql = editorInstance ? editorInstance.getValue() : valueRef.current;
    onExecuteRef.current(fullSql);
    setContextMenu(null);
  };

  return (
    <div
      className="h-full w-full bg-[#111318] relative overflow-hidden flex flex-col select-none"
      onContextMenu={() => {
        // 如果右键点击了 Monaco 组件区域，弹窗辅助菜单
        const selection = editorInstance?.getSelection();
        const model = editorInstance?.getModel();
        if (selection && model && !selection.isEmpty()) {
          const text = model.getValueInRange(selection).trim();
          if (text) setSelectedText(text);
        }
      }}
    >
      <Editor
        height="100%"
        defaultLanguage="sql"
        theme="vs-dark"
        value={value}
        onChange={(v) => onChange(v || '')}
        onMount={handleEditorMount}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          contextmenu: true
        }}
      />

      {/* 自定义悬浮 / 选中态辅助面板条 (如果有选中文本) */}
      {selectedText && (
        <div className="absolute top-2 right-4 z-20 flex items-center gap-2 bg-[#181a20]/90 border border-blue-500/60 backdrop-blur-md px-3 py-1 rounded-lg shadow-xl text-xs text-blue-300">
          <span className="font-mono text-[11px] truncate max-w-xs text-slate-300">
            已选中: <strong className="text-amber-400 font-mono">"{selectedText.slice(0, 30)}{selectedText.length > 30 ? '...' : ''}"</strong>
          </span>
          <button
            onClick={() => onExecute(selectedText)}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded text-[11px] flex items-center gap-1 shadow transition-colors"
            title="快捷运行选中的这段 SQL (⌘Enter)"
          >
            <Play className="w-3 h-3 fill-current text-white" /> 执行选中
          </button>
        </div>
      )}

      {/* 自定义右键快捷菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[#181a20] border border-slate-700 rounded-xl shadow-2xl py-1 text-xs text-slate-200 w-56 font-sans backdrop-blur-md"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            onClick={handleRunSelected}
            className="px-3.5 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center gap-2 font-medium text-amber-300"
          >
            <Play className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
            <span>{selectedText ? '执行选中的 SQL (⌘Enter)' : '执行选中/当前 SQL (⌘Enter)'}</span>
          </div>

          <div
            onClick={handleRunAll}
            className="px-3.5 py-2 hover:bg-emerald-600 hover:text-white cursor-pointer flex items-center gap-2 font-medium border-t border-slate-800 text-slate-200"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>执行全部 SQL 脚本</span>
          </div>
        </div>
      )}
    </div>
  );
};
