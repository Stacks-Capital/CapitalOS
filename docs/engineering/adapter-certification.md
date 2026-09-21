# Protocol adapter certification

CapitalOS adapters are admitted through a deterministic conformance harness before any live workflow certification. Fixture conformance is necessary, but it is not a claim that a protocol or production workflow is live-certified.

Run the gate with:

```sh
npm run adapters:certify
```

The JSON report names the protocol, adapter version, registry version, network, exact deployment/revision, and canonical fixture block. A fixture passes only when all of these checks agree:

- protocol-specific amount units, decimals, rounding, completion evidence, and post-condition policy are declared;
- normalized reads match the fixture exactly, so an adapter cannot invent an unsupported field;
- quote inputs, outputs, fees, minimum output, and evidence snapshots match exact integer base units;
- unsigned payloads, Clarity arguments, dependency order, and deny-mode post-conditions match exactly;
- core signing validation accepts the resulting plan against the signed-registry contract allowlist;
- canonical events decode to the expected activity; and
- an exact reconciliation succeeds while a one-unit mismatch fails with an explanation.

The built-in suite currently covers sBTC deposit, sBTC withdrawal, Zest supply, Zest redeem, Granite borrow, and Bitflow exact-input swap. Each protocol lifecycle task must add entry and exit fixtures before its launch state can change. A provider response or passing fixture must never be relabeled as independent live evidence.

## Evidence handling

Certification fixtures are immutable regression evidence. They identify their source and pinned block, and their values are deliberately literal rather than generated from the adapter under test. Live certification remains a separate release artifact containing current deployment checks, canonical transaction IDs, reconciliation evidence, known limitations, and reviewer approval.
