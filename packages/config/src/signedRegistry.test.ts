import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_REGISTRY,
  activateRegistry,
  rollbackRegistry,
  safeExitOnly,
  verifyBuiltinRegistry,
  verifySignedRegistry,
  type SignedRegistry,
} from "./signedRegistry.ts";

describe("signed deployment registry", () => {
  it("verifies the repository registry with its pinned release key", async () => {
    const verified = await verifyBuiltinRegistry();
    assert.equal(verified.verified, true);
    assert.equal(verified.payload.version, "0.1.0");
  });

  it("rejects untrusted signers and any change to signed content", async () => {
    await assert.rejects(
      () => verifySignedRegistry({ ...BUILTIN_REGISTRY, keyId: "unknown-release-key" }),
      /signer is not trusted/,
    );

    const tampered: SignedRegistry = {
      ...BUILTIN_REGISTRY,
      payload: { ...BUILTIN_REGISTRY.payload, issuedAt: "2026-09-20T00:00:01.000Z" },
    };
    await assert.rejects(() => verifySignedRegistry(tampered), /signature is invalid/);
  });

  it("rejects capabilities that target an unregistered or wrong-network contract", async () => {
    const unsafe = structuredClone(BUILTIN_REGISTRY) as unknown as {
      payload: { capabilities: Array<Record<string, unknown>> };
    };
    const capability = unsafe.payload.capabilities.find((item) => item.state === "enabled");
    if (capability === undefined) throw new Error("expected an enabled capability");
    capability.contractId = "ST000000000000000000002AMW42H.unreviewed";
    await assert.rejects(() => verifySignedRegistry(unsafe as unknown as SignedRegistry), /does not target mainnet/);
  });

  it("activates, enters safe-exit-only mode, and rolls back without enabling writes", async () => {
    const verified = await verifyBuiltinRegistry();
    const active = activateRegistry(null, verified);
    assert.deepEqual(active, { activeVersion: "0.1.0", rollbackVersion: null, mode: "active" });
    assert.equal(safeExitOnly(active).mode, "safe_exit_only");

    const rolledBack = rollbackRegistry({
      activeVersion: "0.2.0",
      rollbackVersion: "0.1.0",
      mode: "active",
    });
    assert.deepEqual(rolledBack, {
      activeVersion: "0.1.0",
      rollbackVersion: "0.2.0",
      mode: "safe_exit_only",
    });
  });
});
