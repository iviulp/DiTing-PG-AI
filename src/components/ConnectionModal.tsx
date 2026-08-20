import React, { useState, useEffect } from 'react';
import { ConnectionConfig, DatabaseType } from '../types';
import { connectDb } from '../services/ipc';
import { Shield, Key, Lock, CheckCircle2, AlertCircle } from 'lucide-react';


interface ConnectionModalProps {
  isOpen: boolean;
  editingConfig?: ConnectionConfig | null;
  isDuplicate?: boolean;
  onClose: () => void;
  onSave: (config: ConnectionConfig, isDuplicate?: boolean) => void;
}


/**
 * TablePlus 级别的大厂顶级连接配置与编辑面板
 * 支持 SSH 隧道配置、SSL 握手模式、环境色块标签、双弹窗编辑与连接测试 (Test Connection)
 */
export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  isOpen,
  editingConfig,
  isDuplicate,
  onClose,
  onSave,
}) => {

  const [dbType, setDbType] = useState<DatabaseType>('postgres');
  const [name, setName] = useState('New Postgres Connection');
  const [groupName, setGroupName] = useState('个人本地');
  const [colorLabel, setColorLabel] = useState('#3b82f6');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(5432);
  const [user, setUser] = useState('postgres');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('postgres');
  const [envTag, setEnvTag] = useState<'PROD' | 'DEV' | 'TEST'>('DEV');
  const [readOnly, setReadOnly] = useState(false);
  const [sslMode, setSslMode] = useState<'disable' | 'require' | 'verify-ca' | 'verify-full'>('disable');

  // SSH Tunnel State (支持单跳与堡垒机跳板二次 Jump Server 链式代理)
  const [sshEnabled, setSshEnabled] = useState(false);
  const [tunnelType, setTunnelType] = useState<'direct' | 'bastion_jump'>('direct');
  
  // 第一重：堡垒机 / 跳板机 (Bastion Jump Host)
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('root');
  const [sshAuthType, setSshAuthType] = useState<'password' | 'private_key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshPrivateKeyPath, setSshPrivateKeyPath] = useState('~/.ssh/id_rsa');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [sshOtpSecret, setSshOtpSecret] = useState('');
  const [sshOtpCode, setSshOtpCode] = useState('');

  // 第二重：目标内网 SSH 机器 (Target Internal Host)
  const [targetSshHost, setTargetSshHost] = useState('');
  const [targetSshPort, setTargetSshPort] = useState(22);
  const [targetSshUser, setTargetSshUser] = useState('root');
  const [targetAuthType, setTargetAuthType] = useState<'password' | 'private_key'>('password');
  const [targetSshPassword, setTargetSshPassword] = useState('');
  const [targetSshPrivateKeyPath, setTargetSshPrivateKeyPath] = useState('~/.ssh/id_rsa');

  const [activeTab, setActiveTab] = useState<'general' | 'ssh'>('general');
  const [testStatus, setTestStatus] = useState<{ testing: boolean; message: string | null; success: boolean | null }>({
    testing: false,
    message: null,
    success: null,
  });

  useEffect(() => {
    if (editingConfig) {
      setDbType(editingConfig.db_type);
      setName(editingConfig.name);
      setGroupName(editingConfig.group_name || '个人本地');
      setColorLabel(editingConfig.color_label || '#3b82f6');
      setHost(editingConfig.host);
      setPort(editingConfig.port);
      setUser(editingConfig.user);
      setPassword(editingConfig.password || '');
      setDatabase(editingConfig.database);
      setEnvTag(editingConfig.env_tag || 'DEV');
      setReadOnly(editingConfig.read_only);
      setSslMode(editingConfig.ssl_mode || 'disable');

      if (editingConfig.ssh_tunnel) {
        setSshEnabled(editingConfig.ssh_tunnel.enabled);
        setTunnelType(editingConfig.ssh_tunnel.tunnel_type || 'direct');
        setSshHost(editingConfig.ssh_tunnel.ssh_host);
        setSshPort(editingConfig.ssh_tunnel.ssh_port);
        setSshUser(editingConfig.ssh_tunnel.ssh_user);
        setSshAuthType(editingConfig.ssh_tunnel.auth_type);
        setSshPassword(editingConfig.ssh_tunnel.ssh_password || '');
        setSshPrivateKeyPath(editingConfig.ssh_tunnel.ssh_private_key_path || '~/.ssh/id_rsa');
        setSshPassphrase(editingConfig.ssh_tunnel.passphrase || '');
        setSshOtpSecret(editingConfig.ssh_tunnel.otp_secret || '');
        setSshOtpCode(editingConfig.ssh_tunnel.otp_code || '');

        setTargetSshHost(editingConfig.ssh_tunnel.target_ssh_host || '');
        setTargetSshPort(editingConfig.ssh_tunnel.target_ssh_port || 22);
        setTargetSshUser(editingConfig.ssh_tunnel.target_ssh_user || 'root');
        setTargetAuthType(editingConfig.ssh_tunnel.target_auth_type || 'password');
        setTargetSshPassword(editingConfig.ssh_tunnel.target_ssh_password || '');
        setTargetSshPrivateKeyPath(editingConfig.ssh_tunnel.target_ssh_private_key_path || '~/.ssh/id_rsa');
      } else {
        setSshEnabled(false);
      }
    } else {
      // Default new form reset
      setDbType('postgres');
      setName('New Postgres DB');
      setHost('127.0.0.1');
      setPort(5432);
      setUser('postgres');
      setPassword('');
      setDatabase('postgres');
      setEnvTag('DEV');
      setReadOnly(false);
      setSshEnabled(false);
      setTunnelType('direct');
      setSshPassphrase('');
      setSshOtpSecret('');
      setSshOtpCode('');
      setTargetSshHost('');
      setTargetSshPort(22);
      setTargetSshUser('root');
      setTargetAuthType('password');
      setTargetSshPassword('');
      setTargetSshPrivateKeyPath('~/.ssh/id_rsa');
    }
  }, [editingConfig, isOpen]);



  if (!isOpen) return null;

  const handleDbTypeChange = (type: DatabaseType) => {
    setDbType(type);
    if (type === 'postgres') {
      setPort(5432);
      setUser('postgres');
      setName('Postgres DB');
      setColorLabel('#3b82f6');
    } else if (type === 'mysql') {
      setPort(3306);
      setUser('root');
      setName('MySQL DB');
      setColorLabel('#f97316');
    } else if (type === 'sqlite') {
      setPort(0);
      setUser('root');
      setName('SQLite Local');
      setColorLabel('#64748b');
    }
  };

  const handleTestConnection = async () => {
    setTestStatus({ testing: true, message: null, success: null });
    const tempConfig: ConnectionConfig = {
      id: `test_temp_${Date.now()}`,
      name,
      db_type: dbType,
      host,
      port,
      user,
      password: password || undefined,
      database,
      read_only: false,
    };

    try {
      await connectDb(tempConfig);
      setTestStatus({
        testing: false,
        message: 'Connection successful! (Rust SQLx Pool Connected)',
        success: true,
      });
    } catch (err: any) {
      setTestStatus({
        testing: false,
        message: `Test Failed: ${err.message || String(err)}`,
        success: false,
      });
    }
  };


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: ConnectionConfig = {
      id: editingConfig ? editingConfig.id : `conn_${Date.now()}`,
      name,
      db_type: dbType,
      group_name: groupName,
      color_label: colorLabel,
      host,
      port,
      user,
      password: password || undefined,
      database,
      env_tag: envTag,
      ssl_mode: sslMode,
      read_only: readOnly,
      ssh_tunnel: sshEnabled
        ? {
            enabled: true,
            tunnel_type: tunnelType,
            ssh_host: sshHost,
            ssh_port: sshPort,
            ssh_user: sshUser,
            auth_type: sshAuthType,
            ssh_password: sshPassword,
            ssh_private_key_path: sshPrivateKeyPath,
            passphrase: sshPassphrase || undefined,
            otp_secret: sshOtpSecret || undefined,
            otp_code: sshOtpCode || undefined,
            target_ssh_host: tunnelType === 'bastion_jump' ? targetSshHost : undefined,
            target_ssh_port: tunnelType === 'bastion_jump' ? targetSshPort : undefined,
            target_ssh_user: tunnelType === 'bastion_jump' ? targetSshUser : undefined,
            target_auth_type: tunnelType === 'bastion_jump' ? targetAuthType : undefined,
            target_ssh_password: tunnelType === 'bastion_jump' ? targetSshPassword : undefined,
            target_ssh_private_key_path: tunnelType === 'bastion_jump' ? targetSshPrivateKeyPath : undefined,
          }
        : undefined,


    };
    onSave(config, isDuplicate);
    onClose();
  };


  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-[#1e2024] border border-slate-700/80 rounded-2xl w-full max-w-xl text-slate-200 text-xs shadow-2xl overflow-hidden font-sans flex flex-col">
        {/* Header Bar */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-[#181a1d]">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full border border-white/20 shadow-sm"
              style={{ backgroundColor: colorLabel }}
            />
            <h2 className="text-base font-bold text-white">
              {editingConfig ? `Edit Connection: ${editingConfig.name}` : 'New Database Connection'}
            </h2>
          </div>

          <div className="flex items-center gap-2 bg-slate-800 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('general')}
              className={`px-3 py-1 rounded-md font-semibold transition-all ${
                activeTab === 'general' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              General Settings
            </button>
            <button
              onClick={() => setActiveTab('ssh')}
              className={`px-3 py-1 rounded-md font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'ssh' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              SSH Tunnel {sshEnabled && <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
            </button>
          </div>
        </div>

        {/* Modal Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 flex-1">
          {activeTab === 'general' ? (
            <>
              {/* Database Type Select */}
              <div>
                <label className="block text-slate-400 font-semibold mb-2">Database Engine</label>
                <div className="grid grid-cols-3 gap-3">
                  {(['postgres', 'mysql', 'sqlite'] as DatabaseType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleDbTypeChange(type)}
                      className={`p-3 rounded-xl border text-left flex items-center gap-3 transition-all ${
                        dbType === type
                          ? 'border-blue-500 bg-blue-500/10 text-white font-bold shadow-md'
                          : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs text-white ${
                          type === 'postgres' ? 'bg-blue-500' : type === 'mysql' ? 'bg-orange-500' : 'bg-slate-600'
                        }`}
                      >
                        {type === 'postgres' ? 'Pg' : type === 'mysql' ? 'My' : 'Lite'}
                      </div>
                      <span className="capitalize">{type}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Form Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Group (分组)</label>
                  <input
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="个人本地 / 公司测试 / 生产集群"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              {dbType !== 'sqlite' ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-slate-400 mb-1">Host / Server IP</label>
                      <input
                        type="text"
                        required
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Port</label>
                      <input
                        type="number"
                        required
                        value={port}
                        onChange={(e) => setPort(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">User</label>
                      <input
                        type="text"
                        required
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">Database Name</label>
                      <input
                        type="text"
                        required
                        value={database}
                        onChange={(e) => setDatabase(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Environment Badge (防呆标签)</label>
                      <select
                        value={envTag}
                        onChange={(e) => setEnvTag(e.target.value as any)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none"
                      >
                        <option value="DEV">DEV (Green Badge - 绿色测试开发)</option>
                        <option value="TEST">TEST (Yellow Badge - 黄色测试环境)</option>
                        <option value="PROD">PROD (Red Warning - 红色生产警告)</option>

                      </select>
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-slate-400 mb-1">SQLite File Path</label>
                  <input
                    type="text"
                    required
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="/path/to/database.db or :memory:"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:border-blue-500 focus:outline-none font-mono"
                  />
                </div>
              )}

              {/* Safety Read-Only Mode Checkbox */}
              <div className="pt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="readonly"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-0"
                />
                <label htmlFor="readonly" className="text-slate-300 flex items-center gap-1.5 cursor-pointer">
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                  <span>Enable AST Safety Read-Only Mode (Blocks Write/Delete SQL)</span>
                </label>
              </div>
            </>
          ) : (
            /* SSH Tunnel Config Tab */
            <div className="space-y-4">
              <div className="p-3 bg-blue-950/40 border border-blue-800/60 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-blue-400" />
                  <span className="font-semibold text-slate-200">Use SSH Tunnel for Remote Connections</span>
                </div>
                <input
                  type="checkbox"
                  checked={sshEnabled}
                  onChange={(e) => setSshEnabled(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-blue-600"
                />
              </div>

              {sshEnabled && (
                <div className="space-y-4 pt-2 max-h-[380px] overflow-auto pr-1">
                  {/* 代理模式选择 (单跳 vs 堡垒机双跳) */}
                  <div>
                    <label className="block text-slate-400 font-semibold mb-1.5">SSH Tunnel Mode (代理链路模式)</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setTunnelType('direct')}
                        className={`p-2.5 rounded-xl border text-left flex flex-col transition-all ${
                          tunnelType === 'direct'
                            ? 'border-blue-500 bg-blue-500/10 text-white font-bold'
                            : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        <span className="text-xs">Direct SSH Tunnel (单跳代理)</span>
                        <span className="text-[10px] text-slate-400 font-normal">直接连接 SSH 代理机器访问数据库</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setTunnelType('bastion_jump')}
                        className={`p-2.5 rounded-xl border text-left flex flex-col transition-all ${
                          tunnelType === 'bastion_jump'
                            ? 'border-purple-500 bg-purple-500/10 text-white font-bold'
                            : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        <span className="text-xs">Bastion Jump Server (堡垒机跳板)</span>
                        <span className="text-[10px] text-purple-300 font-normal">先登录堡垒机，再二次 Jump 到内网机器</span>
                      </button>
                    </div>
                  </div>

                  {/* 第一重：堡垒机 / 跳板机配置 */}
                  <div className="p-3.5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-3">
                    <div className="text-[11px] font-bold text-blue-400 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>{tunnelType === 'bastion_jump' ? 'Hop 1: Bastion Server (第一重：堡垒机 / 跳板机)' : 'SSH Proxy Server (SSH 代理服务器)'}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-slate-400 mb-1">Bastion Host / IP</label>
                        <input
                          type="text"
                          value={sshHost}
                          onChange={(e) => setSshHost(e.target.value)}
                          placeholder="bastion.company.com"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">Port</label>
                        <input
                          type="number"
                          value={sshPort}
                          onChange={(e) => setSshPort(Number(e.target.value))}
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">SSH User (堡垒机用户名)</label>
                      <input
                        type="text"
                        value={sshUser}
                        onChange={(e) => setSshUser(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Authentication Method</label>
                      <select
                        value={sshAuthType}
                        onChange={(e) => setSshAuthType(e.target.value as any)}
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                      >
                        <option value="password">SSH Password (密码认证)</option>
                        <option value="private_key">SSH Private Key Certificate (私钥证书)</option>
                      </select>
                    </div>

                    {sshAuthType === 'password' ? (
                      <div>
                        <label className="block text-slate-400 mb-1">SSH Password</label>
                        <input
                          type="password"
                          value={sshPassword}
                          onChange={(e) => setSshPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                        />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <label className="block text-slate-400 mb-1">Private Key Certificate Path</label>
                          <input
                            type="text"
                            value={sshPrivateKeyPath}
                            onChange={(e) => setSshPrivateKeyPath(e.target.value)}
                            placeholder="~/.ssh/id_rsa or /path/to/cert.pem"
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Passphrase (证书解密口令 - 可选)</label>
                          <input
                            type="password"
                            value={sshPassphrase}
                            onChange={(e) => setSshPassphrase(e.target.value)}
                            placeholder="Passphrase for private key"
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                      </div>
                    )}

                    {/* OTP / 2FA 支持 */}
                    <div className="pt-2 border-t border-slate-800 space-y-2">
                      <div className="text-[10px] font-bold text-amber-400 flex items-center gap-1">
                        <Key className="w-3 h-3" />
                        <span>OTP / 2FA Secondary Auth (堡垒机双因素动态验证码)</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          type="password"
                          value={sshOtpSecret}
                          onChange={(e) => setSshOtpSecret(e.target.value)}
                          placeholder="TOTP Secret Key"
                          className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono text-[11px]"
                        />
                        <input
                          type="text"
                          value={sshOtpCode}
                          onChange={(e) => setSshOtpCode(e.target.value)}
                          placeholder="6-digit OTP Code"
                          className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono text-[11px]"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 第二重：堡垒机内部跳转到的目标内网 SSH 机器 (Bastion Second Jump) */}
                  {tunnelType === 'bastion_jump' && (
                    <div className="p-3.5 bg-purple-950/20 border border-purple-800/60 rounded-xl space-y-3 animate-in fade-in">
                      <div className="text-[11px] font-bold text-purple-300 flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5 text-purple-400" />
                        <span>Hop 2: Target Internal SSH Machine (第二重：堡垒机登录后的内网目标机器)</span>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className="block text-slate-400 mb-1">Internal Target Host / IP</label>
                          <input
                            type="text"
                            value={targetSshHost}
                            onChange={(e) => setTargetSshHost(e.target.value)}
                            placeholder="10.0.12.88 (堡垒机内网可达的机器 IP)"
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Port</label>
                          <input
                            type="number"
                            value={targetSshPort}
                            onChange={(e) => setTargetSshPort(Number(e.target.value))}
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 mb-1">Target Machine User</label>
                          <input
                            type="text"
                            value={targetSshUser}
                            onChange={(e) => setTargetSshUser(e.target.value)}
                            placeholder="root or deploy"
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Auth Type</label>
                          <select
                            value={targetAuthType}
                            onChange={(e) => setTargetAuthType(e.target.value as any)}
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                          >
                            <option value="password">Password</option>
                            <option value="private_key">Private Key</option>
                          </select>
                        </div>
                      </div>

                      {targetAuthType === 'password' ? (
                        <div>
                          <label className="block text-slate-400 mb-1">Target Machine Password</label>
                          <input
                            type="password"
                            value={targetSshPassword}
                            onChange={(e) => setTargetSshPassword(e.target.value)}
                            placeholder="••••••••"
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-slate-400 mb-1">Target Key Path</label>
                          <input
                            type="text"
                            value={targetSshPrivateKeyPath}
                            onChange={(e) => setTargetSshPrivateKeyPath(e.target.value)}
                            className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}




          {/* Test Status Banner */}
          {testStatus.message && (
            <div
              className={`p-3 rounded-xl border flex items-center gap-2 text-xs ${
                testStatus.success
                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                  : 'bg-red-950/60 border-red-800 text-red-300'
              }`}
            >
              {testStatus.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              <span>{testStatus.message}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testStatus.testing}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-semibold border border-slate-700"
            >
              {testStatus.testing ? 'Testing...' : 'Test Connection'}
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-lg"
              >
                {editingConfig ? 'Save Changes' : 'Connect & Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
