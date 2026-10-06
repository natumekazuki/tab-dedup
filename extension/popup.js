let windowId;
let busy = true;
let state;
const buttons = [...document.querySelectorAll("button[data-mode]")];
const status = document.querySelector("#status");

async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, windowId, ...extra });
  if (!result?.ok) throw new Error(result?.error || "拡張機能から応答を受け取れませんでした。");
  return result.data;
}

function showStatus(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
  status.hidden = false;
}

function render() {
  document.querySelector("main").setAttribute("aria-busy", String(busy));
  for (const button of buttons) button.disabled = busy || !state?.counts[button.dataset.mode];
  if (!state) return;
  document.querySelector("#window-info").textContent = `このウィンドウ · ${state.total}タブ`;
  document.querySelector("#include-count").textContent = `${state.counts["include-query"]}件`;
  document.querySelector("#ignore-count").textContent = `${state.counts["ignore-query"]}件`;
}

async function refresh() {
  state = await request("state");
  render();
}

for (const button of buttons) {
  button.addEventListener("click", async () => {
    busy = true;
    render();
    showStatus("重複タブを削除中…");
    try {
      const result = await request("dedup", { mode: button.dataset.mode });
      const parts = [`${result.removed}タブを削除しました。`];
      if (result.skipped) parts.push(`状態が変わった${result.skipped}タブは削除していません。`);
      if (result.failed) parts.push(`${result.failed}タブの削除に失敗しました。`);
      showStatus(parts.join(" "), result.failed > 0);
      await refresh();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      busy = false;
      render();
    }
  });
}

try {
  const window = await chrome.windows.getCurrent();
  windowId = window.id;
  await refresh();
} catch (error) {
  document.querySelector("#window-info").textContent = "このウィンドウを取得できませんでした";
  showStatus(error.message, true);
} finally {
  busy = false;
  render();
}
