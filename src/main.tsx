import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import App from "./App";
import "./index.css";

// 强制配置 Monaco Editor 使用本地捆绑的离线模块，严禁从 jsdelivr/cloudflare 等外网 CDN 加载
loader.config({ monaco });

// 禁用 Webview 浏览器默认右键菜单（如 Reload、Inspect Element），让应用拥有纯正原生桌面软件质感
if (import.meta.env.PROD || !window.location.href.includes('debug=true')) {
  document.addEventListener('contextmenu', (e) => {
    // 允许 Monaco 编辑器或显式标记的区域触发其内部自定义菜单，屏蔽所有网页级原生默认菜单
    const target = e.target as HTMLElement | null;
    const isMonaco = target?.closest('.monaco-editor');
    if (!isMonaco) {
      e.preventDefault();
    }
  });

  // 禁用 F5、Cmd+R / Ctrl+R 等误触刷新网页快捷键
  document.addEventListener('keydown', (e) => {
    if (
      (e.key === 'r' && (e.metaKey || e.ctrlKey)) ||
      e.key === 'F5'
    ) {
      e.preventDefault();
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
