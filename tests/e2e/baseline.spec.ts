import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("landing page is usable with keyboard and fits the viewport", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Web Application Baseline");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start with the boundaries already drawn.");
  await expect(page.locator("nextjs-portal")).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/u);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(accessibility.incomplete).toEqual([]);
});

test("health endpoint exposes readiness but no environment values", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await response.json();
  expect(body).toEqual({ status: "ok", checks: ["environment-boundary"] });
  expect(JSON.stringify(body)).not.toContain("supabase.co");
});
