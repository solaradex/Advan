import { ZodError } from "zod";

export class AdvanError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ConfigError extends AdvanError {
  constructor(message: string) {
    super(message, "config", 500);
  }
}

export class ValidationError extends AdvanError {
  constructor(message: string, details?: unknown) {
    super(message, "validation", 400, details);
  }
}

export class GuardError extends AdvanError {
  constructor(message: string, details?: unknown) {
    super(message, "guard", 400, details);
  }
}

export class FeeCheckError extends AdvanError {
  readonly failures: string[];

  constructor(failures: string[]) {
    super(failures.join("; "), "fee_check_failure", 502, { failures });
    this.failures = failures;
  }
}

export class UpstreamError extends AdvanError {
  constructor(message: string, details?: unknown) {
    super(message, "upstream", 502, details);
  }
}

export class PaymentsUnconfiguredError extends AdvanError {
  constructor() {
    super(
      "x402 payments are not configured. Set X402_PAY_TO to a Solana address whose USDC token account already exists.",
      "payments_unconfigured",
      503,
    );
  }
}

export function toAdvanError(error: unknown): AdvanError {
  if (error instanceof AdvanError) return error;
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return new ValidationError(message, error.issues);
  }
  if (error instanceof Error) return new UpstreamError(error.message);
  return new UpstreamError("Unknown error");
}
