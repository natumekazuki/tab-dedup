export const MODES = ["include-query", "ignore-query"];

export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

export function urlKey(value, mode) {
  if (!MODES.includes(mode)) throw new Error("URLの判定方式が不正です。");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (mode === "ignore-query") url.search = "";
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
  return {
    total: tabs.length,
    counts: Object.fromEntries(MODES.map(mode => [mode, planDedup(tabs, mode).length])),
  };
}

export async function deduplicate(api, windowId, mode) {
  const tabs = await api.tabs.query({ windowId });
  const plan = planDedup(tabs, mode);
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
    } catch {
      failed++;
    }
  }
  return { removed, skipped, failed };
}
