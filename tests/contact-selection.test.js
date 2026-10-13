import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BATCH_SELECTION,
  reconcileContactSelection,
  selectCurrentPage,
  summarizeContactSelection,
  toggleContactSelection,
} from "../src/contact-selection.js";

test("空页不会保留选择，摘要为未选中的零状态", () => {
  assert.deepEqual([...reconcileContactSelection(new Set(["outside"]), [])], []);
  assert.deepEqual(summarizeContactSelection(new Set(["outside"]), []), {
    pageIds: [],
    pageCount: 0,
    selectedCount: 0,
    checked: false,
    indeterminate: false,
  });
});

test("页内 ID 去重、忽略非法值，并在第 50 个唯一 ID 处截断", () => {
  const pageIds = ["first", "first", "", null, 7, ...Array.from({ length: 55 }, (_, index) => `id-${index}`)];
  const selected = selectCurrentPage(pageIds);

  assert.equal(MAX_BATCH_SELECTION, 50);
  assert.equal(selected.size, 50);
  assert.equal(selected.has("first"), true);
  assert.equal(selected.has("id-48"), true);
  assert.equal(selected.has("id-49"), false);
  assert.equal(selected.has(""), false);
});

test("翻页协调只保留当前页 ID，页外选择会被裁剪", () => {
  const original = new Set(["page-a", "page-b", "outside"]);
  const reconciled = reconcileContactSelection(original, ["page-b", "page-c"]);

  assert.deepEqual([...reconciled], ["page-b"]);
  assert.deepEqual([...original], ["page-a", "page-b", "outside"], "不得原地修改调用方 Set");
});

test("单选可以勾选和取消，页外 ID 不会被加入", () => {
  const original = new Set();
  const checked = toggleContactSelection(original, "a", true, ["a", "b"]);
  const unchecked = toggleContactSelection(checked, "a", false, ["a", "b"]);
  const ignored = toggleContactSelection(unchecked, "outside", true, ["a", "b"]);

  assert.deepEqual([...checked], ["a"]);
  assert.deepEqual([...unchecked], []);
  assert.deepEqual([...ignored], []);
  assert.deepEqual([...original], [], "单选操作不得原地修改输入 Set");
});

test("全选当前页与清空返回独立的新 Set", () => {
  const pageIds = ["a", "b"];
  const selected = selectCurrentPage(pageIds, true);
  const cleared = selectCurrentPage(pageIds, false);

  assert.deepEqual([...selected], ["a", "b"]);
  assert.deepEqual([...cleared], []);
  assert.notStrictEqual(selected, cleared);
});

test("选择摘要覆盖未选、部分选择和全选三态", () => {
  const pageIds = ["a", "b", "c"];
  const none = summarizeContactSelection(new Set(), pageIds);
  const partial = summarizeContactSelection(new Set(["b"]), pageIds);
  const all = summarizeContactSelection(new Set(pageIds), pageIds);

  assert.deepEqual([none.checked, none.indeterminate, none.selectedCount], [false, false, 0]);
  assert.deepEqual([partial.checked, partial.indeterminate, partial.selectedCount], [false, true, 1]);
  assert.deepEqual([all.checked, all.indeterminate, all.selectedCount], [true, false, 3]);
});

