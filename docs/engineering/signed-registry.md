# Signed capability and deployment registry

Stacks Capital treats contract principals, reviewed assets, adapter versions, and action states as release material. They live in `packages/config/src/deployments.ts` and are included in the Ed25519-signed payload in `packages/config/src/signedRegistry.ts`.

## Runtime guarantees

- API and worker startup verify the built-in registry before opening network or database services.
- A wallet-signable Stacks contract call is rejected when its target is absent from the active registry.
- A missing trusted-contract context fails closed; it is not treated as an empty or permissive allowlist.
- Disabled capabilities never become signing targets.
- `safe_exit_only` pauses deposits, borrows, supplies, swaps, and staking while retaining reads, repayments, and supported withdrawals.
- Rollback always enters `safe_exit_only`; an operator must review evidence before re-enabling new-risk actions.

Read paths do not depend on a capability being executable. Pausing a write therefore does not hide positions, evidence, or the user's supported exit actions.

## Release procedure

1. Review every asset identity, deployment principal, network, revision, capability state, and adapter version.
2. Set `previousVersion` to the currently active version and increment `version`.
3. Canonicalize the payload with `canonicalRegistryPayload`.
4. Sign those exact UTF-8 bytes with an offline Ed25519 release key. Never place the private key in the repository, build logs, CI variables visible to forks, or application runtime.
5. Add the release public key under a new `keyId` when rotating keys, then replace the payload signature.
6. Run the config, signing-boundary, threat-model, engine, and SDK tests. A one-byte payload change must make verification fail.
7. Deploy in safe-exit-only mode first. Confirm reads and exit paths, then activate new-risk actions.

## Rollback

Use `rollbackRegistry` to select the recorded prior version. Rollback deliberately does not restore active writes: it returns `safe_exit_only`. Investigate the failed release, verify current chain and provider evidence, and explicitly activate only after review.

The repository stores public keys and signatures only. Loss or compromise of a private release key requires a code-reviewed key rotation and a newly signed registry; it must never be recovered from an application host.
