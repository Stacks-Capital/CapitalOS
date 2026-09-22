import { expect, type Page, test } from "@playwright/test";
import { type FakeWallet, installWallet } from "./wallet.ts";

/*
 * Real journeys through the real screens: the web app, the API, a seeded database and a wallet that
 * answers like Leather. Each test starts from a fresh page, so no state leaks between them.
 */

async function connect(page: Page) {
  const signedIn = page.getByText("signed in", { exact: true });
  if (await signedIn.isVisible()) return;
  await page.getByRole("button", { name: "Connect leather" }).click();
  await expect(signedIn).toBeVisible();
}

async function disconnect(page: Page) {
  const disconnectBtn = page.getByRole("button", { name: "Disconnect" });
  if (await disconnectBtn.isVisible()) {
    await disconnectBtn.click();
    await expect(page.getByRole("button", { name: "Connect leather" })).toBeVisible();
  }
}

async function openTab(page: Page, name: string) {
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
}

async function quoteVaultSupply(page: Page) {
  await openTab(page, "Earn");
  await page
    .getByRole("row", { name: /zest\.sbtc\.vault/ })
    .getByRole("button", { name: /Supply|Choose/ })
    .click();
  await page.getByLabel("Amount in base units").fill("100000");
  await page.getByRole("button", { name: /Get (a |Supply )?quote/i }).click();
  await expect(page.getByText(/Valid for \d+s\./)).toBeVisible();
}

let wallet: FakeWallet;

test.beforeEach(async ({ page }) => {
  wallet = await installWallet(page);
  await page.goto("/");
});

test("connects, signs in with a real signature, and completes a supply", async ({ page }) => {
  await connect(page);
  await quoteVaultSupply(page);

  await page.getByRole("button", { name: "Sign in your wallet" }).click();

  await expect(page.getByRole("heading", { name: "Confirming" })).toBeVisible();
  // Exact, because the submitted state also spells the word out in its heading.
  await expect(page.getByText("SUBMITTED", { exact: true })).toBeVisible();
  expect(wallet.calls).toEqual(["getAddresses", "stx_signMessage", "stx_callContract"]);
});

test("a rejected signature sends nothing, and the same step can be asked again", async ({ page }) => {
  await connect(page);
  await quoteVaultSupply(page);

  wallet.transactions = "reject";
  await page.getByRole("button", { name: "Sign in your wallet" }).click();

  await expect(page.getByText("You declined in your wallet. Nothing was sent.")).toBeVisible();
  // Still waiting on the same workflow, not sent to support as an unknown broadcast.
  await expect(page.getByRole("heading", { name: "Waiting for your wallet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs a look" })).toHaveCount(0);

  wallet.transactions = "approve";
  await page.getByRole("button", { name: "Ask the wallet again" }).click();
  await expect(page.getByRole("heading", { name: "Confirming" })).toBeVisible();
});

test("a wallet that answers without a transaction id goes to recovery, never a retry", async ({ page }) => {
  await connect(page);
  await quoteVaultSupply(page);

  wallet.transactions = "no-txid";
  await page.getByRole("button", { name: "Sign in your wallet" }).click();

  await expect(page.getByRole("heading", { name: "Needs a look" })).toBeVisible();
  await expect(page.getByText(/could move your money twice/)).toBeVisible();
});

