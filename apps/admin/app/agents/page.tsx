"use client";

import {
  AGENT_OPERATION_POLL_TIMEOUT_MS,
  formatAgentGitStatus,
  formatAgentStatus,
  formatSkillChangeStatus,
  formatSkillReloadStatus,
  formatWorkflowReloadStatus,
  getSoulByteLength,
  getAgentOperationPollDelay,
  isSkillChangeTerminal,
  isSoulDraftValid,
  selectEnabledProviders,
  validateWorkflowKey,
  ApiError,
  type Agent,
  type AgentSkill,
  type AgentSkillChange,
  type AgentSkillState,
  type AgentSoul,
  type AgentWorkflow,
  type AgentWorkflowVersion,
  type ModelProvider,
  type SkillCatalogSkill,
  type SkillCatalogSource,
  type SkillCatalogVersion,
  type WorkflowCapabilities,
} from "@homelab/views";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AuthShell } from "../components/auth-shell";
import { api } from "../lib/api";

type DetailTab = "overview" | "workspace" | "soul" | "skills" | "workflow";
const pageSizes = [20, 50, 100] as const;

export default function AgentsPage() {
  const initialListState = useMemo(() => readAgentListState(), []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [queryDraft, setQueryDraft] = useState(initialListState.query);
  const [query, setQuery] = useState(initialListState.query);
  const [page, setPage] = useState(initialListState.page);
  const [pageSize, setPageSize] = useState<number>(initialListState.pageSize);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Agent | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const detailRequest = useRef(0);

  const enabledProviders = useMemo(
    () => selectEnabledProviders(providers),
    [providers],
  );
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function applyAgentSnapshot(next: Agent) {
    setDetail(next);
    setAgents((current) =>
      current.map((item) =>
        item.id === next.id ? { ...item, ...next } : item,
      ),
    );
  }

  async function loadAgents(
    next: { query: string; page: number; pageSize: number },
    preferredId = selectedId,
  ) {
    setLoading(true);
    setListError("");
    try {
      const result = await api.listAgents(next);
      setAgents(result.items);
      setTotal(result.total);
      setPage(result.page);
      setPageSize(result.pageSize);
      syncAgentListUrl({
        query: next.query,
        page: result.page,
        pageSize: result.pageSize,
      });
      const nextSelected = result.items.some((item) => item.id === preferredId)
        ? preferredId
        : (result.items[0]?.id ?? "");
      setSelectedId(nextSelected);
      if (!nextSelected) {
        setDetail(null);
      }
    } catch {
      setListError(
        agents.length ? "列表刷新失败，请重试" : "Agent 列表加载失败，请重试",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents(initialListState, "");
    api
      .listModelProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  async function loadAgentDetail(agentId: string) {
    const requestId = detailRequest.current + 1;
    detailRequest.current = requestId;
    setDetailLoading(true);
    setDetailError("");
    try {
      const next = await api.getAgent(agentId);
      if (detailRequest.current === requestId) {
        applyAgentSnapshot(next);
      }
    } catch {
      if (detailRequest.current === requestId) {
        setDetail(null);
        setDetailError("Agent 详情加载失败，请重试");
      }
    } finally {
      if (detailRequest.current === requestId) {
        setDetailLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadAgentDetail(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (
      !detail ||
      detail.id !== selectedId ||
      detail.status !== "initializing"
    ) {
      return;
    }

    let cancelled = false;
    let elapsedMs = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = getAgentOperationPollDelay(elapsedMs);
      timer = setTimeout(async () => {
        elapsedMs += delay;
        try {
          const next = await api.getAgent(detail.id);
          if (cancelled) return;
          applyAgentSnapshot(next);
          if (
            next.status === "initializing" &&
            elapsedMs < AGENT_OPERATION_POLL_TIMEOUT_MS
          ) {
            schedule();
          }
        } catch {
          if (!cancelled && elapsedMs < AGENT_OPERATION_POLL_TIMEOUT_MS) {
            schedule();
          }
        }
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detail?.id, detail?.status, selectedId]);

  function selectAgent(agentId: string) {
    setSelectedId(agentId);
    setTab("overview");
  }

  return (
    <AuthShell>
      <section className="page-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h2>Agent 管理</h2>
          <p className="page-summary">
            配置 Workspace、Soul、Skills 与 Workflow
          </p>
        </div>
        <button onClick={() => setCreateOpen(true)} type="button">
          新增 Agent
        </button>
      </section>

      <form
        className="toolbar agent-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const nextQuery = queryDraft.trim();
          setQuery(nextQuery);
          void loadAgents({ query: nextQuery, page: 1, pageSize });
        }}
      >
        <label className="visually-labeled-field">
          <span>名称或标识</span>
          <input
            aria-label="搜索 Agent"
            onChange={(event) => setQueryDraft(event.target.value)}
            placeholder="搜索名称或标识"
            value={queryDraft}
          />
        </label>
        <button type="submit">查询</button>
        <button
          className="ghost-button inline-ghost"
          onClick={() => void loadAgents({ query, page, pageSize })}
          type="button"
        >
          刷新
        </button>
      </form>

      {listError ? <Notice tone="error">{listError}</Notice> : null}
      {loading ? <Notice>正在加载 Agent...</Notice> : null}
      {!loading && agents.length === 0 ? (
        <div className="empty-state">
          {query ? "未找到匹配 Agent" : "暂无 Agent"}
        </div>
      ) : null}

      {agents.length ? (
        <>
          <div className="table-wrap agent-table">
            <table>
              <thead>
                <tr>
                  <th>名称 / 标识</th>
                  <th>Provider</th>
                  <th>状态</th>
                  <th>Workspace / Git</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((item) => (
                  <tr
                    className={item.id === selectedId ? "selected-row" : ""}
                    key={item.id}
                  >
                    <td data-label="名称 / 标识">
                      <strong>{item.name}</strong>
                      <small className="cell-secondary">
                        {item.slug ?? item.workspaceName ?? "-"}
                      </small>
                    </td>
                    <td data-label="Provider">{formatProvider(item)}</td>
                    <td data-label="状态">
                      <StatusBadge status={item.status} />
                    </td>
                    <td data-label="Workspace / Git">
                      <code className="inline-code">
                        {item.workspaceName ?? "-"}
                      </code>
                      <small className="cell-secondary">
                        {formatAgentGitStatus(item.gitStatus)}
                      </small>
                    </td>
                    <td data-label="更新时间">{formatDate(item.updatedAt)}</td>
                    <td className="actions" data-label="操作">
                      <button
                        onClick={() => selectAgent(item.id)}
                        type="button"
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination agent-pagination">
            <span>总数 {total}</span>
            <label className="page-size-field">
              每页
              <select
                aria-label="每页数量"
                onChange={(event) => {
                  const nextSize = Number(event.target.value);
                  void loadAgents({ query, page: 1, pageSize: nextSize });
                }}
                value={pageSize}
              >
                {pageSizes.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={page <= 1}
              onClick={() =>
                void loadAgents({ query, page: page - 1, pageSize })
              }
              type="button"
            >
              上一页
            </button>
            <span>
              {page} / {pageCount}
            </span>
            <button
              disabled={page >= pageCount}
              onClick={() =>
                void loadAgents({ query, page: page + 1, pageSize })
              }
              type="button"
            >
              下一页
            </button>
          </div>
        </>
      ) : null}

      {detailError ? <Notice tone="error">{detailError}</Notice> : null}
      {detailLoading ? <Notice>正在加载 Agent 详情...</Notice> : null}
      {detail ? (
        <AgentDetail
          agent={detail}
          enabledProviders={enabledProviders}
          onAgentChange={(next) => {
            setDetail(next);
            setAgents((current) =>
              current.map((item) =>
                item.id === next.id ? { ...item, ...next } : item,
              ),
            );
          }}
          onRefresh={() => void loadAgentDetail(detail.id)}
          onTabChange={setTab}
          tab={tab}
        />
      ) : null}

      {createOpen ? (
        <CreateAgentDialog
          providers={enabledProviders}
          onClose={() => setCreateOpen(false)}
          onCreated={async (created) => {
            setCreateOpen(false);
            await loadAgents({ query, page: 1, pageSize }, created.id);
          }}
        />
      ) : null}
    </AuthShell>
  );
}

function AgentDetail({
  agent,
  enabledProviders,
  onAgentChange,
  onRefresh,
  onTabChange,
  tab,
}: {
  agent: Agent;
  enabledProviders: ModelProvider[];
  onAgentChange: (agent: Agent) => void;
  onRefresh: () => void;
  onTabChange: (tab: DetailTab) => void;
  tab: DetailTab;
}) {
  const tabs: Array<[DetailTab, string]> = [
    ["overview", "概览"],
    ["workspace", "Workspace"],
    ["soul", "Soul"],
    ["skills", "Skills"],
    ["workflow", "Workflow"],
  ];

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, value: DetailTab) {
    const index = tabs.findIndex(([candidate]) => candidate === value);
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex][0];
    onTabChange(next);
    document.getElementById(`agent-tab-${next}`)?.focus();
  }

  return (
    <section aria-label="Agent 详情" className="agent-detail" role="region">
      <header className="detail-title">
        <div>
          <p className="eyebrow">Agent Detail</p>
          <h3>{agent.slug ?? agent.workspaceName ?? agent.id}</h3>
        </div>
        <StatusBadge status={agent.status} />
      </header>
      <div aria-label="Agent 配置区" className="detail-tabs" role="tablist">
        {tabs.map(([value, label]) => (
          <button
            aria-controls={`agent-panel-${value}`}
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            id={`agent-tab-${value}`}
            key={value}
            onClick={() => onTabChange(value)}
            onKeyDown={(event) => moveTab(event, value)}
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`agent-tab-${tab}`}
        id={`agent-panel-${tab}`}
        role="tabpanel"
        tabIndex={0}
      >
        {tab === "overview" ? (
          <OverviewPanel
            agent={agent}
            enabledProviders={enabledProviders}
            onAgentChange={onAgentChange}
          />
        ) : null}
        {tab === "workspace" ? (
          <WorkspacePanel
            agent={agent}
            onAgentChange={onAgentChange}
            onRefresh={onRefresh}
          />
        ) : null}
        {tab === "soul" ? <SoulPanel agent={agent} /> : null}
        {tab === "skills" ? <SkillsPanel agent={agent} /> : null}
        {tab === "workflow" ? <WorkflowPanel agent={agent} /> : null}
      </div>
    </section>
  );
}

function OverviewPanel({
  agent,
  enabledProviders,
  onAgentChange,
}: {
  agent: Agent;
  enabledProviders: ModelProvider[];
  onAgentChange: (agent: Agent) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [providerId, setProviderId] = useState(agent.modelProviderId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflictDraft, setConflictDraft] = useState<{
    name: string;
    providerId: string;
  } | null>(null);
  const dirty =
    name.trim() !== agent.name || providerId !== (agent.modelProviderId ?? "");

  useEffect(() => {
    setName(agent.name);
    setProviderId(agent.modelProviderId ?? "");
  }, [agent.id, agent.name, agent.modelProviderId]);

  async function save() {
    if (!name.trim() || agent.revision === undefined) return;
    setBusy(true);
    setMessage("");
    try {
      const updated = await api.updateAgent(agent.id, {
        name: name.trim(),
        modelProviderId: providerId || null,
        expectedRevision: agent.revision,
      });
      onAgentChange(updated);
      setMessage("基础配置已保存");
    } catch (error) {
      if (isRevisionConflict(error, "REVISION_CONFLICT")) {
        const draft = { name, providerId };
        try {
          const latest = await api.getAgent(agent.id);
          setConflictDraft(draft);
          onAgentChange(latest);
          setMessage(
            `检测到并发修改，已读取服务器 Revision ${latest.revision}`,
          );
        } catch {
          setMessage(
            "检测到 revision 冲突，但服务器快照读取失败；编辑内容已保留",
          );
        }
      } else {
        setMessage("保存失败，配置未变；请刷新后重试");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-section">
      <div className="form-grid two-column">
        <label>
          Agent 名称
          <input
            aria-label="Agent 名称"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label>
          Agent Provider
          <select
            aria-label="Agent Provider"
            onChange={(event) => setProviderId(event.target.value)}
            value={providerId}
          >
            <option value="">使用全局默认 Provider</option>
            {enabledProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <dl className="detail-list compact-detail-list">
        <div>
          <dt>ID</dt>
          <dd>{agent.id}</dd>
        </div>
        <div>
          <dt>标识</dt>
          <dd>{agent.slug ?? "-"}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{agent.revision ?? "-"}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{agent.workspacePath ?? "-"}</dd>
        </div>
      </dl>
      {message ? (
        <Notice tone={message.includes("已保存") ? "success" : "error"}>
          {message}
        </Notice>
      ) : null}
      {conflictDraft ? (
        <div className="conflict-recovery">
          <p>
            服务器 Revision {agent.revision}：{agent.name}；我的修改：
            {conflictDraft.name}
          </p>
          <button
            className="ghost-button inline-ghost"
            onClick={() => {
              setName(conflictDraft.name);
              setProviderId(conflictDraft.providerId);
              setConflictDraft(null);
            }}
            type="button"
          >
            重新应用我的基础配置
          </button>
        </div>
      ) : null}
      <div className="detail-actions">
        <button
          disabled={!dirty || busy || !name.trim()}
          onClick={() => void save()}
          type="button"
        >
          {busy ? "保存中" : "保存基础配置"}
        </button>
      </div>
    </div>
  );
}

function WorkspacePanel({
  agent,
  onAgentChange,
  onRefresh,
}: {
  agent: Agent;
  onAgentChange: (agent: Agent) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function retry() {
    setBusy(true);
    setError("");
    try {
      onAgentChange(await api.retryAgentInitialization(agent.id));
    } catch {
      setError("初始化重试失败，请刷新状态后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-section">
      <dl className="detail-list compact-detail-list">
        <div>
          <dt>初始化状态</dt>
          <dd>{formatAgentStatus(agent.status)}</dd>
        </div>
        <div>
          <dt>Git</dt>
          <dd>{formatAgentGitStatus(agent.gitStatus)}</dd>
        </div>
        <div>
          <dt>Workspace 路径</dt>
          <dd>{agent.workspacePath ?? "-"}</dd>
        </div>
        <div>
          <dt>错误代码</dt>
          <dd>{agent.initError?.code ?? "-"}</dd>
        </div>
        <div>
          <dt>安全摘要</dt>
          <dd>{agent.initError?.message ?? "-"}</dd>
        </div>
      </dl>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="detail-actions">
        <button
          className="ghost-button inline-ghost"
          onClick={onRefresh}
          type="button"
        >
          刷新 Workspace
        </button>
        {agent.status === "init_failed" ? (
          <button disabled={busy} onClick={() => void retry()} type="button">
            {busy ? "重试中" : "重试初始化"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SoulPanel({ agent }: { agent: Agent }) {
  const [soul, setSoul] = useState<AgentSoul | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);

  async function load() {
    setLoading(true);
    setMessage("");
    try {
      const next = await api.getAgentSoul(agent.id);
      setSoul(next);
      setDraft(next.content);
    } catch {
      setMessage("Soul 加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [agent.id]);
  const validation = soul ? isSoulDraftValid(draft, soul.maxBytes) : null;

  async function save() {
    if (!soul || !validation?.valid) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await api.saveAgentSoul(agent.id, draft, soul.revision);
      setSoul(next);
      setDraft(next.content);
      setMessage("Soul 已保存");
    } catch (error) {
      if (isRevisionConflict(error, "SOUL_REVISION_CONFLICT")) {
        try {
          const latest = await api.getAgentSoul(agent.id);
          setSoul(latest);
          setConflict(true);
          setMessage(
            `检测到并发修改，已读取服务器 Revision ${latest.revision}`,
          );
        } catch {
          setMessage(
            "检测到 Soul revision 冲突，但服务器快照读取失败；编辑内容已保留",
          );
        }
      } else {
        setMessage("Soul 保存失败，编辑内容已保留");
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Notice>正在加载 Soul...</Notice>;
  if (!soul)
    return (
      <div className="detail-section">
        <Notice tone="error">{message}</Notice>
        <button onClick={() => void load()} type="button">
          重试读取
        </button>
      </div>
    );

  const ready = agent.status === "ready";
  return (
    <div className="detail-section">
      {soul.missing ? (
        <Notice>当前 soul.md 缺失，保存后将重新创建</Notice>
      ) : null}
      {!ready ? <Notice>Agent 尚未就绪，配置写入已禁用</Notice> : null}
      <label>
        Soul 内容
        <textarea
          aria-label="Soul 内容"
          disabled={!ready || busy}
          onChange={(event) => setDraft(event.target.value)}
          rows={14}
          value={draft}
        />
      </label>
      <div className="editor-meta">
        <span>
          {getSoulByteLength(draft)} / {soul.maxBytes} 字节
        </span>
        <span>Revision {soul.revision}</span>
      </div>
      {validation && !validation.valid ? (
        <Notice tone="error">{validation.message}</Notice>
      ) : null}
      {message ? (
        <Notice tone={message.includes("已保存") ? "success" : "error"}>
          {message}
        </Notice>
      ) : null}
      {conflict ? (
        <div className="conflict-recovery">
          <p>服务器 Revision {soul.revision} 内容：</p>
          <pre>{soul.content}</pre>
          <button
            className="ghost-button inline-ghost"
            disabled={busy || !validation?.valid}
            onClick={() => {
              setConflict(false);
              void save();
            }}
            type="button"
          >
            使用最新 revision 重试 Soul
          </button>
        </div>
      ) : null}
      <div className="detail-actions">
        <button
          className="ghost-button inline-ghost"
          disabled={busy || draft === soul.content}
          onClick={() => setDraft(soul.content)}
          type="button"
        >
          取消修改
        </button>
        <button
          disabled={
            !ready || busy || draft === soul.content || !validation?.valid
          }
          onClick={() => void save()}
          type="button"
        >
          {busy ? "保存中" : "保存 Soul"}
        </button>
      </div>
      <p className="help-text">保存影响后续新 run；已启动 run 保持原快照。</p>
    </div>
  );
}

function SkillsPanel({ agent }: { agent: Agent }) {
  const [state, setState] = useState<AgentSkillState | null>(null);
  const [change, setChange] = useState<AgentSkillChange | null>(null);
  const [loading, setLoading] = useState(true);
  const [installOpen, setInstallOpen] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<AgentSkill | null>(null);
  const [error, setError] = useState("");
  const [pollGeneration, setPollGeneration] = useState(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setState(await api.listAgentSkills(agent.id));
    } catch {
      setError("Skills 加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [agent.id]);

  const changeTerminal = change ? isSkillChangeTerminal(change) : true;
  useEffect(() => {
    if (!change || changeTerminal) return;

    let cancelled = false;
    let elapsedMs = 0;
    let timer: ReturnType<typeof setTimeout>;
    const changeId = change.changeId;
    const schedule = () => {
      const delay = getAgentOperationPollDelay(elapsedMs);
      timer = setTimeout(async () => {
        elapsedMs += delay;
        try {
          const next = await api.getAgentSkillChange(agent.id, changeId);
          if (cancelled) return;
          setChange(next);
          if (isSkillChangeTerminal(next)) {
            setPollTimedOut(false);
            await load();
          } else if (elapsedMs < AGENT_OPERATION_POLL_TIMEOUT_MS) {
            schedule();
          } else {
            setPollTimedOut(true);
            setError("Skill 变更仍在进行，可手动刷新状态");
          }
        } catch {
          if (!cancelled && elapsedMs < AGENT_OPERATION_POLL_TIMEOUT_MS) {
            schedule();
          } else if (!cancelled) {
            setPollTimedOut(true);
            setError("Skill 状态刷新失败，请手动重试");
          }
        }
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent.id, change?.changeId, changeTerminal, pollGeneration]);

  async function refreshCurrentChange() {
    if (!change) return;
    setError("");
    try {
      const next = await api.getAgentSkillChange(agent.id, change.changeId);
      setChange(next);
      if (isSkillChangeTerminal(next)) {
        setPollTimedOut(false);
        await load();
      } else {
        setPollTimedOut(false);
        setPollGeneration((current) => current + 1);
      }
    } catch {
      setError("Skill 状态刷新失败，请手动重试");
    }
  }
  if (loading) return <Notice>正在加载 Skills...</Notice>;

  return (
    <div className="detail-section">
      {agent.status !== "ready" ? (
        <Notice>Agent 尚未就绪，配置写入已禁用</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {change && (!changeTerminal || pollTimedOut) ? (
        <button
          className="ghost-button inline-ghost"
          onClick={() => void refreshCurrentChange()}
          type="button"
        >
          刷新当前 Skill 变更
        </button>
      ) : null}
      <div className="section-heading">
        <div>
          <h4>已安装 Skills</h4>
          <p>仅可从受控 Catalog 选择不可变版本。</p>
        </div>
        <button
          disabled={agent.status !== "ready"}
          onClick={() => setInstallOpen(true)}
          type="button"
        >
          安装 Skill
        </button>
      </div>
      {state?.skills.length ? (
        <div className="table-wrap nested-table">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>版本</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.skills.map((skill) => (
                <tr key={skill.name}>
                  <td data-label="名称">{skill.name}</td>
                  <td data-label="版本">{skill.version}</td>
                  <td data-label="来源">{skill.sourceId}</td>
                  <td className="actions" data-label="操作">
                    <button
                      disabled={
                        skill.systemRequired || agent.status !== "ready"
                      }
                      onClick={() => setUpdateTarget(skill)}
                      type="button"
                    >
                      更新
                    </button>
                    <button
                      disabled={
                        skill.systemRequired || agent.status !== "ready"
                      }
                      onClick={async () => {
                        try {
                          setError("");
                          setChange(
                            await api.removeAgentSkill(agent.id, skill.name),
                          );
                          await load();
                        } catch {
                          setError("Skill 移除失败，请重试");
                        }
                      }}
                      type="button"
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">暂无已安装 Skill</div>
      )}
      {state ? (
        <StatusSummary
          changeStatus={state.changeStatus}
          reloadStatus={state.reloadStatus}
          auditStatus={state.auditStatus}
          rollbackResult={state.rollbackResult}
          failedStage={state.failedStage}
        />
      ) : null}
      {change ? (
        <StatusSummary
          changeStatus={change.changeStatus}
          reloadStatus={change.reloadStatus}
          auditStatus={change.auditStatus}
          rollbackResult={change.rollbackResult}
          failedStage={change.failedStage}
        />
      ) : null}
      {installOpen ? (
        <SkillInstallDialog
          agentId={agent.id}
          onClose={() => setInstallOpen(false)}
          onInstalled={async (next) => {
            setChange(next);
            setInstallOpen(false);
            await load();
          }}
        />
      ) : null}
      {updateTarget ? (
        <SkillInstallDialog
          agentId={agent.id}
          initialSkill={updateTarget}
          onClose={() => setUpdateTarget(null)}
          onInstalled={async (next) => {
            setChange(next);
            setUpdateTarget(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function SkillInstallDialog({
  agentId,
  initialSkill,
  onClose,
  onInstalled,
}: {
  agentId: string;
  initialSkill?: AgentSkill;
  onClose: () => void;
  onInstalled: (change: AgentSkillChange) => Promise<void>;
}) {
  const [sources, setSources] = useState<SkillCatalogSource[]>([]);
  const [skills, setSkills] = useState<SkillCatalogSkill[]>([]);
  const [versions, setVersions] = useState<SkillCatalogVersion[]>([]);
  const [sourceId, setSourceId] = useState(initialSkill?.sourceId ?? "");
  const [skillId, setSkillId] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .listSkillCatalogSources({ page: 1, pageSize: 100 })
      .then((result) => setSources(result.items))
      .catch(() => setError("Catalog 来源加载失败"));
  }, []);
  useEffect(() => {
    setSkills([]);
    setVersions([]);
    setVersion("");
    if (sourceId)
      api
        .listSkillCatalogSkills(sourceId, { page: 1, pageSize: 100 })
        .then((result) => {
          setSkills(result.items);
          if (initialSkill) {
            const catalogSkill = result.items.find(
              (item) => item.name === initialSkill.name,
            );
            if (catalogSkill) setSkillId(catalogSkill.skillId);
            else setError("Catalog 中找不到已安装 Skill 的稳定 ID");
          }
        })
        .catch(() => setError("Skill 列表加载失败"));
  }, [sourceId]);
  useEffect(() => {
    setVersions([]);
    setVersion("");
    if (sourceId && skillId)
      api
        .listSkillCatalogVersions(sourceId, skillId, { page: 1, pageSize: 100 })
        .then((result) => setVersions(result.items))
        .catch(() => setError("版本列表加载失败"));
  }, [sourceId, skillId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const source = sources.find((item) => item.id === sourceId);
    const skill = skills.find((item) => item.skillId === skillId);
    if (!source || !skill || !version) return;
    setBusy(true);
    try {
      const payload = {
        skillName: skill.name,
        sourceId,
        sourceType: source.sourceType,
        version,
      };
      await onInstalled(
        initialSkill
          ? await api.updateAgentSkill(agentId, payload)
          : await api.installAgentSkill(agentId, payload),
      );
    } catch {
      setError(
        initialSkill
          ? "更新失败，请检查状态后重试"
          : "安装失败，请检查状态后重试",
      );
      setBusy(false);
    }
  }

  return (
    <AccessibleDialog
      onClose={onClose}
      onSubmit={submit}
      title={initialSkill ? "更新 Skill" : "安装 Skill"}
    >
      <label>
        Skill 来源
        <select
          aria-label="Skill 来源"
          onChange={(event) => {
            setSourceId(event.target.value);
            setSkillId("");
            setVersion("");
          }}
          value={sourceId}
        >
          <option value="">请选择来源</option>
          {sources.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Skill
        <select
          aria-label="Skill"
          disabled={!sourceId}
          onChange={(event) => {
            setSkillId(event.target.value);
            setVersion("");
          }}
          value={skillId}
        >
          <option value="">请选择 Skill</option>
          {skills.map((item) => (
            <option key={item.skillId} value={item.skillId}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Skill 版本
        <select
          aria-label="Skill 版本"
          disabled={!skillId}
          onChange={(event) => setVersion(event.target.value)}
          value={version}
        >
          <option value="">请选择不可变版本</option>
          {versions.map((item) => (
            <option key={item.immutableRef} value={item.version}>
              {item.version}
            </option>
          ))}
        </select>
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="modal-actions">
        <button
          className="ghost-button inline-ghost"
          onClick={onClose}
          type="button"
        >
          取消
        </button>
        <button
          disabled={busy || !sourceId || !skillId || !version}
          type="submit"
        >
          {busy ? "处理中" : initialSkill ? "确认更新" : "确认安装"}
        </button>
      </div>
    </AccessibleDialog>
  );
}

function WorkflowPanel({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<AgentWorkflow[]>([]);
  const [editing, setEditing] = useState<AgentWorkflow | null>(null);
  const [source, setSource] = useState("");
  const [versions, setVersions] = useState<AgentWorkflowVersion[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<WorkflowCapabilities | null>(
    null,
  );
  const [pollGeneration, setPollGeneration] = useState(0);
  const [conflictRetryReload, setConflictRetryReload] = useState<
    boolean | null
  >(null);

  async function load() {
    setLoading(true);
    try {
      const [nextItems, nextCapabilities] = await Promise.all([
        api.listAgentWorkflows(agent.id),
        api.getWorkflowCapabilities(agent.id),
      ]);
      setItems(nextItems);
      setCapabilities(nextCapabilities);
    } catch {
      setMessage("Workflow 加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [agent.id]);

  useEffect(() => {
    if (!editing || editing.reloadStatus !== "loading") return;

    let cancelled = false;
    let elapsedMs = 0;
    let timer: ReturnType<typeof setTimeout>;
    const workflowKey = editing.workflowKey;
    const schedule = () => {
      const delay = getAgentOperationPollDelay(elapsedMs);
      timer = setTimeout(async () => {
        elapsedMs += delay;
        try {
          const next = await api.getAgentWorkflow(agent.id, workflowKey);
          if (cancelled) return;
          setEditing((current) =>
            current?.workflowKey === workflowKey
              ? { ...next, source: next.source ?? current.source }
              : current,
          );
          setItems((current) =>
            current.map((item) =>
              item.workflowKey === workflowKey ? next : item,
            ),
          );
          if (
            next.reloadStatus === "loading" &&
            elapsedMs <
              (capabilities?.reloadTimeoutMs ?? AGENT_OPERATION_POLL_TIMEOUT_MS)
          ) {
            schedule();
          } else if (next.reloadStatus === "loading") {
            setMessage("Workflow reload 仍在进行，可手动刷新当前 Workflow");
          } else {
            setMessage(
              next.reloadStatus === "succeeded"
                ? "Workflow reload 已完成"
                : "Workflow reload 失败，active 版本未变",
            );
          }
        } catch {
          if (
            !cancelled &&
            elapsedMs <
              (capabilities?.reloadTimeoutMs ?? AGENT_OPERATION_POLL_TIMEOUT_MS)
          ) {
            schedule();
          } else if (!cancelled) {
            setMessage("Workflow reload 状态刷新失败，请手动重试");
          }
        }
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    agent.id,
    capabilities?.reloadTimeoutMs,
    editing?.reloadStatus,
    editing?.workflowKey,
    pollGeneration,
  ]);

  async function edit(workflowKey: string) {
    setMessage("");
    const [detail, history] = await Promise.all([
      api.getAgentWorkflow(agent.id, workflowKey),
      api.listAgentWorkflowVersions(agent.id, workflowKey),
    ]);
    setEditing(detail);
    setSource(detail.source ?? "");
    setVersions(history);
  }

  async function save(reload: boolean) {
    if (!editing) return;
    setBusy(true);
    setMessage("");
    try {
      const payload = {
        source,
        extension: workflowExtension(editing),
        expectedRevision: editing.revision,
      };
      const next = reload
        ? await api.saveAndReloadAgentWorkflow(
            agent.id,
            editing.workflowKey,
            payload,
          )
        : await api.saveAgentWorkflowDraft(
            agent.id,
            editing.workflowKey,
            payload,
          );
      setEditing({ ...next, source });
      setConflictRetryReload(null);
      setMessage(reload ? "Workflow 已保存并 reload" : "Workflow 草稿已保存");
      await load();
    } catch (error) {
      if (isRevisionConflict(error, "WORKFLOW_REVISION_CONFLICT")) {
        try {
          const latest = await api.getAgentWorkflow(
            agent.id,
            editing.workflowKey,
          );
          setEditing(latest);
          setConflictRetryReload(reload);
          setMessage(
            `检测到并发修改，已读取服务器 Revision ${latest.revision}`,
          );
        } catch {
          setMessage(
            "检测到 Workflow revision 冲突，但服务器快照读取失败；草稿已保留",
          );
        }
      } else {
        setMessage("Workflow 保存失败，草稿内容已保留");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadCurrentDraft() {
    if (!editing?.draftHash) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await api.reloadAgentWorkflow(
        agent.id,
        editing.workflowKey,
        editing.draftHash,
      );
      setEditing({ ...next, source });
      setMessage(
        next.reloadStatus === "succeeded"
          ? "Workflow reload 已完成"
          : "Workflow reload 失败，active 版本未变",
      );
      await load();
    } catch {
      setMessage("Workflow reload 失败，active 版本未变");
    } finally {
      setBusy(false);
    }
  }

  async function refreshCurrentWorkflow() {
    if (!editing) return;
    const [next, history] = await Promise.all([
      api.getAgentWorkflow(agent.id, editing.workflowKey),
      api.listAgentWorkflowVersions(agent.id, editing.workflowKey),
    ]);
    setEditing(next);
    setVersions(history);
    if (next.reloadStatus === "loading") {
      setPollGeneration((current) => current + 1);
      setMessage("已刷新当前 Workflow，并重新开始状态轮询");
    } else {
      setSource(next.source ?? source);
      setMessage("已刷新当前 Workflow");
    }
  }

  if (loading) return <Notice>正在加载 Workflow...</Notice>;
  if (!capabilities) return <Notice tone="error">{message}</Notice>;
  const sourceBytes = getSoulByteLength(source);
  const sourceTooLarge = sourceBytes > capabilities.sourceMaxBytes;
  return (
    <div className="detail-section">
      {agent.status !== "ready" ? (
        <Notice>Agent 尚未就绪，配置写入已禁用</Notice>
      ) : null}
      <div className="section-heading">
        <div>
          <h4>Workflows</h4>
          <p>草稿与当前生效版本分离。</p>
        </div>
        <div className="detail-actions">
          <button
            className="ghost-button inline-ghost"
            onClick={() => void load()}
            type="button"
          >
            刷新
          </button>
          <button
            disabled={agent.status !== "ready"}
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            新建 Workflow
          </button>
        </div>
      </div>
      <div className="workflow-layout">
        <div className="workflow-list">
          {items.length ? (
            items.map((item) => (
              <button
                aria-label={`编辑 ${item.workflowKey}`}
                className={
                  editing?.workflowKey === item.workflowKey ? "active" : ""
                }
                key={item.workflowKey}
                onClick={() => void edit(item.workflowKey)}
                type="button"
              >
                <strong>{item.workflowKey}</strong>
                <span>{formatWorkflowReloadStatus(item.reloadStatus)}</span>
              </button>
            ))
          ) : (
            <div className="empty-state">暂无 Workflow</div>
          )}
        </div>
        {editing ? (
          <div className="workflow-editor">
            <div className="editor-title">
              <div>
                <strong>{editing.workflowKey}</strong>
                <small>
                  draft {shortHash(editing.draftHash)} · active{" "}
                  {shortHash(editing.activeHash)}
                </small>
              </div>
              <StatusPill
                label={formatWorkflowReloadStatus(editing.reloadStatus)}
                tone={editing.reloadStatus === "failed" ? "danger" : "neutral"}
              />
            </div>
            <label>
              Workflow 源码
              <textarea
                aria-label="Workflow 源码"
                disabled={busy}
                onChange={(event) => setSource(event.target.value)}
                rows={16}
                value={source}
              />
            </label>
            <div className="editor-meta">
              <span>
                {sourceBytes} / {capabilities.sourceMaxBytes} 字节
              </span>
              <span>
                reload 最长 {capabilities.reloadTimeoutMs / 1000} 秒 · 最多保留{" "}
                {capabilities.historyLimit} 个历史版本
              </span>
            </div>
            {sourceTooLarge ? (
              <Notice tone="error">
                Workflow 源码不能超过 {capabilities.sourceMaxBytes} UTF-8 字节
              </Notice>
            ) : null}
            <div className="detail-actions">
              <button
                className="ghost-button inline-ghost"
                disabled={busy || sourceTooLarge}
                onClick={async () => {
                  try {
                    const result = await api.validateAgentWorkflow(
                      agent.id,
                      editing.workflowKey,
                      { source, extension: workflowExtension(editing) },
                    );
                    setMessage(
                      result.valid
                        ? "校验通过"
                        : (result.errors?.join("；") ?? "校验失败"),
                    );
                  } catch {
                    setMessage("Workflow 校验失败，请检查源码");
                  }
                }}
                type="button"
              >
                校验
              </button>
              <button
                className="ghost-button inline-ghost"
                disabled={
                  busy ||
                  agent.status !== "ready" ||
                  !editing.draftHash ||
                  editing.draftHash === editing.activeHash ||
                  sourceTooLarge
                }
                onClick={() => void reloadCurrentDraft()}
                type="button"
              >
                reload 当前 draft
              </button>
              <button
                disabled={
                  busy ||
                  agent.status !== "ready" ||
                  source === editing.source ||
                  sourceTooLarge
                }
                onClick={() => void save(false)}
                type="button"
              >
                保存 draft
              </button>
              <button
                disabled={
                  busy ||
                  agent.status !== "ready" ||
                  source === editing.source ||
                  sourceTooLarge
                }
                onClick={() => void save(true)}
                type="button"
              >
                保存并 reload
              </button>
              <button
                className="ghost-button inline-ghost"
                onClick={() => void refreshCurrentWorkflow()}
                type="button"
              >
                刷新当前 Workflow
              </button>
            </div>
            {conflictRetryReload !== null ? (
              <div className="conflict-recovery">
                <p>
                  服务器 Revision {editing.revision}，draft{" "}
                  {shortHash(editing.draftHash)}； 当前编辑内容已保留，可在最新
                  revision 上重新应用。
                </p>
                <button
                  className="ghost-button inline-ghost"
                  disabled={busy || sourceTooLarge}
                  onClick={() => void save(conflictRetryReload)}
                  type="button"
                >
                  使用最新 revision 重试 Workflow
                </button>
              </div>
            ) : null}
            {versions.length ? (
              <details>
                <summary>历史版本（{versions.length}）</summary>
                <ul className="version-list">
                  {versions
                    .slice(0, capabilities.historyLimit)
                    .map((version) => (
                      <li key={version.id}>
                        <code>{shortHash(version.sourceHash)}</code>
                        <button
                          disabled={busy || agent.status !== "ready"}
                          onClick={async () => {
                            const next = await api.rollbackAgentWorkflow(
                              agent.id,
                              editing.workflowKey,
                              version.id,
                            );
                            setEditing({ ...next, source: version.source });
                            setSource(version.source);
                            setMessage("Workflow 已回滚");
                          }}
                          type="button"
                        >
                          回滚到此版本
                        </button>
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">选择一个 Workflow 查看源码</div>
        )}
      </div>
      {message ? (
        <Notice tone={message.includes("失败") ? "error" : "success"}>
          {message}
        </Notice>
      ) : null}
      {createOpen ? (
        <WorkflowCreateDialog
          agentId={agent.id}
          capabilities={capabilities}
          onClose={() => setCreateOpen(false)}
          onCreated={async (next) => {
            setCreateOpen(false);
            await load();
            await edit(next.workflowKey);
          }}
        />
      ) : null}
    </div>
  );
}

function WorkflowCreateDialog({
  agentId,
  capabilities,
  onClose,
  onCreated,
}: {
  agentId: string;
  capabilities: WorkflowCapabilities;
  onClose: () => void;
  onCreated: (workflow: AgentWorkflow) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [source, setSource] = useState("export default {}\n");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const keyError = key ? validateWorkflowKey(key) : null;
  const sourceBytes = getSoulByteLength(source);
  const sourceTooLarge = sourceBytes > capabilities.sourceMaxBytes;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const validation = validateWorkflowKey(key);
    if (validation) {
      setError(validation);
      return;
    }
    if (sourceTooLarge) {
      setError(
        `Workflow 源码不能超过 ${capabilities.sourceMaxBytes} UTF-8 字节`,
      );
      return;
    }
    setBusy(true);
    try {
      await onCreated(
        await api.createAgentWorkflow(agentId, {
          workflowKey: key,
          source,
          extension: "ts",
        }),
      );
    } catch {
      setError("Workflow 创建失败，请重试");
      setBusy(false);
    }
  }
  return (
    <AccessibleDialog
      className="wide-modal"
      onClose={onClose}
      onSubmit={submit}
      title="新建 Workflow"
    >
      <label>
        Workflow key
        <input
          aria-label="Workflow key"
          onChange={(event) => setKey(event.target.value)}
          value={key}
        />
      </label>
      <label>
        初始源码
        <textarea
          aria-label="初始 Workflow 源码"
          onChange={(event) => setSource(event.target.value)}
          rows={10}
          value={source}
        />
      </label>
      <p className="help-text">
        {sourceBytes} / {capabilities.sourceMaxBytes} UTF-8 字节
      </p>
      {keyError || error ? (
        <Notice tone="error">{keyError ?? error}</Notice>
      ) : null}
      <div className="modal-actions">
        <button
          className="ghost-button inline-ghost"
          onClick={onClose}
          type="button"
        >
          取消
        </button>
        <button
          disabled={
            busy ||
            Boolean(validateWorkflowKey(key)) ||
            !source.trim() ||
            sourceTooLarge
          }
          type="submit"
        >
          {busy ? "创建中" : "创建 Workflow"}
        </button>
      </div>
    </AccessibleDialog>
  );
}

function CreateAgentDialog({
  providers,
  onClose,
  onCreated,
}: {
  providers: ModelProvider[];
  onClose: () => void;
  onCreated: (agent: Agent) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [providerId, setProviderId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasDefault = providers.some((provider) => provider.isDefault);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) {
      setError("名称至少 2 位");
      return;
    }
    if (!slug.trim()) {
      setError("请输入标识");
      return;
    }
    if (!providerId && !hasDefault) {
      setError("请选择可用 Provider");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreated(
        await api.createAgent(
          {
            name: name.trim(),
            slug: slug.trim(),
            modelProviderId: providerId || null,
          },
          idempotencyKey,
        ),
      );
    } catch {
      setError("创建失败，输入已保留；可安全重试");
      setBusy(false);
    }
  }
  return (
    <AccessibleDialog onClose={onClose} onSubmit={submit} title="新增 Agent">
      <label>
        名称
        <input
          aria-label="名称"
          onChange={(event) => {
            setName(event.target.value);
            setIdempotencyKey(createIdempotencyKey());
          }}
          value={name}
        />
      </label>
      <label>
        标识
        <input
          aria-label="标识"
          onChange={(event) => {
            setSlug(event.target.value);
            setIdempotencyKey(createIdempotencyKey());
          }}
          placeholder="创建后不可修改"
          value={slug}
        />
      </label>
      <label>
        Provider
        <select
          aria-label="Provider"
          onChange={(event) => {
            setProviderId(event.target.value);
            setIdempotencyKey(createIdempotencyKey());
          }}
          value={providerId}
        >
          <option value="">使用全局默认 Provider</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
              {provider.isDefault ? "（全局默认）" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="help-text">
        Workspace 将创建于 .homelab/agents/{slug || "{slug}"}--系统生成/
      </p>
      {!providers.length ? (
        <Notice tone="error">暂无启用 Provider，请先配置模型提供方</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="modal-actions">
        <button
          className="ghost-button inline-ghost"
          onClick={onClose}
          type="button"
        >
          取消
        </button>
        <button disabled={busy || !providers.length} type="submit">
          {busy ? "创建中" : "创建 Agent"}
        </button>
      </div>
    </AccessibleDialog>
  );
}

function AccessibleDialog({
  children,
  className = "",
  onClose,
  onSubmit,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  title: string;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    const focusable = getFocusableElements(dialogRef.current);
    focusable[0]?.focus();
    return () => returnFocus.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusableElements(dialogRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className={`modal ${className}`.trim()}
        onKeyDown={handleKeyDown}
        onSubmit={onSubmit}
        ref={dialogRef}
        role="dialog"
      >
        <h3 id={titleId}>{title}</h3>
        {children}
      </form>
    </div>
  );
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function isRevisionConflict(error: unknown, code: string) {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.details || typeof error.details !== "object") return false;
  return (error.details as { code?: unknown }).code === code;
}

function StatusSummary({
  changeStatus,
  reloadStatus,
  auditStatus,
  rollbackResult,
  failedStage,
}: {
  changeStatus: string;
  reloadStatus: string;
  auditStatus: string;
  rollbackResult: string;
  failedStage: string | null;
}) {
  return (
    <dl className="status-summary">
      <div>
        <dt>变更</dt>
        <dd>{formatSkillChangeStatus(changeStatus)}</dd>
      </div>
      <div>
        <dt>Reload</dt>
        <dd>{formatSkillReloadStatus(reloadStatus)}</dd>
      </div>
      <div>
        <dt>审计</dt>
        <dd>{auditStatus}</dd>
      </div>
      <div>
        <dt>回滚</dt>
        <dd>{rollbackResult}</dd>
      </div>
      <div>
        <dt>失败阶段</dt>
        <dd>{failedStage ?? "-"}</dd>
      </div>
    </dl>
  );
}

function Notice({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error" | "success";
}) {
  return (
    <div
      aria-live="polite"
      className={`notice compact ${tone === "neutral" ? "" : tone}`}
    >
      {children}
    </div>
  );
}
function StatusBadge({ status }: { status: string }) {
  const valid =
    status === "ready" || status === "initializing" || status === "init_failed";
  return (
    <span
      className={`status ${status === "ready" ? "on" : status === "init_failed" || !valid ? "danger-status" : "off"}`}
    >
      {formatAgentStatus(status)}
    </span>
  );
}
function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "danger" | "neutral";
}) {
  return (
    <span className={`status ${tone === "danger" ? "danger-status" : "off"}`}>
      {label}
    </span>
  );
}
function formatProvider(agent: Agent) {
  const provider = agent.providerSummary;
  if (!provider || provider.source === "invalid") return "模型配置异常";
  if (provider.source === "default")
    return `全局默认 · ${provider.name ?? "-"}`;
  return provider.name ?? "专属 Provider";
}
function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}
function shortHash(value: string | null) {
  return value ? value.slice(0, 8) : "-";
}
function workflowExtension(workflow: AgentWorkflow): "ts" | "js" {
  return workflow.filePath?.endsWith(".js") ? "js" : "ts";
}
function createIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function syncAgentListUrl({
  query,
  page,
  pageSize,
}: {
  query: string;
  page: number;
  pageSize: number;
}) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}?${params}`,
  );
}

function readAgentListState(): {
  query: string;
  page: number;
  pageSize: (typeof pageSizes)[number];
} {
  const fallback = { query: "", page: 1, pageSize: 20 as const };
  if (typeof window === "undefined") {
    return fallback;
  }

  const params = new URLSearchParams(window.location.search);
  const rawPage = Number(params.get("page"));
  const rawPageSize = Number(params.get("pageSize"));

  return {
    query: (params.get("query") ?? "").trim(),
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : fallback.page,
    pageSize: pageSizes.includes(rawPageSize as (typeof pageSizes)[number])
      ? (rawPageSize as (typeof pageSizes)[number])
      : fallback.pageSize,
  };
}
