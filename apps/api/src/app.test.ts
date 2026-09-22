import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sql } from "@stacks-capital/database";
import { createApp } from "./app.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { memoryLimiter } from "./rateLimit.ts";
import { ErrorBody } from "./schemas.ts";

// Any request that reaches the database fails, so these tests prove validation happens first.
const noDatabase = (() => {
  throw new Error("the database must not be reached");
}) as unknown as Sql;
const app = createApp({ sql: noDatabase, limiter: memoryLimiter() });
const KEY = { authorization: `Bearer key_0123456789abcdef.${"A".repeat(43)}` };

async function expectError(path: string, status: number, init?: RequestInit) {
  const response = await app.request(path, init);
  assert.equal(response.status, status);
  const body = ErrorBody.parse(await response.json());
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.match(body.requestId, /^req_/);
  return body.error;
}

describe("request validation", () => {
  it("requires a network and never picks a default", async () => {
    const error = await expectError("/v1/markets", 400);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.match(error.message, /network/);
  });

  it("rejects an unknown network", async () => {
    assert.equal((await expectError("/v1/markets?network=devnet", 400)).code, "INVALID_REQUEST");
  });

  it("rejects page sizes outside 1 to 100", async () => {
    await expectError("/v1/capabilities?network=mainnet&limit=0", 400);
    await expectError("/v1/capabilities?network=mainnet&limit=101", 400);
  });

  it("rejects a tampered cursor and a cursor from another list", async () => {
    await expectError("/v1/markets?network=mainnet&cursor=not-a-cursor", 400);
    const other = encodeCursor("capabilities", ["zest.sbtc.vault", "supply"]);
    await expectError(`/v1/markets?network=mainnet&cursor=${other}`, 400);
  });
});

describe("credentials", () => {
  it("are required on every data route", async () => {
    assert.equal((await expectError("/v1/markets?network=mainnet", 401)).code, "UNAUTHORIZED");
    assert.equal((await expectError("/v1/workflows/wf_1?network=mainnet", 401)).code, "UNAUTHORIZED");
    const quoteBody = JSON.stringify({
      network: "mainnet",
      action: "supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000",
      owner: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR",
    });
    assert.equal(
      (
        await expectError("/v1/quotes", 401, {
          method: "POST",
          body: quoteBody,
          headers: { "content-type": "application/json" },
        })
      ).code,
      "UNAUTHORIZED",
    );
  });

  it("reject a bearer token that is neither a key nor a session", async () => {
    const headers = { authorization: "Bearer something_else" };
    assert.equal((await expectError("/v1/capabilities?network=mainnet", 401, { headers })).code, "UNAUTHORIZED");
  });

  it("reject a client id sent without an Origin header", async () => {
    const headers = { "x-capital-client-id": "pk_fixture_sandbox" };
    assert.equal((await expectError("/v1/markets?network=mainnet", 401, { headers })).code, "UNAUTHORIZED");
  });

  it("are checked after the request is validated", async () => {
    assert.equal((await expectError("/v1/markets", 400)).code, "INVALID_REQUEST");
    const body = JSON.stringify({ network: "mainnet", nonceId: "non_1", publicKey: "00", signature: "00" });
    const init = { method: "POST", body, headers: { "content-type": "application/json" } };
    assert.equal((await expectError("/v1/auth/verify", 400, init)).code, "INVALID_REQUEST");
  });
});

describe("errors", () => {
  it("answer unknown routes with the error body", async () => {
    assert.equal((await expectError("/v1/unknown", 404)).code, "NOT_FOUND");
  });

  it("hide unexpected failures behind INTERNAL", async () => {
    const error = await expectError("/v1/markets?network=mainnet", 500, { headers: KEY });
    assert.equal(error.code, "INTERNAL");
    assert.doesNotMatch(error.message, /database/);
  });
});

describe("cursors", () => {
  it("round trip their key", () => {
    assert.deepEqual(decodeCursor("markets", encodeCursor("markets", ["zest.sbtc.vault"]), 1), ["zest.sbtc.vault"]);
  });

  it("are optional", () => {
    assert.equal(decodeCursor("markets", undefined, 1), null);
  });
});

describe("OpenAPI document", () => {
  it("is served from the runtime schemas", async () => {
    const response = await app.request("/v1/openapi.json");
    assert.equal(response.status, 200);
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(document.openapi, "3.1.0");
    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/v1/auth/challenge",
      "/v1/auth/verify",
      "/v1/capabilities",
      "/v1/earn/options",
      "/v1/earn/performance",
      "/v1/markets",
      "/v1/markets/{id}/evidence",
      "/v1/markets/{id}/risk",
      "/v1/plans",
      "/v1/portfolio",
      "/v1/positions",
      "/v1/prices",
      "/v1/prices/valuations",
      "/v1/quotes",
      "/v1/workflows",
      "/v1/workflows/{id}",
      "/v1/workflows/{id}/signature",
    ]);
  });
});
