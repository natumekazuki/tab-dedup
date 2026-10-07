import assert from "node:assert/strict";
import test from "node:test";
import { deduplicate, getState, historyKey, planDedup, restoreLatest, tabUrl, urlKey } from "../extension/core.js";

function tab(id, url, options = {}) {
  return { id, url, index: id - 1, windowId: 1, pinned: false, active: false, ...options };
}

function fakeApi(initial) {
  const tabs = structuredClone(initial);
  const removed = [];
  const created = [];
  const data = {};
  let nextId = Math.max(0, ...tabs.map(item => item.id)) + 1000;
  return {
    removed,
    created,
    storage: {
      session: {
        async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
        async set(value) { Object.assign(data, structuredClone(value)); },
        async remove(key) { delete data[key]; },
      },
    },
    tabs: {
      async query({ windowId }) { return structuredClone(tabs.filter(item => windowId === undefined || item.windowId === windowId)); },
      async get(id) {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error("No tab");
        return structuredClone(found);
      },
      async remove(id) {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error("No tab");
        removed.push(id);
        tabs.splice(tabs.findIndex(item => item.id === id), 1);
        for (const item of tabs) if (item.windowId === found.windowId && item.index > found.index) item.index--;
      },
      async create(options) {
        const windowTabs = tabs.filter(item => item.windowId === options.windowId);
        const index = Math.min(options.index ?? windowTabs.length, windowTabs.length);
        for (const item of windowTabs) if (item.index >= index) item.index++;
        const result = tab(nextId++, options.url, { ...options, index });
        tabs.push(result);
        created.push(structuredClone(options));
        return structuredClone(result);
      },
    },
  };
}

test("クエリ込みは値が異なるタブを残す", () => {
  const tabs = [tab(1, "https://example.com/?id=1"), tab(2, "https://example.com/?id=2"),
    tab(3, "https://example.com/?id=1")];
  assert.deepEqual(planDedup(tabs, "include-query").map(item => item.tab.id), [3]);
});

test("クエリ込みはパラメータ順を無視し、名前・値・重複数・fragmentは区別する", () => {
  const url = "https://example.com/?b=2&a=1#one";
  const tabs = [tab(1, url), tab(2, "https://example.com/?a=1&b=2#one"),
    tab(3, "https://example.com/?a=1&b=3#one"), tab(4, "https://example.com/?a=1&c=2#one"),
    tab(5, "https://example.com/?a=1&a=1&b=2#one"), tab(6, "https://example.com/?a=1&b=2#two")];
  const original = structuredClone(tabs);
  assert.equal(urlKey(url, "include-query"), "https://example.com/?a=1&b=2#one");
  assert.deepEqual(planDedup(tabs, "include-query").map(item => [item.tab.id, item.keeperId]), [[2, 1]]);
  assert.deepEqual(tabs, original);
});

test("クエリ込みは同名パラメータも順不同にし、値のエンコード表記は維持する", () => {
  const url = "https://example.com/?a=2&a=1&q=x%26y%3Dz&space=hello%20world";
  assert.equal(urlKey(url, "include-query"),
    urlKey("https://example.com/?space=hello%20world&q=x%26y%3Dz&a=1&a=2", "include-query"));
  for (const different of [
    "https://example.com/?a=1&a=1&q=x%26y%3Dz&space=hello%20world",
    "https://example.com/?a=1&q=x%26y%3Dz&space=hello%20world",
    "https://example.com/?a=1&a=2&q=x%26y%3Dz&space=hello+world",
    "https://example.com/?a=1&a=2&q=x&y=z&space=hello%20world",
  ]) {
    assert.notEqual(urlKey(url, "include-query"), urlKey(different, "include-query"));
  }
});

test("並び順だけ違うクエリを削除・復元しても元のURLを保存する", async () => {
  const keeperUrl = "https://example.com/?a=1&b=2";
  const duplicateUrl = "https://example.com/?b=2&a=1";
  const api = fakeApi([tab(1, keeperUrl, { active: true }), tab(2, duplicateUrl)]);
  assert.equal((await getState(api, 1)).counts["include-query"], 1);
  assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(api.removed, [2]);
  const record = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.equal(record.history[0].tabs[0].url, duplicateUrl);
  assert.equal((await api.tabs.get(1)).url, keeperUrl);
  assert.deepEqual(await restoreLatest(api, 1), { restored: 1, failed: 0, skipped: 0 });
  assert.deepEqual(api.created, [{ windowId: 1, url: duplicateUrl, index: 1, pinned: false, active: false }]);
});

