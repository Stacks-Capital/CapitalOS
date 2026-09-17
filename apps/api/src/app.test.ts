import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sql } from "@stacks-capital/database";
import { createApp } from "./app.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { ErrorBody } from "./schemas.ts";

// Any request that reaches the database fails, so these tests prove validation happens first.
const noDatabase = (() => {
  throw new Error("the database must not be reached");
}) as unknown as Sql;
const app = createApp({ sql: noDatabase });

async function expectError(path: string, status: number) {
  const response = await app.request(path);
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

describe("errors", () => {
  it("answer unknown routes with the error body", async () => {
    assert.equal((await expectError("/v1/unknown", 404)).code, "NOT_FOUND");
  });

  it("hide unexpected failures behind INTERNAL", async () => {
    const error = await expectError("/v1/markets?network=mainnet", 500);
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
    assert.deepEqual(Object.keys(document.paths).sort(), ["/v1/capabilities", "/v1/markets"]);
  });
});
