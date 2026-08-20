<div align="center">

<img src="./public/diting_logo.png" width="160" height="160" alt="DiTing PG AI Logo" style="border-radius: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.3);" />

# DiTing · PG AI

### The Next-Generation AI-Native Desktop Client for PostgreSQL
**High-performance GUI + 100% Offline Embedded CLI + Intelligent Copilot**

[![Tauri 2.0](https://img.shields.io/badge/Tauri-v2.0-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust Engine](https://img.shields.io/badge/Rust-1.80+-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12--17-336791?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

[**English**](./README_EN.md) | [**简体中文**](./README.md) | [**Download Releases**](https://github.com/)

<p align="center">
  <b>Unveil the true nature of your database.</b><br>
  Engineered with Rust, Tauri 2.0, and Monaco Editor. Delivering ultra-low memory footprint, deep LLM context pre-fetching, and complete table-level ACL privileges governance.
</p>

</div>

---

## 🌟 Why DiTing PG AI?

Traditional clients like Navicat, DBeaver, or DataGrip are bloated (Java JVM overhead), sluggish to start, lack native deep LLM integration, and offer clumsy credential exports.

**DiTing PG AI** redefines the database developer experience:

| Feature | Legacy Clients (Navicat / DBeaver) | DiTing PG AI |
| :--- | :--- | :--- |
| **Engine & Performance** | Heavy Java JVM, 500MB~2GB RAM | **Pure Rust async core, cold start < 400ms, ~60MB RAM** |
| **AI Integration** | None or naive generic Webview iframe | **Physical column pre-fetching + Intent routing + Self-healing** |
| **Command Line (CLI)** | Requires external local `psql` installed | **100% offline embedded native psql REPL, zero dependencies** |
| **Security & ACL** | Opaque privileges, easy to misconfigure | **7-dimensional table ACL matrix + SUPERUSER bypass warnings** |
| **Vault & Migration** | Plaintext credentials | **Argon2id + AES-256-GCM encrypted `.ditingvault` backup** |

---

## 🚀 Key Features

### 1. 🤖 Deep AI Copilot with Physical Schema Pre-fetching
- **Pre-fetched Column Types**: Automatically fetches physical column definitions (`boolean`, `varchar`, `timestamp`) into LLM context, eliminating silly counter-questions.
- **Case-Insensitive Intelligence**: Transparently handles lowercase/uppercase values using PostgreSQL `ILIKE` and exact double-quoted identifiers.
- **Instant Error Healing**: Catches PostgreSQL native engine error codes and provides single-click root-cause diagnosis.
- **`@` Mention Autocomplete**: Type `@` in chat to autocomplete table names with `↑`/`↓` arrows and `Tab`/`Enter`.

### 2. ⚡ 100% Offline Embedded Native CLI (psql REPL)
- **Zero External Dependencies**: Connect directly via pure Rust drivers without requiring system `psql`, `zsh`, or `powershell`.
- **Full Meta-Command Support**: `\dt` (tables), `\d <table>` (describe), `\du` (roles), `\l` (databases), `\c <db>` (switch db), `\dn` (schemas), `help`.
- **Classic ASCII Terminal Tables**: Clean border rendering with execution duration and row counts.
- **History Navigation**: `↑` / `↓` command recall, copy output, or pipe back into the main Monaco editor.

### 3. 🛡️ Granular Table-Level Privileges Matrix (ACL Governance)
- **7-Dimensional Privileges**: Visual inspection and modification of `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`.
- **SUPERUSER Kernel Enforcement**: Transparently warns when SUPERUSER bypasses ACLs, avoiding confusing state rollbacks.
- **Safe DCL Diff Preview**: Inspect generated `GRANT` / `REVOKE` scripts before applying to production.

### 4. 🗄️ Connection-Isolated Saved SQL Library
- **Scoped Management**: Store and tag queries (`#Report`, `#DBA`, `#Migration`) strictly isolated per database connection.
- **Safe Execution Modes**: `[Replace Editor]`, `[Append to End]`, or `[Run Directly]` without losing work-in-progress code.

### 5. 🔍 Real-Time Process & Lock Monitor
- Live exploration of `pg_stat_activity`. Kill blocking transactions (`pg_terminate_backend`) with a single click.

### 6. 🔐 Hardened Encryption Vault (.ditingvault)
- Export full connection profiles, AI credentials, and saved SQL scripts with **Argon2id + AES-256-GCM**.

---

## 🖥️ Quick Start

### Option 1: Download Pre-built Binaries
Head over to the [Releases Page](https://github.com/) to download:
- **macOS**: `.dmg` (Apple Silicon & Intel supported)
- **Windows**: `.msi` / `.exe` installer
- **Linux**: `.deb` / `.AppImage`

### Option 2: Build from Source
```bash
# Clone repository
git clone https://github.com/your-username/diting-pg-ai.git
cd diting-pg-ai

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build production bundle (.dmg / .msi / .deb)
npm run tauri build
```

---

## 📄 License

Licensed under the [MIT License](./LICENSE).

<div align="center">
  <sub>Built with ❤️ for the global PostgreSQL community.</sub>
</div>
