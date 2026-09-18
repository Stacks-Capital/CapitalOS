import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashMessage } from "@stacks/encryption";
import {
  getAddressFromPublicKey,
  privateKeyToPublic,
  publicKeyToHex,
  randomPrivateKey,
  signMessageHashRsv,
} from "@stacks/transactions";
import type { PendingNonce } from "@stacks-capital/database";
import { signatureMatches } from "./auth.ts";

const ORIGIN = "http://localhost:5173";

function signed(network: "mainnet" | "testnet") {
  const privateKey = randomPrivateKey();
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
  const address = getAddressFromPublicKey(publicKey, network);
  const message = `Capital OS wants you to sign in with your Stacks account:\n${address}\n\nOrigin: ${ORIGIN}`;
  const messageHash = Buffer.from(hashMessage(message)).toString("hex");
  const nonce: PendingNonce = { address, network, origin: ORIGIN, message };
  return { nonce, proof: { publicKey, signature: signMessageHashRsv({ messageHash, privateKey }) } };
}

describe("sign in signatures", () => {
  it("accept a signature from the named address at the issuing origin", () => {
    const { nonce, proof } = signed("mainnet");
    assert.equal(signatureMatches(nonce, ORIGIN, proof), true);
  });

  it("accept a real Leather signature recorded in I02", () => {
    const nonce: PendingNonce = {
      address: "ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0",
      network: "testnet",
      origin: ORIGIN,
      message: "Capital OS I02 nonce f6cd1549-75b7-483c-a5b6-346a84580853 at 2026-09-15T09:55:09.279Z",
    };
    const proof = {
      publicKey: "02139bf00c4bf7d8cc65c31ce29bdd3e10183bdf7cdfc3d65d9d743a3da06681ab",
      signature:
        "a81aab3458f57d76a98d7b1d7c36b7a19ffdd6f955c2c0c5c49a51e684dce0413187a8b9e453ddd43e4ea41609bdca31e31807ca068e2d8559851b6748d8bfdd01",
    };
    assert.equal(signatureMatches(nonce, ORIGIN, proof), true);
    assert.equal(signatureMatches({ ...nonce, network: "mainnet" }, ORIGIN, proof), false);
  });

  it("reject another origin, another address, a changed message and a malformed key", () => {
    const { nonce, proof } = signed("testnet");
    const other = signed("testnet");
    assert.equal(signatureMatches(nonce, "https://evil.example", proof), false);
    assert.equal(signatureMatches({ ...nonce, address: other.nonce.address }, ORIGIN, proof), false);
    assert.equal(signatureMatches({ ...nonce, message: `${nonce.message} ` }, ORIGIN, proof), false);
    assert.equal(signatureMatches(nonce, ORIGIN, { ...proof, publicKey: "02zz" }), false);
    assert.equal(signatureMatches(nonce, ORIGIN, { ...proof, signature: other.proof.signature }), false);
  });
});
