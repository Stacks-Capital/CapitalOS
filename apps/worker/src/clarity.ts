import { Cl, cvToHex } from "@stacks/transactions";

export function encodeAscii(value: string): string {
  return cvToHex(Cl.stringAscii(value));
}
