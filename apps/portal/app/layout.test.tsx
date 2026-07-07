import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteShell } from "./site-shell";

describe("portal root layout", () => {
  it("renders only the confirmed Admin navigation entry with secure new-tab attributes", () => {
    render(
      <SiteShell>
        <main>Portal content</main>
      </SiteShell>
    );

    const adminLink = screen.getByRole("link", { name: "Admin" });

    expect(adminLink).toHaveAttribute("href", "https://home.gfun.vip:8322/login");
    expect(adminLink).toHaveAttribute("target", "_blank");
    expect(adminLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "Grafana" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Plane" })).not.toBeInTheDocument();
  });
});
