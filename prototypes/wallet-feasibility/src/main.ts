import { request, type StacksProvider } from "@stacks/connect";
import { Cl, Pc } from "@stacks/transactions";
import { Address, OutScript, TEST_NETWORK, Transaction } from "@scure/btc-signer";
import { classifyWalletError, networkGuard, stacksAddressNetwork, walletOutcome, type WalletId } from "./guards.ts";

const NETWORK = "testnet";
const HIRO = "https://api.testnet.hiro.so";
const SBTC_TOKEN = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
const TRANSFER_RECIPIENT = "ST000000000000000000002AMW42H";
const REGTEST: typeof TEST_NETWORK = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

type RawProvider = { request(method: string, params?: unknown): Promise<unknown> };
type Result = { summary: string; raw: unknown };
type LogEntry = {
  at: string;
  finishedAt?: string;
  wallet: WalletId;
  test: string;
  ok: boolean;
  summary: string;
  raw: unknown;
};

const NO_RESPONSE_NOTE_MS = 60_000;

// Xverse exposes request() on BitcoinProvider for both Bitcoin and Stacks methods; its StacksProvider has no request().
const injected = window as unknown as {
  LeatherProvider?: StacksProvider;
  XverseProviders?: { BitcoinProvider?: StacksProvider };
};

const state: Record<WalletId, { stx?: string; payment?: string; lastTxid?: string }> = { leather: {}, xverse: {} };
const log: LogEntry[] = [];

function provider(wallet: WalletId): StacksProvider {
  const found = wallet === "leather" ? injected.LeatherProvider : injected.XverseProviders?.BitcoinProvider;
  if (!found) throw Object.assign(new Error(`${wallet} provider is not injected in this browser`), { code: -32601 });
  return found;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function describeError(error: unknown): unknown {
  return error instanceof Error ? { ...error, name: error.name, message: error.message } : error;
}

// Some wallets answer unsupported raw methods with an error object instead of throwing.
function unwrap(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && "error" in raw && raw.error) throw raw;
  return raw;
}

function requireStx(wallet: WalletId): string {
  const stx = state[wallet].stx;
  if (!stx) throw new Error("Run Connect first");
  return stx;
}

