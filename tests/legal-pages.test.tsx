import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootLayout from "@/app/layout";
import * as TermsPage from "@/app/terms/page";
import * as PrivacyPage from "@/app/privacy/page";

// next/font is transformed by Next's compiler, which is not part of Vitest.
vi.mock("next/font/google", () => ({
  Bricolage_Grotesque: () => ({ variable: "display-font" }),
  IBM_Plex_Mono: () => ({ variable: "utility-font" }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("required legal documents", () => {
  it.each([
    ["terms", "利用規約", TermsPage],
    ["privacy", "プライバシーポリシー", PrivacyPage],
  ] as const)("ships the %s route with an honest draft notice", (_route, title, module) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);
    const Page = module.default;
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
    expect(module.metadata.title).toBe(`${title} | 要確認のひな形`);
    expect(screen.getByRole("note")).toHaveTextContent("未確認のひな形");
    expect(screen.getByRole("note")).toHaveTextContent("公開用の確定文書ではありません");
  });

  it("puts both legal links in the root layout shared by all pages", () => {
    const html = renderToStaticMarkup(<RootLayout><main>Page content</main></RootLayout>);
    const container = document.createElement("div");
    container.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    const footer = within(container).getByRole("contentinfo");
    const navigation = within(footer).getByRole("navigation", { name: "法務情報" });
    expect(within(navigation).getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(within(navigation).getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  });
});
