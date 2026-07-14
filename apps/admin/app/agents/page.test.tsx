import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ApiError,
  type Agent,
  type AgentWorkflow,
  type ModelProvider,
} from "@homelab/views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentsPage from "./page";

const mocks = vi.hoisted(() => ({
  api: {
    createAgent: vi.fn(),
    createAgentWorkflow: vi.fn(),
    getAgent: vi.fn(),
    getAgentSkillChange: vi.fn(),
    getAgentSoul: vi.fn(),
    getAgentWorkflow: vi.fn(),
    getWorkflowCapabilities: vi.fn(),
    installAgentSkill: vi.fn(),
    listAgentSkills: vi.fn(),
    listAgentWorkflowVersions: vi.fn(),
    listAgentWorkflows: vi.fn(),
    listAgents: vi.fn(),
    listModelProviders: vi.fn(),
    listSkillCatalogSkills: vi.fn(),
    listSkillCatalogSources: vi.fn(),
    listSkillCatalogVersions: vi.fn(),
    me: vi.fn(),
    reloadAgentWorkflow: vi.fn(),
    removeAgentSkill: vi.fn(),
    retryAgentInitialization: vi.fn(),
    rollbackAgentWorkflow: vi.fn(),
    saveAgentSoul: vi.fn(),
    saveAndReloadAgentWorkflow: vi.fn(),
    saveAgentWorkflowDraft: vi.fn(),
    updateAgent: vi.fn(),
    updateAgentSkill: vi.fn(),
    validateAgentWorkflow: vi.fn(),
  },
}));

