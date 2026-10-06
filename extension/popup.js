let windowId;
let busy = true;
let state;
const buttons = [...document.querySelectorAll("button[data-mode]")];
const restoreButton = document.querySelector("#restore");
const historyInfo = document.querySelector("#history-info");
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
  restoreButton.disabled = busy || !state?.history.length;
  if (!state) {
    if (!busy) {
      document.querySelector("#window-info").textContent = "タブと履歴を取得できませんでした";
      historyInfo.hidden = false;
      historyInfo.textContent = "復元履歴を取得できませんでした";
      document.querySelector("#history-count").textContent = "— / 5回分";
      document.querySelector("#include-count").textContent = "—";
      document.querySelector("#ignore-count").textContent = "—";
    }
    return;
  }
  document.querySelector("#window-info").textContent = `このウィンドウ · ${state.total}タブ`;
  document.querySelector("#include-count").textContent = `${state.counts["include-query"]}件`;
  document.querySelector("#ignore-count").textContent = `${state.counts["ignore-query"]}件`;
  document.querySelector("#history-count").textContent = `${state.history.length} / 5回分`;
  const latest = state.history[0];
  restoreButton.textContent = latest ? `直前の削除を戻す · ${latest.count}タブ` : "直前の削除を戻す";
  historyInfo.hidden = !latest;
  historyInfo.textContent = latest
    ? `${new Date(latest.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} · ${latest.mode === "include-query" ? "クエリ込み" : "クエリ無視"}の削除`
    : "";
}

async function refresh() {
  state = await request("state");
  render();
}

async function runOperation(type, extra = {}) {
  if (busy) return;
  busy = true;
  render();
  showStatus(type === "restore" ? "削除したタブを復元中…" : "重複タブを削除中…");
  try {
    const result = await request(type, extra);
    const restoring = type === "restore";
    const parts = [restoring ? `${result.restored}タブを復元しました。` : `${result.removed}タブを削除しました。`];
    if (result.skipped) parts.push(restoring ? `まだ開いている${result.skipped}タブは追加していません。` : `状態が変わった${result.skipped}タブは削除していません。`);
    if (result.failed) parts.push(restoring ? `${result.failed}タブの復元に失敗しました。失敗したタブは履歴に残っています。` : `${result.failed}タブの削除に失敗しました。`);
    if (result.storageError) parts.push(result.storageError);
    showStatus(parts.join(" "), result.failed > 0 || Boolean(result.storageError));
    try {
      await refresh();
    } catch (error) {
      state = undefined;
      showStatus(`${parts.join(" ")} 件数と履歴を更新できませんでした: ${error.message}`, true);
    }
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => runOperation("dedup", { mode: button.dataset.mode }));
}
restoreButton.addEventListener("click", () => runOperation("restore"));

try {
  const window = await chrome.windows.getCurrent();
  windowId = window.id;
  await refresh();
} catch (error) {
  showStatus(error.message, true);
} finally {
  busy = false;
  render();
}
