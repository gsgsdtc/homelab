"use client";

import type { PublicUser, UserRole } from "@homelab/views";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthShell } from "../components/auth-shell";
import { api } from "../lib/api";

const pageSize = 10;

export default function UsersPage() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function load(nextPage = page, q = query) {
    setLoading(true);
    setError("");
    try {
      const result = await api.listUsers({ q, page: nextPage, pageSize });
      setUsers(result.items);
      setTotal(result.total);
      setPage(result.page);
    } catch {
      setError("用户列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1, "");
  }, []);

  const emptyText = useMemo(() => (query ? "没有匹配的用户" : "暂无用户"), [query]);

  return (
    <AuthShell>
      <section className="page-header">
        <div>
          <p className="eyebrow">Users</p>
          <h2>用户管理</h2>
        </div>
        <button onClick={() => setCreateOpen(true)} type="button">
          新增用户
        </button>
      </section>

      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void load(1, query);
        }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户名" />
        <button type="submit">查询</button>
      </form>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">加载中...</div> : null}

      {!loading && users.length === 0 ? <div className="empty-state">{emptyText}</div> : null}
      {!loading && users.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>{user.role}</td>
                  <td>
                    <span className={user.isActive ? "status on" : "status off"}>
                      {user.isActive ? "启用" : "禁用"}
                    </span>
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td className="actions">
                    <button onClick={() => setEditing(user)} type="button">
                      编辑
                    </button>
                    <button
                      onClick={async () => {
                        await api.updateUser(user.id, { isActive: !user.isActive });
                        await load();
                      }}
                      type="button"
                    >
                      {user.isActive ? "禁用" : "启用"}
                    </button>
                    <button
                      onClick={async () => {
                        const password = window.prompt("输入新密码，至少 8 位");
                        if (password) {
                          await api.resetPassword(user.id, password);
                        }
                      }}
                      type="button"
                    >
                      重置密码
                    </button>
                    <button
                      className="danger"
                      onClick={async () => {
                        if (window.confirm(`删除用户 ${user.username}？`)) {
                          await api.deleteUser(user.id);
                          await load();
                        }
                      }}
                      type="button"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="pagination">
        <button disabled={page <= 1} onClick={() => load(page - 1)} type="button">
          上一页
        </button>
        <span>
          {page} / {pageCount}
        </span>
        <button disabled={page >= pageCount} onClick={() => load(page + 1)} type="button">
          下一页
        </button>
      </div>

      {createOpen ? (
        <UserDialog
          title="新增用户"
          onClose={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            await api.createUser({ ...payload, password: payload.password || "" });
            setCreateOpen(false);
            await load(1);
          }}
        />
      ) : null}
      {editing ? (
        <UserDialog
          title="编辑用户"
          user={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (payload) => {
            await api.updateUser(editing.id, {
              username: payload.username,
              role: payload.role,
              isActive: payload.isActive
            });
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </AuthShell>
  );
}

function UserDialog({
  title,
  user,
  onClose,
  onSubmit
}: {
  title: string;
  user?: PublicUser;
  onClose: () => void;
  onSubmit: (payload: { username: string; password?: string; role: UserRole; isActive: boolean }) => Promise<void>;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(user?.role ?? "USER");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (username.trim().length < 3) {
      setError("用户名至少 3 位");
      return;
    }
    if (!user && password.length < 8) {
      setError("初始密码至少 8 位");
      return;
    }
    try {
      await onSubmit({ username: username.trim(), password, role, isActive });
    } catch {
      setError("保存失败，请重试");
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h3>{title}</h3>
        <label>
          用户名
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        {!user ? (
          <label>
            初始密码
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
          </label>
        ) : null}
        <label>
          角色
          <select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </label>
        <label className="check-row">
          <input checked={isActive} onChange={(event) => setIsActive(event.target.checked)} type="checkbox" />
          启用账号
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit">保存</button>
        </div>
      </form>
    </div>
  );
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}
