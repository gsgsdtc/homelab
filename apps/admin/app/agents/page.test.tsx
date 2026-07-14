import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent } from "@homelab/views";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AgentsPage from "./page";

const mocks = vi.hoisted(() => ({
  api: {
    createAgent: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    me: vi.fn(),
    retryAgentInitialization: vi.fn(),
    saveAgentSoul: vi.fn(),
  },
}));

vi.mock("../components/auth-shell", () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("../lib/api", () => ({
  api: mocks.api,
}));

const agentA: Agent = {
  id: "agent-a",
  name: "Agent A",
  status: "ready" as const,
  workspacePath: ".homelab/agents/a",
  workspaceName: "agent-a",
  initError: null,
  gitStatus: "clean" as const,
};

const agentB: Agent = {
  ...agentA,
  id: "agent-b",
  name: "Agent B",
  workspacePath: ".homelab/agents/b",
  workspaceName: "agent-b",
};

describe("AgentsPage", () => {
  beforeEach(() => {
    mocks.api.createAgent.mockReset();
    mocks.api.getAgent.mockReset();
    mocks.api.listAgents.mockReset();
    mocks.api.me.mockReset();
    mocks.api.retryAgentInitialization.mockReset();
    mocks.api.saveAgentSoul.mockReset();
  });

  function mockAdmin() {
    mocks.api.me.mockResolvedValue({
      id: "u1",
      username: "admin",
      role: "ADMIN",
      isActive: true,
    });
  }

  function mockAgentList(agents = [agentA]) {
    mocks.api.listAgents.mockResolvedValue(agents);
  }

  function mockLoadedAgent(agent = agentA, soul = "Agent A private soul") {
    mocks.api.getAgent.mockResolvedValue({
      ...agent,
      soul,
      soulFileStatus: "loaded",
    });
  }

  async function renderLoadedPage() {
    render(<AgentsPage />);
    await screen.findByDisplayValue("Agent A private soul");
    await waitFor(() =>
      expect(screen.getByLabelText("Soul 内容")).toBeEnabled(),
    );
  }

  it("does not show or save the previous agent soul when the next detail load fails", async () => {
    mockAdmin();
    mockAgentList([agentA, agentB]);
    mocks.api.getAgent
      .mockResolvedValueOnce({
        ...agentA,
        soul: "Agent A private soul",
        soulFileStatus: "loaded",
      })
      .mockRejectedValueOnce(new Error("detail failed"));

    render(<AgentsPage />);

    expect(
      await screen.findByDisplayValue("Agent A private soul"),
    ).toBeEnabled();

    const agentBRow = screen.getByText("Agent B").closest("tr");
    expect(agentBRow).not.toBeNull();
    await userEvent.click(
      within(agentBRow as HTMLTableRowElement).getByRole("button", {
        name: "详情",
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("Agent 详情加载失败")).toBeInTheDocument(),
    );

    expect(
      screen.queryByDisplayValue("Agent A private soul"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Soul 内容")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(mocks.api.saveAgentSoul).not.toHaveBeenCalled();
  });

  it("saves edited soul content through the dedicated endpoint", async () => {
    mockAdmin();
    mockAgentList();
    mockLoadedAgent();
    mocks.api.saveAgentSoul.mockResolvedValue({
      ...agentA,
      soul: "Updated soul",
      soulFileStatus: "loaded",
    });

    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Soul 内容"), {
      target: { value: "Updated soul" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mocks.api.saveAgentSoul).toHaveBeenCalledWith(
        "agent-a",
        "Updated soul",
      ),
    );
    expect(await screen.findByText("保存成功")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Updated soul")).toBeInTheDocument();
  });

  it("keeps the edited draft when soul save fails", async () => {
    mockAdmin();
    mockAgentList();
    mockLoadedAgent();
    mocks.api.saveAgentSoul.mockRejectedValue(new Error("save failed"));

    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Soul 内容"), {
      target: { value: "Unsaved soul" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Unsaved soul")).toBeInTheDocument();
  });

  it("shows a visible validation message for blank soul drafts", async () => {
    mockAdmin();
    mockAgentList();
    mockLoadedAgent();

    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Soul 内容"), {
      target: { value: "   \n\t" },
    });

    expect(await screen.findByText("soul 内容不能为空")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(mocks.api.saveAgentSoul).not.toHaveBeenCalled();
  });

  it("restores the latest loaded soul when cancelling edits", async () => {
    mockAdmin();
    mockAgentList();
    mockLoadedAgent();

    await renderLoadedPage();

    fireEvent.change(screen.getByLabelText("Soul 内容"), {
      target: { value: "Temporary soul" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消修改" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "取消修改" }));

    expect(
      screen.getByDisplayValue("Agent A private soul"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("shows the missing soul recovery state and allows editing", async () => {
    mockAdmin();
    mockAgentList();
    mocks.api.getAgent.mockResolvedValue({
      ...agentA,
      soul: "Default recovery soul",
      soulFileStatus: "missing",
    });

    render(<AgentsPage />);

    expect(
      await screen.findByText("当前 soul 文件缺失，保存后将重新创建 soul.md"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Default recovery soul")).toBeEnabled();
  });

  it("keeps the soul editor readonly for non-admin users", async () => {
    mocks.api.me.mockResolvedValue({
      id: "u2",
      username: "viewer",
      role: "USER",
      isActive: true,
    });
    mockAgentList();
    mockLoadedAgent();

    render(<AgentsPage />);
    await screen.findByDisplayValue("Agent A private soul");

    expect(
      screen.getByText("你没有权限编辑该 Agent 的 soul"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Soul 内容")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("retries failed agent initialization from the detail panel", async () => {
    mockAdmin();
    const failedAgent = {
      ...agentA,
      status: "init_failed" as const,
      initError: { message: "workspace failed" },
    };
    mockAgentList([failedAgent]);
    mockLoadedAgent(failedAgent);
    mocks.api.retryAgentInitialization.mockResolvedValue({
      ...failedAgent,
      status: "ready",
      initError: null,
    });

    render(<AgentsPage />);

    await screen.findByText("workspace failed");
    await userEvent.click(
      within(screen.getByLabelText("Agent 详情")).getByRole("button", {
        name: "重试初始化",
      }),
    );

    await waitFor(() =>
      expect(mocks.api.retryAgentInitialization).toHaveBeenCalledWith(
        "agent-a",
      ),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
  });

  it("links a ready Agent to its direct chat route", async () => {
    mockAdmin();
    mockAgentList();
    mockLoadedAgent();

    await renderLoadedPage();

    expect(screen.getByRole("link", { name: "开始聊天" })).toHaveAttribute(
      "href",
      "/agents/agent-a/chat",
    );
    expect(screen.getByRole("link", { name: "聊天" })).toHaveAttribute(
      "href",
      "/agents/agent-a/chat",
    );
  });

  it("creates an agent from the dialog and selects the created agent", async () => {
    mockAdmin();
    mocks.api.listAgents
      .mockResolvedValueOnce([agentA])
      .mockResolvedValueOnce([agentA, agentB]);
    mocks.api.getAgent.mockImplementation((id: string) =>
      Promise.resolve({
        ...(id === "agent-b" ? agentB : agentA),
        soul: id === "agent-b" ? "Agent B soul" : "Agent A private soul",
        soulFileStatus: "loaded",
      }),
    );
    mocks.api.createAgent.mockResolvedValue(agentB);

    await renderLoadedPage();

    await userEvent.click(screen.getByRole("button", { name: "新增 Agent" }));
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(screen.getByText("名称至少 2 位")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("名称"), "Agent B");
    await userEvent.type(screen.getByLabelText("标识"), "agent-b");
    await userEvent.type(screen.getByLabelText("模型提供方"), "openai");
    await userEvent.type(
      screen.getByLabelText("Secret 引用"),
      "OPENAI_API_KEY",
    );
    await userEvent.type(screen.getByLabelText("Soul"), "Agent B soul");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(mocks.api.createAgent).toHaveBeenCalledWith({
        name: "Agent B",
        slug: "agent-b",
        modelProvider: "openai",
        modelSecretRef: "OPENAI_API_KEY",
        soul: "Agent B soul",
      }),
    );
    expect(await screen.findByDisplayValue("Agent B soul")).toBeInTheDocument();
  });

  it("renders empty and list error states", async () => {
    mockAdmin();
    mocks.api.listAgents.mockResolvedValueOnce([]);

    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByText("暂无 Agent")).toBeInTheDocument();
    unmount();

    mockAdmin();
    mocks.api.listAgents.mockRejectedValueOnce(new Error("list failed"));

    render(<AgentsPage />);
    expect(await screen.findByText("Agent 列表加载失败")).toBeInTheDocument();
  });
});
