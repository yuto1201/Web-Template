import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("template landing page", () => {
  it("presents a neutral, accessible launch sequence", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "Start with the boundaries already drawn." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("link", { name: "Review the launch sequence" })).toHaveAttribute("href", "#launch-sequence");
    expect(screen.getByRole("heading", { level: 2, name: "Every value has one side of the glass." })).toBeVisible();
    expect(screen.getByRole("group", { name: "Application delivery path" })).toBeVisible();
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });
});