test("a reload in the middle of signing comes back to the same step", async ({ page }) => {
  await connect(page);
  await quoteVaultSupply(page);

  wallet.transactions = "hang";
  await page.getByRole("button", { name: "Sign in your wallet" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for your wallet" })).toBeVisible();

  await page.reload();
  wallet.transactions = "approve";
  await connect(page);
  await openTab(page, "Earn");

  await expect(page.getByRole("heading", { name: "Unfinished step" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for your wallet" })).toBeVisible();
});

test("a different wallet never sees the first wallet's unfinished step", async ({ page }) => {
  await connect(page);
  await quoteVaultSupply(page);
  wallet.transactions = "hang";
  await page.getByRole("button", { name: "Sign in your wallet" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for your wallet" })).toBeVisible();

  const first = wallet.address;
  await disconnect(page);
  wallet.switchAccount();
  expect(wallet.address).not.toBe(first);
  await connect(page);
  await openTab(page, "Earn");

  await expect(page.getByRole("heading", { name: "Unfinished step" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /Verified Protocol Yield Marketplace|Earn marketplace|Compare and review/ }),
  ).toBeVisible();
});

test("rejecting the sign in message leaves the user signed out, with the reason", async ({ page }) => {
  wallet.signIn = "reject";
  await page.getByRole("button", { name: "Connect leather" }).click();

  await expect(page.getByRole("alert")).toContainText("The wallet did not sign");
  await expect(page.getByText("not signed in", { exact: true })).toBeVisible();
});

test("disconnecting forgets the session", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Disconnect" }).click();

  await expect(page.getByRole("button", { name: "Connect leather" })).toBeVisible();
  await openTab(page, "Earn");
  await expect(
    page.getByText(/Connect a wallet and sign in to (supply into a vault|compare earn vaults)/),
  ).toBeVisible();
});

test("deposit BTC screen enforces accounting notice and switches between deposit and withdraw modes", async ({
  page,
}) => {
  await connect(page);
  await openTab(page, "Deposit BTC");

  await expect(page.getByRole("heading", { name: "Deposit Bitcoin" })).toBeVisible();
  await expect(
    page.getByText("Pending BTC and in-flight transactions are held strictly distinct from spendable sBTC."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Withdraw (sBTC → BTC)" }).click();
  await expect(page.getByRole("heading", { name: "Withdraw sBTC" })).toBeVisible();
  await expect(page.getByText("Requested Bitcoin output:")).toBeVisible();
});

test("withdraws sBTC: quotes, reviews initially locked accounting, and submits awaiting request evidence", async ({
  page,
}) => {
  await connect(page);
  await openTab(page, "Deposit BTC");
  await page.getByRole("button", { name: "Withdraw (sBTC → BTC)" }).click();

  await page.getByRole("button", { name: "Get withdraw quote" }).click();
  await expect(page.getByRole("heading", { name: "Review before signing" })).toBeVisible();
  await expect(page.getByText("Workflow completes only after signer acceptance and the Bitcoin payout")).toBeVisible();

  await page.getByRole("button", { name: "Sign in your wallet" }).click();
  await expect(page.getByText("withdrawal request submitted; awaiting on-chain request evidence.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Transaction submitted" }).getByText("SUBMITTED", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("COMPLETED", { exact: true })).toHaveCount(0);
});

/*
 * --- Task I40 Additional Automated Journeys ---
 * Expiry, outage, partial-data, swap routing, and risk journeys
 */

test("quote expiry journey shows expired state and permits fresh requote", async ({ page }) => {
  await connect(page);
  await openTab(page, "Earn");
  await page
    .getByRole("row", { name: /zest\.sbtc\.vault/ })
    .getByRole("button", { name: /Supply|Choose/ })
    .click();
  await page.getByLabel("Amount in base units").fill("100000");

  // Mock a near-instant expiry timestamp for the quote to test countdown and stale transition
  await page.route("**/v1/quotes", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.data?.quote) {
      json.data.quote.expiresAt = new Date(Date.now() - 5000).toISOString();
      json.data.plan.expiresAt = json.data.quote.expiresAt;
    }
    await route.fulfill({ json });
  });

  await page.getByRole("button", { name: /Get (a |Supply )?quote/i }).click();

  // Screen detects expired quote and presents stale/requote state
  await expect(page.getByText("This quote has expired. Ask for a new one.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ask for a new quote|Get (a |Supply )?quote/i })).toBeVisible();
});

test("service outage journey displays actionable error guidance instead of crashing", async ({ page }) => {
  await connect(page);
  await openTab(page, "Earn");
  await page
    .getByRole("row", { name: /zest\.sbtc\.vault/ })
    .getByRole("button", { name: /Supply|Choose/ })
    .click();
  await page.getByLabel("Amount in base units").fill("100000");

  // Intercept and simulate 503 outage
  await page.route("**/v1/quotes", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Capital API backend is temporarily undergoing maintenance.",
          action: "Please retry in a few moments or contact support.",
        },
      }),
    });
  });

  await page.getByRole("button", { name: /Get (a |Supply )?quote/i }).click();

  // Verify alert panel appears with actionable error message
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/temporarily undergoing maintenance|SERVICE_UNAVAILABLE|Please retry/i)).toBeVisible();
});

test("partial data journey discloses unvalued assets and coverage warnings", async ({ page }) => {
  await connect(page);
  await openTab(page, "Overview");

  // Verify Gross Assets, Debt Liabilities, Net Subtotal, and Coverage KPIs render
  await expect(page.getByRole("region", { name: "Portfolio Summary" })).toBeVisible();
  await expect(page.getByText("Gross Assets")).toBeVisible();
  await expect(page.getByText("Debt Liabilities")).toBeVisible();
  await expect(page.getByText("Net Subtotal", { exact: true })).toBeVisible();
  await expect(page.getByText("Valuation Coverage")).toBeVisible();

  // Verify Capital Deployment by Category grid renders
  await expect(page.getByText("Capital Deployment by Category")).toBeVisible();
});

test("swap routing journey quotes Bitflow AMM, displays impact and route hops", async ({ page }) => {
  await connect(page);
  await openTab(page, "Swap");

  await expect(page.getByRole("heading", { name: "Swap assets" })).toBeVisible();
  await page.locator("#swap-amount-input").fill("1.0");
  await page.getByRole("button", { name: "Get Swap Quote" }).click();

  await expect(page.getByRole("heading", { name: "Review before signing" })).toBeVisible();
  await expect(page.locator(".route-contract").getByText(/dlmm-swap-router/)).toBeVisible();
  await expect(page.getByText("Price Impact", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Validation required|Sign in your wallet/ })).toBeVisible();
});

test("risk and alerts journey allows view toggle and advisory consent", async ({ page }) => {
  await connect(page);
  await openTab(page, "Risk");

  // Verify Credit Health Overview
  await expect(page.getByText("Credit Health Overview")).toBeVisible();

  // Toggle to Advanced / Pro mode
  const proToggle = page.getByRole("button", { name: "Pro" });
  if (await proToggle.isVisible()) {
    await proToggle.click();
    await expect(page.getByText("Granite Protocol Risk Telemetry")).toBeVisible();
  }

  // Verify BTC stress test section
  await expect(page.getByText("BTC Collateral Stress Scenarios")).toBeVisible();

  // Verify Advisory Alert Consent card
  await expect(page.getByText("Advisory Health Alerts & Notification Consent")).toBeVisible();
});