const tests: Record<string, (wallet: WalletId) => Promise<Result>> = {
  // @stacks/connect only applies its Xverse rewrites when the provider has both of these methods and is not Leather.
  async providerInfo(wallet) {
    const found = provider(wallet) as unknown as Record<string, unknown>;
    const keys = [
      ...new Set([...Object.keys(found), ...Object.getOwnPropertyNames(Object.getPrototypeOf(found) ?? {})]),
    ].sort();
    const detectedAsXverse =
      "signMultipleTransactions" in found && "createRepeatInscriptions" in found && !found.isLeather;
    return {
      summary: `@stacks/connect treats it as Xverse: ${detectedAsXverse}`,
      raw: { keys, isLeather: found.isLeather ?? null },
    };
  },

  async rawWalletConnect(wallet) {
    const raw = unwrap(
      await (provider(wallet) as unknown as RawProvider).request("wallet_connect", {
        addresses: ["payment", "ordinals", "stacks"],
        message: "Stacks Capital I02 feasibility",
      }),
    );
    return { summary: "raw wallet_connect answered", raw };
  },

  async rawGetAddresses(wallet) {
    const raw = unwrap(
      await (provider(wallet) as unknown as RawProvider).request("getAddresses", {
        purposes: ["payment", "ordinals", "stacks"],
        message: "Stacks Capital I02 feasibility",
      }),
    );
    return { summary: "raw getAddresses answered", raw };
  },

  // Xverse's wallet_connect only accepts network "Mainnet", "Testnet" or "Signet"; @stacks/connect forwards "testnet" unchanged.
  async connectNoNetwork(wallet) {
    const result = await request({ provider: provider(wallet) }, "getAddresses");
    const stx = result.addresses.find((entry) => stacksAddressNetwork(entry.address) !== null)?.address;
    if (stx) state[wallet].stx = stx;
    const payment = result.addresses.find((entry) => /^(tb|bcrt)1q/i.test(entry.address))?.address;
    if (payment) state[wallet].payment = payment;
    return { summary: `answered without a network param, stx ${stx ?? "missing"}`, raw: result };
  },

  async rawWalletConnectLowercase(wallet) {
    const raw = unwrap(
      await (provider(wallet) as unknown as RawProvider).request("wallet_connect", {
        addresses: ["payment", "ordinals", "stacks"],
        message: "Stacks Capital I02 feasibility",
        network: "testnet",
      }),
    );
    return { summary: "raw wallet_connect with network testnet answered", raw };
  },

  async connect(wallet) {
    const result = await request({ provider: provider(wallet) }, "getAddresses", { network: NETWORK });
    const stx = result.addresses.find((entry) => stacksAddressNetwork(entry.address) !== null)?.address;
    const btc = result.addresses.map((entry) => entry.address).filter((address) => address !== stx);
    if (stx) state[wallet].stx = stx;
    const payment = result.addresses.find((entry) => /^(tb|bcrt)1q/i.test(entry.address))?.address;
    if (payment) state[wallet].payment = payment;
    const guard = networkGuard(NETWORK, stx ? { stx, btc } : { btc });
    return {
      summary: `stx ${stx ?? "missing"}, ${btc.length} btc addresses, network guard ${guard ?? "passed"}`,
      raw: result,
    };
  },

  async network(wallet) {
    const raw = unwrap(await (provider(wallet) as unknown as RawProvider).request("wallet_getNetwork"));
    return { summary: "wallet_getNetwork answered", raw };
  },

  async supportedMethods(wallet) {
    const raw = unwrap(await (provider(wallet) as unknown as RawProvider).request("supportedMethods"));
    return { summary: "supportedMethods answered", raw };
  },

  async signMessage(wallet) {
    const message = `Stacks Capital I02 nonce ${crypto.randomUUID()} at ${new Date().toISOString()}`;
    const result = await request({ provider: provider(wallet) }, "stx_signMessage", { message });
    return { summary: `signature of ${result.signature.length} hex chars`, raw: { message, ...result } };
  },

  // Stacks nodes reject transfers where recipient equals sender (MemPoolRejection::TransferRecipientIsSender), so send elsewhere.
  async transferStx(wallet) {
    requireStx(wallet);
    const result = await request({ provider: provider(wallet) }, "stx_transferStx", {
      recipient: TRANSFER_RECIPIENT,
      amount: "1",
      memo: "stacks-capital i02",
      network: NETWORK,
    });
    if (result.txid) state[wallet].lastTxid = result.txid;
    return { summary: `outcome ${walletOutcome(result)}`, raw: result };
  },

  // Expected to be refused by the node (TransferRecipientIsSender). Records how a broadcast rejection reaches the app.
  async selfTransfer(wallet) {
    const stx = requireStx(wallet);
    const result = await request({ provider: provider(wallet) }, "stx_transferStx", {
      recipient: stx,
      amount: "1",
      memo: "stacks-capital i02",
      network: NETWORK,
    });
    return { summary: `outcome ${walletOutcome(result)}`, raw: result };
  },

  // The test accounts hold no sBTC, so this should abort onchain. The point is whether the post-condition reaches the chain.
  async contractCall(wallet) {
    const stx = requireStx(wallet);
    const result = await request({ provider: provider(wallet) }, "stx_callContract", {
      contract: SBTC_TOKEN,
      functionName: "transfer",
      functionArgs: [Cl.uint(1), Cl.principal(stx), Cl.principal(stx), Cl.none()],
      postConditions: [Pc.principal(stx).willSendLte(1).ft(SBTC_TOKEN, "sbtc-token")],
      postConditionMode: "deny",
      network: NETWORK,
    });
    if (result.txid) state[wallet].lastTxid = result.txid;
    return { summary: `outcome ${walletOutcome(result)}`, raw: result };
  },

  // Spends a made-up outpoint, so the signed PSBT can never be broadcast. Only the signing capability is tested.
  async psbt(wallet) {
    const payment = state[wallet].payment;
    if (!payment) throw new Error("Run Connect first, a tb1q or bcrt1q payment address is needed");
    const regtest = payment.toLowerCase().startsWith("bcrt1");
    const network = regtest ? REGTEST : TEST_NETWORK;
    const tx = new Transaction();
    tx.addInput({
      txid: fromHex("11".repeat(32)),
      index: 0,
      witnessUtxo: { script: OutScript.encode(Address(network).decode(payment)), amount: 10_000n },
    });
    tx.addOutputAddress(payment, 9_000n, network);

    // @stacks/connect expects base64: it base64-decodes the PSBT for Leather and passes it unchanged to Xverse.
    const result = await request({ provider: provider(wallet) }, "signPsbt", {
      psbt: toBase64(tx.toPSBT()),
      signInputs: [{ index: 0, address: payment }],
      broadcast: false,
      network: regtest ? "regtest" : "testnet",
    });
    // Wallets differ in field name and encoding, so keep the raw response even when it cannot be decoded.
    const returned: unknown = result;
    const field =
      typeof returned === "object" && returned !== null
        ? (["psbt", "hex"] as const).find((key) => key in returned)
        : undefined;
    const value =
      field && typeof returned === "object" && returned !== null
        ? (returned as Record<string, unknown>)[field]
        : undefined;
    if (typeof value !== "string" || value.length === 0) {
      return { summary: `outcome ${walletOutcome(result)}, no psbt or hex string in the response`, raw: result };
    }
    const encoding = /^[0-9a-f]+$/i.test(value) ? "hex" : "base64";
    try {
      const input = Transaction.fromPSBT(encoding === "hex" ? fromHex(value) : fromBase64(value)).getInput(0);
      const hasSignature = Boolean(input.partialSig?.length || input.finalScriptWitness?.length);
      return {
        summary: `outcome ${walletOutcome(result)}, field ${field}, ${encoding}, input 0 signed ${hasSignature ? "yes" : "no"}`,
        raw: result,
      };
    } catch (error) {
      return { summary: `returned field ${field} could not be decoded as ${encoding}: ${String(error)}`, raw: result };
    }
  },

  async checkTx(wallet) {
    const txid = state[wallet].lastTxid;
    if (!txid) throw new Error("No transaction from this wallet yet");
    const id = txid.startsWith("0x") ? txid : `0x${txid}`;
    const res = await fetch(`${HIRO}/extended/v1/tx/${id}`);
    const body = (await res.json()) as {
      tx_status?: string;
      post_condition_mode?: string;
      post_conditions?: unknown[];
    };
    return {
      summary: `http ${res.status}, status ${body.tx_status ?? "?"}, post_condition_mode ${body.post_condition_mode ?? "?"}, post_conditions ${body.post_conditions?.length ?? "?"}`,
      raw: body,
    };
  },
};

