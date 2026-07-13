"use client";

import type { Agent, AgentGitStatus, AgentStatus } from "@homelab/views";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthShell } from "../components/auth-shell";
import { api } from "../lib/api";

const statusText: Record<AgentStatus, string> = {
  initializing: "初始化中",
  ready: "可用",
  init_failed: "初始化失败",
};

const gitStatusText: Record<AgentGitStatus, string> = {
  available: "可用",
  unavailable: "不可用",
  dirty: "有未提交变更",
  clean: "无未提交变更",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null,
    [agents, selectedId],
  );

  async function load(nextSelectedId = selectedId) {
    setLoading(true);
    setError("");
    try {
      const nextAgents = await api.listAgents();
      setAgents(nextAgents);
      if (nextAgents.length === 0) {
        setSelectedId("");
      } else if (
        nextSelectedId &&
        nextAgents.some((agent) => agent.id === nextSelectedId)
      ) {
        setSelectedId(nextSelectedId);
      } else {
        setSelectedId(nextAgents[0].id);
      }
    } catch {
      setError("Agent 列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function retryInitialization(agent: Agent) {
    setBusyId(agent.id);
    setError("");
    try {
      const retried = await api.retryAgentInitialization(agent.id);
      setAgents((current) =>
        current.map((item) => (item.id === retried.id ? retried : item)),
      );
      setSelectedId(retried.id);
    } catch {
      setError("重试初始化失败");
    } finally {
      setBusyId("");
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  return (
    <AuthShell>
      <section className="page-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h2>Agent 管理</h2>
        </div>
        <button onClick={() => setCreateOpen(true)} type="button">
          新增 Agent
        </button>
      </section>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">加载中...</div> : null}

      {!loading && agents.length === 0 ? (
        <div className="empty-state">暂无 Agent</div>
      ) : null}
      {!loading && agents.length > 0 ? (
        <div className="agents-layout">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>状态</th>
                  <th>Workspace</th>
                  <th>Git</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td data-label="名称">{agent.name}</td>
                    <td data-label="状态">
                      <StatusBadge status={agent.status} />
                    </td>
                    <td data-label="Workspace">
                      <code className="inline-code">
                        {agent.workspaceName || "-"}
                      </code>
                    </td>
                    <td data-label="Git">{formatGitStatus(agent.gitStatus)}</td>
                    <td className="actions" data-label="操作">
                      <button
                        onClick={() => setSelectedId(agent.id)}
                        type="button"
                      >
                        详情
                      </button>
                      <button disabled={agent.status !== "ready"} type="button">
                        运行
                      </button>
                      {agent.status === "init_failed" ? (
                        <button
                          disabled={busyId === agent.id}
                          onClick={() => retryInitialization(agent)}
                          type="button"
                        >
                          {busyId === agent.id ? "重试中" : "重试初始化"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <section className="detail-panel" aria-label="Agent 详情">
              <div className="detail-title">
                <div>
                  <p className="eyebrow">Agent Detail</p>
                  <h3>{selected.name}</h3>
                </div>
                <StatusBadge status={selected.status} />
              </div>
              <dl className="detail-list">
                <div>
                  <dt>ID</dt>
                  <dd>{selected.id}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{formatStatus(selected.status)}</dd>
                </div>
                <div>
                  <dt>Workspace 名称</dt>
                  <dd>{selected.workspaceName || "-"}</dd>
                </div>
                <div>
                  <dt>Workspace 路径</dt>
                  <dd>{selected.workspacePath || "-"}</dd>
                </div>
                <div>
                  <dt>Git 状态</dt>
                  <dd>{formatGitStatus(selected.gitStatus)}</dd>
                </div>
                <div>
                  <dt>失败原因</dt>
                  <dd>{selected.initError?.message || "-"}</dd>
                </div>
              </dl>
              <div className="detail-actions">
                <button disabled={selected.status !== "ready"} type="button">
                  运行
                </button>
                {selected.status === "init_failed" ? (
                  <button
                    disabled={busyId === selected.id}
                    onClick={() => retryInitialization(selected)}
                    type="button"
                  >
                    {busyId === selected.id ? "重试中" : "重试初始化"}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {createOpen ? (
        <AgentDialog
          onClose={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            const created = await api.createAgent(payload);
            setCreateOpen(false);
            await load(created.id);
          }}
        />
      ) : null}
    </AuthShell>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const className =
    status === "ready"
      ? "status on"
      : status === "init_failed"
        ? "status danger-status"
        : "status off";
  return <span className={className}>{formatStatus(status)}</span>;
}

function AgentDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    slug?: string;
    modelProvider?: string;
    modelSecretRef?: string;
    soul?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelSecretRef, setModelSecretRef] = useState("");
  const [soul, setSoul] = useState("");
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
        slug: slug.trim() || undefined,
        modelProvider: modelProvider.trim() || undefined,
        modelSecretRef: modelSecretRef.trim() || undefined,
        soul: soul.trim() || undefined,
      });
    } catch {
      setError("创建失败，请重试");
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal wide-modal" onSubmit={submit}>
        <h3>新增 Agent</h3>
        <label>
          名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          标识
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label>
          模型提供方
          <input
            value={modelProvider}
            onChange={(event) => setModelProvider(event.target.value)}
          />
        </label>
        <label>
          Secret 引用
          <input
            value={modelSecretRef}
            onChange={(event) => setModelSecretRef(event.target.value)}
          />
        </label>
        <label>
          Soul
          <textarea
            value={soul}
            onChange={(event) => setSoul(event.target.value)}
            rows={6}
          />
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

function formatStatus(status: AgentStatus) {
  return statusText[status] ?? status;
}

function formatGitStatus(status: AgentGitStatus) {
  return gitStatusText[status] ?? status;
}
