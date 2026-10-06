import assert from "node:assert/strict";
import test from "node:test";
import { deduplicate, getState, planDedup, tabUrl, urlKey } from "../extension/core.js";

function tab(id, url, options = {}) {
  return { id, url, index: id - 1, windowId: 1, pinned: false, active: false, ...options };
}

function fakeApi(initial) {
  const tabs = structuredClone(initial);
  const removed = [];
  return {
    removed,
    tabs: {
      async query({ windowId }) { return structuredClone(tabs.filter(item => item.windowId === windowId)); },
      async get(id) {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error("No tab");
        return structuredClone(found);
      },
      async remove(id) {
        removed.push(id);
        tabs.splice(tabs.findIndex(item => item.id === id), 1);
      },
    },
  };
}

test("クエリ込みはパラメータが違うタブを残し、完全に同じURLだけをまとめる", () => {
  const tabs = [tab(1, "https://example.com/?id=1"), tab(2, "https://example.com/?id=2"),
    tab(3, "https://example.com/?id=1")];
  assert.deepEqual(planDedup(tabs, "include-query").map(item => item.tab.id), [3]);
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
  assert.deepEqual(await getState(api, 1), { total: 2, counts: { "include-query": 1, "ignore-query": 1 } });
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
});
