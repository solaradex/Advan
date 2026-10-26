import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { encoding: "utf8" }),
);
const filename = packed[0]?.filename;
if (!filename) {
  console.error("npm pack did not report a tarball");
  process.exit(1);
}

try {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", filename, "package/package.json"], { encoding: "utf8" }),
  );
  const bin = manifest.bin?.["advan-mcp"];
  if (bin !== "dist/index.js") {
    console.error(`packed package.json bin is ${JSON.stringify(manifest.bin)}`);
    process.exit(1);
  }

  const listing = execFileSync("tar", ["-tvf", filename], { encoding: "utf8" });
  const entry = listing.split("\n").find((line) => line.endsWith("package/dist/index.js"));
  if (!entry?.startsWith("-rwx")) {
    console.error(`dist/index.js is not executable in ${filename}: ${entry ?? "missing"}`);
    process.exit(1);
  }
} finally {
  unlinkSync(filename);
}
