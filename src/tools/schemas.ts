import { z } from "zod";

const pubkeySchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a Solana address");

const amountSchema = z
  .string()
  .regex(/^[0-9]{1,40}$/, "amount must be a base-unit integer")
  .refine((value) => BigInt(value) > 0n, "amount must be greater than 0");

export const quoteSchema = z
  .object({
    inputMint: pubkeySchema,
    outputMint: pubkeySchema,
    amount: amountSchema,
    slippageBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.inputMint === value.outputMint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputMint"],
        message: "inputMint and outputMint must differ",
      });
    }
  });

export const swapSchema = z
  .object({
    inputMint: pubkeySchema,
    outputMint: pubkeySchema,
    amount: amountSchema,
    taker: pubkeySchema,
    slippageBps: z.number().int().min(0).max(10_000).optional(),
    selfBroadcast: z.boolean().optional(),
    receiver: pubkeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.inputMint === value.outputMint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputMint"],
        message: "inputMint and outputMint must differ",
      });
    }
  });

export const tokenRiskSchema = z
  .object({
    mint: pubkeySchema,
  })
  .strict();

export const portfolioSchema = z
  .object({
    owner: pubkeySchema,
  })
  .strict();

export type QuoteInput = z.infer<typeof quoteSchema>;
export type SwapInput = z.infer<typeof swapSchema>;
export type TokenRiskInput = z.infer<typeof tokenRiskSchema>;
export type PortfolioInput = z.infer<typeof portfolioSchema>;

export const quoteShape = {
  inputMint: pubkeySchema,
  outputMint: pubkeySchema,
  amount: amountSchema,
  slippageBps: z.number().int().min(0).max(10_000).optional(),
};

export const swapShape = {
  ...quoteShape,
  taker: pubkeySchema,
  selfBroadcast: z.boolean().optional(),
  receiver: pubkeySchema.optional(),
};

export const tokenRiskShape = { mint: pubkeySchema };
export const portfolioShape = { owner: pubkeySchema };
