"use client";

import {
  getAgentSoulNotice,
  isAgentSoulSaveDisabled,
  validateAgentSoulDraft,
  type Agent,
  type AgentGitStatus,
  type AgentSoulFileStatus,
  type AgentStatus,
  type PublicUser,
} from "@homelab/views";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<Agent | null>(null);
  const [soulDraft, setSoulDraft] = useState("");
  const [savedSoul, setSavedSoul] = useState("");
  const [soulMessage, setSoulMessage] = useState("");
  const [soulError, setSoulError] = useState("");
  const [savingSoul, setSavingSoul] = useState(false);
  const detailRequestRef = useRef(0);

  const selected = useMemo(
    () =>
      selectedDetail?.id === selectedId
        ? selectedDetail
        : (agents.find((agent) => agent.id === selectedId) ??
          agents[0] ??
          null),
    [agents, selectedDetail, selectedId],
  );
  const canEditSoul = currentUser?.role === "ADMIN";

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

  async function loadAgentDetail(agentId: string) {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    if (!agentId) {
      setSelectedDetail(null);
      setSavedSoul("");
      setSoulDraft("");
      return;
    }
    const fallbackAgent = agents.find((agent) => agent.id === agentId) ?? null;
    setDetailLoading(true);
    setSelectedDetail(null);
    setSavedSoul("");
    setSoulDraft("");
    setSoulError("");
    setSoulMessage("");
    try {
      const detail = await api.getAgent(agentId);
      if (detailRequestRef.current !== requestId) {
        return;
      }
      setSelectedDetail(detail);
      const soul = detail.soul ?? "";
      setSavedSoul(soul);
      setSoulDraft(detail.soulFileStatus === "error" ? "" : soul);
    } catch {
      if (detailRequestRef.current !== requestId) {
        return;
      }
      if (fallbackAgent) {
        setSelectedDetail({
          ...fallbackAgent,
          soul: null,
          soulFileStatus: "error",
          soulFileError: "Agent 详情加载失败",
        });
      }
      setSavedSoul("");
      setSoulDraft("");
      setSoulError("Agent 详情加载失败");
    } finally {
      if (detailRequestRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }

  async function saveSoul(agent: Agent) {
    setSoulError("");
    setSoulMessage("");
    const validationError = validateAgentSoulDraft(soulDraft);
    if (validationError) {
      setSoulError(validationError);
      return;
    }
    setSavingSoul(true);
    try {
      const updated = await api.saveAgentSoul(agent.id, soulDraft);
      setSelectedDetail(updated);
      setAgents((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      const nextSoul = updated.soul ?? soulDraft;
      setSavedSoul(nextSoul);
      setSoulDraft(nextSoul);
      setSoulMessage("保存成功");
    } catch {
      setSoulError("保存失败，请稍后重试");
    } finally {
      setSavingSoul(false);
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  useEffect(() => {
    api
      .me()
      .then((user) => setCurrentUser(user))
      .catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    void loadAgentDetail(selectedId);
  }, [selectedId]);

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
              <AgentSoulPanel
                agent={selected}
                canEdit={canEditSoul}
                detailLoading={detailLoading}
                draft={soulDraft}
                error={soulError}
                message={soulMessage}
                onCancel={() => {
                  setSoulDraft(savedSoul);
                  setSoulError("");
                  setSoulMessage("");
                }}
                onChange={setSoulDraft}
                onRetry={() => void loadAgentDetail(selected.id)}
                onSave={() => void saveSoul(selected)}
                saved={savedSoul}
                saving={savingSoul}
              />
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

function AgentSoulPanel({
  agent,
  canEdit,
  detailLoading,
  draft,
  error,
  message,
  onCancel,
  onChange,
  onRetry,
  onSave,
  saved,
  saving,
}: {
  agent: Agent;
  canEdit: boolean;
  detailLoading: boolean;
  draft: string;
  error: string;
  message: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onRetry: () => void;
  onSave: () => void;
  saved: string;
  saving: boolean;
}) {
  const fileStatus: AgentSoulFileStatus = agent.soulFileStatus ?? "loaded";
  const notice = getAgentSoulNotice({
    canEdit,
    fileStatus,
    fileError: agent.soulFileError,
  });
  const saveDisabled = isAgentSoulSaveDisabled({
    canEdit,
    busy: saving || detailLoading,
    fileStatus,
    draft,
    saved,
  });
  const cancelDisabled = saving || detailLoading || draft === saved;
  const editorDisabled =
    !canEdit || saving || detailLoading || fileStatus === "error";
  const draftValidationError =
    canEdit && !detailLoading && !saving && fileStatus !== "error"
      ? validateAgentSoulDraft(draft)
      : null;

  return (
    <section className="soul-panel" aria-label="Soul 系统提示词">
      <div className="soul-header">
        <div>
          <p className="eyebrow">Soul</p>
          <h4>系统提示词</h4>
        </div>
        <span className={`status ${soulStatusClass(fileStatus)}`}>
          {formatSoulStatus(fileStatus, detailLoading, saving)}
        </span>
      </div>
      <div className="soul-meta">
        <span>文件名</span>
        <code className="inline-code">soul.md</code>
      </div>
      {notice ? (
        <div
          className={`notice compact ${fileStatus === "error" ? "error" : ""}`}
        >
          {notice}
        </div>
      ) : null}
      {error ? <div className="notice compact error">{error}</div> : null}
      {draftValidationError ? (
        <div className="notice compact error">{draftValidationError}</div>
      ) : null}
      {message ? <div className="notice compact success">{message}</div> : null}
      <label>
        内容
        <textarea
          aria-label="Soul 内容"
          disabled={editorDisabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={fileStatus === "error" ? "读取失败后请重试" : ""}
          rows={12}
          value={draft}
        />
      </label>
      <div className="detail-actions">
        {fileStatus === "error" ? (
          <button disabled={detailLoading} onClick={onRetry} type="button">
            {detailLoading ? "重试中" : "重试读取"}
          </button>
        ) : null}
        <button
          className="ghost-button inline-ghost"
          disabled={cancelDisabled}
          onClick={onCancel}
          type="button"
        >
          取消修改
        </button>
        <button disabled={saveDisabled} onClick={onSave} type="button">
          {saving ? "保存中" : "保存"}
        </button>
      </div>
    </section>
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

function formatSoulStatus(
  status: AgentSoulFileStatus,
  loading: boolean,
  saving: boolean,
) {
  if (saving) {
    return "保存中";
  }
  if (loading) {
    return "加载中";
  }
  if (status === "missing") {
    return "缺失";
  }
  if (status === "error") {
    return "错误";
  }
  return "已加载";
}

function soulStatusClass(status: AgentSoulFileStatus) {
  if (status === "error") {
    return "danger-status";
  }
  if (status === "missing") {
    return "off";
  }
  return "on";
}
