import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage, { metadata } from "./page";

describe("portal home page", () => {
  it("exposes SEO metadata for public discovery", () => {
    expect(metadata.title).toBe("Homelab Portal | Private cloud operations");
    expect(metadata.description).toContain("public entry point");
    expect(metadata.openGraph).toMatchObject({
      title: "Homelab Portal",
      type: "website"
    });
  });

  it("renders semantic public portal content and an articles entry", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Homelab Portal"
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Operate a resilient personal cloud");
    expect(screen.getByRole("link", { name: "View articles" })).toHaveAttribute("href", "/articles");
    expect(
      screen.getByRole("img", {
        name: "Homelab server nodes and an operations dashboard"
      })
    ).toHaveAttribute("src", expect.stringContaining("homelab-portal-hero.png"));
  });
});
