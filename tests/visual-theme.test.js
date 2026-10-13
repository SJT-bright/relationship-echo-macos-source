import assert from "node:assert/strict";
import test from "node:test";

import {
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyVisualTheme,
  initVisualTheme,
  preloadAppearanceAssets,
  resolveThemeMode,
} from "../src/visual-theme.js";

function createFakeDocument() {
  const listeners = new Map();
  const label = { textContent: "" };
  const symbol = { textContent: "" };
  const button = {
    dataset: {},
    attributes: new Map(),
    title: "",
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    querySelector(selector) {
      if (selector === "[data-theme-label]") return label;
      if (selector === "[data-theme-symbol]") return symbol;
      return null;
    },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    click() { listeners.get("click")?.(); },
  };
  const preloadLinks = [];
  const head = {
    querySelector(selector) {
      const href = /href="([^"]+)"/.exec(selector)?.[1];
      return preloadLinks.find((link) => link.rel === "preload" && link.href === href) || null;
    },
    append(link) { preloadLinks.push(link); },
  };
  const documentRoot = {
    documentElement: { dataset: {} },
    head,
    createElement(tagName) { return { tagName: tagName.toUpperCase() }; },
    querySelector(selector) { return selector === "#theme-toggle" ? button : null; },
  };
  return { documentRoot, button, label, symbol, listeners, preloadLinks };
}

function createMediaQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, callback) { if (type === "change") listeners.add(callback); },
    removeEventListener(type, callback) { if (type === "change") listeners.delete(callback); },
    setMatches(value) {
      this.matches = value;
      for (const callback of listeners) callback({ matches: value });
    },
    listenerCount() { return listeners.size; },
  };
}

test("主题解析严格覆盖 system/light/dark，解析层非法值退回跟随系统", () => {
  assert.deepEqual(THEME_MODES, ["system", "light", "dark"]);
  assert.equal(resolveThemeMode("system", false), "light");
  assert.equal(resolveThemeMode("system", true), "dark");
  assert.equal(resolveThemeMode("light", true), "light");
  assert.equal(resolveThemeMode("dark", false), "dark");
  assert.equal(resolveThemeMode("unknown", true), "dark");

  const { documentRoot } = createFakeDocument();
  assert.deepEqual(applyVisualTheme(documentRoot, "unknown", false), { preference: "system", resolved: "light" });
  assert.equal(documentRoot.documentElement.dataset.themePreference, "system");
  assert.equal(documentRoot.documentElement.dataset.theme, "light");
});

test("外观按钮按 system → light → dark → system 循环，并只在 system 时响应系统变化", () => {
  const fixture = createFakeDocument();
  const mediaQuery = createMediaQuery(true);
  const writes = [];
  const storage = {
    getItem(key) { assert.equal(key, THEME_STORAGE_KEY); return "system"; },
    setItem(key, value) { assert.equal(key, THEME_STORAGE_KEY); writes.push(value); },
  };
  const controller = initVisualTheme({ documentRoot: fixture.documentRoot, storage, mediaQuery });

  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "dark");
  assert.equal(fixture.button.dataset.themeMode, "system");
  assert.equal(fixture.label.textContent, "自动");
  assert.equal(fixture.preloadLinks.length, 2);

  fixture.button.click();
  assert.equal(fixture.button.dataset.themeMode, "light");
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "light");
  mediaQuery.setMatches(false);
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "light", "显式浅色不能被系统变化覆盖");

  fixture.button.click();
  assert.equal(fixture.button.dataset.themeMode, "dark");
  fixture.button.click();
  assert.equal(fixture.button.dataset.themeMode, "system");
  mediaQuery.setMatches(true);
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "dark");
  assert.deepEqual(writes, ["light", "dark", "system"]);

  controller.destroy();
  assert.equal(mediaQuery.listenerCount(), 0);
  assert.equal(fixture.listeners.has("click"), false);
});

test("没有已存偏好时默认浅色，同时保留显式 system 与 dark 选项", () => {
  const fixture = createFakeDocument();
  const mediaQuery = createMediaQuery(true);
  const writes = [];
  const storage = {
    getItem(key) { assert.equal(key, THEME_STORAGE_KEY); return null; },
    setItem(key, value) { assert.equal(key, THEME_STORAGE_KEY); writes.push(value); },
  };
  initVisualTheme({ documentRoot: fixture.documentRoot, storage, mediaQuery });

  assert.equal(fixture.button.dataset.themeMode, "light");
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "light", "深色系统也不能覆盖产品默认浅色");
  fixture.button.click();
  assert.equal(fixture.button.dataset.themeMode, "dark");
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "dark");
  fixture.button.click();
  assert.equal(fixture.button.dataset.themeMode, "system");
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "dark");
  assert.deepEqual(writes, ["dark", "system"]);
});

test("外观存储读取或写入失败不会影响初始化、按钮切换和资源去重", () => {
  const fixture = createFakeDocument();
  const storage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("quota exceeded"); },
  };
  assert.doesNotThrow(() => initVisualTheme({
    documentRoot: fixture.documentRoot,
    storage,
    mediaQuery: createMediaQuery(false),
  }));
  assert.equal(fixture.button.dataset.themeMode, "light");
  assert.equal(fixture.documentRoot.documentElement.dataset.theme, "light");
  assert.doesNotThrow(() => fixture.button.click());
  assert.equal(fixture.button.dataset.themeMode, "dark");

  preloadAppearanceAssets(fixture.documentRoot);
  assert.equal(fixture.preloadLinks.length, 2, "重复预加载不得创建重复 link");
});
