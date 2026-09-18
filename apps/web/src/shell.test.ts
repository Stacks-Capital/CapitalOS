import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CapitalApiError,
  type CapitalClient,
  CapitalTransportError,
  type ResponseContext,
} from "@stacks-capital/client";
import { signIn } from "./session.ts";
import { messageFor, panelState, UNAVAILABLE } from "./state.ts";
import { connectWallet, findProvider, findStacksAddress, installedWallets, messageSigner } from "./wallet.ts";

const MAINNET_ADDRESS = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";
const TESTNET_ADDRESS = "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0";

const context: ResponseContext = {
  requestId: "req_1",
  network: "mainnet",
  observedAt: "2026-09-18T09:00:00.000Z",
  stale: false,
  warnings: [],
};

function fakeClient(overrides: Partial<CapitalClient> = {}): CapitalClient {
  return {
    network: "mainnet",
    hasSession: false,
    challenge: async () => ({ data: { nonceId: "non_1", message: "sign me", expiresAt: "" }, context }),
    verify: async () => ({
      data: { token: "ses_1.secret", sessionId: "ses_1", address: MAINNET_ADDRESS, expiresAt: "" },
      context,
    }),
    ...overrides,
  } as unknown as CapitalClient;
}

describe("wallet discovery", () => {
  it("finds each wallet where it actually lives", () => {
    const leather = { request: async () => ({}) };
    const xverse = { request: async () => ({}) };
    const root = { LeatherProvider: leather, XverseProviders: { BitcoinProvider: xverse } };
    assert.equal(findProvider("leather", root), leather);
    assert.equal(findProvider("xverse", root), xverse);
    assert.deepEqual(installedWallets(root), ["leather", "xverse"]);
    assert.equal(findProvider("leather", {}), null);
    assert.deepEqual(installedWallets({}), []);
  });

  it("reads the Stacks address out of whatever shape the wallet answers with", () => {
    assert.equal(findStacksAddress({ addresses: [{ address: MAINNET_ADDRESS, symbol: "STX" }] }), MAINNET_ADDRESS);
    assert.equal(findStacksAddress({ result: { addresses: { stx: { address: TESTNET_ADDRESS } } } }), TESTNET_ADDRESS);
    assert.equal(findStacksAddress({ addresses: [{ address: "bc1qsomethingelse" }] }), null);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(findStacksAddress(cyclic), null);
  });
});

describe("connecting", () => {
  it("asks Xverse with the capitalised network it requires", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const provider = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return { addresses: [{ address: MAINNET_ADDRESS }] };
      },
    };
    const wallet = await connectWallet("xverse", "mainnet", provider);
    assert.deepEqual(wallet, { id: "xverse", address: MAINNET_ADDRESS, network: "mainnet" });
    assert.deepEqual(calls[0], { method: "wallet_connect", params: { addresses: ["stacks"], network: "Mainnet" } });
  });

  it("asks Leather with getAddresses", async () => {
    const calls: string[] = [];
    const provider = {
      request: async (method: string) => {
        calls.push(method);
        return { addresses: [{ address: TESTNET_ADDRESS }] };
      },
    };
    const wallet = await connectWallet("leather", "testnet", provider);
    assert.equal(wallet.network, "testnet");
    assert.deepEqual(calls, ["getAddresses"]);
  });

  it("fails clearly when the wallet is missing or answers with nothing usable", async () => {
    await assert.rejects(connectWallet("leather", "mainnet", null), /not installed/);
    const empty = { request: async () => ({ addresses: [] }) };
    await assert.rejects(connectWallet("leather", "mainnet", empty), /no Stacks address/);
  });

  it("returns the signature and public key the wallet produced", async () => {
    const provider = { request: async () => ({ signature: "ff", publicKey: "02ab" }) };
    assert.deepEqual(await messageSigner("leather", provider)("sign me"), { signature: "ff", publicKey: "02ab" });

    const nested = { request: async () => ({ result: { signature: "ee", publicKey: "03cd" } }) };
    assert.deepEqual(await messageSigner("xverse", nested)("sign me"), { signature: "ee", publicKey: "03cd" });

    const silent = { request: async () => ({}) };
    await assert.rejects(messageSigner("leather", silent)("sign me"), /no signature/);
  });
});

