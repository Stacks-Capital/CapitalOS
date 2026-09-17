import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clarityBoolAfter, clarityIntAfter, decodeClarityUint, encodeStandardPrincipal, encodeUint } from "./clarity.ts";

describe("Clarity live-read codecs", () => {
  it("encodes a standard principal and uint argument", () => {
    assert.equal(
      encodeStandardPrincipal("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4"),
      "0x0514f6decc7cfff2a413bd7cd4f53c25ad7fd1899acc",
    );
    assert.equal(encodeUint(4n), "0x0100000000000000000000000000000004");
  });

  it("decodes vault pause flags and sBTC egroup LTVs from live hex", () => {
    const pause = "0x070c00000006066163637275650406626f72726f7704076465706f7369740409666c6173686c6f616e040672656465656d0405726570617904";
    assert.equal(clarityBoolAfter(pause, "deposit"), false);
    assert.equal(clarityBoolAfter(pause, "redeem"), false);
    assert.equal(decodeClarityUint("0x07010000000000000000000000746a528800"), 500000000000n);

    const egroup = "0x070c0000000914424f52524f572d44495341424c45442d4d41534b01000000000000000000000000000000000d4c49512d43555256452d455850020000000227100f4c49512d50454e414c54592d4d4158020000000203e80f4c49512d50454e414c54592d4d494e020000000202ee0a4c54562d424f52524f5702000000021f400c4c54562d4c49512d46554c4c020000000223280f4c54562d4c49512d5041525449414c02000000022134044d41534b0100000000000000040000000000000004026964020000000102";
    assert.equal(clarityIntAfter(egroup, "LTV-BORROW"), 8000n);
    assert.equal(clarityIntAfter(egroup, "LTV-LIQ-PARTIAL"), 8500n);
    assert.equal(clarityIntAfter(egroup, "LTV-LIQ-FULL"), 9000n);
  });
});
