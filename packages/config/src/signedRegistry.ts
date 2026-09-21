import { formatAssetId, parseAssetId } from "@stacks-capital/core";
import { ASSETS, CAPABILITIES, CONTRACTS, REGISTRY_VERSION, type RegistryMode } from "./deployments.ts";

export type RegistryPayload = {
  schemaVersion: "1";
  version: string;
  previousVersion: string | null;
  issuedAt: string;
  assets: typeof ASSETS;
  deployments: typeof CONTRACTS;
  capabilities: typeof CAPABILITIES;
};

export type SignedRegistry = {
  keyId: string;
  signature: string;
  payload: RegistryPayload;
};

export type VerifiedRegistry = {
  keyId: string;
  payload: RegistryPayload;
  verified: true;
};

export type RegistryActivation = {
  activeVersion: string;
  rollbackVersion: string | null;
  mode: RegistryMode;
};

const KEY_ID = "capitalos-release-2026-01";

// The matching private key is deliberately not stored in the repository.
export const REGISTRY_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  [KEY_ID]: "8f362fcecfa79d02415016bbfcf360c5860ba7cb44402941b56d7c8a28424444",
};

export const BUILTIN_REGISTRY: SignedRegistry = {
  keyId: KEY_ID,
  signature:
    "ede6f39b51385e051112c5f66a2f08961f4d048c5d91eb04567fa01c8407ce80e098bc630e86b0f687ef1362700223316d0c66b4544086227b4df36ac67ebe08",
  payload: {
    schemaVersion: "1",
    version: REGISTRY_VERSION,
    previousVersion: null,
    issuedAt: "2026-09-20T00:00:00.000Z",
    assets: ASSETS,
    deployments: CONTRACTS,
    capabilities: CAPABILITIES,
  },
};

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(",")}}`;
  }
  throw new Error(`Registry contains a non-JSON value: ${typeof value}`);
}

export function canonicalRegistryPayload(payload: RegistryPayload): string {
  return canonicalValue(payload);
}

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("Registry key or signature is not hex");
  const result = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function assertNetworkTarget(network: "mainnet" | "testnet", contractId: string): void {
  const prefix = contractId.slice(0, 2);
  const matches = network === "mainnet" ? prefix === "SP" || prefix === "SM" : prefix === "ST" || prefix === "SN";
  if (!matches) throw new Error(`${contractId} does not target ${network}`);
}

function validatePayload(payload: RegistryPayload): void {
  if (payload.schemaVersion !== "1" || payload.version === "") throw new Error("Registry metadata is invalid");
  if (!Number.isFinite(Date.parse(payload.issuedAt))) throw new Error("Registry issuedAt is invalid");

  const deploymentIds = new Set<string>();
  const deployedContracts = new Set<string>();
  for (const deployment of payload.deployments) {
    assertNetworkTarget(deployment.network, deployment.contractId);
    const key = `${deployment.protocol}:${deployment.network}:${deployment.contractId}@${deployment.revision}`;
    if (deploymentIds.has(key)) throw new Error(`Duplicate registry deployment ${key}`);
    deploymentIds.add(key);
    deployedContracts.add(`${deployment.network}:${deployment.contractId}`);
  }

  const assetIds = new Set<string>();
  for (const asset of payload.assets) {
    assertNetworkTarget(asset.network, asset.contractId);
    const parsed = parseAssetId(asset.id);
    if (parsed.network !== asset.network || formatAssetId(parsed) !== asset.id) {
      throw new Error(`Asset identity does not match its network: ${asset.id}`);
    }
    if (assetIds.has(asset.id)) throw new Error(`Duplicate registry asset ${asset.id}`);
    assetIds.add(asset.id);
  }

  const capabilityIds = new Set<string>();
  for (const capability of payload.capabilities) {
    const key = `${capability.network}:${capability.protocol}:${capability.action}`;
    if (capabilityIds.has(key)) throw new Error(`Duplicate registry capability ${key}`);
    capabilityIds.add(key);
    if (!/^[a-z0-9-]+@\d+\.\d+\.\d+$/.test(capability.adapterVersion)) {
      throw new Error(`Invalid adapter version ${capability.adapterVersion}`);
    }
    if (capability.state !== "disabled") {
      assertNetworkTarget(capability.network, capability.contractId);
      if (!deployedContracts.has(`${capability.network}:${capability.contractId}`)) {
        throw new Error(`Capability targets an unregistered deployment: ${capability.contractId}`);
      }
    }
  }
}

export async function verifySignedRegistry(
  registry: SignedRegistry,
  trustedKeys: Readonly<Record<string, string>> = REGISTRY_PUBLIC_KEYS,
): Promise<VerifiedRegistry> {
  const publicKey = trustedKeys[registry.keyId];
  if (publicKey === undefined) throw new Error(`Registry signer is not trusted: ${registry.keyId}`);
  validatePayload(registry.payload);
  const key = await globalThis.crypto.subtle.importKey("raw", bytes(publicKey), "Ed25519", false, ["verify"]);
  const valid = await globalThis.crypto.subtle.verify(
    "Ed25519",
    key,
    bytes(registry.signature),
    new TextEncoder().encode(canonicalRegistryPayload(registry.payload)),
  );
  if (!valid) throw new Error(`Registry signature is invalid for ${registry.payload.version}`);
  return { keyId: registry.keyId, payload: registry.payload, verified: true };
}

export function verifyBuiltinRegistry(): Promise<VerifiedRegistry> {
  return verifySignedRegistry(BUILTIN_REGISTRY);
}

export function activateRegistry(current: RegistryActivation | null, candidate: VerifiedRegistry): RegistryActivation {
  if (current !== null && candidate.payload.previousVersion !== current.activeVersion) {
    throw new Error(
      `Registry ${candidate.payload.version} cannot replace ${current.activeVersion}; previousVersion does not match`,
    );
  }
  return {
    activeVersion: candidate.payload.version,
    rollbackVersion: current?.activeVersion ?? candidate.payload.previousVersion,
    mode: "active",
  };
}

export function safeExitOnly(state: RegistryActivation): RegistryActivation {
  return { ...state, mode: "safe_exit_only" };
}

export function rollbackRegistry(state: RegistryActivation): RegistryActivation {
  if (state.rollbackVersion === null) throw new Error("Registry has no rollback version");
  return {
    activeVersion: state.rollbackVersion,
    rollbackVersion: state.activeVersion,
    mode: "safe_exit_only",
  };
}
