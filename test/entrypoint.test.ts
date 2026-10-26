import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const entrypoint = join(process.cwd(), "docker/entrypoint.sh");

function writeBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function runEntrypoint(options: {
  dataDir: string;
  binDir: string;
  fakeUid: string;
  args: string[];
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(entrypoint, options.args, {
      env: {
        ...process.env,
        PATH: `${options.binDir}:${process.env.PATH ?? ""}`,
        ADVAN_DATA_DIR: options.dataDir,
        ADVAN_RUN_AS: "node",
        FAKE_UID: options.fakeUid,
        ...options.extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("docker entrypoint", () => {
  it("chowns an existing data directory and drops root with su-exec", async () => {
    const root = mkdtempSync(join(tmpdir(), "advan-entry-"));
    try {
      const dataDir = join(root, "data");
      const binDir = join(root, "bin");
      mkdirSync(dataDir);
      mkdirSync(binDir);
      const chownLog = join(root, "chown.log");
      const suLog = join(root, "su.log");
      writeBin(
        binDir,
        "chown",
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${chownLog}"\n`,
      );
      writeBin(
        binDir,
        "id",
        "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then printf '%s\\n' \"${FAKE_UID:-0}\"; exit 0; fi\nexit 1\n",
      );
      writeBin(
        binDir,
        "su-exec",
        `#!/bin/sh\nprintf '%s\\n' "$1" > "${suLog}"\nshift\nexec "$@"\n`,
      );

      const result = await runEntrypoint({
        dataDir,
        binDir,
        fakeUid: "0",
        args: ["node", "-e", "process.stdout.write('started')"],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("started");
      expect(readFileSync(chownLog, "utf8").trim()).toBe(`-R node:node ${dataDir}`);
      expect(readFileSync(suLog, "utf8").trim()).toBe("node");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a missing data directory and still starts the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "advan-entry-"));
    try {
      const dataDir = join(root, "missing");
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const chownLog = join(root, "chown.log");
      const suLog = join(root, "su.log");
      writeBin(
        binDir,
        "chown",
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${chownLog}"\n`,
      );
      writeBin(
        binDir,
        "id",
        "#!/bin/sh\nif [ \"$1\" = \"-u\" ]; then printf '%s\\n' \"${FAKE_UID:-0}\"; exit 0; fi\nexit 1\n",
      );
      writeBin(
        binDir,
        "su-exec",
        `#!/bin/sh\nprintf '%s\\n' "$1" > "${suLog}"\nshift\nexec "$@"\n`,
      );

      const marker = join(dataDir, "usage.jsonl");
      const result = await runEntrypoint({
        dataDir,
        binDir,
        fakeUid: "1000",
        args: ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker],
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(readFileSync(marker, "utf8")).toBe("ok");
      expect(readFileSync(chownLog, "utf8")).toContain(dataDir);
      expect(() => readFileSync(suLog, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
