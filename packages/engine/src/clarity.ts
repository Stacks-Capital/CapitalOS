const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ADDRESS_VERSION: Readonly<Record<string, number>> = {
  SP: 0x16,
  SM: 0x14,
  ST: 0x1a,
  SN: 0x15,
};

export function encodeStandardPrincipal(address: string): string {
  const prefix = address.slice(0, 2);
  const version = ADDRESS_VERSION[prefix];
  if (version === undefined) throw new Error(`Unsupported Stacks address ${address}`);
  const hash = c32Hash160(address);
  return `0x05${version.toString(16).padStart(2, "0")}${hash}`;
}

export function encodeUint(value: bigint): string {
  return `0x01${value.toString(16).padStart(32, "0")}`;
}

export function encodeAscii(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x0d${bytes.length.toString(16).padStart(8, "0")}${hex}`;
}

function c32Hash160(address: string): string {
  let n = 0n;
  for (const ch of address.slice(1)) {
    const i = C32.indexOf(ch);
    if (i < 0) throw new Error(`Invalid c32 character in ${address}`);
    n = n * 32n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = hex.length >= 50 ? hex.slice(-50) : hex.padStart(50, "0");
  return bytes.slice(2, 42);
}

export function decodeClarityUint(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.startsWith("08")) throw new Error(`Clarity error ${hex}`);
  const body = h.startsWith("07") ? h.slice(2) : h;
  if (!body.startsWith("01") || body.length < 34) throw new Error(`Not a Clarity uint: ${hex}`);
  return BigInt(`0x${body.slice(2, 34)}`);
}

function utf8Hex(name: string): string {
  return Array.from(new TextEncoder().encode(name), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clarityBoolAfter(hex: string, name: string): boolean {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const needle = utf8Hex(name);
  const at = h.indexOf(needle);
  if (at < 0) throw new Error(`tuple field ${name} missing`);
  const flag = h.slice(at + needle.length, at + needle.length + 2);
  if (flag === "03") return true;
  if (flag === "04") return false;
  throw new Error(`tuple field ${name} is not a bool`);
}

export function clarityIntAfter(hex: string, name: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const needle = utf8Hex(name);
  const at = h.indexOf(needle);
  if (at < 0) throw new Error(`tuple field ${name} missing`);
  const encoded = h.slice(at + needle.length, at + needle.length + 14);
  if (!encoded.startsWith("02")) throw new Error(`tuple field ${name} is not an int`);
  return BigInt(`0x${encoded.slice(10)}`);
}

export function clarityUintAfter(hex: string, name: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const needle = utf8Hex(name);
  const at = h.indexOf(needle);
  if (at < 0) throw new Error(`tuple field ${name} missing`);
  const encoded = h.slice(at + needle.length, at + needle.length + 34);
  if (!encoded.startsWith("01") || encoded.length < 34) throw new Error(`tuple field ${name} is not a uint`);
  return BigInt(`0x${encoded.slice(2, 34)}`);
}

/** DIA get-value response used by tests: (ok {timestamp: uint, value: uint}). */
export function diaOracleHex(price: bigint, timestampMs: bigint): string {
  const uint = (value: bigint) => `01${value.toString(16).padStart(32, "0")}`;
  const field = (name: string, encoded: string) =>
    `${name.length.toString(16).padStart(2, "0")}${utf8Hex(name)}${encoded}`;
  return `0x070c00000002${field("timestamp", uint(timestampMs))}${field("value", uint(price))}`;
}
