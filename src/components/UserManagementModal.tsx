import React, { useState, useEffect } from 'react';
import { Shield, UserPlus, CheckCircle2, KeyRound, Users, RefreshCw, Trash2, User } from 'lucide-react';
import { executeSql } from '../services/ipc';

interface DbUser {
  username: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canLogin: boolean;
  connectionLimit: number;
  validUntil?: string;
  isCurrentUser?: boolean;
}

interface SchemaPrivilege {
  usage: boolean;
  create: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  isSystemSchema?: boolean;
}

interface TablePrivilege {
  schemaName: string;
  tableName: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  references: boolean;
  trigger: boolean;
}

interface UserManagementModalProps {
  isOpen: boolean;
  connId: string;
  connName: string;
  onClose: () => void;
}

/**
 * 谛听 (DiTing Desk) PostgreSQL 工业级用户与表级权限管理中心 (PostgreSQL Role, Schema & Table-Level Privilege Manager)
 * 遵循 PostgreSQL 官方 ACL 规范与顶级 DBA 运维准则：
 * 1. 角色属性 (Role Attributes): SUPERUSER, CREATEDB, CREATEROLE, LOGIN
 * 2. 模式特权 (Schema Privileges): USAGE (访问/解析), CREATE (新建表/视图等对象)
 * 3. 模式级默认表权限 (All Tables In Schema): SELECT, INSERT, UPDATE, DELETE, TRUNCATE
 * 4. 细粒度单表级权限 (Granular Table-Level Privileges):
 *    - 探查每一个物理表/视图上该用户独立的 has_table_privilege 权限
 *    - 支持按表独立配置 SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
 *    - 支持一键快捷模板（全只读 ReadOnly, 读写 ReadWrite, 全权 ALL, 零权限 RevokeAll）
 *    - 实时 Diff 精准计算生成单表 GRANT / REVOKE DCL 脚本并执行
 */
