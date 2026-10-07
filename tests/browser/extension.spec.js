import { test as base, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";

const test = base.extend({
  context: async ({}, use) => {
    const extension = resolve(process.env.TAB_DEDUP_EXTENSION_PATH || "extension");
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true, viewport: { width: 360, height: 420 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try { await use(context); } finally { await context.close(); }
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await use(worker);
  },
  origin: async ({}, use) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Tab Dedup fixture</title><p>fixture</p>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  },
});

for (const mode of ["include-query", "ignore-query"]) {
  test(`${mode}: 配布物のpopupから削除・復元し、別ウィンドウを変更しない`, async ({ page, worker, origin }, testInfo) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const source = mode === "include-query" ? "?b=2&a=1#one" : "?id=2#one";
    const keeper = mode === "include-query" ? "?a=1&b=2#one" : "?id=1#one";
    const fixture = await worker.evaluate(async ({ origin, source, keeper, mode }) => {
      const current = await chrome.windows.getLastFocused();
      const first = await chrome.tabs.create({ windowId: current.id, url: origin + "/page" + keeper, index: 0, pinned: true, active: false });
      const duplicate = await chrome.tabs.create({ windowId: current.id, url: origin + "/page" + source,
        index: 1, pinned: mode === "ignore-query", active: false });
      const different = await chrome.tabs.create({ windowId: current.id, url: origin + "/page?other=3#two", active: false });
      const other = await chrome.windows.create({ url: origin + "/page" + source, focused: false });
      return { windowId: current.id, first, duplicate, different, otherId: other.id };
    }, { origin, source, keeper, mode });
    await expect.poll(async () => {
      const tabs = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.otherId);
      return tabs.map(tab => tab.url);
    }).toEqual([origin + "/page" + source]);
    const otherBefore = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.otherId);
    const extensionId = worker.url().split("/")[2];
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("#history-count")).toHaveText("0 / 5回分");
    await expect(page.locator("#history-info")).toBeHidden();
    await expect(page.locator("#restore")).toBeDisabled();
    const button = page.locator(`button[data-mode="${mode}"]`);
    await expect(button).toBeEnabled();
    await expect(page.locator(mode === "include-query" ? "#include-count" : "#ignore-count")).toHaveText("1件");
    if (mode === "ignore-query") await expect(page.locator("#include-count")).toHaveText("0件");
    await button.click();
    await expect(page.locator("#status")).toHaveText("1タブを削除しました。");
    await expect(page.locator("#history-count")).toHaveText("1 / 5回分");
    const remaining = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.windowId);
    expect(remaining.some(tab => tab.id === fixture.duplicate.id)).toBe(false);
    expect(remaining.some(tab => tab.id === fixture.first.id)).toBe(true);
    expect(remaining.some(tab => tab.id === fixture.different.id)).toBe(true);
    const activeBefore = remaining.find(tab => tab.active).id;
    await page.locator("#restore").click();
    await expect(page.locator("#status")).toHaveText("1タブを復元しました。");
    await expect(page.locator("#history-count")).toHaveText("0 / 5回分");
    await expect.poll(async () => {
      const tabs = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.windowId);
      return tabs.filter(tab => !remaining.some(existing => existing.id === tab.id)).map(tab => tab.url);
    }).toEqual([origin + "/page" + source]);
    const restored = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.windowId);
    const added = restored.filter(tab => !remaining.some(existing => existing.id === tab.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ url: origin + "/page" + source, index: fixture.duplicate.index,
      pinned: fixture.duplicate.pinned, active: false });
    expect(restored.find(tab => tab.active).id).toBe(activeBefore);
    const otherAfter = await worker.evaluate(id => chrome.tabs.query({ windowId: id }), fixture.otherId);
    const stable = tabs => tabs.map(({ id, url, index, pinned, active }) => ({ id, url, index, pinned, active }));
    expect(stable(otherAfter)).toEqual(stable(otherBefore));
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("popup-restored.png"), fullPage: true });
  });
}
