import { deduplicate, getState, MODES } from "./core.js";

let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  const task = async () => {
    if (!Number.isInteger(message.windowId) || message.windowId < 0) {
      throw new Error("対象のウィンドウを確認できません。");
    }
    const window = await chrome.windows.get(message.windowId);
    if (window.incognito || window.type !== "normal") {
      throw new Error("通常のChromeウィンドウで実行してください。");
    }
    if (message.type === "state") return getState(chrome, window.id);
    if (message.type === "dedup" && MODES.includes(message.mode)) {
      return deduplicate(chrome, window.id, message.mode);
    }
    throw new Error("この操作には対応していません。");
  };
  const result = queue.then(task);
  queue = result.catch(() => {});
  result.then(data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message }));
  return true;
});
