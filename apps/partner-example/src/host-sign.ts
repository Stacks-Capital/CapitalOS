import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  Cl,
  Pc,
  PayloadType,
  deserializeTransaction,
  getAddressFromPrivateKey,
  isSingleSig,
  makeContractCall,
  type ClarityValue as StacksClarity,
} from "@stacks/transactions";
import { capitalError, parseAssetId, type ClarityValue, type PlanWire, type StacksNetwork } from "@stacks-capital/sdk";

const STX_ACCOUNT_PATH = "m/44'/5757'/0'/0/0";

export type HostAccount = {
  address: string;
};

export type SignedPlan = {
  transaction: string;
  sender: string;
  contractId: string;
  functionName: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function privateKeyFromMnemonic(mnemonic: string): string {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw capitalError("PLAN_INVALID", "mnemonic is not a valid BIP39 phrase");
  }
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(STX_ACCOUNT_PATH);
  if (child.privateKey === null) throw capitalError("UNCLASSIFIED", "derivation produced no private key");
  return `${bytesToHex(child.privateKey)}01`;
}

export function ownerFromMnemonic(mnemonic: string, network: StacksNetwork): HostAccount {
  const privateKey = privateKeyFromMnemonic(mnemonic);
  return { address: getAddressFromPrivateKey(privateKey, network) };
}

function toClarity(value: ClarityValue): StacksClarity {
  if (value.type === "uint") return Cl.uint(BigInt(value.value));
  if (value.type === "principal") return Cl.principal(value.value);
  if (value.type === "buff") return Cl.bufferFromHex(value.hex);
  if (value.type === "none") return Cl.none();
  if (value.type === "some") return Cl.some(toClarity(value.value));
  return Cl.tuple(Object.fromEntries(Object.entries(value.value).map(([key, nested]) => [key, toClarity(nested)])));
}

function postCondition(condition: {
  principal: string;
  mode: "send_lte" | "send_eq" | "send_gte" | "receive_gte";
  amount: { asset: string; quantity: string };
}) {
  const identity = parseAssetId(condition.amount.asset).identity;
  if (identity.kind !== "contract") {
    throw capitalError("UNSUPPORTED_ACTION", "host signer only builds SIP-010 post conditions");
  }
  const builder = Pc.principal(condition.principal);
  const quantity = BigInt(condition.amount.quantity);
  const coded =
    condition.mode === "send_lte"
      ? builder.willSendLte(quantity)
      : condition.mode === "send_eq"
        ? builder.willSendEq(quantity)
        : condition.mode === "send_gte"
          ? builder.willSendGte(quantity)
          : null;
  if (coded === null) throw capitalError("PLAN_INVALID", "receive post conditions are not signed here");
  return coded.ft(identity.principal as `${string}.${string}`, identity.assetName);
}

/**
 * Host-wallet stand-in: turn an unsigned Stacks plan into a signed transaction.
 * Never broadcasts. Bitcoin lockup signing stays disabled.
 */
export async function signUnsignedPlan(plan: PlanWire, mnemonic: string, network: StacksNetwork): Promise<SignedPlan> {
  const account = ownerFromMnemonic(mnemonic, network);
  const step = plan.steps[0];
  if (step === undefined) throw capitalError("PLAN_INVALID", "plan has no steps");
  if (step.payload.kind === "bitcoin_deposit") {
    throw capitalError("UNSUPPORTED_ACTION", "Bitcoin L1 lockup signing is not implemented");
  }
  if (step.payload.kind !== "stacks_contract_call" || step.payload.network !== network) {
    throw capitalError("NETWORK_MISMATCH", "plan step is not a Stacks call on this network");
  }
  const senderPc = step.payload.postConditions[0]?.principal;
  if (senderPc !== account.address) {
    throw capitalError("PLAN_INVALID", "plan sender does not match the mnemonic account");
  }
  const [contractAddress, contractName] = step.payload.contractId.split(".");
  if (contractAddress === undefined || contractName === undefined) {
    throw capitalError("PLAN_INVALID", "contract id is missing an address or name");
  }

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: step.payload.functionName,
    functionArgs: step.payload.functionArgs.map(toClarity),
    senderKey: privateKeyFromMnemonic(mnemonic),
    network,
    nonce: 0n,
    fee: 0n,
    sponsored: false,
    validateWithAbi: false,
    postConditionMode: step.payload.postConditionMode,
    postConditions: step.payload.postConditions.map(postCondition),
  });
  tx.verifyOrigin();
  const serialized = tx.serialize();
  const decoded = deserializeTransaction(serialized);
  if (decoded.payload.payloadType !== PayloadType.ContractCall) {
    throw capitalError("PLAN_INVALID", "signed payload is not a contract call");
  }
  if (decoded.payload.contractName.content !== contractName) {
    throw capitalError("PLAN_INVALID", "signed contract does not match the plan");
  }
  if (!isSingleSig(decoded.auth.spendingCondition) || decoded.auth.spendingCondition.signature.data.length < 8) {
    throw capitalError("PLAN_INVALID", "signed transaction is missing a signature");
  }
  return {
    transaction: serialized,
    sender: account.address,
    contractId: step.payload.contractId,
    functionName: decoded.payload.functionName.content,
  };
}