vi.mock("../components/auth-shell", () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("../lib/api", () => ({ api: mocks.api }));

const provider: ModelProvider = {
  id: "provider-1",
  name: "OpenAI",
  nameKey: "openai",
  type: "OPENAI_COMPATIBLE",
  baseUrl: "https://example.invalid/v1",
  defaultModel: "gpt-test",
  isActive: true,
  isDefault: true,
  hasApiKey: true,
  createdAt: "2026-07-14T00:00:00Z",
  updatedAt: "2026-07-14T00:00:00Z",
};

const agent: Agent = {
  id: "agent-a",
  name: "Ops Agent",
  slug: "ops-agent",
  status: "ready",
  workspacePath: ".homelab/agents/ops-agent--a1",
  workspaceName: "ops-agent--a1",
  initError: null,
  gitStatus: "dirty",
  modelProviderId: null,
  providerSummary: { id: "provider-1", name: "OpenAI", source: "default" },
  revision: 7,
  updatedAt: "2026-07-14T00:00:00Z",
};

const workflow: AgentWorkflow = {
  workflowKey: "support",
  filePath: "workflows/support.ts",
  source: "export default { version: 1 }",
  draftHash: "draft-v1",
  activeHash: "active-v1",
  revision: 1,
  reloadStatus: "draft",
};

const page = (items: Agent[] = [agent], pageNumber = 1, pageSize = 20) => ({
  items,
  total: items.length,
  page: pageNumber,
  pageSize,
});

describe("AgentsPage", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/agents");
    mocks.api.listAgents.mockResolvedValue(page());
    mocks.api.listModelProviders.mockResolvedValue([provider]);
    mocks.api.me.mockResolvedValue({
      id: "admin",
      username: "admin",
      role: "ADMIN",
      isActive: true,
    });
    mocks.api.getAgent.mockResolvedValue(agent);
    mocks.api.getAgentSoul.mockResolvedValue({
      content: "Be concise",
      missing: false,
      revision: 3,
      maxBytes: 65_536,
    });
    mocks.api.listAgentSkills.mockResolvedValue({
      agentId: agent.id,
      changeStatus: "succeeded",
      reloadStatus: "loaded",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      skills: [],
    });
    mocks.api.listAgentWorkflows.mockResolvedValue([workflow]);
    mocks.api.getAgentWorkflow.mockResolvedValue(workflow);
    mocks.api.listAgentWorkflowVersions.mockResolvedValue([]);
    mocks.api.getWorkflowCapabilities.mockResolvedValue({
      sourceMaxBytes: 262_144,
      reloadTimeoutMs: 30_000,
      historyLimit: 10,
      extensions: ["ts", "js"],
    });
  });

  async function renderReadyPage() {
    render(<AgentsPage />);
    expect(await screen.findByText("Ops Agent")).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Agent 详情" }),
    ).toBeInTheDocument();
  }

  it("queries paginated agents and renders provider, status, and git summaries", async () => {
    await renderReadyPage();

    expect(screen.getByText("全局默认 · OpenAI")).toBeInTheDocument();
    expect(screen.getByText("有未提交变更")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("搜索 Agent"), " ops ");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() =>
      expect(mocks.api.listAgents).toHaveBeenLastCalledWith({
        query: "ops",
        page: 1,
        pageSize: 20,
      }),
    );
    expect(window.location.search).toBe("?query=ops&page=1&pageSize=20");
  });

  it("keeps stale rows visible when refresh fails", async () => {
    await renderReadyPage();
    mocks.api.listAgents.mockRejectedValueOnce(new Error("offline"));

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("列表刷新失败，请重试")).toBeInTheDocument();
    expect(screen.getByText("Ops Agent")).toBeInTheDocument();
  });

  it("creates an agent with an enabled Provider reference and no secret fields", async () => {
    mocks.api.createAgent.mockResolvedValue({
      ...agent,
      id: "agent-b",
      name: "QA Agent",
    });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("button", { name: "新增 Agent" }));
    expect(screen.queryByLabelText(/Secret/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Soul")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("名称"), "QA Agent");
    await userEvent.type(screen.getByLabelText("标识"), "qa-agent");
    await userEvent.selectOptions(
      screen.getByLabelText("Provider"),
      "provider-1",
    );
    await userEvent.click(screen.getByRole("button", { name: "创建 Agent" }));

    await waitFor(() =>
      expect(mocks.api.createAgent).toHaveBeenCalledWith(
        { name: "QA Agent", slug: "qa-agent", modelProviderId: "provider-1" },
        expect.any(String),
      ),
    );
  });

  it("updates name and Provider with the loaded revision", async () => {
    mocks.api.updateAgent.mockResolvedValue({
      ...agent,
      name: "Renamed Agent",
      modelProviderId: "provider-1",
      revision: 8,
    });
    await renderReadyPage();

    const detail = screen.getByRole("region", { name: "Agent 详情" });
    await userEvent.clear(within(detail).getByLabelText("Agent 名称"));
    await userEvent.type(
      within(detail).getByLabelText("Agent 名称"),
      "Renamed Agent",
    );
    await userEvent.selectOptions(
      within(detail).getByLabelText("Agent Provider"),
      "provider-1",
    );
    await userEvent.click(
      within(detail).getByRole("button", { name: "保存基础配置" }),
    );

    await waitFor(() =>
      expect(mocks.api.updateAgent).toHaveBeenCalledWith("agent-a", {
        name: "Renamed Agent",
        modelProviderId: "provider-1",
        expectedRevision: 7,
      }),
    );
    expect(await screen.findByText("基础配置已保存")).toBeInTheDocument();
  });

  it("uses the real Agent DTO and retries a failed initialization", async () => {
    const failed = {
      ...agent,
      status: "init_failed",
      gitStatus: "unavailable",
      initError: {
        code: "WORKSPACE_FILE_WRITE_FAILED",
        message: "soul.md 初始化失败",
      },
    };
    mocks.api.listAgents.mockResolvedValue(page([failed]));
    mocks.api.getAgent.mockResolvedValue(failed);
    mocks.api.retryAgentInitialization.mockResolvedValue({
      ...failed,
      status: "initializing",
    });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByText("WORKSPACE_FILE_WRITE_FAILED")).toBeInTheDocument();
    expect(
      screen.queryByText(/agent\.yaml|soul\.md 缺失/),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试初始化" }));

    await waitFor(() =>
      expect(mocks.api.retryAgentInitialization).toHaveBeenCalledWith(
        "agent-a",
      ),
    );
  });

  it("recovers overview edits from a revision conflict using the latest snapshot", async () => {
    mocks.api.updateAgent
      .mockRejectedValueOnce(
        new ApiError("conflict", 409, {
          code: "REVISION_CONFLICT",
          currentRevision: 8,
        }),
      )
      .mockResolvedValueOnce({ ...agent, name: "Conflict Name", revision: 9 });
    mocks.api.getAgent
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce({ ...agent, name: "Server Name", revision: 8 });
    await renderReadyPage();

    const name = screen.getByLabelText("Agent 名称");
    await userEvent.clear(name);
    await userEvent.type(name, "Conflict Name");
    await userEvent.click(screen.getByRole("button", { name: "保存基础配置" }));

    expect(
      (await screen.findAllByText(/服务器 Revision 8/)).length,
    ).toBeGreaterThan(0);
    await userEvent.click(
      screen.getByRole("button", { name: "重新应用我的基础配置" }),
    );
    expect(name).toHaveValue("Conflict Name");
    await userEvent.click(screen.getByRole("button", { name: "保存基础配置" }));
    await waitFor(() =>
      expect(mocks.api.updateAgent).toHaveBeenLastCalledWith(
        "agent-a",
        expect.objectContaining({ expectedRevision: 8 }),
      ),
    );
  });

  it("preserves and retries a Soul draft after refreshing a revision conflict", async () => {
    mocks.api.saveAgentSoul
      .mockRejectedValueOnce(
        new ApiError("conflict", 409, {
          code: "SOUL_REVISION_CONFLICT",
          currentRevision: 4,
        }),
      )
      .mockResolvedValueOnce({
        content: "My Soul",
        missing: false,
        revision: 5,
        maxBytes: 65_536,
      });
    mocks.api.getAgentSoul
      .mockResolvedValueOnce({
        content: "Old Soul",
        missing: false,
        revision: 3,
        maxBytes: 65_536,
      })
      .mockResolvedValueOnce({
        content: "Server Soul",
        missing: false,
        revision: 4,
        maxBytes: 65_536,
      });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Soul" }));
    const editor = await screen.findByLabelText("Soul 内容");
    await userEvent.clear(editor);
    await userEvent.type(editor, "My Soul");
    await userEvent.click(screen.getByRole("button", { name: "保存 Soul" }));

    expect(
      (await screen.findAllByText(/服务器 Revision 4/)).length,
    ).toBeGreaterThan(0);
    expect(editor).toHaveValue("My Soul");
    await userEvent.click(
      screen.getByRole("button", { name: "使用最新 revision 重试 Soul" }),
    );
    await waitFor(() =>
      expect(mocks.api.saveAgentSoul).toHaveBeenLastCalledWith(
        "agent-a",
        "My Soul",
        4,
      ),
    );
  });

  it("refreshes workspace details on demand", async () => {
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    await userEvent.click(
      screen.getByRole("button", { name: "刷新 Workspace" }),
    );

    await waitFor(() => expect(mocks.api.getAgent).toHaveBeenCalledTimes(2));
  });

  it("polls an initializing Agent until it reaches a terminal state", async () => {
    const initializing = { ...agent, status: "initializing" };
    const ready = { ...agent, status: "ready" };
    mocks.api.listAgents.mockResolvedValue(page([initializing]));
    mocks.api.getAgent
      .mockResolvedValueOnce(initializing)
      .mockResolvedValueOnce(ready);

    await renderReadyPage();

    await waitFor(() => expect(mocks.api.getAgent).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    expect(screen.getAllByText("可用").length).toBeGreaterThan(0);
  });

  it("loads and saves soul with byte count and revision", async () => {
    mocks.api.saveAgentSoul.mockResolvedValue({
      content: "新的 Soul",
      missing: false,
      revision: 4,
      maxBytes: 65_536,
    });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("tab", { name: "Soul" }));
    const editor = await screen.findByLabelText("Soul 内容");
    expect(screen.getByText("10 / 65536 字节")).toBeInTheDocument();
    await userEvent.clear(editor);
    await userEvent.type(editor, "新的 Soul");
    await userEvent.click(screen.getByRole("button", { name: "保存 Soul" }));

    await waitFor(() =>
      expect(mocks.api.saveAgentSoul).toHaveBeenCalledWith(
        "agent-a",
        "新的 Soul",
        3,
      ),
    );
    expect(await screen.findByText("Soul 已保存")).toBeInTheDocument();
  });

  it("installs a skill through the controlled catalog", async () => {
    mocks.api.listSkillCatalogSources.mockResolvedValue({
      items: [{ id: "builtin", label: "Built-in", sourceType: "registry" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.listSkillCatalogSkills.mockResolvedValue({
      items: [{ skillId: "qa", name: "qa", description: "QA helpers" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.listSkillCatalogVersions.mockResolvedValue({
      items: [
        {
          version: "1.2.0",
          immutableRef: "sha-120",
          createdAt: "2026-07-14T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.installAgentSkill.mockResolvedValue({
      changeId: "change-1",
      skillName: "qa",
      operation: "install",
      changeStatus: "succeeded",
      reloadStatus: "pending_restart",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      terminal: true,
    });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "安装 Skill" }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Skill 来源"),
      "builtin",
    );
    await userEvent.selectOptions(await screen.findByLabelText("Skill"), "qa");
    await userEvent.selectOptions(
      await screen.findByLabelText("Skill 版本"),
      "1.2.0",
    );
    await userEvent.click(screen.getByRole("button", { name: "确认安装" }));

    await waitFor(() =>
      expect(mocks.api.installAgentSkill).toHaveBeenCalledWith("agent-a", {
        skillName: "qa",
        sourceId: "builtin",
        sourceType: "registry",
        version: "1.2.0",
      }),
    );
    expect(await screen.findByText("等待重启")).toBeInTheDocument();
  });

  it("edits, validates, and reloads a workflow draft", async () => {
    mocks.api.validateAgentWorkflow.mockResolvedValue({ valid: true });
    mocks.api.saveAndReloadAgentWorkflow.mockResolvedValue({
      ...workflow,
      source: "export default { version: 2 }",
      draftHash: "draft-v2",
      activeHash: "draft-v2",
      revision: 2,
      reloadStatus: "succeeded",
    });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑 support" }),
    );
    const source = await screen.findByLabelText("Workflow 源码");
    await userEvent.clear(source);
    await userEvent.type(source, "export default {{ version: 2 }}");
    await userEvent.click(screen.getByRole("button", { name: "校验" }));
    expect(await screen.findByText("校验通过")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "保存并 reload" }),
    );

    await waitFor(() =>
      expect(mocks.api.saveAndReloadAgentWorkflow).toHaveBeenCalledWith(
        "agent-a",
        "support",
        expect.objectContaining({ expectedRevision: 1 }),
      ),
    );
    expect(mocks.api.saveAgentWorkflowDraft).not.toHaveBeenCalled();
    expect(mocks.api.reloadAgentWorkflow).not.toHaveBeenCalled();
    expect(await screen.findByText("已生效")).toBeInTheDocument();
  });

  it("keeps Workflow validation read-like while ready writes stay disabled", async () => {
    const initializing = { ...agent, status: "initializing" };
    mocks.api.listAgents.mockResolvedValue(page([initializing]));
    mocks.api.getAgent.mockResolvedValue(initializing);
    mocks.api.validateAgentWorkflow.mockResolvedValue({ valid: true });
    await renderReadyPage();

    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑 support" }),
    );
    const editor = await screen.findByLabelText("Workflow 源码");
    expect(editor).toBeEnabled();
    await userEvent.type(editor, "\n// validate only");
    await userEvent.click(screen.getByRole("button", { name: "校验" }));

    expect(mocks.api.validateAgentWorkflow).toHaveBeenCalledWith(
      "agent-a",
      "support",
      expect.objectContaining({
        source: expect.stringContaining("validate only"),
      }),
    );
    expect(screen.getByRole("button", { name: "保存 draft" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "保存并 reload" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "reload 当前 draft" }),
    ).toBeDisabled();
  });

  it("keeps basic settings writable while disabling ready-gated resources", async () => {
    const initializing = { ...agent, status: "initializing" };
    mocks.api.listAgents.mockResolvedValue(page([initializing]));
    mocks.api.getAgent.mockResolvedValue(initializing);
    await renderReadyPage();

    await userEvent.clear(screen.getByLabelText("Agent 名称"));
    await userEvent.type(screen.getByLabelText("Agent 名称"), "Repair Agent");
    expect(screen.getByRole("button", { name: "保存基础配置" })).toBeEnabled();
    await userEvent.click(screen.getByRole("tab", { name: "Soul" }));
    expect(await screen.findByLabelText("Soul 内容")).toBeDisabled();
    expect(
      screen.getByText("Agent 尚未就绪，配置写入已禁用"),
    ).toBeInTheDocument();
  });

  it("supports page-size changes and degrades unknown response enums safely", async () => {
    const unusual = {
      ...agent,
      status: "future_status",
      gitStatus: "future_git",
      providerSummary: { id: null, name: null, source: "invalid" as const },
      updatedAt: undefined,
    };
    mocks.api.listAgents.mockResolvedValue({
      items: [unusual],
      total: 120,
      page: 1,
      pageSize: 20,
    });
    mocks.api.getAgent.mockResolvedValue(unusual);
    await renderReadyPage();

    expect(screen.getAllByText("状态异常").length).toBeGreaterThan(0);
    expect(screen.getByText("Git 状态异常")).toBeInTheDocument();
    expect(screen.getByText("模型配置异常")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("每页数量"), "50");
    await waitFor(() =>
      expect(mocks.api.listAgents).toHaveBeenLastCalledWith({
        query: "",
        page: 1,
        pageSize: 50,
      }),
    );
  });

  it("restores query and pagination from the URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/agents?query=qa&page=2&pageSize=50",
    );
    mocks.api.listAgents.mockResolvedValue({
      items: [agent],
      total: 51,
      page: 2,
      pageSize: 50,
    });

    render(<AgentsPage />);

    await waitFor(() =>
      expect(mocks.api.listAgents).toHaveBeenCalledWith({
        query: "qa",
        page: 2,
        pageSize: 50,
      }),
    );
    expect(screen.getByLabelText("搜索 Agent")).toHaveValue("qa");
  });

  it("preserves create form input across validation and request failures", async () => {
    mocks.api.createAgent.mockRejectedValue(new Error("conflict"));
    await renderReadyPage();
    await userEvent.click(screen.getByRole("button", { name: "新增 Agent" }));

    await userEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    expect(screen.getByText("名称至少 2 位")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("名称"), "QA Agent");
    await userEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    expect(screen.getByText("请输入标识")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("标识"), "qa-agent");
    await userEvent.click(screen.getByRole("button", { name: "创建 Agent" }));

    expect(
      await screen.findByText("创建失败，输入已保留；可安全重试"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("QA Agent")).toBeInTheDocument();

    const firstKey = mocks.api.createAgent.mock.calls[0]?.[1];
    await userEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    await waitFor(() => expect(mocks.api.createAgent).toHaveBeenCalledTimes(2));
    expect(mocks.api.createAgent.mock.calls[1]?.[1]).toBe(firstKey);
  });

  it("keeps overview edits after a revision-aware save failure", async () => {
    mocks.api.updateAgent.mockRejectedValue(new Error("revision conflict"));
    await renderReadyPage();
    const name = screen.getByLabelText("Agent 名称");
    await userEvent.clear(name);
    await userEvent.type(name, "Conflict Name");
    await userEvent.click(screen.getByRole("button", { name: "保存基础配置" }));

    expect(
      await screen.findByText("保存失败，配置未变；请刷新后重试"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Conflict Name")).toBeInTheDocument();
  });

  it("shows missing Soul recovery and preserves a failed draft", async () => {
    mocks.api.getAgentSoul.mockResolvedValue({
      content: "Recovery content",
      missing: true,
      revision: 1,
      maxBytes: 65_536,
    });
    mocks.api.saveAgentSoul.mockRejectedValue(new Error("write failed"));
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Soul" }));

    expect(
      await screen.findByText("当前 soul.md 缺失，保存后将重新创建"),
    ).toBeInTheDocument();
    const editor = screen.getByLabelText("Soul 内容");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Unsaved recovery");
    await userEvent.click(screen.getByRole("button", { name: "保存 Soul" }));
    expect(
      await screen.findByText("Soul 保存失败，编辑内容已保留"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Unsaved recovery")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消修改" }));
    expect(screen.getByDisplayValue("Recovery content")).toBeInTheDocument();
  });

  it("removes a non-system skill and renders independent failure states", async () => {
    mocks.api.listAgentSkills.mockResolvedValue({
      agentId: agent.id,
      changeStatus: "failed",
      reloadStatus: "runtime_offline",
      auditStatus: "audit_failed",
      rollbackResult: "failed",
      failedStage: "reload",
      errorCode: "RUNTIME_OFFLINE",
      safeErrorSummary: "Runtime offline",
      skills: [
        {
          name: "qa",
          version: "1.0.0",
          sourceType: "registry",
          sourceId: "builtin",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false,
        },
      ],
    });
    mocks.api.removeAgentSkill.mockResolvedValue({
      changeId: "remove-1",
      skillName: "qa",
      operation: "remove",
      changeStatus: "rolled_back",
      reloadStatus: "failed",
      auditStatus: "audit_written",
      rollbackResult: "succeeded",
      failedStage: "reload",
      errorCode: "RELOAD_FAILED",
      safeErrorSummary: "reload failed",
      terminal: true,
    });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await userEvent.click(await screen.findByRole("button", { name: "移除" }));

    await waitFor(() =>
      expect(mocks.api.removeAgentSkill).toHaveBeenCalledWith("agent-a", "qa"),
    );
    expect(screen.getAllByText("已回滚").length).toBeGreaterThan(0);
  });

  it("updates an installed skill to a controlled Catalog version", async () => {
    mocks.api.listAgentSkills.mockResolvedValue({
      agentId: agent.id,
      changeStatus: "succeeded",
      reloadStatus: "loaded",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      skills: [
        {
          name: "qa",
          version: "1.0.0",
          sourceType: "registry",
          sourceId: "builtin",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false,
        },
      ],
    });
    mocks.api.listSkillCatalogSources.mockResolvedValue({
      items: [{ id: "builtin", label: "Built-in", sourceType: "registry" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.listSkillCatalogSkills.mockResolvedValue({
      items: [{ skillId: "qa-tools", name: "qa" }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.listSkillCatalogVersions.mockResolvedValue({
      items: [
        {
          version: "2.0.0",
          immutableRef: "sha-200",
          createdAt: "2026-07-14T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    mocks.api.updateAgentSkill.mockResolvedValue({
      changeId: "update-1",
      skillName: "qa",
      operation: "update",
      changeStatus: "succeeded",
      reloadStatus: "loaded",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      terminal: true,
    });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await userEvent.click(await screen.findByRole("button", { name: "更新" }));
    await waitFor(() =>
      expect(mocks.api.listSkillCatalogVersions).toHaveBeenCalledWith(
        "builtin",
        "qa-tools",
        { page: 1, pageSize: 100 },
      ),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Skill 版本"),
      "2.0.0",
    );
    await userEvent.click(screen.getByRole("button", { name: "确认更新" }));

    await waitFor(() =>
      expect(mocks.api.updateAgentSkill).toHaveBeenCalledWith("agent-a", {
        skillName: "qa",
        sourceId: "builtin",
        sourceType: "registry",
        version: "2.0.0",
      }),
    );
  });

  it("rolls back from the real response DTO without a source field", async () => {
    mocks.api.listAgentWorkflowVersions.mockResolvedValue([
      {
        id: "version-1",
        sourceHash: "1234567890",
        source: "export default { version: 'rollback' }",
        extension: "ts",
      },
    ]);
    mocks.api.rollbackAgentWorkflow.mockResolvedValue({
      workflowKey: "support",
      filePath: "workflows/support.ts",
      draftHash: "rollback-hash",
      activeHash: "rollback-hash",
      revision: 2,
      reloadStatus: "succeeded",
    });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑 support" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "回滚到此版本" }));

    expect(screen.getByLabelText("Workflow 源码")).toHaveValue(
      "export default { version: 'rollback' }",
    );
  });

  it("loads Workflow capabilities and blocks multibyte sources over the byte limit", async () => {
    mocks.api.getWorkflowCapabilities.mockResolvedValue({
      sourceMaxBytes: 4,
      reloadTimeoutMs: 30_000,
      historyLimit: 1,
      extensions: ["ts"],
    });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "新建 Workflow" }),
    );
    await userEvent.type(screen.getByLabelText("Workflow key"), "new-flow");
    expect(
      screen.getByRole("button", { name: "创建 Workflow" }),
    ).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑 support" }),
    );
    const editor = screen.getByLabelText("Workflow 源码");
    await userEvent.clear(editor);
    await userEvent.type(editor, "你好");

    expect(screen.getByText("6 / 4 字节")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 draft" })).toBeDisabled();
    expect(screen.getByText(/最多保留 1 个历史版本/)).toBeInTheDocument();
  });

  it("preserves and retries a Workflow draft after refreshing a revision conflict", async () => {
    mocks.api.saveAgentWorkflowDraft
      .mockRejectedValueOnce(
        new ApiError("conflict", 409, {
          code: "WORKFLOW_REVISION_CONFLICT",
          currentRevision: 2,
        }),
      )
      .mockResolvedValueOnce({
        ...workflow,
        revision: 3,
        draftHash: "draft-v3",
      });
    mocks.api.getAgentWorkflow
      .mockResolvedValueOnce(workflow)
      .mockResolvedValueOnce({
        ...workflow,
        source: "export default { server: true }",
        revision: 2,
        draftHash: "server-v2",
      });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑 support" }),
    );
    const editor = screen.getByLabelText("Workflow 源码");
    await userEvent.clear(editor);
    await userEvent.type(editor, "export default {{ local: true }}");
    await userEvent.click(screen.getByRole("button", { name: "保存 draft" }));

    expect(
      (await screen.findAllByText(/服务器 Revision 2/)).length,
    ).toBeGreaterThan(0);
    expect(editor).toHaveValue("export default { local: true }}");
    await userEvent.click(
      screen.getByRole("button", { name: "使用最新 revision 重试 Workflow" }),
    );
    await waitFor(() =>
      expect(mocks.api.saveAgentWorkflowDraft).toHaveBeenLastCalledWith(
        "agent-a",
        "support",
        expect.objectContaining({ expectedRevision: 2 }),
      ),
    );
  });

  it("supports dialog focus, Escape close, focus return, and roving tabs", async () => {
    await renderReadyPage();
    const opener = screen.getByRole("button", { name: "新增 Agent" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "新增 Agent" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("名称")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "新增 Agent" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    const overview = screen.getByRole("tab", { name: "概览" });
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "agent-tab-workspace",
    );
  });

  it("restarts Workflow polling from manual refresh and stops after unmount", async () => {
    mocks.api.getAgentWorkflow.mockResolvedValue({
      ...workflow,
      reloadStatus: "loading",
    });
    mocks.api.getWorkflowCapabilities.mockResolvedValue({
      sourceMaxBytes: 262_144,
      reloadTimeoutMs: 3_000,
      historyLimit: 10,
      extensions: ["ts", "js"],
    });
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByText("Ops Agent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    const editButton = await screen.findByRole("button", {
      name: "编辑 support",
    });
    vi.useFakeTimers();
    act(() => editButton.click());
    await act(async () => Promise.resolve());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
    }
    expect(mocks.api.getAgentWorkflow).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/可手动刷新当前 Workflow/)).toBeInTheDocument();
    const beforeRefresh = mocks.api.getAgentWorkflow.mock.calls.length;
    await act(async () => {
      screen.getByRole("button", { name: "刷新当前 Workflow" }).click();
      await Promise.resolve();
    });
    expect(mocks.api.getAgentWorkflow.mock.calls.length).toBe(
      beforeRefresh + 1,
    );
    unmount();
    const atUnmount = mocks.api.getAgentWorkflow.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(mocks.api.getAgentWorkflow).toHaveBeenCalledTimes(atUnmount);
  });

  it("polls a Skill change at 1s x10 then 2s to 30s and stops on leave", async () => {
    const pendingChange = {
      changeId: "change-pending",
      skillName: "qa",
      operation: "remove",
      changeStatus: "applying",
      reloadStatus: "unknown",
      auditStatus: "audit_pending",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      terminal: false,
    };
    mocks.api.listAgentSkills.mockResolvedValue({
      agentId: agent.id,
      changeStatus: "succeeded",
      reloadStatus: "loaded",
      auditStatus: "audit_written",
      rollbackResult: "not_required",
      failedStage: null,
      errorCode: null,
      safeErrorSummary: null,
      skills: [
        {
          name: "qa",
          version: "1.0.0",
          sourceType: "registry",
          sourceId: "builtin",
          enabled: true,
          systemRequired: false,
          selfUpdateAllowed: false,
        },
      ],
    });
    mocks.api.removeAgentSkill.mockResolvedValue(pendingChange);
    mocks.api.getAgentSkillChange.mockResolvedValue(pendingChange);
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByText("Ops Agent")).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Agent 详情" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Skills" }));
    const remove = await screen.findByRole("button", { name: "移除" });
    vi.useFakeTimers();
    await act(async () => {
      remove.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
    }
    expect(mocks.api.getAgentSkillChange).toHaveBeenCalledTimes(20);
    expect(
      screen.getByText("Skill 变更仍在进行，可手动刷新状态"),
    ).toBeInTheDocument();
    await act(async () => {
      screen.getByRole("button", { name: "刷新当前 Skill 变更" }).click();
      await Promise.resolve();
    });
    expect(mocks.api.getAgentSkillChange).toHaveBeenCalledTimes(21);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.api.getAgentSkillChange).toHaveBeenCalledTimes(21);
  });

  it("creates a workflow and rolls back to a scoped history version", async () => {
    mocks.api.createAgentWorkflow.mockResolvedValue({
      ...workflow,
      workflowKey: "new-flow",
      source: "export default {}\n",
    });
    mocks.api.getAgentWorkflow.mockImplementation((_: string, key: string) =>
      Promise.resolve({ ...workflow, workflowKey: key }),
    );
    mocks.api.listAgentWorkflowVersions.mockResolvedValue([
      {
        id: "version-1",
        sourceHash: "1234567890",
        source: "export default {}",
        extension: "ts",
      },
    ]);
    mocks.api.rollbackAgentWorkflow.mockResolvedValue({
      ...workflow,
      reloadStatus: "succeeded",
    });
    await renderReadyPage();
    await userEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "新建 Workflow" }),
    );
    await userEvent.type(screen.getByLabelText("Workflow key"), "new-flow");
    await userEvent.click(
      screen.getByRole("button", { name: "创建 Workflow" }),
    );

    await waitFor(() =>
      expect(mocks.api.createAgentWorkflow).toHaveBeenCalled(),
    );
    expect(await screen.findByLabelText("Workflow 源码")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回滚到此版本" }));
    expect(await screen.findByText("Workflow 已回滚")).toBeInTheDocument();
  });

  it("distinguishes the initial empty state from a load error", async () => {
    mocks.api.listAgents.mockResolvedValueOnce(page([]));
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByText("暂无 Agent")).toBeInTheDocument();
    unmount();

    mocks.api.listAgents.mockRejectedValueOnce(new Error("offline"));
    render(<AgentsPage />);
    expect(
      await screen.findByText("Agent 列表加载失败，请重试"),
    ).toBeInTheDocument();
  });
});