function render(): void {
  const out = document.querySelector<HTMLPreElement>("#log");
  if (!out) return;
  out.textContent = log
    .map((entry) => {
      const status = entry.finishedAt === undefined ? "pending" : entry.ok ? "ok" : "failed";
      return `[${entry.at}] ${entry.wallet} ${entry.test}: ${status}, ${entry.summary}\n${stringify(entry.raw)}`;
    })
    .join("\n\n");
}

// The entry is logged before the wallet answers, because some wallet failures never resolve the request at all.
async function run(wallet: WalletId, name: string, test: (wallet: WalletId) => Promise<Result>): Promise<void> {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    wallet,
    test: name,
    ok: false,
    summary: "waiting for the wallet",
    raw: null,
  };
  log.unshift(entry);
  render();
  const timer = setTimeout(() => {
    entry.summary = `no response from the wallet after ${NO_RESPONSE_NOTE_MS / 1000}s`;
    render();
  }, NO_RESPONSE_NOTE_MS);
  try {
    const { summary, raw } = await test(wallet);
    Object.assign(entry, { ok: true, summary, raw });
  } catch (error) {
    Object.assign(entry, {
      ok: false,
      summary: `product error ${classifyWalletError(wallet, error)}`,
      raw: describeError(error),
    });
  } finally {
    clearTimeout(timer);
    entry.finishedAt = new Date().toISOString();
    render();
  }
}

document.querySelectorAll<HTMLButtonElement>("button[data-test]").forEach((button) => {
  button.addEventListener("click", () => {
    const wallet = button.dataset.wallet;
    const name = button.dataset.test ?? "";
    const test = tests[name];
    if ((wallet === "leather" || wallet === "xverse") && test) void run(wallet, name, test);
  });
});

document.querySelector("#copy")?.addEventListener("click", () => void navigator.clipboard.writeText(stringify(log)));
document.querySelector("#clear")?.addEventListener("click", () => {
  log.length = 0;
  render();
});