test("クエリ無視はsearchだけを除外し、fragment・path・originを区別する", () => {
  const tabs = [tab(1, "https://example.com/a?id=1#one"), tab(2, "https://example.com/a?id=2#one"),
    tab(3, "https://example.com/a?id=1#two"), tab(4, "https://example.com/b?id=1#one"),
    tab(5, "http://example.com/a?id=1#one")];
  assert.deepEqual(planDedup(tabs, "ignore-query").map(item => item.tab.id), [2]);
  assert.equal(urlKey("https://example.com/a?x=1#route?x=2", "ignore-query"),
    "https://example.com/a#route?x=2");
});

test("表示中、固定、左端の順に1タブを残し、入力配列を変更しない", () => {
  const url = "https://example.com/";
  const tabs = [tab(1, url), tab(2, url, { pinned: true }), tab(3, url, { active: true })];
  const original = structuredClone(tabs);
  assert.deepEqual(planDedup(tabs, "include-query").map(item => [item.tab.id, item.keeperId]), [[1, 3], [2, 3]]);
  assert.deepEqual(planDedup(tabs.slice(0, 2), "include-query").map(item => item.keeperId), [2]);
  assert.deepEqual(planDedup([tab(2, url), tab(1, url)], "include-query").map(item => item.keeperId), [1]);
  assert.deepEqual(tabs, original);
});

test("遷移中のURLを優先し、URLがない・不正なタブは削除計画に入れない", () => {
  const loading = tab(2, "https://example.com/", { pendingUrl: "https://example.com/next" });
  assert.equal(tabUrl(loading), "https://example.com/next");
  assert.deepEqual(planDedup([tab(1, "https://example.com/"), loading, tab(3, ""), tab(4, "bad"),
    tab(-1, "https://example.com/")], "include-query"), []);
  assert.throws(() => planDedup([], "unknown"), /不正/);
});

test("削除と件数取得は指定ウィンドウだけを対象にする", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url), tab(3, url, { windowId: 2 })]);
  assert.deepEqual(await getState(api, 1), { total: 2, counts: { "include-query": 1, "ignore-query": 1 }, history: [] });
  assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(api.removed, [2]);
  assert.equal((await api.tabs.get(3)).windowId, 2);
});

test("削除直前にURL・ウィンドウ・固定状態・activeが変わったタブを閉じない", async () => {
  const url = "https://example.com/";
  for (const changed of [{ url: "https://other.example/" }, { windowId: 2 }, { pinned: true }, { active: true }]) {
    const api = fakeApi([tab(1, url), tab(2, url)]);
    const get = api.tabs.get;
    api.tabs.get = async id => ({ ...await get(id), ...(id === 2 ? changed : {}) });
    assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 0, skipped: 1, failed: 0 });
    assert.deepEqual(api.removed, []);
  }
});

test("残すタブが消失・遷移・移動した場合は最後のタブを閉じない", async () => {
  const url = "https://example.com/";
  for (const changed of [null, { url: "https://other.example/" }, { windowId: 2 }]) {
    const api = fakeApi([tab(1, url), tab(2, url)]);
    const get = api.tabs.get;
    api.tabs.get = async id => {
      if (id === 1 && changed === null) throw new Error("No tab");
      return { ...await get(id), ...(id === 1 ? changed : {}) };
    };
    assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 0, skipped: 1, failed: 0 });
    assert.deepEqual(api.removed, []);
  }
});

test("削除APIの失敗を成功件数へ含めず、後続タブは処理する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url), tab(3, url)]);
  const remove = api.tabs.remove;
  api.tabs.remove = async id => { if (id === 2) throw new Error("Cannot edit"); await remove(id); };
  assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 1, skipped: 0, failed: 1 });
  assert.deepEqual(api.removed, [3]);
  const record = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.deepEqual(record.history[0].tabs.map(item => item.originalId), [3]);
});

test("削除前のクエリ付きURL・位置・固定状態を保存し、既存タブを閉じず復元する", async () => {
  const url = "https://example.com/?id=1";
  const api = fakeApi([tab(1, url, { index: 1, active: true }), tab(2, url, { index: 0, pinned: true }),
    tab(3, "https://example.com/?id=2", { index: 2 }), tab(4, "https://other.example/", { index: 3 })]);
  assert.deepEqual(await deduplicate(api, 1, "ignore-query"), { removed: 2, skipped: 0, failed: 0 });
  const record = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.deepEqual(record.history[0].tabs, [
    { originalId: 2, url, index: 0, pinned: true },
    { originalId: 3, url: "https://example.com/?id=2", index: 2, pinned: false },
  ]);
  await api.tabs.create({ windowId: 1, url: "https://new.example/", active: false });
  assert.deepEqual(await restoreLatest(api, 1), { restored: 2, failed: 0, skipped: 0 });
  assert.deepEqual(api.created.slice(-2), [
    { windowId: 1, url, index: 0, pinned: true, active: false },
    { windowId: 1, url: "https://example.com/?id=2", index: 2, pinned: false, active: false },
  ]);
  assert.equal((await api.tabs.get(1)).active, true);
  assert.equal((await api.tabs.query({ windowId: 1 })).some(item => item.url === "https://new.example/"), true);
  assert.deepEqual(api.removed, [2, 3]);
  assert.equal((await getState(api, 1)).history.length, 0);
  assert.deepEqual(await restoreLatest(api, 1), { restored: 0, failed: 0, skipped: 0 });
  assert.equal(api.created.length, 3);
});

