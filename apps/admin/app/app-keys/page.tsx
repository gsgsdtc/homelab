"use client";

import type { AppKey } from "@homelab/views";
import { FormEvent, useEffect, useState } from "react";
import { AuthShell } from "../components/auth-shell";
import { api } from "../lib/api";

export default function AppKeysPage() {
  const [items, setItems] = useState<AppKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api.listAppKeys());
    } catch {
      setError("AppKey 列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <AuthShell>
      <section className="page-header">
        <div>
          <p className="eyebrow">AppKeys</p>
          <h2>AppKey 管理</h2>
        </div>
        <button onClick={() => setCreateOpen(true)} type="button">
          创建 AppKey
        </button>
      </section>

      <div className="notice">
        当前后端支持列表、创建和吊销；权限范围在创建时写入，编辑权限范围与重新启用需要后端补充接口。
      </div>
      {newKey ? (
        <div className="secret-box">
          <strong>新 AppKey 仅显示一次</strong>
          <code>{newKey}</code>
        </div>
      ) : null}
      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">加载中...</div> : null}
      {!loading && items.length === 0 ? <div className="empty-state">暂无 AppKey</div> : null}
      {!loading && items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Agent</th>
                <th>范围</th>
                <th>状态</th>
                <th>过期时间</th>
                <th>最后使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.agentName || "-"}</td>
                  <td>{item.scopes.length ? item.scopes.join(", ") : "未限制"}</td>
                  <td>
                    <span className={item.isActive ? "status on" : "status off"}>
                      {item.isActive ? "启用" : "已吊销"}
                    </span>
                  </td>
                  <td>{formatDate(item.expiresAt)}</td>
                  <td>{formatDate(item.lastUsedAt)}</td>
                  <td className="actions">
                    <button
                      className="danger"
                      disabled={!item.isActive}
                      onClick={async () => {
                        if (window.confirm(`吊销 ${item.name}？`)) {
                          await api.revokeAppKey(item.id);
                          await load();
                        }
                      }}
                      type="button"
                    >
                      吊销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {createOpen ? (
        <AppKeyDialog
          onClose={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            const result = await api.createAppKey(payload);
            setNewKey(result.key);
            setCreateOpen(false);
            await load();
          }}
        />
      ) : null}
    </AuthShell>
  );
}

function AppKeyDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (payload: { name: string; agentName?: string; scopes?: string[]; expiresAt?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [scopes, setScopes] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (name.trim().length < 2) {
      setError("名称至少 2 位");
      return;
    }
    try {
      await onSubmit({
        name: name.trim(),
        agentName: agentName.trim() || undefined,
        scopes: scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined
      });
    } catch {
      setError("创建失败，请重试");
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h3>创建 AppKey</h3>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Agent 名称
          <input value={agentName} onChange={(event) => setAgentName(event.target.value)} />
        </label>
        <label>
          权限范围
          <input value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="逗号分隔" />
        </label>
        <label>
          过期时间
          <input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit">创建</button>
        </div>
      </form>
    </div>
  );
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}