describe("signing in", () => {
  it("exchanges a wallet signature for a session", async () => {
    const wallet = { id: "leather", address: MAINNET_ADDRESS, network: "mainnet" } as const;
    let signed = "";
    const result = await signIn(fakeClient(), wallet, async (message) => {
      signed = message;
      return { signature: "ff", publicKey: "02ab" };
    });
    assert.equal(result.ok, true);
    assert.equal(signed, "sign me");
    assert.equal(result.ok && result.session.token, "ses_1.secret");
  });

  it("refuses a wallet on the other network before asking it to sign", async () => {
    const wallet = { id: "leather", address: TESTNET_ADDRESS, network: "testnet" } as const;
    let asked = false;
    const result = await signIn(fakeClient(), wallet, async () => {
      asked = true;
      return { signature: "ff", publicKey: "02ab" };
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "NETWORK_MISMATCH");
    assert.equal(asked, false);
  });

  it("reports a rejected signature as the user's choice, not a failure", async () => {
    const wallet = { id: "leather", address: MAINNET_ADDRESS, network: "mainnet" } as const;
    const result = await signIn(fakeClient(), wallet, async () => {
      throw { code: 4001, message: "User rejected the request" };
    });
    assert.equal(result.ok === false && result.error.code, "USER_REJECTED");
    assert.equal(result.ok === false && result.error.class, "user_action");
  });

  it("reports a failed challenge without asking the wallet", async () => {
    const wallet = { id: "xverse", address: MAINNET_ADDRESS, network: "mainnet" } as const;
    const client = fakeClient({
      challenge: async () => {
        throw new CapitalTransportError("network", "Cannot reach Capital OS");
      },
    });
    const result = await signIn(client, wallet, async () => ({ signature: "ff", publicKey: "02ab" }));
    assert.equal(result.ok === false && result.error.code, "PROVIDER_TIMEOUT");
  });
});

describe("panel states", () => {
  it("shows loading, then ready with the observed time", () => {
    assert.deepEqual(panelState({ status: "loading", data: undefined, error: undefined }), { kind: "loading" });
    assert.deepEqual(panelState({ status: "ready", data: [], error: undefined }, context), {
      kind: "ready",
      stale: false,
      warnings: [],
      observedAt: "2026-09-18T09:00:00.000Z",
    });
  });

  it("keeps showing data that failed to refresh, marked stale with the reason", () => {
    const state = panelState(
      { status: "error", data: ["market"], error: new CapitalTransportError("timeout", "too slow") },
      context,
    );
    assert.equal(state.kind, "ready");
    assert.equal(state.kind === "ready" && state.stale, true);
    assert.match(state.kind === "ready" ? state.warnings.join(" ") : "", /took too long/);
  });

  it("shows an error only when there is nothing to show", () => {
    const error = new CapitalApiError({ code: "UNAUTHORIZED", message: "no", status: 401, requestId: "req_9" });
    const state = panelState({ status: "error", data: undefined, error });
    assert.deepEqual(state, {
      kind: "error",
      message: "Your session has expired. Sign in again.",
      canRetry: false,
      requestId: "req_9",
    });
  });

  it("passes the stale flag and warnings from the API through", () => {
    const stale = { ...context, stale: true, warnings: ["sBTC/USD was published 44 days ago"] };
    const state = panelState({ status: "ready", data: [], error: undefined }, stale);
    assert.equal(state.kind === "ready" && state.stale, true);
    assert.deepEqual(state.kind === "ready" ? state.warnings : [], ["sBTC/USD was published 44 days ago"]);
  });

  it("names why a panel has no data source yet", () => {
    assert.match(UNAVAILABLE.positions, /not built yet/);
    assert.match(UNAVAILABLE.balances, /not built yet/);
  });
});

describe("error messages", () => {
  it("say what to do, and whether trying again helps", () => {
    const limited = new CapitalApiError({
      code: "RATE_LIMITED",
      message: "slow",
      status: 429,
      requestId: "r",
      retryAfter: 30,
    });
    assert.deepEqual(messageFor(limited), {
      message: "Too many requests. Try again in 30 seconds.",
      canRetry: true,
      requestId: "r",
    });
    assert.equal(messageFor(new CapitalTransportError("network", "down")).canRetry, true);
    assert.equal(messageFor(new CapitalTransportError("aborted", "cancelled")).canRetry, false);
    assert.equal(messageFor(new Error("anything")).message, "Something went wrong.");
  });
});
