import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] || resolve(root, "dist"));
const manifest = JSON.parse(execFileSync("git", ["show", "HEAD:extension/manifest.json"], { cwd: root, encoding: "utf8" }));
const working = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
assert.equal(manifest.version, working.version, "パッケージ対象のversion変更を先にcommitしてください");
const zip = resolve(output, `tab-dedup-${manifest.version}.zip`);
const extension = resolve(output, "extension");
assert.ok(!existsSync(zip) && !existsSync(extension), "出力先には既存のパッケージがあります。別の空の出力先を指定してください");
mkdirSync(output, { recursive: true });
execFileSync("git", ["archive", "--format=zip", `--output=${zip}`, "HEAD:extension"], { cwd: root, stdio: "inherit" });

if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:TAB_DEDUP_ZIP -DestinationPath $env:TAB_DEDUP_UNPACKED"], {
    env: { ...process.env, TAB_DEDUP_ZIP: zip, TAB_DEDUP_UNPACKED: extension }, stdio: "inherit",
  });
} else {
  execFileSync("unzip", ["-q", zip, "-d", extension], { stdio: "inherit" });
}
assert.ok(readdirSync(extension).includes("manifest.json"), "ZIPルートにmanifestがありません");
execFileSync(process.execPath, [resolve(root, "scripts/check.mjs"), extension], { cwd: root, stdio: "inherit" });
console.log(`ZIP: ${zip}\n展開先: ${extension}`);
