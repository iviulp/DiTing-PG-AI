import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import App from "./App";
import "./index.css";

// 强制配置 Monaco Editor 使用本地捆绑的离线模块，严禁从 jsdelivr/cloudflare 等外网 CDN 加载
loader.config({ monaco });


ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