test("6回の削除は最新5回だけを残し、0件の操作で履歴を消費しない", async () => {
  const api = fakeApi(Array.from({ length: 6 }, (_, i) => tab(i + 1, `https://example.com/run${i + 1}`)));
  for (let i = 1; i <= 6; i++) {
    await api.tabs.create({ windowId: 1, url: `https://example.com/run${i}`, active: false });
    assert.equal((await deduplicate(api, 1, "include-query")).removed, 1);
  }
  const before = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.deepEqual(before.history.map(item => item.tabs[0].url), [6, 5, 4, 3, 2].map(i => `https://example.com/run${i}`));
  assert.equal((await getState(api, 1)).history.length, 5);
  assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 0, failed: 0, skipped: 0 });
  assert.deepEqual((await api.storage.session.get(historyKey(1)))[historyKey(1)], before);
});

test("復元は1回分ずつ新しい削除から処理する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url)]);
  await deduplicate(api, 1, "include-query");
  await api.tabs.create({ windowId: 1, url, active: false });
  await deduplicate(api, 1, "include-query");
  assert.equal((await getState(api, 1)).history.length, 2);
  assert.equal((await restoreLatest(api, 1)).restored, 1);
  assert.equal((await getState(api, 1)).history.length, 1);
  assert.equal((await api.tabs.query({ windowId: 1 })).length, 2);
  assert.equal((await restoreLatest(api, 1)).restored, 1);
  assert.equal((await getState(api, 1)).history.length, 0);
  assert.equal((await api.tabs.query({ windowId: 1 })).length, 3);
});

test("削除履歴と復元先はウィンドウごとに独立する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url), tab(3, url, { windowId: 2, index: 0 }),
    tab(4, url, { windowId: 2, index: 1 })]);
  await deduplicate(api, 1, "include-query");
  assert.equal((await getState(api, 2)).history.length, 0);
  await deduplicate(api, 2, "include-query");
  await restoreLatest(api, 1);
  assert.equal((await getState(api, 1)).history.length, 0);
  assert.equal((await getState(api, 2)).history.length, 1);
  assert.equal((await api.tabs.query({ windowId: 2 })).length, 1);
  assert.equal(api.created[0].windowId, 1);
});

test("スナップショット保存が失敗したらタブを1つも閉じない", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url)]);
  api.storage.session.set = async () => { throw new Error("Quota"); };
  await assert.rejects(deduplicate(api, 1, "include-query"), /タブは削除していません/);
  assert.deepEqual(api.removed, []);
  assert.equal((await api.tabs.query({ windowId: 1 })).length, 2);
});

test("全タブの削除が失敗した場合は既存の復元履歴を保持する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url)]);
  await deduplicate(api, 1, "include-query");
  const before = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  await api.tabs.create({ windowId: 1, url, active: false });
  api.tabs.remove = async () => { throw new Error("Cannot edit"); };
  assert.deepEqual(await deduplicate(api, 1, "include-query"), { removed: 0, failed: 1, skipped: 0 });
  assert.deepEqual((await api.storage.session.get(historyKey(1)))[historyKey(1)], before);
});

test("削除0件の履歴確定と再保存が失敗しても、後日の手動閉鎖で5回分の履歴を消費しない", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url)]);
  const before = { history: Array.from({ length: 5 }, (_, i) => ({
    createdAt: 5 - i, mode: "include-query",
    tabs: [{ originalId: 100 + i, url: `https://example.com/old${i}`, index: 1, pinned: false }],
  })) };
  await api.storage.session.set({ [historyKey(1)]: before });
  const set = api.storage.session.set;
  let writes = 0;
  api.storage.session.set = async value => {
    if ([2, 3].includes(++writes)) throw new Error("Write failed");
    await set(value);
  };
  const remove = api.tabs.remove;
  api.tabs.remove = async () => { throw new Error("Cannot edit"); };
  const result = await deduplicate(api, 1, "include-query");
  assert.deepEqual({ removed: result.removed, failed: result.failed, skipped: result.skipped },
    { removed: 0, failed: 1, skipped: 0 });
  assert.ok(result.storageError);
  await remove(2);
  await assert.rejects(getState(api, 1), /Write failed/);
  assert.equal((await getState(api, 1)).history.length, 5);
  assert.deepEqual((await api.storage.session.get(historyKey(1)))[historyKey(1)], before);
});

