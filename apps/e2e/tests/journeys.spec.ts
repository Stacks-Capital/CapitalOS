import { expect, type Page, test } from "@playwright/test";
import { type FakeWallet, installWallet } from "./wallet.ts";

/*
 * Real journeys through the real screens: the web app, the API, a seeded database and a wallet that
 * answers like Leather. Each test starts from a fresh page, so no state leaks between them.
 */

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect leather" }).click();
  await expect(page.getByText("signed in", { exact: true })).toBeVisible();
}

async function openTab(page: Page, name: string) {
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
}

async function quoteVaultSupply(page: Page) {
  await openTab(page, "Earn");
  await page
    .getByRole("row", { name: /zest\.sbtc\.vault/ })
    .getByRole("button", { name: "Choose" })
    .click();
  await page.getByLabel("Amount in base units").fill("100000");
  await page.getByRole("button", { name: "Get a quote" }).click();
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
  await expect(page.getByText("SUBMITTED")).toBeVisible();
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
  await page.reload();
  wallet.switchAccount();
  expect(wallet.address).not.toBe(first);
  await connect(page);
  await openTab(page, "Earn");

  await expect(page.getByRole("heading", { name: "Unfinished step" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Compare and review" })).toBeVisible();
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
  await expect(page.getByText("Connect a wallet and sign in to supply into a vault.")).toBeVisible();
});
