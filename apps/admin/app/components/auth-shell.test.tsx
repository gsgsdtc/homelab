import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthShell } from "./auth-shell";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  router: { replace: vi.fn() },
  api: {
    getToken: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    onUnauthorized: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => mocks.router,
}));

vi.mock("../lib/api", () => ({ api: mocks.api }));

describe("AuthShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.router.replace = mocks.replace;
    mocks.api.getToken.mockReturnValue("jwt");
    mocks.api.onUnauthorized.mockReturnValue(() => undefined);
  });

  it("redirects immediately when a child business request becomes unauthorized", async () => {
    let notifyUnauthorized: (() => void) | undefined;
    mocks.api.onUnauthorized.mockImplementation((listener: () => void) => {
      notifyUnauthorized = listener;
      return () => undefined;
    });
    mocks.api.me.mockResolvedValue({
      id: "admin",
      username: "admin",
      role: "ADMIN",
      isActive: true,
    });

    render(
      <AuthShell>
        <div>private admin content</div>
      </AuthShell>,
    );
    expect(
      await screen.findByText("private admin content"),
    ).toBeInTheDocument();

    act(() => notifyUnauthorized?.());

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("private admin content")).not.toBeInTheDocument();
  });

  it("renders Admin content only after an ADMIN identity is verified", async () => {
    mocks.api.me.mockResolvedValue({
      id: "admin",
      username: "admin",
      role: "ADMIN",
      isActive: true,
    });

    render(
      <AuthShell>
        <div>private admin content</div>
      </AuthShell>,
    );

    expect(
      await screen.findByText("private admin content"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(mocks.api.logout).toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/login");
  });

  it("blocks USER identities before rendering Admin content", async () => {
    mocks.api.me.mockResolvedValue({
      id: "user",
      username: "user",
      role: "USER",
      isActive: true,
    });

    render(
      <AuthShell>
        <div>private admin content</div>
      </AuthShell>,
    );

    expect(
      await screen.findByText("当前账号无权访问管理后台"),
    ).toBeInTheDocument();
    expect(screen.queryByText("private admin content")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(mocks.api.logout).toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/login");
  });

  it("clears the route when the token is absent or rejected", async () => {
    mocks.api.getToken.mockReturnValueOnce(null);
    const { unmount } = render(
      <AuthShell>
        <div>private admin content</div>
      </AuthShell>,
    );
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("private admin content")).not.toBeInTheDocument();
    unmount();

    mocks.api.getToken.mockReturnValue("expired");
    mocks.api.me.mockRejectedValueOnce(new Error("unauthorized"));
    render(
      <AuthShell>
        <div>private admin content</div>
      </AuthShell>,
    );
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
    expect(screen.getByText("请先登录")).toBeInTheDocument();
  });
});
