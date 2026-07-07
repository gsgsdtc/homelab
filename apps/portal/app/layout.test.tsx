import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteShell } from "./site-shell";

describe("portal root layout", () => {
  it("renders confirmed footer shortcuts from the shared site shell", () => {
    render(
      <SiteShell>
        <main>Portal content</main>
      </SiteShell>
    );

    const footer = screen.getByRole("contentinfo", { name: "Portal shortcuts" });
    const footerScreen = within(footer);

    expect(footer).toHaveTextContent("Quick links");
    expect(footer).toHaveTextContent("Homelab Portal");
    expect(footerScreen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(footerScreen.getByRole("link", { name: "Articles" })).toHaveAttribute("href", "/articles");
    expect(footerScreen.getByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "https://home.gfun.vip:8322/login"
    );
  });

  it("keeps footer shortcut targets fixed and excludes unconfirmed entries", () => {
    render(
      <SiteShell>
        <main>Portal content</main>
      </SiteShell>
    );

    const footer = screen.getByRole("contentinfo", { name: "Portal shortcuts" });
    const footerScreen = within(footer);
    const homeLink = footerScreen.getByRole("link", { name: "Home" });
    const articlesLink = footerScreen.getByRole("link", { name: "Articles" });
    const adminLink = footerScreen.getByRole("link", { name: "Admin" });

    expect(footer).toContainElement(homeLink);
    expect(footer).toContainElement(articlesLink);
    expect(footer).toContainElement(adminLink);
    expect(homeLink).toHaveAttribute("href", "/");
    expect(articlesLink).toHaveAttribute("href", "/articles");
    expect(adminLink).toHaveAttribute("href", "https://home.gfun.vip:8322/login");
    expect(adminLink).toHaveAttribute("target", "_blank");
    expect(adminLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(footerScreen.queryByRole("link", { name: "Grafana" })).not.toBeInTheDocument();
    expect(footerScreen.queryByRole("link", { name: "Plane" })).not.toBeInTheDocument();
  });

  it("renders only the confirmed Admin navigation entry with secure new-tab attributes", () => {
    render(
      <SiteShell>
        <main>Portal content</main>
      </SiteShell>
    );

    const primaryNavigation = screen.getByRole("navigation", { name: "Primary navigation" });
    const adminLink = within(primaryNavigation).getByRole("link", { name: "Admin" });

    expect(adminLink).toHaveAttribute("href", "https://home.gfun.vip:8322/login");
    expect(adminLink).toHaveAttribute("target", "_blank");
    expect(adminLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(primaryNavigation).queryByRole("link", { name: "Grafana" })).not.toBeInTheDocument();
    expect(within(primaryNavigation).queryByRole("link", { name: "Plane" })).not.toBeInTheDocument();
  });
});
