import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ERROR_CLASS, type ErrorCode } from "@stacks-capital/core";
import { errorClassOf } from "@stacks-capital/client";
import { ApiError, type ApiErrorCode } from "./errors.ts";

/*
 * Writes docs/reference/api-errors.md from the code itself: the status comes from ApiError and the class
 * from the client, so the reference cannot disagree with what the API does. Only the meaning and the
 * advice are written by hand, and `--check` fails when a code has none, so a new code cannot ship undocumented.
 */

const target = fileURLToPath(new URL("../../../docs/reference/api-errors.md", import.meta.url));

const TRANSPORT: ApiErrorCode[] = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "TEMPORARY_UNAVAILABLE",
  "INTERNAL",
];

type Entry = { meaning: string; action: string };

const DESCRIPTIONS: Record<ApiErrorCode, Entry> = {
  INVALID_REQUEST: {
    meaning: "The request does not match the schema: a missing network, a bad amount, an unknown field value.",
    action: "Fix the request. The message names the field.",
  },
  UNAUTHORIZED: {
    meaning: "No credentials, or credentials that are unknown, revoked or expired.",
    action: "Sign in again for a session, or check the API key.",
  },
  FORBIDDEN: {
    meaning:
      "Valid credentials that may not do this: a missing scope, a browser client id on a server route, a key sent from a browser.",
    action: "Use a caller with the right scope. Never send an API key from a browser.",
  },
  NOT_FOUND: {
    meaning:
      "No such route, quote, market or workflow for this caller. Another tenant's workflow also reads as not found.",
    action: "Check the id and the network.",
  },
  TEMPORARY_UNAVAILABLE: {
    meaning: "A dependency the API needs to answer safely is down, for example the rate limit store.",
    action: "Retry after a short wait. The client does this for reads.",
  },
  INTERNAL: {
    meaning: "Something unexpected failed. The message never exposes internals.",
    action: "Retry once, then contact support with the request id.",
  },
  PROVIDER_TIMEOUT: {
    meaning: "A chain or data provider did not answer in time.",
    action: "Retry. The client does this for reads.",
  },
  RATE_LIMITED: {
    meaning: "Too many requests from this key, session or app in the current window.",
    action: "Wait for the number of seconds in retryAfter.",
  },
  QUOTE_EXPIRED: {
    meaning: "The quote is past its expiry, so it is not signed.",
    action: "Ask for a new quote.",
  },
  CAP_REACHED: {
    meaning: "The market is at its supply or borrow cap for this amount.",
    action: "Ask for a new quote with a smaller amount, or wait for capacity.",
  },
  ORACLE_STALE: {
    meaning: "A price the action depends on is older than the protocol allows.",
    action: "Ask for a new quote once the price has updated.",
  },
  USER_REJECTED: {
    meaning: "The user declined in their wallet. Nothing was signed or sent.",
    action: "Nothing to fix. Offer to ask the wallet again.",
  },
  INSUFFICIENT_BALANCE: {
    meaning: "The wallet does not hold enough of the asset for this action.",
    action: "Lower the amount or fund the wallet.",
  },
  NETWORK_MISMATCH: {
    meaning: "The address, session, workflow or wallet belongs to the other network.",
    action: "Switch the wallet or the request to the same network.",
  },
  UNSUPPORTED_WALLET: {
    meaning: "The wallet does not support a method the action needs.",
    action: "Use a supported wallet (Leather or Xverse).",
  },
  UNSUPPORTED_ACTION: {
    meaning: "The market does not list this action.",
    action: "Pick an action the market lists in /v1/markets.",
  },
  PLAN_INVALID: {
    meaning: "The plan does not match its quote, its network or the rules for signing it.",
    action: "Ask for a new quote and plan.",
  },
  CAPABILITY_DISABLED: {
    meaning: "The action is disabled or paused, by the registry or by an operator. The message gives the reason.",
    action: "Do not retry. Show the reason; the action returns when it is switched back on.",
  },
  BROADCAST_UNKNOWN: {
    meaning: "The wallet answered without a transaction id, so it is not known whether anything was sent.",
    action: "Never resubmit. Check the chain for the transaction, then contact support with the workflow id.",
  },
  REORG_DETECTED: {
    meaning: "A block the workflow depended on was replaced by a chain reorganisation.",
    action: "Wait for reconciliation. Contact support if it does not settle.",
  },
  RECONCILIATION_MISMATCH: {
    meaning: "What the chain shows does not match what the workflow expected.",
    action: "Contact support with the workflow id. Do not act on the balance shown.",
  },
  UNCLASSIFIED: {
    meaning: "An error that could not be classified.",
    action: "Contact support with the request id.",
  },
};

export function allCodes(): ApiErrorCode[] {
  return [...TRANSPORT, ...(Object.keys(ERROR_CLASS) as ErrorCode[])];
}

export function undocumented(): ApiErrorCode[] {
  return allCodes().filter((code) => DESCRIPTIONS[code] === undefined);
}

export function errorReference(): string {
  const missing = undocumented();
  if (missing.length > 0) throw new Error(`Error codes without a description: ${missing.join(", ")}`);

  const rows = allCodes()
    .map((code) => {
      const status = new ApiError(code, "").status;
      const errorClass = errorClassOf(code);
      const retried = errorClass === "retryable_read" ? "yes" : "no";
      const entry = DESCRIPTIONS[code];
      return { code, status, errorClass, retried, entry };
    })
    .sort((left, right) => left.status - right.status || left.code.localeCompare(right.code));

  const table = rows
    .map(
      (row) =>
        `| \`${row.code}\` | ${row.status} | \`${row.errorClass}\` | ${row.retried} | ${row.entry.meaning} | ${row.entry.action} |`,
    )
    .join("\n");

  return `# API errors

Generated by \`pnpm docs:errors\` from \`apps/api/src/errors.ts\` and the client's error classes. Do not edit by hand: \`pnpm docs:errors:check\` fails in CI when this file and the code disagree.

Every error body has the same shape:

\`\`\`json
{ "schemaVersion": "1.0", "requestId": "req_...", "error": { "code": "RATE_LIMITED", "message": "Too many requests", "retryAfter": 12 } }
\`\`\`

\`requestId\` is also in the \`x-request-id\` header. Quote it when asking for support.

The class says what a caller can do, and is what code should branch on:

| Class | Meaning |
|---|---|
| \`retryable_read\` | Temporary. Safe reads are retried by the client with backoff |
| \`requote\` | The quote no longer holds. Ask for a new one |
| \`user_action\` | The caller or the user has to change something |
| \`investigation\` | Something needs a person. Never retried automatically |

| Code | Status | Class | Retried by the client | Meaning | What to do |
|---|---|---|---|---|---|
${table}

Writes are never retried by the client, whatever the class, because a repeated write could act twice.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = errorReference();
  if (process.argv.includes("--check")) {
    const committed = await readFile(target, "utf8").catch(() => "");
    if (committed !== generated) {
      console.error("docs/reference/api-errors.md is out of date. Run pnpm docs:errors and commit the result.");
      process.exit(1);
    }
    console.log("docs/reference/api-errors.md matches the code.");
  } else {
    await writeFile(target, generated);
    console.log("Wrote docs/reference/api-errors.md.");
  }
}
