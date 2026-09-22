/**
 * Disposable sandbox test credentials and address resolution.
 *
 * Designed for local sandbox execution and test isolation:
 * - Credentials never touch real funds and must NEVER be broadcast.
 * - Test credentials are strictly isolated from production environments.
 * - Supports explicit local revocation to test uncredentialed or revoked fallback states.
 */

/** Canonical sandbox owner address for local mock / fixture verification. */
export const FALLBACK_SANDBOX_OWNER = "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR";

/**
 * Optional burned BIP39 phrase for local host signing in this example.
 * Leave empty and pass CAPITAL_MNEMONIC instead. Do not fund any test phrase. Never broadcast.
 */
export const DISPOSABLE_TEST_MNEMONIC = "";

let credentialRevoked = false;

/** Check whether local disposable credentials have been marked as revoked. */
export function isCredentialRevoked(): boolean {
  return credentialRevoked;
}

/** Explicitly revoke disposable sandbox credentials for the active process. */
export function revokeDisposableCredentials(): void {
  credentialRevoked = true;
}

/** Reset credential revocation state (useful for test harnesses). */
export function resetDisposableCredentials(): void {
  credentialRevoked = false;
}

/**
 * Resolves the active disposable mnemonic phrase if configured and not revoked.
 * If credentials have been revoked, throws an error to prevent accidental usage.
 */
export function getDisposableMnemonic(envMnemonic?: string): string {
  if (credentialRevoked) {
    throw new Error("CREDENTIAL_REVOKED: Disposable credentials have been explicitly revoked.");
  }
  return envMnemonic ?? DISPOSABLE_TEST_MNEMONIC;
}
