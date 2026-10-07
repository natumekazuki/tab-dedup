import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const extension = resolve(process.argv[2] || resolve(root, "extension"));
const manifest = JSON.parse(readFileSync(resolve(extension, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.ok(manifest.version.split(".").every(n => Number(n) <= 65535));
assert.notEqual(manifest.version, "0.0.0");
assert.equal(pkg.version, manifest.version, "packageとmanifestのversionが一致しません");
assert.equal(pkg.private, true);
assert.equal(manifest.manifest_version, 3);

function asset(relative) {
  const file = resolve(extension, relative);
  assert.ok(file.startsWith(extension + sep), `拡張外への参照: ${relative}`);
  assert.ok(statSync(file).isFile(), `参照先がありません: ${relative}`);
  return file;
}
asset(manifest.background.service_worker);
asset(manifest.action.default_popup);
for (const icons of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, relative] of Object.entries(icons)) {
    const png = readFileSync(asset(relative));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
}

function syntax(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) syntax(file);
    else if (/\.(mjs|js)$/.test(entry.name)) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}
for (const directory of [extension, resolve(root, "scripts"), resolve(root, "tests")]) syntax(directory);
execFileSync(process.execPath, ["--check", resolve(root, "playwright.config.js")], { stdio: "inherit" });

if (process.env.GITHUB_REF?.startsWith("refs/tags/")) {
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${manifest.version}`, "タグとversionが一致しません");
}
assert.ok(statSync(resolve(root, `docs/releases/${manifest.version}.md`)).isFile());
console.log(`構成・構文・version ${manifest.version}: OK`);
