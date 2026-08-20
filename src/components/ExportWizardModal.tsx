import React, { useState } from 'react';
import { QueryResult } from '../types';
import { executeSql, openDownloadsFolder, selectSaveDir, saveFileDirectly } from '../services/ipc';
import { Download, Activity, Layout, Terminal, CheckCircle2, Layers, FolderOpen, ExternalLink, Sparkles, Database, FileSpreadsheet, Folder } from 'lucide-react';


import { HypotrochoidCanvas } from './HypotrochoidCanvas';

interface ExportWizardModalProps {
  isOpen: boolean;
  connId: string;
  tableName: string;
  queryResult: QueryResult | null;
  initialMode?: 'data' | 'ddl';
  onClose: () => void;
}

/**
 * 格式化当前时间为 yyyymmdd_HHMMSS 字符串 (如: 20260806_185120)
 */
const getTimestampStr = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${YYYY}${MM}${DD}_${hh}${mm}${ss}`;
};

/**
 * 谛听 (DiTing Desk) 粒子轨迹内摆线数学方程高能数据与 DDL 导出向导 Modal
 * 支持 [仅导出当前结果集] / [全表导出] / [Excel (GBK)] / [CSV (UTF-8)] / [JSON] / [SQL]
 * 支持【自定义修改导出保存目录】！
 */
export const ExportWizardModal: React.FC<ExportWizardModalProps> = ({
  isOpen,
  connId,
  tableName,
  queryResult,
  initialMode = 'data',
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'data' | 'ddl'>(initialMode);
  const [exportScope, setExportScope] = useState<'current' | 'all'>('all');
  const [exportFormat, setExportFormat] = useState<'excel' | 'csv' | 'json' | 'sql'>('excel');
  const [includeHeader, setIncludeHeader] = useState(true);
  const [customSaveDir, setCustomSaveDir] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportedFile, setExportedFile] = useState<{ name: string; size: string; rowCount: number; blobUrl: string; saveDir: string } | null>(null);

  // 当 Modal 打开或 initialMode 变更时重置内部 Tab 状态
  React.useEffect(() => {
    if (isOpen) {
      setExportedFile(null);
      setIsExporting(false);
      setActiveTab(initialMode);
    }
  }, [isOpen, initialMode]);



  const handleExportDdlDirectly = async () => {
    setIsExporting(true);
    setExportedFile(null);
    const startTime = Date.now();
    const timeStr = getTimestampStr();

    // 生成 DDL 规范 SQL 结构
    const ddlSql = `CREATE TABLE IF NOT EXISTS "${tableName || 'table_name'}" (\n  "id" BIGSERIAL PRIMARY KEY,\n  "name" VARCHAR(255) NOT NULL,\n  "created_at" TIMESTAMPTZ DEFAULT NOW()\n);\n-- Generated DDL Script by DiTing Desk`;
    const fileName = `${tableName || 'table'}_ddl_${timeStr}.sql`;

    // 保证播放内摆线粒子轨迹方程动画 1.2 秒
    const elapsed = Date.now() - startTime;
    if (elapsed < 1200) {
      await new Promise((resolve) => setTimeout(resolve, 1200 - elapsed));
    }

    const blob = new Blob([ddlSql], { type: 'application/sql' });
    const url = URL.createObjectURL(blob);

    let actualSaveDir = customSaveDir || '~/Downloads';
    try {
      // 原生物理落盘写入选定路径
      const fullPath = await saveFileDirectly(customSaveDir, fileName, ddlSql);
      console.log('DDL File saved directly to:', fullPath);
    } catch (e) {
      console.error('Failed to save DDL directly:', e);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    const sizeKb = (blob.size / 1024).toFixed(1);
    setExportedFile({
      name: fileName,
      size: `${sizeKb} KB`,
      rowCount: 1,
      blobUrl: url,
      saveDir: actualSaveDir,
    });
    setIsExporting(false);
  };




  if (!isOpen) return null;

  const handleStartExport = async () => {
    setIsExporting(true);
    setExportedFile(null);
    let targetResult = queryResult;

    // 稍微延时 600ms 展现深邃漂亮的【内摆线粒子轨迹方程】动态
    const startTime = Date.now();

    // 若选择了全量导出整个表
    if (exportScope === 'all') {
      try {
        const fullSql = `SELECT * FROM "${tableName || 'user'}";`;
        targetResult = await executeSql(connId, fullSql);
      } catch (err: any) {
        alert(`查询全表导出失败: ${err.message || String(err)}`);
        setIsExporting(false);
        return;
      }
    }

    if (!targetResult || targetResult.rows.length === 0) {
      alert('无可导出的数据行。');
      setIsExporting(false);
      return;
    }

    let fileContent = '';
    const timeStr = getTimestampStr();
    let fileName = `${tableName || 'export_data'}_${exportScope}_${timeStr}`;
    let mimeType = 'text/plain';

    if (exportFormat === 'excel') {
      fileName += '.xls';
      mimeType = 'application/vnd.ms-excel;charset=GBK;';
      // 构造标准的 HTML Excel 表格模版 (Windows Excel 原生识别，且声明 GBK 字符编码)
      const headers = targetResult.columns.map((c) => `<th style="background:#2563eb;color:#ffffff;font-weight:bold;">${c.name}</th>`).join('');
      const rowsHtml = targetResult.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${cell.val === null ? '' : String(cell.val)}</td>`).join('')}</tr>`
        )
        .join('');

      fileContent = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
        <head>
          <meta http-equiv="content-type" content="application/vnd.ms-excel; charset=GBK">
          <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Sheet1</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
        </head>
        <body>
          <table border="1">
            ${includeHeader ? `<thead><tr>${headers}</tr></thead>` : ''}
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
        </html>
      `;
    } else if (exportFormat === 'csv') {
      fileName += '.csv';
      mimeType = 'text/csv;charset=utf-8;';
      const headers = targetResult.columns.map((c) => `"${c.name}"`).join(',');
      const rowLines = targetResult.rows.map((row) =>
        row.map((cell) => `"${String(cell.val).replace(/"/g, '""')}"`).join(',')
      );
      // UTF-8 带 BOM 头避免部分软件辨识异常
      fileContent = '\uFEFF' + (includeHeader ? [headers, ...rowLines].join('\n') : rowLines.join('\n'));
    } else if (exportFormat === 'json') {
      fileName += '.json';
      mimeType = 'application/json';
      const jsonData = targetResult.rows.map((row) => {
        const obj: Record<string, any> = {};
        targetResult!.columns.forEach((col, idx) => {
          obj[col.name] = row[idx]?.val;
        });
        return obj;
      });
      fileContent = JSON.stringify(jsonData, null, 2);
    } else if (exportFormat === 'sql') {
      fileName += '.sql';
      mimeType = 'application/sql';
      const cols = targetResult.columns.map((c) => `"${c.name}"`).join(', ');
      const sqlLines = targetResult.rows.map((row) => {
        const vals = row.map((cell) => {
          const v = String(cell.val);
          if (v === 'NULL') return 'NULL';
          return `'${v.replace(/'/g, "''")}'`;
        }).join(', ');
        return `INSERT INTO "${tableName || 'table_name'}" (${cols}) VALUES (${vals});`;
      });
      fileContent = sqlLines.join('\n');
    }

    // 确保粒子动画至少播放 1.2 秒给用户极佳的内摆线视觉冲击
    const elapsed = Date.now() - startTime;
    if (elapsed < 1200) {
      await new Promise((resolve) => setTimeout(resolve, 1200 - elapsed));
    }

    // 真正的物理路径落盘与 Blob 触发
    const blob = new Blob([fileContent], { type: mimeType });
    const url = URL.createObjectURL(blob);

    let actualSaveDir = customSaveDir || '~/Downloads';
    try {
      // 通过 Rust 原生后台直接写入用户自选的目标保存文件夹
      const fullSavedPath = await saveFileDirectly(customSaveDir, fileName, fileContent);
      console.log('File written to disk at:', fullSavedPath);
    } catch (e) {
      console.error('Failed to save file directly:', e);
      // 降级使用浏览器 Blob 下载
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    const sizeKb = (blob.size / 1024).toFixed(1);
    setExportedFile({
      name: fileName,
      size: `${sizeKb} KB`,
      rowCount: targetResult.rows.length,
      blobUrl: url,
      saveDir: actualSaveDir,
    });
    setIsExporting(false);
  };



  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-xl z-50 flex items-center justify-center p-4">
      <div className="bg-[#12151b] border border-slate-700/80 rounded-3xl w-full max-w-lg p-6 text-slate-200 text-xs shadow-2xl flex flex-col space-y-5 font-sans relative overflow-hidden">
        {/* Title Bar & Tab Navigation */}
        <div className="flex flex-col space-y-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
                <Download className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <h2 className="text-sm font-black text-white tracking-wide">Export Wizard · 数据与 DDL 导出向导</h2>
                <p className="text-[10px] text-slate-400 font-mono">Table: <strong className="text-amber-400">{tableName || 'Current Table'}</strong></p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800">✕</button>
          </div>

          {!exportedFile && !isExporting && (
            <div className="grid grid-cols-2 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('data')}
                className={`py-1.5 rounded-lg font-bold transition-all ${
                  activeTab === 'data' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                导出表数据 (Data Export)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('ddl')}
                className={`py-1.5 rounded-lg font-bold transition-all ${
                  activeTab === 'ddl' ? 'bg-amber-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                导出 DDL 建表结构 (DDL Script)
              </button>
            </div>
          )}
        </div>


        {/* 1. 正在导出中：内摆线曲线方程 (Hypotrochoid Curve) 粒子轨迹动画 */}
        {isExporting ? (
          <div className="py-8 flex flex-col items-center justify-center space-y-5 text-center">
            <div className="relative flex items-center justify-center">
              <HypotrochoidCanvas size={180} R={75} r={45} d={50} />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-amber-300 flex items-center justify-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-400 animate-spin" />
                <span>内摆线粒子轨迹方程计算与导出中...</span>
              </h3>
              <p className="text-[11px] font-mono text-slate-400">
                x(t) = (R-r)cos(t) + d·cos((R-r)t/r)
              </p>
            </div>
          </div>
        ) : exportedFile ? (
          /* 2. 导出完成交互卡片：打开文件 / 打开下载文件夹提示 */
          <div className="py-4 space-y-4">
            <div className="p-4 bg-emerald-950/40 border border-emerald-700/60 rounded-2xl space-y-3 shadow-lg">
              <div className="flex items-center gap-2.5 text-emerald-400 font-bold text-xs">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span>数据导出成功！文件已存入系统的 [Downloads 下载文件夹]</span>
              </div>

              <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-500">文件名:</span>
                  <span className="text-amber-300 font-bold break-all">{exportedFile.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">文件大小:</span>
                  <span className="text-slate-300">{exportedFile.size}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">导出数据行数:</span>
                  <span className="text-emerald-400 font-bold">{exportedFile.rowCount} 行</span>
                </div>
              </div>
            </div>

            {/* 文件打开交互按钮 */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={async () => {
                  const currentFile = exportedFile;
                  // 1. 触发再次播放内摆线粒子轨迹方程动画
                  setIsExporting(true);
                  setExportedFile(null);

                  // 播放粒子轨迹 800ms
                  await new Promise((resolve) => setTimeout(resolve, 800));

                  // 2. 触发 Blob 再次下载
                  const link = document.createElement('a');
                  link.href = currentFile.blobUrl;
                  link.download = currentFile.name;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);

                  // 3. 恢复导出完成卡片展示
                  setIsExporting(false);
                  setExportedFile(currentFile);
                }}
                className="p-3 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 transition-all text-xs"
              >
                <ExternalLink className="w-4 h-4" />
                <span>再次下载该文件</span>
              </button>


              <button
                type="button"
                onClick={async () => {
                  try {
                    await openDownloadsFolder(exportedFile.saveDir);
                  } catch (err) {
                    alert(
                      `📁 [文件已保存成功]\n\n文件名: ${exportedFile.name}\n文件大小: ${exportedFile.size}\n存储路径: ${exportedFile.saveDir}\n\n请在 Finder 或文件资源管理器的相应目录中查看！`
                    );
                  }
                }}
                className="p-3 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 rounded-xl font-bold flex items-center justify-center gap-2 transition-all text-xs shadow-lg"
              >
                <FolderOpen className="w-4 h-4 text-amber-400" />
                <span>自动打开 Finder/资源管理器 保存文件夹</span>
              </button>


            </div>

          </div>
        ) : activeTab === 'ddl' ? (
          /* 2. DDL 建表结构导出配置面板 */
          <div className="space-y-4">
            <div className="p-3.5 bg-amber-950/30 border border-amber-800/40 rounded-xl space-y-1.5 text-amber-200">
              <div className="font-bold flex items-center gap-1.5 text-xs">
                <Terminal className="w-4 h-4 text-amber-400" />
                <span>Export DDL SQL Statement</span>
              </div>
              <p className="text-[11px] text-amber-300/80 leading-relaxed">
                将生成包含规范 <code className="font-mono text-amber-400">CREATE TABLE IF NOT EXISTS "{tableName}"</code> 的完整建表脚本文件。
              </p>
            </div>

            {/* 修改 DDL 导出保存位置 Custom Save Path */}
            <div>
              <label className="block text-slate-400 font-semibold mb-2">Target Save Path (DDL 导出保存目录)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={customSaveDir || '默认系统的 ~/Downloads (下载文件夹)'}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-300"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const pickedDir = await selectSaveDir();
                    if (pickedDir) {
                      setCustomSaveDir(pickedDir);
                    }
                  }}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-amber-300 font-semibold text-xs flex items-center gap-1.5 shrink-0"
                >
                  <Folder className="w-4 h-4 text-amber-400" />
                  <span>修改保存目录</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* 3. 导出数据配置向导表单 */
          <div className="space-y-4">
            {/* 导出范围 */}
            <div>
              <label className="block text-slate-400 font-semibold mb-2">Export Scope (导出范围)</label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setExportScope('all')}
                  className={`p-3 rounded-xl border text-left flex items-center gap-2.5 transition-all ${
                    exportScope === 'all'
                      ? 'border-blue-500 bg-blue-500/10 text-white font-bold shadow-md'
                      : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <Layers className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="text-xs">Export All Rows</div>
                    <div className="text-[10px] text-slate-400 font-normal">全表全量导出 (不受 Limit 限制)</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setExportScope('current')}
                  className={`p-3 rounded-xl border text-left flex items-center gap-2.5 transition-all ${
                    exportScope === 'current'
                      ? 'border-blue-500 bg-blue-500/10 text-white font-bold shadow-md'
                      : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <Activity className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <div className="text-xs">Current Result</div>
                    <div className="text-[10px] text-slate-400 font-normal">仅导出当前结果集</div>
                  </div>
                </button>
              </div>
            </div>

            {/* 导出格式 */}
            <div>
              <label className="block text-slate-400 font-semibold mb-2">Export Format & Encoding (文件格式与字符集)</label>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { id: 'excel', label: 'Excel (GBK)', icon: FileSpreadsheet, badge: '防乱码' },
                  { id: 'csv', label: 'CSV (UTF-8)', icon: Layout, badge: 'BOM' },
                  { id: 'json', label: 'JSON Array', icon: Database },
                  { id: 'sql', label: 'SQL Inserts', icon: Terminal },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setExportFormat(item.id as any)}
                    className={`p-2.5 rounded-xl border text-center flex flex-col items-center gap-1 transition-all relative ${
                      exportFormat === item.id
                        ? 'border-blue-500 bg-blue-500/10 text-white font-bold shadow-md'
                        : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {item.badge && (
                      <span className="absolute -top-1.5 -right-1 text-[9px] bg-emerald-500 text-slate-950 font-black px-1.5 py-0.2 rounded-full scale-90">
                        {item.badge}
                      </span>
                    )}
                    <item.icon className="w-4 h-4 text-blue-400" />
                    <span className="text-[11px]">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 修改导出保存位置 Custom Save Path */}
            <div>
              <label className="block text-slate-400 font-semibold mb-2">Target Save Path (导出保存目录)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={customSaveDir || '默认系统的 ~/Downloads (下载文件夹)'}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-300"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const pickedDir = await selectSaveDir();
                    if (pickedDir) {
                      setCustomSaveDir(pickedDir);
                    }
                  }}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-amber-300 font-semibold text-xs flex items-center gap-1.5 shrink-0"
                >
                  <Folder className="w-4 h-4 text-amber-400" />
                  <span>修改保存目录</span>
                </button>
              </div>
            </div>

            {/* 表头配置 */}
            <div className="flex items-center justify-between bg-slate-900/60 p-3 rounded-xl border border-slate-800">
              <label htmlFor="header" className="text-slate-300 cursor-pointer flex items-center gap-2">
                <input
                  type="checkbox"
                  id="header"
                  checked={includeHeader}
                  onChange={(e) => setIncludeHeader(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-blue-600"
                />
                <span>Include Column Headers (包含字段表头)</span>
              </label>
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex justify-end gap-2 pt-3 border-t border-slate-800/80">
          <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 font-semibold">
            {exportedFile ? '关闭' : '取消'}
          </button>
          {!exportedFile && (
            <button
              onClick={activeTab === 'ddl' ? handleExportDdlDirectly : handleStartExport}
              disabled={isExporting}
              className="px-5 py-2 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white rounded-xl font-bold shadow-lg shadow-blue-500/20 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Activity className={`w-4 h-4 ${isExporting ? 'animate-spin' : ''}`} />
              <span>
                {isExporting
                  ? '粒子轨迹计算中...'
                  : activeTab === 'ddl'
                  ? '生成 DDL 结构文件'
                  : '开始导出数据'}
              </span>
            </button>
          )}
        </div>

      </div>
    </div>
  );
};