export const UserManagementModal: React.FC<UserManagementModalProps> = ({
  isOpen,
  connId,
  connName,
  onClose,
}) => {
  const [users, setUsers] = useState<DbUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<DbUser | null>(null);
  const selectedUserRef = React.useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'schema_privs' | 'table_privs'>('schema_privs');
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsSuperuser, setNewIsSuperuser] = useState(false);

  // 模式级权限矩阵
  const [privilegeMatrix, setPrivilegeMatrix] = useState<Record<string, SchemaPrivilege>>({});
  const initialPrivilegeRef = React.useRef<Record<string, SchemaPrivilege>>({});

  // 表级细粒度权限列表与矩阵 (Key: `${schemaName}.${tableName}`)
  const [tablePrivileges, setTablePrivileges] = useState<Record<string, TablePrivilege>>({});
  const initialTablePrivilegesRef = React.useRef<Record<string, TablePrivilege>>({});
  const [tableSearchFilter, setTableSearchFilter] = useState('');
  const [selectedSchemaFilter, setSelectedSchemaFilter] = useState<string>('ALL');

  const [isFetchingPrivileges, setIsFetchingPrivileges] = useState(false);

  const handleSelectUser = (u: DbUser) => {
    selectedUserRef.current = u.username;
    setSelectedUser(u);
    // 切换用户时立即清空旧矩阵，避免界面残留上一个用户的权限假象
    setPrivilegeMatrix({});
    setTablePrivileges({});
    fetchRealPrivileges(u.username);
  };

  /**
   * 权威探测 PostgreSQL 实时权限
   * 1. 探测 Schema 级 USAGE / CREATE
   * 2. 探测每一个具体物理表的真实权限 (has_table_privilege)
   * 3. 探测默认权限 pg_default_acl
   */
  const fetchRealPrivileges = async (username: string) => {
    if (!connId || !username) return;
    setIsFetchingPrivileges(true);

    try {
      // 1. Schema 模式级 USAGE 和 CREATE
      const schemaSql = `
        SELECT 
          n.nspname AS schema_name,
          r.rolsuper AS is_superuser,
          (r.rolsuper OR has_schema_privilege(r.rolname, n.nspname, 'USAGE')) AS has_usage,
          (r.rolsuper OR has_schema_privilege(r.rolname, n.nspname, 'CREATE')) AS has_create,
          CASE 
            WHEN n.nspname IN ('information_schema', 'pg_catalog', 'pg_toast') OR n.nspname LIKE 'pg_%' THEN 'true'
            ELSE 'false'
          END AS is_system
        FROM pg_namespace n
        CROSS JOIN pg_roles r
        WHERE r.rolname = '${username}' 
          AND n.nspname NOT LIKE 'pg_temp_%' 
          AND n.nspname NOT LIKE 'pg_toast_%'
        ORDER BY 
          CASE WHEN n.nspname = 'public' THEN 0 WHEN n.nspname LIKE 'pg_%' THEN 2 ELSE 1 END,
          n.nspname ASC;
      `;
      const schemaRes = await executeSql(connId, schemaSql);

      // 2. 探查当前数据库内所有用户可见物理表/视图的具体表级权限
      const granularTableSql = `
        SELECT 
          c.table_schema,
          c.table_name,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'SELECT')) AS can_select,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'INSERT')) AS can_insert,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'UPDATE')) AS can_update,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'DELETE')) AS can_delete,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'TRUNCATE')) AS can_truncate,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'REFERENCES')) AS can_references,
          (r.rolsuper OR has_table_privilege(r.rolname, format('%I.%I', c.table_schema, c.table_name), 'TRIGGER')) AS can_trigger
        FROM information_schema.tables c
        CROSS JOIN pg_roles r
        WHERE r.rolname = '${username}'
          AND c.table_schema NOT IN ('information_schema', 'pg_catalog')
          AND c.table_schema NOT LIKE 'pg_%'
        ORDER BY c.table_schema ASC, c.table_name ASC;
      `;
      const tableRes = await executeSql(connId, granularTableSql).catch(() => null);

      // 3. 检查 pg_default_acl 默认权限
      const defaultAclSql = `
        SELECT 
          n.nspname AS schemaname,
          defaclacl::text AS defacl
        FROM pg_default_acl a
        JOIN pg_namespace n ON a.defaclnamespace = n.oid
        WHERE defaclobjtype = 'r';
      `;
      const defaultAclRes = await executeSql(connId, defaultAclSql).catch(() => null);

      if (schemaRes && schemaRes.rows.length > 0) {
        const matrix: Record<string, SchemaPrivilege> = {};
        schemaRes.rows.forEach((r) => {
          const sch = String(r[0]?.val || '');
          if (!sch) return;
          const isSuperuser = String(r[1]?.val) === 'true' || String(r[1]?.val) === 't';
          const hasUsage = String(r[2]?.val) === 'true' || String(r[2]?.val) === 't';
          const hasCreate = String(r[3]?.val) === 'true' || String(r[3]?.val) === 't';
          const isSys = String(r[4]?.val) === 'true' || String(r[4]?.val) === 't';

          matrix[sch] = {
            usage: isSuperuser || hasUsage,
            create: isSuperuser || hasCreate,
            select: isSuperuser,
            insert: isSuperuser,
            update: isSuperuser,
            delete: isSuperuser,
            truncate: isSuperuser,
            isSystemSchema: isSys,
          };
        });

        // 默认权限
        if (defaultAclRes && defaultAclRes.rows.length > 0) {
          defaultAclRes.rows.forEach((dr) => {
            const sch = String(dr[0]?.val || '');
            const aclStr = String(dr[1]?.val || '');
            if (matrix[sch] && (aclStr.includes(`"${username}"=`) || aclStr.includes(`${username}=`))) {
              const regex = new RegExp(`"?${username}"?=([a-zA-Z*]+)/`);
              const match = aclStr.match(regex);
              if (match && match[1]) {
                const privChars = match[1];
                if (privChars.includes('r')) matrix[sch].select = true;
                if (privChars.includes('a')) matrix[sch].insert = true;
                if (privChars.includes('w')) matrix[sch].update = true;
                if (privChars.includes('d')) matrix[sch].delete = true;
                if (privChars.includes('D')) matrix[sch].truncate = true;
              }
            }
          });
        }

        setPrivilegeMatrix(matrix);
        initialPrivilegeRef.current = JSON.parse(JSON.stringify(matrix));
      }

      // 解析具体物理表级别的权限
      if (tableRes && tableRes.rows.length > 0) {
        const tblMatrix: Record<string, TablePrivilege> = {};
        tableRes.rows.forEach((tr) => {
          const sName = String(tr[0]?.val || 'public');
          const tName = String(tr[1]?.val || '');
          if (!tName) return;

          const key = `${sName}.${tName}`;
          tblMatrix[key] = {
            schemaName: sName,
            tableName: tName,
            select: String(tr[2]?.val) === 'true' || String(tr[2]?.val) === 't',
            insert: String(tr[3]?.val) === 'true' || String(tr[3]?.val) === 't',
            update: String(tr[4]?.val) === 'true' || String(tr[4]?.val) === 't',
            delete: String(tr[5]?.val) === 'true' || String(tr[5]?.val) === 't',
            truncate: String(tr[6]?.val) === 'true' || String(tr[6]?.val) === 't',
            references: String(tr[7]?.val) === 'true' || String(tr[7]?.val) === 't',
            trigger: String(tr[8]?.val) === 'true' || String(tr[8]?.val) === 't',
          };
        });

        setTablePrivileges(tblMatrix);
        initialTablePrivilegesRef.current = JSON.parse(JSON.stringify(tblMatrix));
      }
    } catch (err: any) {
      console.error('Failed to probe PostgreSQL privileges:', err);
      alert(`⚠️ 探查用户 "${username}" 权限失败：\n${err.message || String(err)}`);
    } finally {
      setIsFetchingPrivileges(false);
    }
  };

  const reloadUsers = async () => {
    if (!connId) return;
    try {
      const directPgSql = `
        SELECT 
          r.rolname::text AS username,
          CASE WHEN r.rolsuper THEN 'true' ELSE 'false' END AS is_superuser,
          CASE WHEN r.rolcreatedb THEN 'true' ELSE 'false' END AS can_create_db,
          CASE WHEN (r.rolcreaterole OR r.rolsuper) THEN 'true' ELSE 'false' END AS can_create_role,
          CASE WHEN r.rolcanlogin THEN 'true' ELSE 'false' END AS can_login,
          CASE WHEN r.rolname = current_user THEN 'true' ELSE 'false' END AS is_current_user,
          r.rolvaliduntil::text AS valid_until
        FROM pg_roles r
        ORDER BY is_current_user DESC, r.rolname ASC;
      `;
      const directRes = await executeSql(connId, directPgSql);
      if (directRes && directRes.rows.length > 0) {
        const mapped: DbUser[] = directRes.rows.map((r) => ({
          username: String(r[0]?.val || ''),
          isSuperuser: String(r[1]?.val) === 'true' || String(r[1]?.val) === 't',
          canCreateDb: String(r[2]?.val) === 'true' || String(r[2]?.val) === 't',
          canCreateRole: String(r[3]?.val) === 'true' || String(r[3]?.val) === 't',
          canLogin: String(r[4]?.val) === 'true' || String(r[4]?.val) === 't',
          connectionLimit: -1,
          validUntil: r[6]?.val ? String(r[6].val) : undefined,
          isCurrentUser: String(r[5]?.val) === 'true' || String(r[5]?.val) === 't',
        }));
        setUsers(mapped);
        let nextSelected = mapped.find((u) => u.username === selectedUserRef.current);
        if (!nextSelected) {
          nextSelected = mapped.find((u) => u.isCurrentUser) || mapped[0];
          selectedUserRef.current = nextSelected?.username || null;
        }
        setSelectedUser(nextSelected);
        if (nextSelected) {
          fetchRealPrivileges(nextSelected.username);
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch db users:', err);
      alert(`⚠️ 加载数据库用户列表失败：\n${err.message || String(err)}`);
    }
  };

  useEffect(() => {
    if (isOpen && connId) reloadUsers();
  }, [isOpen, connId]);

  if (!isOpen) return null;

  const handleAddUser = async () => {
    if (!newUsername) return;
    const superSql = newIsSuperuser ? 'SUPERUSER CREATEDB CREATEROLE' : 'NOSUPERUSER NOCREATEDB NOCREATEROLE';
    const pwdSql = newPassword ? `PASSWORD '${newPassword}'` : '';
    const sql = `CREATE ROLE "${newUsername}" WITH LOGIN ${superSql} ${pwdSql};`;
    try {
      await executeSql(connId, sql);
      setShowAddUserModal(false);
      await reloadUsers();
    } catch (err: any) {
      alert(`创建用户失败: ${err.message || String(err)}`);
    }
  };

  const handleDeleteUser = async (uname: string) => {
    if (!confirm(`确定要注销并删除数据库用户 "${uname}" 吗？`)) return;
    try {
      await executeSql(connId, `DROP ROLE IF EXISTS "${uname}";`);
      await reloadUsers();
    } catch (err: any) {
      alert(`删除用户失败: ${err.message || String(err)}`);
    }
  };

  const [resetPwdUser, setResetPwdUser] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  /**
   * 精准对比基线（Diff-based），生成严格的 GRANT 与 REVOKE 语句
   * 同时涵盖：
   * 1. 角色系统特权 (Role Attributes)
   * 2. Schema 模式级访问与建表特权 (Schema USAGE / CREATE)
   * 3. Schema 全表默认权限 (All Tables In Schema)
   * 4. 细粒度单表级权限 (Granular Table-Level: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER)
   */
  const generateSqlStatements = (): string[] => {
    if (!selectedUser) return [];
    const sqls: string[] = [];
    const superSql = selectedUser.isSuperuser ? 'SUPERUSER' : 'NOSUPERUSER';
    const createdbSql = selectedUser.canCreateDb ? 'CREATEDB' : 'NOCREATEDB';
    const createroleSql = selectedUser.canCreateRole ? 'CREATEROLE' : 'NOCREATEROLE';
    const loginSql = selectedUser.canLogin ? 'LOGIN' : 'NOLOGIN';
    sqls.push(`ALTER ROLE "${selectedUser.username}" WITH ${superSql} ${createdbSql} ${createroleSql} ${loginSql} CONNECTION LIMIT -1;`);
    
    // 1. 处理 Schema 模式级 Diff
    Object.entries(privilegeMatrix).forEach(([schema, current]) => {
      if (current.isSystemSchema) return;
      const initial = initialPrivilegeRef.current[schema] || { usage: false, create: false, select: false, insert: false, update: false, delete: false, truncate: false };

      if (current.usage && !initial.usage) {
        sqls.push(`GRANT USAGE ON SCHEMA "${schema}" TO "${selectedUser.username}";`);
      } else if (!current.usage && initial.usage) {
        sqls.push(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${selectedUser.username}" CASCADE;`);
      }

      if (current.create && !initial.create) {
        sqls.push(`GRANT CREATE ON SCHEMA "${schema}" TO "${selectedUser.username}";`);
      } else if (!current.create && initial.create) {
        sqls.push(`REVOKE CREATE ON SCHEMA "${schema}" FROM "${selectedUser.username}" CASCADE;`);
      }

      const tablePrivs = ['select', 'insert', 'update', 'delete', 'truncate'] as const;
      const privMap = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', truncate: 'TRUNCATE' };
      
      const newlyGranted: string[] = [];
      const newlyRevoked: string[] = [];

      tablePrivs.forEach((p) => {
        if (current[p] && !initial[p]) newlyGranted.push(privMap[p]);
        if (!current[p] && initial[p]) newlyRevoked.push(privMap[p]);
      });

      if (newlyGranted.length > 0) {
        sqls.push(`GRANT ${newlyGranted.join(', ')} ON ALL TABLES IN SCHEMA "${schema}" TO "${selectedUser.username}";`);
        sqls.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ${newlyGranted.join(', ')} ON TABLES TO "${selectedUser.username}";`);
      }
      if (newlyRevoked.length > 0) {
        sqls.push(`REVOKE ${newlyRevoked.join(', ')} ON ALL TABLES IN SCHEMA "${schema}" FROM "${selectedUser.username}";`);
        sqls.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" REVOKE ${newlyRevoked.join(', ')} ON TABLES FROM "${selectedUser.username}";`);
      }
    });

    // 2. 处理细粒度单表级 Diff
    Object.entries(tablePrivileges).forEach(([key, current]) => {
      const initial = initialTablePrivilegesRef.current[key] || {
        schemaName: current.schemaName,
        tableName: current.tableName,
        select: false,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      };

      const tablePrivKeys = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const;
      const tablePrivMap = {
        select: 'SELECT',
        insert: 'INSERT',
        update: 'UPDATE',
        delete: 'DELETE',
        truncate: 'TRUNCATE',
        references: 'REFERENCES',
        trigger: 'TRIGGER',
      };

      const tableGranted: string[] = [];
      const tableRevoked: string[] = [];

      tablePrivKeys.forEach((k) => {
        if (current[k] && !initial[k]) tableGranted.push(tablePrivMap[k]);
        if (!current[k] && initial[k]) tableRevoked.push(tablePrivMap[k]);
      });

      if (tableGranted.length > 0) {
        // 自动确保 Schema 的 USAGE 权限
        sqls.push(`GRANT USAGE ON SCHEMA "${current.schemaName}" TO "${selectedUser.username}";`);
        sqls.push(`GRANT ${tableGranted.join(', ')} ON TABLE "${current.schemaName}"."${current.tableName}" TO "${selectedUser.username}";`);
      }
      if (tableRevoked.length > 0) {
        sqls.push(`REVOKE ${tableRevoked.join(', ')} ON TABLE "${current.schemaName}"."${current.tableName}" FROM "${selectedUser.username}";`);
      }
    });

    // 去重保持执行精简
    return Array.from(new Set(sqls));
  };

  const handleApplyRolePrivileges = async () => {
    if (!selectedUser) return;

    // PostgreSQL 规则防呆校验：如果是超级管理员但尝试剥夺单表权限，进行明确阻断式提示
    if (selectedUser.isSuperuser) {
      const hasUncheckedTablePriv = Object.values(tablePrivileges).some(
        (t) => !t.select || !t.insert || !t.update || !t.delete || !t.truncate || !t.references || !t.trigger
      );
      if (hasUncheckedTablePriv) {
        const proceed = confirm(
          `⚠️ PostgreSQL 核心机制提示：\n\n用户 "${selectedUser.username}" 当前仍保留【超级管理员 (SUPERUSER)】属性！\n\n在 PostgreSQL 中，超级管理员在内核级别无视任何单表或 Schema 的 REVOKE 约束（探查时依然会拥有全部权限）。\n\n💡 若要真正限制其单表权限，请先在「角色基本特权」页签中取消其 SUPERUSER 特权。\n\n是否仍然继续执行变更？`
        );
        if (!proceed) return;
      }
    }

    setIsApplying(true);
    const sqlStatements = generateSqlStatements();
    const errors: string[] = [];
    
    for (const stmt of sqlStatements) {
      try {
        await executeSql(connId, stmt);
      } catch (e: any) {
        console.error('SQL Execution Failed:', stmt, e);
        errors.push(`• ${stmt}\n  原因: ${e.message || String(e)}`);
      }
    }
    
    if (errors.length > 0) {
      alert(`⚠️ 数据库执行了部分语句，但有以下错误：\n\n${errors.join('\n\n')}`);
    } else {
      if (selectedUser.isSuperuser) {
        alert(
          `ℹ️ SQL 执行成功！\n\n提示：由于 "${selectedUser.username}" 是超级管理员 (SUPERUSER)，PostgreSQL 内核依然会授予其物理全权。如需隔离表权限，请在基本特权中降级为普通角色。`
        );
      } else {
        alert(`✅ 用户 "${selectedUser.username}" 模式与表级权限已成功在 PostgreSQL 数据库中生效！`);
      }
    }
    
    await fetchRealPrivileges(selectedUser.username);
    setIsApplying(false);
  };

  const handleToggleTablePrivilege = (key: string, field: keyof Omit<TablePrivilege, 'schemaName' | 'tableName'>) => {
    setTablePrivileges((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return {
        ...prev,
        [key]: {
          ...current,
          [field]: !current[field],
        },
      };
    });
  };

  // 快捷批量预设模板应用到特定表或全部表
  const applyTableTemplate = (targetKey: string | 'ALL_FILTERED', template: 'READ_ONLY' | 'READ_WRITE' | 'ALL' | 'REVOKE_ALL') => {
    setTablePrivileges((prev) => {
      const next = { ...prev };
      const keysToUpdate =
        targetKey === 'ALL_FILTERED'
          ? Object.keys(next).filter((k) => {
              const tbl = next[k];
              const matchesSchema = selectedSchemaFilter === 'ALL' || tbl.schemaName === selectedSchemaFilter;
              const matchesSearch = tbl.tableName.toLowerCase().includes(tableSearchFilter.toLowerCase());
              return matchesSchema && matchesSearch;
            })
          : [targetKey];

      keysToUpdate.forEach((k) => {
        if (!next[k]) return;
        if (template === 'READ_ONLY') {
          next[k] = { ...next[k], select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false };
        } else if (template === 'READ_WRITE') {
          next[k] = { ...next[k], select: true, insert: true, update: true, delete: true, truncate: false, references: false, trigger: false };
        } else if (template === 'ALL') {
          next[k] = { ...next[k], select: true, insert: true, update: true, delete: true, truncate: true, references: true, trigger: true };
        } else if (template === 'REVOKE_ALL') {
          next[k] = { ...next[k], select: false, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false };
        }
      });
      return next;
    });
  };

  const handleResetPasswordCommit = async () => {
    if (!resetPwdUser || !resetPassword) return;
    try {
      const sql = `ALTER ROLE "${resetPwdUser}" WITH PASSWORD '${resetPassword}';`;
      await executeSql(connId, sql);
      alert(`✅ 用户 "${resetPwdUser}" 密码重置成功！`);
      setResetPwdUser(null);
      setResetPassword('');
    } catch (err: any) {
      alert(`❌ 重置密码失败: ${err.message || String(err)}`);
    }
  };

  const handleTogglePrivilege = (schema: string, field: keyof Omit<SchemaPrivilege, 'isSystemSchema'>) => {
    setPrivilegeMatrix((prev) => {
      const current = prev[schema] || { usage: false, create: false, select: false, insert: false, update: false, delete: false, truncate: false };
      const nextVal = !current[field];
      const updated = { ...current, [field]: nextVal };
      if (field !== 'usage' && nextVal) updated.usage = true;
      return { ...prev, [schema]: updated };
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div className="bg-[#101216] border border-slate-800 rounded-3xl w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl overflow-hidden font-sans">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#14171d]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">User & Privilege Manager (PostgreSQL 角色与权限管理中心)</h2>
                {connName && (
                  <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-mono text-xs border border-blue-500/30">
                    {connName}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">遵循 PostgreSQL ACL 授权机制与系统目录规范，严密管理模式访问与表级数据读写</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 border-r border-slate-800 bg-[#12141a] overflow-y-auto p-2">
            {users.map((u) => (
              <div
                key={u.username}
                onClick={() => handleSelectUser(u)}
                className={`p-2.5 rounded-xl cursor-pointer flex items-center justify-between transition-colors ${selectedUser?.username === u.username ? 'bg-blue-600/15 border border-blue-500/40' : 'hover:bg-slate-800/40 border border-transparent'}`}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${u.isSuperuser ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>
                    {u.isSuperuser ? <Shield className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                  </div>
                  <div className="truncate">
                    <div className="font-mono text-xs font-bold text-slate-200 truncate">{u.username}</div>
                    <div className="text-[10px] text-slate-500">{u.isSuperuser ? 'SUPERUSER' : '普通用户'}</div>
                  </div>
                </div>
                {u.username !== 'postgres' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteUser(u.username);
                    }}
                    className="p-1 hover:bg-red-500/20 text-slate-600 hover:text-red-400 rounded transition-colors"
                    title="删除此角色"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {selectedUser ? (
            <div className="flex-1 flex flex-col bg-[#14171d]">
              {/* Top Navigation Tabs */}
              <div className="flex items-center gap-2 p-3 border-b border-slate-800 bg-[#12141a]">
                {[
                  { id: 'general', label: '角色基本特权 (Role Attributes)' },
                  { id: 'schema_privs', label: 'Schema 模式级授权 (USAGE / CREATE)' },
                  { id: 'table_privs', label: '表级细粒度控制 (Table CRUD / DCL)' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                      activeTab === tab.id
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                    }`}
                  >
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 p-5 overflow-y-auto space-y-5">
                {/* TAB 1: 角色系统全局特权 */}
                {activeTab === 'general' && (
                  <div className="space-y-5">
                    <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl flex items-center justify-between">
                      <div>
                        <h3 className="font-bold text-sm text-white font-mono flex items-center gap-2">
                          <span>User: {selectedUser.username}</span>
                          {selectedUser.isSuperuser && (
                            <span className="text-xs font-sans text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/30">
                              超级管理员
                            </span>
                          )}
                        </h3>
                        <p className="text-[11px] text-slate-400 mt-1">控制该角色的系统级特权、数据库创建权限与登录授权</p>
                      </div>

                      <button
                        onClick={() => setResetPwdUser(selectedUser.username)}
                        className="px-3.5 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-xl text-amber-300 font-semibold text-xs flex items-center gap-1.5 shadow-md transition-colors"
                      >
                        <KeyRound className="w-4 h-4 text-amber-400" />
                        <span>重置账户密码</span>
                      </button>
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-bold text-slate-300">Global Role Privileges (PostgreSQL 角色特权属性)</h4>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { key: 'isSuperuser', title: 'Superuser (SUPERUSER)', desc: '拥有 PostgreSQL 最高全局越权控制，无视一切 ACL 约束' },
                          { key: 'canCreateDb', title: 'Create DB (CREATEDB)', desc: '允许在当前实例创建全新数据库 (CREATE DATABASE)' },
                          { key: 'canCreateRole', title: 'Create Roles (CREATEROLE)', desc: '允许创建、修改并授权其他子角色与用户' },
                          { key: 'canLogin', title: 'Can Login (CANLOGIN)', desc: '允许该角色作为登录账户建立客户端连接与身份鉴权' },
                        ].map((item) => (
                          <label
                            key={item.key}
                            className="p-3 bg-slate-900/40 border border-slate-800/80 rounded-xl flex items-start gap-3 cursor-pointer hover:bg-slate-900/80"
                          >
                            <input
                              type="checkbox"
                              checked={Boolean((selectedUser as any)[item.key])}
                              onChange={(e) => {
                                const next = { ...selectedUser, [item.key]: e.target.checked };
                                setSelectedUser(next);
                                setUsers(users.map((u) => (u.username === next.username ? next : u)));
                              }}
                              className="mt-0.5 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-0"
                            />
                            <div>
                              <div className="font-bold text-white text-xs">{item.title}</div>
                              <div className="text-[10px] text-slate-400">{item.desc}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 2: 模式级授权 (Schema Privileges) */}
                {activeTab === 'schema_privs' && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-slate-300 flex items-center gap-2">
                          <span>PostgreSQL Schema 模式级特权 (USAGE & CREATE)</span>
                          {isFetchingPrivileges && (
                            <span className="text-[10px] text-blue-400 font-mono flex items-center gap-1 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              正在实时检索数据库...
                            </span>
                          )}
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          控制是否允许解析访问 Schema 下对象 (USAGE) 以及在 Schema 下新建表/视图 (CREATE)
                        </p>
                      </div>

                      <button
                        onClick={() => selectedUser && fetchRealPrivileges(selectedUser.username)}
                        disabled={isFetchingPrivileges}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors border border-slate-700"
                        title="立即从数据库重新探查当前用户的最新权限"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isFetchingPrivileges ? 'animate-spin text-blue-400' : ''}`} />
                        <span>重新探查权限</span>
                      </button>
                    </div>

                    <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-900/40">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-950/80 text-slate-400 font-bold border-b border-slate-800 text-[11px]">
                            <th className="p-3">Schema Name</th>
                            <th className="p-3 text-center bg-blue-950/30 text-blue-300 border-x border-slate-800/50" title="允许访问该模式下的对象 (USAGE)">
                              USAGE (模式访问与解析)
                            </th>
                            <th className="p-3 text-center bg-blue-950/30 text-blue-300 border-r border-slate-800/50" title="允许在该模式下新建表/视图等对象 (CREATE)">
                              CREATE (建表/视图 DDL)
                            </th>
                            <th className="p-3 text-center">全表默认 SELECT</th>
                            <th className="p-3 text-center">全表默认 INSERT</th>
                            <th className="p-3 text-center">全表默认 UPDATE</th>
                            <th className="p-3 text-center">全表默认 DELETE</th>
                            <th className="p-3 text-center">全表默认 TRUNCATE</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                          {Object.keys(privilegeMatrix).map((sch) => {
                            const priv = privilegeMatrix[sch];
                            const isSys = priv?.isSystemSchema;
                            return (
                              <tr key={sch} className={`hover:bg-slate-800/30 ${isSys ? 'opacity-60 bg-slate-950/30' : ''}`}>
                                <td className="p-3 font-bold text-amber-300 flex items-center gap-1.5">
                                  <span>{sch}</span>
                                  {isSys && (
                                    <span className="text-[9px] px-1 bg-slate-800 text-slate-400 rounded font-normal font-sans">
                                      系统内置
                                    </span>
                                  )}
                                </td>
                                
                                <td className="p-3 text-center bg-blue-950/15 border-x border-slate-800/40">
                                  <input
                                    type="checkbox"
                                    disabled={isSys || selectedUser.isSuperuser}
                                    checked={!!priv?.usage}
                                    onChange={() => handleTogglePrivilege(sch, 'usage')}
                                    className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                                  />
                                </td>
                                <td className="p-3 text-center bg-blue-950/15 border-r border-slate-800/40">
                                  <input
                                    type="checkbox"
                                    disabled={isSys || selectedUser.isSuperuser}
                                    checked={!!priv?.create}
                                    onChange={() => handleTogglePrivilege(sch, 'create')}
                                    className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                                  />
                                </td>

                                {(['select', 'insert', 'update', 'delete', 'truncate'] as const).map((field) => (
                                  <td key={field} className="p-3 text-center">
                                    <input
                                      type="checkbox"
                                      disabled={isSys || selectedUser.isSuperuser}
                                      checked={!!priv?.[field]}
                                      onChange={() => handleTogglePrivilege(sch, field)}
                                      className="rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                                    />
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* TAB 3: 表级细粒度控制 (Granular Table-Level Privileges) */}
                {activeTab === 'table_privs' && (
                  <div className="space-y-4">
                    {/* Superuser Warning Banner */}
                    {selectedUser.isSuperuser && (
                      <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-start gap-3 shadow-inner">
                        <Shield className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div className="text-xs space-y-1">
                          <div className="font-bold text-amber-200">
                            当前用户属于超级管理员 (SUPERUSER) —— PostgreSQL 内核特权规则说明
                          </div>
                          <div className="text-[11px] text-amber-300/80 leading-relaxed">
                            根据 PostgreSQL 官方内核规范，超级用户在底层自动越过（Bypass）所有 Schema 及单表级 ACL 访问控制。
                            即使对超级用户执行 <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-200 font-mono">REVOKE ALL</code>，其探查结果依然会保持全权。
                            <strong>如需限制该角色的表级权限，请先在「角色基本特权」页签中取消其【超级管理员 (SUPERUSER)】勾选。</strong>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Header + Search + Schema Filter + Preset Actions */}
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h4 className="font-bold text-slate-300 flex items-center gap-2">
                            <span>PostgreSQL 细粒度表级权限控制 (Table-Level Privileges)</span>
                            <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-mono">
                              共探查到 {Object.keys(tablePrivileges).length} 张表
                            </span>
                          </h4>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            支持按物理数据表/视图独立配置 CRUD、清空、外键引用与触发器权限
                          </p>
                        </div>

                        {/* 一键快捷批量赋权模板 */}
                        <div className="flex items-center gap-1.5 bg-slate-900/90 border border-slate-800 p-1 rounded-xl">
                          <span className="text-[10px] text-slate-400 px-2 font-semibold">批量模板:</span>
                          <button
                            onClick={() => applyTableTemplate('ALL_FILTERED', 'READ_ONLY')}
                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded text-[10px] font-bold transition-all border border-slate-700"
                            title="对当前过滤视图下的全部表赋予 SELECT 只读权限"
                          >
                            只读 (ReadOnly)
                          </button>
                          <button
                            onClick={() => applyTableTemplate('ALL_FILTERED', 'READ_WRITE')}
                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded text-[10px] font-bold transition-all border border-slate-700"
                            title="对当前过滤视图下的全部表赋予 SELECT + INSERT + UPDATE + DELETE 读写权限"
                          >
                            读写 (ReadWrite)
                          </button>
                          <button
                            onClick={() => applyTableTemplate('ALL_FILTERED', 'ALL')}
                            className="px-2 py-1 bg-blue-600/80 hover:bg-blue-500 text-white rounded text-[10px] font-bold transition-all shadow"
                            title="赋予全部表级特权 (ALL PRIVILEGES)"
                          >
                            全权 (ALL)
                          </button>
                          <button
                            onClick={() => applyTableTemplate('ALL_FILTERED', 'REVOKE_ALL')}
                            className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-[10px] font-bold transition-all border border-red-500/30"
                            title="清空当前过滤视图下的所有表权限"
                          >
                            清空 (Revoke)
                          </button>
                        </div>
                      </div>

                      {/* Filter Bar: Schema Select + Table Search */}
                      <div className="flex items-center gap-3">
                        <select
                          value={selectedSchemaFilter}
                          onChange={(e) => setSelectedSchemaFilter(e.target.value)}
                          className="px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-blue-500/70"
                        >
                          <option value="ALL">全部 Schema ({Object.keys(privilegeMatrix).length})</option>
                          {Object.keys(privilegeMatrix).map((sch) => (
                            <option key={sch} value={sch}>
                              Schema: {sch}
                            </option>
                          ))}
                        </select>

                        <div className="relative flex-1">
                          <input
                            type="text"
                            value={tableSearchFilter}
                            onChange={(e) => setTableSearchFilter(e.target.value)}
                            placeholder="快速搜索过滤表名 (如 approval_instances, users, orders)..."
                            className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/70"
                          />
                          {tableSearchFilter && (
                            <button
                              onClick={() => setTableSearchFilter('')}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Table-Level Privileges Matrix Table */}
                    <div className="border border-slate-800 rounded-2xl overflow-hidden bg-slate-900/40 max-h-[420px] overflow-y-auto">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur shadow">
                          <tr className="text-slate-400 font-bold border-b border-slate-800 text-[11px]">
                            <th className="p-3">Schema</th>
                            <th className="p-3">Table Name (物理表/视图)</th>
                            <th className="p-3 text-center text-cyan-300">SELECT (读)</th>
                            <th className="p-3 text-center text-emerald-300">INSERT (增)</th>
                            <th className="p-3 text-center text-amber-300">UPDATE (改)</th>
                            <th className="p-3 text-center text-rose-300">DELETE (删)</th>
                            <th className="p-3 text-center text-purple-300">TRUNCATE (截断)</th>
                            <th className="p-3 text-center text-blue-300">REFERENCES (外键)</th>
                            <th className="p-3 text-center text-indigo-300">TRIGGER (触发器)</th>
                            <th className="p-3 text-center">快捷设置</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                          {Object.keys(tablePrivileges)
                            .filter((key) => {
                              const tbl = tablePrivileges[key];
                              const matchesSchema = selectedSchemaFilter === 'ALL' || tbl.schemaName === selectedSchemaFilter;
                              const matchesSearch = tbl.tableName.toLowerCase().includes(tableSearchFilter.toLowerCase());
                              return matchesSchema && matchesSearch;
                            })
                            .map((key) => {
                              const tbl = tablePrivileges[key];
                              return (
                                <tr key={key} className="hover:bg-slate-800/40 transition-colors">
                                  <td className="p-3 text-slate-400 text-[11px] font-sans">{tbl.schemaName}</td>
                                  <td className="p-3 font-bold text-amber-300">{tbl.tableName}</td>

                                  {(['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const).map(
                                    (field) => (
                                      <td key={field} className="p-3 text-center">
                                        <input
                                          type="checkbox"
                                          disabled={selectedUser.isSuperuser}
                                          checked={!!tbl[field]}
                                          onChange={() => handleToggleTablePrivilege(key, field)}
                                          className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                                        />
                                      </td>
                                    )
                                  )}

                                  <td className="p-3 text-center">
                                    <div className="flex items-center justify-center gap-1 font-sans">
                                      <button
                                        onClick={() => applyTableTemplate(key, 'READ_ONLY')}
                                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded text-[10px] border border-slate-700"
                                      >
                                        只读
                                      </button>
                                      <button
                                        onClick={() => applyTableTemplate(key, 'READ_WRITE')}
                                        className="px-1.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded text-[10px] border border-slate-700"
                                      >
                                        读写
                                      </button>
                                      <button
                                        onClick={() => applyTableTemplate(key, 'REVOKE_ALL')}
                                        className="px-1.5 py-0.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded text-[10px] border border-red-500/20"
                                      >
                                        清空
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Bottom Footer Actions with Dynamic SQL Preview */}
              <div className="p-4 border-t border-slate-800/80 bg-slate-950/60 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 overflow-hidden max-w-xl truncate">
                  <Shield className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="truncate">
                    SQL: <code className="text-amber-300 font-bold">{generateSqlStatements()[0] || '-- No changes'}</code>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 font-semibold">
                    取消
                  </button>
                  <button
                    disabled={isApplying}
                    onClick={handleApplyRolePrivileges}
                    className="px-5 py-2 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 disabled:opacity-50 text-white rounded-xl font-bold shadow-lg shadow-blue-500/20 flex items-center gap-1.5 transition-all"
                  >
                    {isApplying ? (
                      <RefreshCw className="w-4 h-4 animate-spin text-white" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    <span>{isApplying ? '正在物理执行变更 SQL...' : '执行权限变更 SQL'}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500 font-semibold">
              请在左侧选择一个用户查看并管理权限
            </div>
          )}
        </div>

        {/* Modal inside Modal: Add New User */}
        {showAddUserModal && (
          <div className="absolute inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <div className="bg-[#181b22] border border-slate-700/90 rounded-2xl w-full max-w-md p-5 text-xs text-slate-200 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="font-bold text-sm text-white flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-blue-400" />
                  新建数据库用户 (Create New Role)
                </span>
                <button onClick={() => setShowAddUserModal(false)}>✕</button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-slate-400 mb-1">Username (用户名)</label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="e.g. dev_readonly_user"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Password (初始密码)</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 font-mono"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={newIsSuperuser}
                    onChange={(e) => setNewIsSuperuser(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-950 text-blue-600"
                  />
                  <span>赋予超级管理员 (SUPERUSER) 特权</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button onClick={() => setShowAddUserModal(false)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300">
                  取消
                </button>
                <button
                  onClick={handleAddUser}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-md"
                >
                  创建用户
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal inside Modal: Reset Password */}
        {resetPwdUser && (
          <div className="absolute inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <div className="bg-[#181b22] border border-amber-500/40 rounded-2xl w-full max-w-md p-5 text-xs text-slate-200 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="font-bold text-sm text-amber-300 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-amber-400" />
                  重置用户密码 ({resetPwdUser})
                </span>
                <button onClick={() => setResetPwdUser(null)}>✕</button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-slate-400 mb-1">New Password (新密码)</label>
                  <input
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    placeholder="请输入新密码..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-100 font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button onClick={() => setResetPwdUser(null)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300">
                  取消
                </button>
                <button
                  onClick={handleResetPasswordCommit}
                  className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-bold shadow-md flex items-center gap-1"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>确认物理修改密码</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
