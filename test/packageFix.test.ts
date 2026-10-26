import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("npm pkg fix", () => {
  it("does not rewrite package.json", () => {
    const before = readFileSync("package.json", "utf8");
    const dir = mkdtempSync(join(tmpdir(), "advan-pkg-"));
    try {
      writeFileSync(join(dir, "package.json"), before);
      execFileSync("npm", ["pkg", "fix"], { cwd: dir, stdio: "pipe" });
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
