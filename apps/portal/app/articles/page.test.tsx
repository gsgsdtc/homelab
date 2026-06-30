import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ArticlesPage, { metadata } from "./page";

describe("articles entry page", () => {
  it("exposes SEO metadata for the content list", () => {
    expect(metadata.title).toBe("Articles | Homelab Portal");
    expect(metadata.description).toContain("operational notes");
  });

  it("renders a clear empty state until articles are published", () => {
    render(<ArticlesPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Articles" })).toBeInTheDocument();
    expect(screen.getByText("No articles have been published yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to portal" })).toHaveAttribute("href", "/");
  });
});
