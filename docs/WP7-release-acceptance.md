# WP7 回归验收报告与发布说明

> 分支: `feature/hardening-improvements`
> 验收日期: 2026-09-22
> 范围: WP1–WP6 全部改造的最终回归与发布准备

---

## 一、工作包完成清单

| WP | 内容 | 提交 | 测试增量 |
|----|------|------|---------|
| WP1 | SQL 安全管道 (AST 分级 + read_only 白名单 + Critical 二次确认流) | `4a792da` | +20 cargo |
| WP2 | AI 升级 (多轮历史 + SSE 流式 Channel + api_key 加密落盘) | `b41bbe1` | +39 cargo (wiremock) |
| WP3 | SSH 隧道 (russh direct/双跳 + TOTP + TOFU 主机密钥) | `f2611d0` | +25 cargo |
| WP4 | 注入加固 (双端转义工具 + 拼接点全量收编 + schema 参数化) | `18ee024` | +16 cargo, +27 vitest |
| WP5 | 类型保真 + SSL (TypePlan 三栈映射 + ssl_mode 生效 + formatDbValue) | `b52d510` | +16 cargo, +12 vitest |
| WP6 | 凭证安全 (Vault 服务 + 主密码备份 v2 + localStorage 迁移 + 死代码清理) | `f5ed7bc` | +44 cargo, +5 vitest |

## 二、最终回归结果

| 检查项 | 命令 | 结果 |
|--------|------|------|
| Rust 单测/集成 | `cargo test --bin aidb-desk` | **154 passed, 0 failed** |
| Rust lint | `cargo clippy --bin aidb-desk --all-targets` | **0 warning, 0 error** |
| TS 类型 | `npx tsc --noEmit` | **0 error** |
| 前端单测 | `npm run test` (vitest) | **44 passed (4 files)** |
| 前端构建 | `npm run build` (vite) | **成功** |
| Release 构建 | `cargo build --release --bin aidb-desk` | 见下方补录 |
| 完整桌面打包 | `npx tauri build` | 见下方补录 |

## 三、发布说明（用户可见变更）

### ⚠️ 必读 1: 连接配置自动迁移
首次启动新版本时，旧版存于浏览器 localStorage 的**明文**连接配置（含密码）会被自动吸入
后端加密存储 `~/.aidb/connections.enc`（Argon2id KEK + HKDF + AES-256-GCM，文件 0600），
迁移成功后明文即被清除。迁移失败时明文保留并在界面提示，重启自动重试——数据不会丢失。

### ⚠️ 必读 2: 备份主密码无法找回
`.ditingvault` 备份升级为 **v2 格式**：导出时必须设置 ≥8 位主密码（旧版内置固定密钥已废弃）。
主密码丢失后**没有任何找回途径**，备份文件将无法解密。旧 v1 备份仍可导入（会显示风险告知），
导入后请立即以 v2 格式重新导出并销毁旧文件。

### ⚠️ 必读 3: SSL 默认策略变更
未显式配置 `ssl_mode` 时：本机回环地址（localhost/127.0.0.1/::1）默认 `disable`（向后兼容），
**远程主机默认 `require`**。如远程服务器不支持 SSL 导致连接失败，错误信息会提示在连接配置中
显式设置 `ssl_mode=disable` 降级。

### 其他行为变更
- 高危 SQL（DROP/TRUNCATE 等 Critical 级）在编辑器与 CLI 均需二次确认；只读连接以 AST 白名单硬拦截写操作。
- AI 回复支持流式逐字输出（失败自动降级同步）；API Key 不再明文存储于任何前端可见位置。
- MySQL/SQLite 查询结果恢复真实类型（数字不再变字符串、真 NULL 与字符串 "NULL" 可区分）。
- SSH 隧道支持密码/私钥/动态口令 (TOTP) 三种认证，direct 单跳与堡垒机双跳。

### 回滚方案
版本回退即可（安装包降级）。注意：v2 备份文件对旧版本不可读（旧版无主密码解密逻辑），
回退前请先用新版导出说明中的方式确认可用备份；`~/.aidb/*.enc` 对旧版透明（旧版继续读 localStorage）。

## 四、遗留技术债登记（不阻塞发布）

1. **execute_query bind 化**（WP4 债）：内部系统查询改 sqlx bind 参数。
2. **App.tsx 正则反解表名**（WP4 债）：改为后端回传 source table 元数据。
3. **AiService 接入 vault_service**（WP6 DoD⑥ 联调项）：ai_config.enc 契约测试已就绪，
   AiService 仍走 WP2 secret_store（同为加密落盘，无明文暴露）；两者统一列 WP8 跟踪。
4. **legacy v1 解密分支移除**：`bundle.rs` 中 SECURITY-LEGACY-REMOVAL-MARKER 标记处，
   计划于 WP7 后首个 breaking release 删除（届时旧备份不再可导入）。
5. **ConnectionConfig 自定义 CA 证书路径**（WP5 债）：企业内网 verify-ca 场景。
6. **ColumnMetadata nullable/is_primary_key 精确化**（WP5 债）。
7. **L2 docker 三栈 all_types 集成测试**（WP5 T6-T8/T10）：需 docker 环境，CI 补挂。

## 五、安全终审结论

- 全仓硬编码密钥仅剩 `bundle.rs` legacy 分支一处（带移除标记，仅用于旧备份解密）。
- 密码/密钥材料路径：连接密码仅存在于 vault 加密文件与 Rust 进程内存；IPC 出口全部脱敏视图。
- SQL 拼接点全部登记于 `docs/security/sql-concat-inventory.md` 并逐点定性。
- SSH 主机密钥 TOFU + 指纹持久化，变更硬失败（防中间人）。
