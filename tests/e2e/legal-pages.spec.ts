import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const documents = [
  { path: "/terms", title: "利用規約" },
  { path: "/privacy", title: "プライバシーポリシー" },
] as const;

for (const legalDocument of documents) {
  test(`${legalDocument.path} is a public, readable, clearly unfinished starter document`, async ({ page }) => {
    const response = await page.goto(legalDocument.path);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`${legalDocument.title} | 要確認のひな形`);
    await expect(page.getByRole("heading", { level: 1, name: legalDocument.title })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("未確認のひな形");
    await expect(page.getByRole("note")).toContainText("公開用の確定文書ではありません");
    await expect(page.getByText("施行日・最終更新日：未確定")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "運営者とお問い合わせ" })).toBeVisible();
    expect(await page.getByRole("heading", { level: 2 }).count()).toBeGreaterThanOrEqual(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(accessibility.incomplete).toEqual([]);
  });
}

for (const source of ["/", "/login", "/terms", "/privacy"]) {
  test(`shared footer on ${source} provides both legal documents`, async ({ page }) => {
    await page.goto(source);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    const navigation = page.getByRole("contentinfo").getByRole("navigation", { name: "法務情報" });
    for (const document of documents) {
      const link = navigation.getByRole("link", { name: document.title, exact: true });
      await expect(link).toHaveAttribute("href", document.path);
      await expect(link).toBeVisible();
    }
    const terms = navigation.getByRole("link", { name: "利用規約", exact: true });
    await terms.focus();
    await page.keyboard.press("Tab");
    await expect(navigation.getByRole("link", { name: "プライバシーポリシー", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/privacy$/u);
    await expect(page.getByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeVisible();
    await page.getByRole("contentinfo").getByRole("link", { name: "利用規約", exact: true }).click();
    await expect(page).toHaveURL(/\/terms$/u);
    await expect(page.getByRole("heading", { level: 1, name: "利用規約" })).toBeVisible();
  });
}
