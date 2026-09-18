import { ApiError } from "./errors.ts";

// Cursors are opaque to clients: a list kind plus the last key, base64url encoded.
export function encodeCursor(kind: string, key: readonly string[]): string {
  return Buffer.from(JSON.stringify([kind, ...key])).toString("base64url");
}

export function decodeCursor(kind: string, cursor: string | undefined, size: number): string[] | null {
  if (cursor === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("INVALID_REQUEST", "cursor is not valid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== size + 1 ||
    parsed[0] !== kind ||
    !parsed.every((part) => typeof part === "string")
  ) {
    throw new ApiError("INVALID_REQUEST", "cursor is not valid for this list");
  }
  return parsed.slice(1);
}
