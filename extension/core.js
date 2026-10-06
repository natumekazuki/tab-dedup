export const MODES = ["include-query", "ignore-query"];
export const HISTORY_LIMIT = 5;

export function historyKey(windowId) {
  return `history:${windowId}`;
}

async function saveRecord(api, windowId, record) {
  await api.storage.session.set({ [historyKey(windowId)]: record });
}

async function readRecord(api, windowId) {
  const key = historyKey(windowId);
  const data = await api.storage.session.get(key);
  const record = data[key] || { history: [] };
  if (record.pending) {
    const openIds = new Set((await api.tabs.query({})).map(tab => tab.id));
    const tabs = record.pending.tabs.filter(tab => !openIds.has(tab.originalId));
    if (tabs.length) record.history = [{ ...record.pending, tabs }, ...record.history].slice(0, HISTORY_LIMIT);
    delete record.pending;
    await saveRecord(api, windowId, record);
  }
  return record;
}

export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

export function urlKey(value, mode) {
  if (!MODES.includes(mode)) throw new Error("URLの判定方式が不正です。");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (mode === "ignore-query") url.search = "";
    else if (url.search) url.search = url.search.slice(1).split("&").sort().join("&");
    return url.href;
  } catch {
    return null;
  }
}

export function planDedup(tabs, mode) {
  if (!MODES.includes(mode)) throw new Error("URLの判定方式が不正です。");
  const groups = new Map();
  for (const tab of tabs) {
    const key = urlKey(tabUrl(tab), mode);
    if (key === null || !Number.isInteger(tab.id) || tab.id < 0) continue;
    const group = groups.get(key) || [];
    group.push(tab);
    groups.set(key, group);
  }
  const duplicates = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Number(b.active) - Number(a.active)
      || Number(b.pinned) - Number(a.pinned) || a.index - b.index);
    const [keeper, ...rest] = group;
    for (const tab of rest) duplicates.push({ tab, keeperId: keeper.id });
  }
  return duplicates.sort((a, b) => a.tab.index - b.tab.index);
}

export async function getState(api, windowId) {
  const tabs = await api.tabs.query({ windowId });
  const record = await readRecord(api, windowId);
  return {
    total: tabs.length,
    counts: Object.fromEntries(MODES.map(mode => [mode, planDedup(tabs, mode).length])),
    history: record.history.map(snapshot => ({
      createdAt: snapshot.createdAt, mode: snapshot.mode, count: snapshot.tabs.length,
    })),
  };
}

export async function deduplicate(api, windowId, mode) {
  const record = await readRecord(api, windowId);
  const tabs = await api.tabs.query({ windowId });
  const plan = planDedup(tabs, mode);
  const snapshot = {
    createdAt: Date.now(), mode,
    tabs: plan.map(({ tab }) => ({ originalId: tab.id, url: tabUrl(tab), index: tab.index, pinned: tab.pinned })),
  };
  if (plan.length) {
    try {
      await saveRecord(api, windowId, { ...record, pending: snapshot });
    } catch {
      throw new Error("復元用のスナップショットを保存できなかったため、タブは削除していません。");
    }
  }
  const removedIds = new Set();
  let removed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { tab, keeperId } of plan) {
    let current;
    let keeper;
    try {
      [current, keeper] = await Promise.all([api.tabs.get(tab.id), api.tabs.get(keeperId)]);
    } catch {
      skipped++;
      continue;
    }
    if (current.windowId !== windowId || keeper.windowId !== windowId || current.active
      || current.pinned !== tab.pinned || tabUrl(current) !== tabUrl(tab)
      || urlKey(tabUrl(current), mode) !== urlKey(tabUrl(keeper), mode)) {
      skipped++;
      continue;
    }
    try {
      await api.tabs.remove(current.id);
      removed++;
      removedIds.add(current.id);
    } catch {
      failed++;
    }
  }
  if (plan.length) {
    const closed = snapshot.tabs.filter(tab => removedIds.has(tab.originalId));
    if (closed.length) record.history = [{ ...snapshot, tabs: closed }, ...record.history].slice(0, HISTORY_LIMIT);
    try {
      await saveRecord(api, windowId, record);
    } catch {
      return { removed, skipped, failed, storageError: "履歴の確定に失敗しました。保存済みスナップショットは残っています。メニューを開き直して履歴を確認してください。" };
    }
  }
  return { removed, skipped, failed };
}

export async function restoreLatest(api, windowId) {
  const record = await readRecord(api, windowId);
  const snapshot = record.history[0];
  let restored = 0;
  let failed = 0;
  let skipped = 0;
  if (!snapshot) return { restored, failed, skipped };
  const openIds = new Set((await api.tabs.query({})).map(tab => tab.id));
  for (const saved of [...snapshot.tabs].sort((a, b) => a.index - b.index)) {
    if (openIds.has(saved.originalId)) {
      skipped++;
    } else {
      try {
        await api.tabs.create({ windowId, url: saved.url, index: saved.index, pinned: saved.pinned, active: false });
        restored++;
      } catch {
        failed++;
        continue;
      }
    }
    snapshot.tabs = snapshot.tabs.filter(tab => tab.originalId !== saved.originalId);
    if (!snapshot.tabs.length) record.history.shift();
    try {
      await saveRecord(api, windowId, record);
    } catch {
      return { restored, failed, skipped, storageError: "復元履歴の更新に失敗しました。追加済みのタブを確認してから再実行してください。" };
    }
  }
  return { restored, failed, skipped };
}
