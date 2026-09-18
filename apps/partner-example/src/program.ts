import {
  canSubmitWrite,
  createCapitalOS,
  executable,
  parsePlan,
  parseQuote,
  requireNetwork,
  type PlanWire,
  type QuoteWire,
} from "@stacks-capital/sdk";

const SCHEMA_VERSION = "1.0";

export type PartnerOptions = {
  apiBase: string;
  network: "mainnet" | "testnet";
  owner: string;
  fetchImpl?: typeof fetch;
};

export type PartnerSuccess = {
  quote: QuoteWire;
  plan: PlanWire;
  workflowState: "AWAITING_SIGNATURE";
  shares: string;
  receiptAsset: string;
};

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

async function postJson<T>(options: PartnerOptions, path: string, body: unknown): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as {
    error?: { code?: string; message?: string };
    data?: T;
    schemaVersion?: string;
  };
  if (!response.ok) {
    throw Object.assign(new Error(json.error?.message ?? `HTTP ${response.status}`), {
      code: json.error?.code ?? "UNCLASSIFIED",
      status: response.status,
    });
  }
  if (json.schemaVersion !== SCHEMA_VERSION || json.data === undefined) {
    throw new Error("Capital API envelope is missing schemaVersion or data");
  }
  return json.data;
}

/**
 * Partner write path: Capital API mints the quote and plan; the SDK only validates
 * and holds local workflow state. The host wallet broadcasts.
 */
export async function runZestSupply(options: PartnerOptions): Promise<PartnerSuccess> {
  requireNetwork(options.network);
  const os = createCapitalOS({ network: options.network });
  const intent = { action: "supply" as const, marketId: "zest.sbtc.vault", amount: "100000000" };

  const quote = await postJson<QuoteWire>(options, "/v1/quotes", {
    network: options.network,
    owner: options.owner,
    ...intent,
  });
  const plan = await postJson<PlanWire>(options, "/v1/plans", {
    network: options.network,
    owner: options.owner,
    intent,
    quote,
  });

  const checked = os.validate(parsePlan(plan), parseQuote(quote), { sender: options.owner });
  if (!checked.ok) throw new Error(`SDK rejected the plan: ${checked.reasons.join("; ")}`);

  let flow = os.startWorkflow({ id: "partner-example", idempotencyKey: "partner-example-zest-supply" });
  flow = os.recordQuote(flow, parseQuote(quote));
  flow = os.recordPlan(flow, parsePlan(plan));
  if (flow.state !== "AWAITING_SIGNATURE" || !canSubmitWrite(flow.state)) {
    throw new Error(`workflow stopped at ${flow.state}, not AWAITING_SIGNATURE`);
  }

  let submitRefused = false;
  try {
    os.submit();
  } catch (error) {
    submitRefused = codeOf(error) === "UNSUPPORTED_ACTION";
    if (!submitRefused) throw error;
  }
  if (!submitRefused) throw new Error("SDK submit() must throw");

  const receipt = quote.expectedOutput[0];
  if (receipt === undefined) throw new Error("quote has no expected output");
  return {
    quote,
    plan,
    workflowState: "AWAITING_SIGNATURE",
    shares: receipt.quantity,
    receiptAsset: receipt.asset,
  };
}

export function stakingIsDisabled(): boolean {
  return executable("stake", "mainnet") === false;
}
