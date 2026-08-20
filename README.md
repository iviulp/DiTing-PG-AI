<div align="center">

<img src="./public/diting_logo.png" width="160" height="160" alt="DiTing PG AI Logo" style="border-radius: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.3);" />

# 谛听 · DiTing PG AI

### 专为 PostgreSQL 打造的下一代 AI 增强型桌面数据库客户端
**Next-Generation AI-Powered PostgreSQL GUI & Native CLI Client**

[![Tauri 2.0](https://img.shields.io/badge/Tauri-v2.0-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust Engine](https://img.shields.io/badge/Rust-1.80+-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12--17-336791?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

[**简体中文**](./README.md) | [**English**](./README_EN.md) | [**快速下载 Release**](https://github.com/)

<p align="center">
  <b>听音辨伪 · 洞察万物数据真相</b><br>
  集「极速原生 Rust 驱动」、「AI 智能协同中枢」、「100% 离线 Native CLI 控制台」与「细粒度权限/锁监控」于一体的专业级数据库神器。
</p>

</div>

---

## 🌟 为什么选择 DiTing PG AI？

传统数据库客户端（如 Navicat、DBeaver、DataGrip）往往存在**内存占用高（Java 虚拟机）、启动缓慢、对现代大模型（LLM）缺乏原生深度整合、缺乏安全沙箱隔离**等痛点。

**DiTing PG AI** 采用 **Tauri 2.0 + Rust + React + Monaco Editor** 现代全栈技术重构，带来前所未有的体验：

| 核心特性 | 传统客户端 (Navicat / DBeaver) | DiTing PG AI |
| :--- | :--- | :--- |
| **底层架构与性能** | Java JVM 启动，内存常态 500MB~2GB | **Rust 原生轻量引擎，冷启动 < 400ms，内存仅 60MB** |
| **AI 深度整合** | 无或仅为粗糙的 Webview 网页问答 | **物理元数据实时探查 + 意图路由 + 自然语言直出 SQL** |
| **命令行交互 (CLI)** | 依赖本地是否装有 `psql` 环境 | **100% 离线内置原生 psql 模拟器，零依赖免装环境** |
| **安全性 & 权限治理** | 权限修改黑盒，容易误操作 | **PostgreSQL 细粒度表级 ACL 矩阵 + 生产红线防护** |
| **配置漫游与迁移** | 明文保存连接密码，迁移困难 | **Argon2id + AES-256-GCM 强加密 `.ditingvault` 备份** |

---

## 🚀 核心功能亮点 (Key Features)

### 1. 🤖 深度注入的 AI 数据库协同中枢
- **物理 Schema 自动探查**：提问时自动并发读取相关表的真实物理字段与数据类型（`boolean` vs `varchar` vs `timestamp` 等），绝不会产生低级反问。
- **大小写智能自愈**：无论查询条件是大写、小写还是驼峰，AI 自动运用 PostgreSQL 原生 `ILIKE` 与双引号精确匹配。
- **SQL 报错一键自愈**：内核捕获 PostgreSQL 原始报错码，AI 专家一键定位根因并生成修复方案。
- **`@` 快捷语法补全**：在侧边栏输入 `@` 即可弹出当前库表名，支持键盘 `↑` / `↓` 导航和 `Tab` / `Enter` 快捷填入。

### 2. ⚡ 100% 离线内置原生 CLI 控制台 (psql Emulation)
- **无需系统安装 psql / zsh / bash**：直接通过 Rust 原生数据库驱动与目标实例建立物理交互会话。
- **全套 psql 元命令支持**：`\dt`（列出表）、`\d <table>`（结构详解）、`\du`（用户角色）、`\l`（所有库）、`\c <db>`（切换库）、`\dn`（模式）等。
- **经典 ASCII 终端排版**：执行 SQL 即时输出经典边框 ASCII 表格与毫秒级耗时统计。
- **历史记录与编辑器联动**：支持键盘 `↑` / `↓` 历史回溯，支持一键将命令行语句注入主 Monaco 编辑器。

### 3. 🛡️ 企业级用户与细粒度表级权限矩阵 (ACL Manager)
- **7 维细粒度表级特权**：可视化的 `SELECT`、`INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`REFERENCES`、`TRIGGER` 赋权与回收。
- **超级用户（SUPERUSER）内核越权警示**：自动侦测并显式告警 PostgreSQL 内核 ACL 规则约束，杜绝运维吞错与困惑。
- **实时 Diff 与 DCL 预览**：生成 `GRANT` / `REVOKE` 脚本确认后再执行，保障生产安全。

### 4. 🗄️ 连接专属已存 SQL 脚本库 (Saved SQL Library)
- **连接级物理隔离**：每个连接拥有独立的 SQL 脚本库，支持自定义标签分类（如 `#报表`、`#运维`、`#清洗`）与模糊搜索。
- **三种灵活调用模式**：
  - `【覆盖填入】`：填入 Monaco 主编辑器进行二度修改；
  - `【追加到末尾】`：将脚本追加到末尾，绝不丢失当前正在写的草稿；
  - `【立即执行】`：直接后台运行并在主表格呈现结果。

### 5. 🔍 实时进程与死锁监控 (Process & Lock Inspector)
- 实时探查 `pg_stat_activity`，直观展示活跃连接、慢查询耗时、客户端 IP 与执行状态。
- 支持一键安全终止（`pg_terminate_backend`）阻断进程或死锁事务。

### 6. 🔐 军工级加密数据备份与迁移 (.ditingvault)
- 支持将全量连接配置、AI Provider 密钥、已存 SQL 脚本库一键导出为 `.ditingvault` 加密备份包。
- 采用 **Argon2id 密钥派生 + AES-256-GCM 强加密**，换电脑一键恢复，安全无忧。

---

## 🖥️ 快速上手 (Quick Start)

### 方式 1：直接下载安装包（推荐）
请前往 [Releases 页面](https://github.com/) 下载对应平台的最新安装包：
- **macOS**：下载 `.dmg` 文件（同时支持 Apple Silicon M1/M2/M3/M4 及 Intel 芯片）
- **Windows**：下载 `.msi` 或 `.exe` 安装程序
- **Linux**：下载 `.deb` 或 `.AppImage`

### 方式 2：本地源码运行与二次开发

#### 1. 前置环境准备
- [Node.js](https://nodejs.org/) (v18.0+)
- [Rust & Cargo](https://www.rust-lang.org/) (v1.80+)

#### 2. 克隆仓库与安装依赖
```bash
# 克隆代码仓库
git clone https://github.com/your-username/diting-pg-ai.git
cd diting-pg-ai

# 安装前端依赖
npm install
```

#### 3. 启动本地开发环境
```bash
# 启动热重载开发服务器
npm run tauri dev
```

#### 4. 打包生成桌面应用安装包
```bash
# 编译生产版本 (.dmg / .msi / .deb)
npm run tauri build
```

---

## ⌨️ 常用快捷键速查

| 快捷键 | 所在区域 | 功能描述 |
| :--- | :--- | :--- |
| **`⌘ + Enter` / `Ctrl + Enter`** | Monaco SQL 编辑器 | 优先执行选中的 SQL，未选中则执行当前全部有效 SQL |
| **`Tab` / `Enter`** | AI 侧边栏 `@` 补全 | 一键填入高亮选中的数据库表名 |
| **`↑` / `↓`** | CLI 原生控制台 | 回溯上一条 / 下一条执行过的历史命令 |
| **`Esc`** | 浮层 / 弹窗 | 快速关闭当前弹窗或补全菜单 |

---

## 🛠️ 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DiTing · PG AI Architecture              │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┴───────────────────────┐
       ▼                                               ▼
┌──────────────────────────────┐       ┌──────────────────────────────┐
│       Frontend (UI/UX)       │       │       Backend (Core)         │
│  - React 18 + TypeScript     │ IPC   │  - Tauri 2.0 (Rust)          │
│  - TailwindCSS + Lucide      │◄─────►│  - sqlx (Pure Async Driver)  │
│  - Monaco Editor             │       │  - Argon2id + AES-256-GCM    │
│  - Resizable Layout Panels   │       │  - Native psql Translator    │
└──────────────────────────────┘       └──────────────────────────────┘
```

---

## 🤝 参与贡献 (Contributing)

我们非常欢迎社区贡献者提交 PR 或 Issue！
1. Fork 本仓库并创建特性分支 (`git checkout -b feature/AmazingFeature`)
2. 提交您的修改 (`git commit -m 'feat: Add some AmazingFeature'`)
3. 推送到远程分支 (`git push origin feature/AmazingFeature`)
4. 在 GitHub 上发起 Pull Request

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](./LICENSE) 协议开源。欢迎自由使用、学习与商业化落地。

<div align="center">
  <sub>Built with ❤️ for the global PostgreSQL community.</sub>
</div>
