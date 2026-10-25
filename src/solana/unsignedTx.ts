import { getBase58Decoder, getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { GuardError } from "../errors.js";

const LOOKUP_TABLE_META_SIZE = 56;

export interface AddressLookup {
  lookupTableAddress: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface InspectedTransaction {
  feePayer: string;
  signers: string[];
  staticAccounts: string[];
  lookups: AddressLookup[];
  allZeroSignatures: boolean;
  version: string;
}

export function encodeUnsignedTransaction(parts: {
  signers: string[];
  writable?: string[];
  readonly?: string[];
}): string {
  const b58 = getBase58Encoder();
  const raw = (value: string) => Buffer.from(b58.encode(value));
  const signers = parts.signers.map(raw);
  const writable = (parts.writable ?? []).map(raw);
  const readonlyAccounts = (parts.readonly ?? []).map(raw);
  const accounts = [...signers, ...writable, ...readonlyAccounts];
  if (accounts.length > 127 || signers.length > 127) {
    throw new GuardError("test transaction has too many accounts");
  }
  const body = Buffer.concat([
    Buffer.from([signers.length, 0, readonlyAccounts.length]),
    Buffer.from([accounts.length]),
    ...accounts,
    Buffer.alloc(32, 4),
    Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([signers.length]), Buffer.alloc(signers.length * 64, 0), body]).toString("base64");
}

export function inspectUnsignedTransaction(base64: string): InspectedTransaction {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 1 + 64 + 3) throw new Error("transaction is too short");
    const tx = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const signers = Object.keys(tx.signatures);
    const allZeroSignatures = signers.length > 0 && Object.values(tx.signatures).every((signature) => signature == null);
    const lookups = readLookups(message);
    const feePayer = message.staticAccounts[0];
    if (!feePayer) throw new Error("transaction has no fee payer");
    return {
      feePayer,
      signers,
      staticAccounts: [...message.staticAccounts],
      lookups,
      allZeroSignatures,
      version: String(message.version),
    };
  } catch (error) {
    if (error instanceof GuardError) throw error;
    const message = error instanceof Error ? error.message : "decode failed";
    throw new GuardError(`could not decode swap transaction: ${message}`);
  }
}

export function assertSwapSigners(
  tx: InspectedTransaction,
  expected: { taker: string; jupiterz: boolean; signatureFeePayer?: string | null },
): void {
  if (!tx.allZeroSignatures) {
    throw new GuardError(
      "swap transaction is not unsigned. Advan refuses to return a transaction that already carries a signature.",
    );
  }
  if (!tx.signers.includes(expected.taker)) {
    throw new GuardError(`taker ${expected.taker} is not a required signer (signers: ${tx.signers.join(", ") || "none"})`);
  }
  if (expected.jupiterz) {
    const marketMakers = tx.signers.filter((signer) => signer !== expected.taker);
    if (marketMakers.length === 0) {
      throw new GuardError(
        "JupiterZ transaction must include the taker and the market maker as signers. This one only lists the taker, so it cannot be co-signed during /execute.",
      );
    }
  } else if (tx.signers.length !== 1 || tx.signers[0] !== expected.taker) {
    throw new GuardError(
      `expected the only signer to be the taker ${expected.taker}, got ${tx.signers.join(", ") || "none"}`,
    );
  }
  const expectedFeePayer = expected.signatureFeePayer || expected.taker;
  if (tx.feePayer !== expectedFeePayer) {
    throw new GuardError(`fee payer ${tx.feePayer} does not match expected fee payer ${expectedFeePayer}`);
  }
}

export function lookupTableAddresses(data: Uint8Array): string[] {
  const decoder = getBase58Decoder();
  const addresses: string[] = [];
  for (let offset = LOOKUP_TABLE_META_SIZE; offset + 32 <= data.length; offset += 32) {
    addresses.push(decoder.decode(data.subarray(offset, offset + 32)));
  }
  return addresses;
}

export async function referralAccountInTransaction(
  tx: InspectedTransaction,
  account: string,
  rpc: { getAccountData(address: string): Promise<Uint8Array | null> },
): Promise<"present" | "absent" | "unverified"> {
  if (tx.staticAccounts.includes(account)) return "present";
  if (tx.lookups.length === 0) return "absent";
  for (const lookup of tx.lookups) {
    let data: Uint8Array | null;
    try {
      data = await rpc.getAccountData(lookup.lookupTableAddress);
    } catch {
      return "unverified";
    }
    if (!data) return "unverified";
    const addresses = lookupTableAddresses(data);
    for (const index of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
      const loaded = addresses[index];
      if (!loaded) return "unverified";
      if (loaded === account) return "present";
    }
  }
  return "absent";
}

function readLookups(message: { addressTableLookups?: unknown; version?: unknown }): AddressLookup[] {
  if (message.version !== 0 || !Array.isArray(message.addressTableLookups)) return [];
  const lookups: AddressLookup[] = [];
  for (const row of message.addressTableLookups) {
    if (!row || typeof row !== "object") continue;
    const record = row as { lookupTableAddress?: unknown; writableIndexes?: unknown; readonlyIndexes?: unknown };
    if (typeof record.lookupTableAddress !== "string") continue;
    lookups.push({
      lookupTableAddress: record.lookupTableAddress,
      writableIndexes: numberList(record.writableIndexes),
      readonlyIndexes: numberList(record.readonlyIndexes),
    });
  }
  return lookups;
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}
