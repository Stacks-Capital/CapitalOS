import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  isCapitalError,
  parseQuote,
  serializePlan,
  serializeQuote,
  type Intent,
  type QuoteWire,
  type StacksNetwork,
} from "@stacks-capital/core";
import { createExecutionEngine, loadServerReads, type AdapterReads } from "@stacks-capital/engine";
import { MAINNET_READS } from "@stacks-capital/fixtures";

const SCHEMA_VERSION = "1.0";

export type DemoServer = {
  url: string;
  close(): Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function errorJson(requestId: string, code: string, message: string) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    requestId,
    error: { code, message },
  });
}

function asIntent(value: { action?: string; marketId?: string; amount?: string } | undefined): Intent | null {
  if (value?.action === undefined || value.marketId === undefined || value.amount === undefined) return null;
  return {
    action: value.action as Intent["action"],
    marketId: value.marketId,
    amount: value.amount,
  };
}

export async function startDemoCapitalApi(input: { live: boolean; now?: Date }): Promise<DemoServer> {
  const now = input.now ?? new Date();
  const reads: AdapterReads = input.live ? await loadServerReads({ network: "mainnet", now }) : MAINNET_READS;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const requestId = `req_demo_${Date.now()}`;
      const fail = (status: number, code: string, message: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(errorJson(requestId, code, message));
      };
      try {
        if (req.method !== "POST" || req.url === undefined) {
          fail(404, "NOT_FOUND", "No such route");
          return;
        }
        const payload = JSON.parse(await readBody(req)) as {
          network?: StacksNetwork;
          owner?: string;
          action?: string;
          marketId?: string;
          amount?: string;
          intent?: { action?: string; marketId?: string; amount?: string };
          quote?: QuoteWire;
        };
        if (payload.network !== "mainnet" || payload.owner === undefined || payload.owner === "") {
          fail(400, "INVALID_REQUEST", "network and owner are required");
          return;
        }
        const engine = createExecutionEngine({
          network: payload.network,
          reads,
          owner: payload.owner,
          now,
        });
        let data: unknown;
        if (req.url === "/v1/quotes") {
          const intent = asIntent(payload);
          if (intent === null) {
            fail(400, "INVALID_REQUEST", "action, marketId and amount are required");
            return;
          }
          const minted = engine.quoteAndPlan(intent);
          data = {
            quote: serializeQuote(minted.quote),
            plan: serializePlan(minted.plan),
          };
        } else if (req.url === "/v1/plans") {
          const intent = asIntent(payload.intent);
          if (intent === null || payload.quote === undefined) {
            fail(400, "INVALID_REQUEST", "intent and quote are required");
            return;
          }
          data = serializePlan(engine.plan(parseQuote(payload.quote), intent));
        } else {
          fail(404, "NOT_FOUND", "No such route");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            requestId,
            network: "stacks:mainnet",
            data,
            context: {
              observedAt: now.toISOString(),
              stale: false,
              warnings: [],
            },
          }),
        );
      } catch (error) {
        if (isCapitalError(error)) {
          fail(400, error.code, error.message);
          return;
        }
        fail(500, "INTERNAL", "Unexpected error");
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("demo server did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        // Node fetch keeps HTTP connections alive. Drain those idle sockets first so the
        // example test and a real embedding host can shut down deterministically.
        server.closeIdleConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
