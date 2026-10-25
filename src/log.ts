import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UsageKind =
  | "tool"
  | "fee_check_failure"
  | "referral_requote"
  | "x402_settlement"
  | "x402_verification"
  | "facilitator_failover";

export type PaymentStatus =
  | "free"
  | "verified"
  | "settled"
  | "settlement_failed"
  | "verification_failed"
  | "unconfigured"
  | "not_applicable";

export interface UsageEvent {
  ts: string;
  kind: UsageKind;
  tool?: string;
  latencyMs?: number;
  success: boolean;
  error?: string;
  errorCode?: string;
  paymentStatus?: PaymentStatus;
  facilitator?: string;
  feeBps?: number;
  feeMint?: string;
  estimatedIntegratorFeeRaw?: string;
  referralAccount?: string;
  usdcAtomic?: string;
  network?: string;
  failures?: string[];
}

export interface UsageLogger {
  write(event: UsageEvent): void;
}

export class JsonlUsageLogger implements UsageLogger {
  constructor(
    private readonly filePath: string,
    private readonly mirrorStdout = false,
  ) {}

  write(event: UsageEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    if (this.filePath !== "stdout") {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line, "utf8");
    }
    if (this.mirrorStdout || this.filePath === "stdout") {
      process.stdout.write(line);
    }
  }
}

export class MemoryUsageLogger implements UsageLogger {
  readonly events: UsageEvent[] = [];

  write(event: UsageEvent): void {
    this.events.push(event);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