test("履歴確定に失敗した部分削除は捨て、手動閉鎖後も既存5回分だけを復元する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url, { active: true }), tab(2, url), tab(3, url)]);
  const before = { history: Array.from({ length: 5 }, (_, i) => ({
    createdAt: 5 - i, mode: "include-query",
    tabs: [{ originalId: 100 + i, url: `https://example.com/old${i}`, index: 1, pinned: false }],
  })) };
  await api.storage.session.set({ [historyKey(1)]: before });
  const set = api.storage.session.set;
  let writes = 0;
  api.storage.session.set = async value => { if (++writes === 2) throw new Error("Write failed"); await set(value); };
  const remove = api.tabs.remove;
  api.tabs.remove = async id => { if (id === 2) throw new Error("Cannot edit"); await remove(id); };
  const result = await deduplicate(api, 1, "include-query");
  assert.deepEqual({ removed: result.removed, failed: result.failed, skipped: result.skipped },
    { removed: 1, failed: 1, skipped: 0 });
  assert.ok(result.storageError);
  await remove(2);
  assert.equal((await getState(api, 1)).history.length, 5);
  const record = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.deepEqual(record, before);
  assert.deepEqual(await restoreLatest(api, 1), { restored: 1, failed: 0, skipped: 0 });
  assert.deepEqual(api.created, [{ windowId: 1, url: "https://example.com/old0", index: 1, pinned: false, active: false }]);
});

test("一部の復元が失敗しても成功済みタブは再追加せず、失敗分だけ再試行する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url), tab(3, url)]);
  await deduplicate(api, 1, "include-query");
  const create = api.tabs.create;
  api.tabs.create = async options => { if (options.index === 1) throw new Error("Cannot create"); return create(options); };
  assert.deepEqual(await restoreLatest(api, 1), { restored: 1, failed: 1, skipped: 0 });
  assert.equal((await getState(api, 1)).history[0].count, 1);
  api.tabs.create = create;
  assert.deepEqual(await restoreLatest(api, 1), { restored: 1, failed: 0, skipped: 0 });
  assert.equal(api.created.length, 2);
  assert.equal((await getState(api, 1)).history.length, 0);
});

test("削除後の履歴確定に失敗した操作は復元対象に含めない", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url)]);
  const set = api.storage.session.set;
  let writes = 0;
  api.storage.session.set = async value => { if (++writes === 2) throw new Error("Write failed"); await set(value); };
  const result = await deduplicate(api, 1, "include-query");
  assert.equal(result.removed, 1);
  assert.equal(result.storageError, "削除履歴の保存に失敗しました。");
  assert.deepEqual((await getState(api, 1)).history, []);
  const record = (await api.storage.session.get(historyKey(1)))[historyKey(1)];
  assert.deepEqual(record, { history: [] });
  assert.deepEqual(await restoreLatest(api, 1), { restored: 0, failed: 0, skipped: 0 });
  assert.deepEqual(api.created, []);
  assert.equal((await api.tabs.query({ windowId: 1 })).length, 1);
});

test("保存済みの未確定スナップショットはタブの有無や移動先によらず破棄する", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url, { windowId: 2 })]);
  await api.storage.session.set({ [historyKey(1)]: {
    history: [], pending: { createdAt: 1, mode: "include-query", tabs: [
      { originalId: 1, url, index: 0, pinned: false },
      { originalId: 2, url, index: 1, pinned: false },
      { originalId: 3, url, index: 2, pinned: false },
    ] },
  } });
  assert.deepEqual((await getState(api, 1)).history, []);
  assert.deepEqual((await api.storage.session.get(historyKey(1)))[historyKey(1)], { history: [] });
  assert.deepEqual(await restoreLatest(api, 1), { restored: 0, failed: 0, skipped: 0 });
  assert.deepEqual(api.created, []);
  assert.equal((await api.tabs.get(1)).windowId, 1);
  assert.equal((await api.tabs.get(2)).windowId, 2);
});

test("復元後の保存が失敗したら追加済み件数と警告を返し、残りのタブは追加しない", async () => {
  const url = "https://example.com/";
  const api = fakeApi([tab(1, url), tab(2, url), tab(3, url)]);
  await deduplicate(api, 1, "include-query");
  api.storage.session.set = async () => { throw new Error("Write failed"); };
  const result = await restoreLatest(api, 1);
  assert.equal(result.restored, 1);
  assert.match(result.storageError, /追加済みのタブを確認/);
  assert.equal(api.created.length, 1);
});
