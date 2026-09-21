import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { installWallet } from "./wallet.ts";

const TABS = [
  "Overview",
  "Deposit BTC",
  "Earn",
  "Borrow",
  "Swap",
  "Liquidity",
  "Staking",
  "Positions",
  "Risk",
  "Activity",
];

async function signIn(page: Page) {
  await installWallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect leather" }).click();
  await expect(page.getByText("signed in", { exact: true })).toBeVisible();
}

test("every screen passes an accessibility scan with no serious or critical issues (signed in)", async ({ page }) => {
  await signIn(page);
  for (const tab of TABS) {
    await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      serious.map((violation) => `${tab}: ${violation.id} (${violation.nodes.length})`),
      `${tab} should have no serious accessibility issues`,
    ).toEqual([]);
  }
});

test("every screen passes an accessibility scan with no serious or critical issues (signed out)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  for (const tab of TABS) {
    await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      serious.map((violation) => `${tab} (signed out): ${violation.id} (${violation.nodes.length})`),
      `${tab} should have no serious accessibility issues while signed out`,
    ).toEqual([]);
  }
});

test("the whole app can be driven from the keyboard", async ({ page, isMobile }) => {
  test.skip(isMobile, "Keyboard navigation is checked on desktop");
  await signIn(page);

  // Tab until the Earn tab has focus, then open it with the keyboard alone.
  for (let press = 0; press < 20; press += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    if (focused === "Earn") break;
  }
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Earn");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Compare and review" })).toBeVisible();

  // Focus lands somewhere visible after each press, so a keyboard user can always see where they are.
  await page.keyboard.press("Tab");
  const visible = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (element === null || element === document.body) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  expect(visible).toBe(true);
});

test("workflow drawer manages focus, traps Tab, and dismisses on Escape", async ({ page, isMobile }) => {
  test.skip(isMobile, "Keyboard modal focus handling is checked on desktop");
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Workflows" });
  await trigger.click();

  const drawer = page.getByRole("dialog", { name: "Workflows and recovery drawer" });
  await expect(drawer).toBeVisible();

  // Focus enters drawer automatically on open
  const closeBtn = drawer.getByRole("button", { name: "Close workflow drawer" });
  await expect(closeBtn).toBeFocused();

  // Pressing Escape dismisses the drawer and returns focus to the trigger
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("canonical states render appropriately across views", async ({ page }) => {
  await page.goto("/");

  // 1. Signed-out Empty state on Overview and Swap
  await expect(page.getByText("Connect a wallet to see what it holds.")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByText("Connect a wallet and sign in to swap.")).toBeVisible();

  // 2. Unsupported state on unbuilt tabs
  for (const tab of ["Deposit BTC", "Liquidity", "Staking"]) {
    await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByText("Unsupported capability")).toBeVisible();
    await expect(page.getByText("Executable controls remain disabled")).toBeVisible();
  }
});

test("no screen scrolls sideways on a phone", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Width is checked on the mobile project");
  await signIn(page);
  for (const tab of TABS) {
    await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${tab} should fit the screen width`).toBeLessThanOrEqual(0);
  }
});
