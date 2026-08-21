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
  expect(response.headers()["content-security-policy"]).toContain("https://template-e2e.supabase.co");
  expect(response.headers()["content-security-policy"]).toContain("wss://template-e2e.supabase.co");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await response.json();
  expect(body).toEqual({ status: "ok", checks: ["environment-boundary"] });
  expect(JSON.stringify(body)).not.toContain("supabase.co");
});

test("protected account access is redirected to the fail-closed login", async ({ page }) => {
  const protectedResponse = await page.request.get("/account", { maxRedirects: 0 });
  expect(protectedResponse.status()).toBe(307);
  expect(protectedResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(protectedResponse.headers().location).toBe("/login?next=%2Faccount");

  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Enter through one trusted door." })).toBeVisible();
  await expect(page.getByText("Signup mode: disabled.")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(accessibility.incomplete).toEqual([]);
});

test("auth callback ignores an external next destination", async ({ page }) => {
  await page.goto("/auth/callback?next=https%3A%2F%2Fevil.example%2Faccount");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount&error=auth_callback_failed$/u);
  await expect(page.getByText("The sign-in link could not be verified.")).toBeVisible();
});
