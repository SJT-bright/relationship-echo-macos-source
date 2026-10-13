import { BUNDLED_APPEARANCE_ASSETS } from "./background-prompt.js";

export const THEME_STORAGE_KEY = "relationship-care-appearance-v1";
export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

export const TEXT_SCALE_STORAGE_KEY = "relationship-care-text-scale-v1";
export const TEXT_SCALES = Object.freeze(["comfortable", "large", "extra-large"]);
const TEXT_SCALE_LABELS = Object.freeze({
  comfortable: "标准",
  large: "大",
  "extra-large": "特大",
});

function normalizeThemeMode(mode) {
  return THEME_MODES.includes(mode) ? mode : "system";
}

export function resolveThemeMode(mode, prefersDark = false) {
  const safeMode = normalizeThemeMode(mode);
  return safeMode === "system" ? (prefersDark ? "dark" : "light") : safeMode;
}

export function applyVisualTheme(documentRoot, mode, prefersDark = false) {
  const safeMode = normalizeThemeMode(mode);
  const resolvedMode = resolveThemeMode(safeMode, prefersDark);
  documentRoot.documentElement.dataset.themePreference = safeMode;
  documentRoot.documentElement.dataset.theme = resolvedMode;
  return { preference: safeMode, resolved: resolvedMode };
}

function readStoredMode(storage) {
  try {
    const storedMode = storage?.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.includes(storedMode) ? storedMode : "light";
  } catch {
    return "light";
  }
}

function storeMode(storage, mode) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalizeThemeMode(mode));
  } catch {
    // Appearance preference is optional; the SQLite relationship state is unaffected.
  }
}

function updateToggle(button, preference, resolved) {
  if (!button) return;
  const labels = {
    system: `外观：跟随系统（当前${resolved === "dark" ? "深色" : "浅色"}）`,
    light: "外观：浅色",
    dark: "外观：深色",
  };
  button.dataset.themeMode = preference;
  button.setAttribute("aria-label", `${labels[preference]}。点击切换。`);
  button.title = `${labels[preference]} · 点击切换`;
  const visibleLabel = button.querySelector("[data-theme-label]");
  if (visibleLabel) visibleLabel.textContent = preference === "system" ? "自动" : preference === "dark" ? "深色" : "浅色";
  const symbol = button.querySelector("[data-theme-symbol]");
  if (symbol) symbol.textContent = preference === "system" ? "◐" : preference === "dark" ? "☾" : "☀";
}

export function preloadAppearanceAssets(documentRoot) {
  const head = documentRoot?.head;
  if (!head) return;
  [BUNDLED_APPEARANCE_ASSETS.lightWide, BUNDLED_APPEARANCE_ASSETS.darkWide].forEach((href) => {
    if (head.querySelector(`link[rel="preload"][href="${href}"]`)) return;
    const link = documentRoot.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = href;
    link.type = "image/webp";
    head.append(link);
  });
}

export function normalizeTextScale(scale) {
  return TEXT_SCALES.includes(scale) ? scale : "comfortable";
}

export function applyTextScale(documentRoot, scale) {
  const safeScale = normalizeTextScale(scale);
  documentRoot.documentElement.dataset.textScale = safeScale;
  return safeScale;
}

function textScaleLabel(scale) {
  return TEXT_SCALE_LABELS[normalizeTextScale(scale)];
}

function updateTextScaleControls(documentRoot, scale) {
  const toggle = documentRoot.querySelector("#text-scale-toggle");
  if (toggle) {
    const label = `${textScaleLabel(scale)}`;
    const visibleLabel = toggle.querySelector("[data-theme-label]");
    if (visibleLabel) visibleLabel.textContent = label;
    const nextScale = TEXT_SCALES[(TEXT_SCALES.indexOf(scale) + 1) % TEXT_SCALES.length];
    toggle.setAttribute("aria-label", `阅读字号：${label}。点击调到“${textScaleLabel(nextScale)}”。`);
    toggle.title = `阅读字号：${label} · 点击切换`;
  }
  documentRoot.querySelectorAll("[data-text-scale-option]").forEach((option) => {
    const selected = option.dataset.textScaleOption === scale;
    option.setAttribute("aria-pressed", String(selected));
    option.classList.toggle("is-selected", selected);
  });
}

export function initTextScale({
  documentRoot = document,
  storage = globalThis.localStorage,
} = {}) {
  let scale = normalizeTextScale((() => {
    try {
      return storage?.getItem(TEXT_SCALE_STORAGE_KEY);
    } catch {
      return null;
    }
  })());

  const render = () => {
    const applied = applyTextScale(documentRoot, scale);
    updateTextScaleControls(documentRoot, applied);
    return applied;
  };

  const store = (value) => {
    try {
      storage?.setItem(TEXT_SCALE_STORAGE_KEY, value);
    } catch {
      // Appearance preference is optional; the SQLite relationship state is unaffected.
    }
  };

  const setScale = (value) => {
    const next = normalizeTextScale(value);
    const changed = next !== scale;
    scale = next;
    render();
    if (changed) store(next);
    return scale;
  };

  const cycle = () => {
    const nextIndex = (TEXT_SCALES.indexOf(scale) + 1) % TEXT_SCALES.length;
    return setScale(TEXT_SCALES[nextIndex]);
  };

  const toggle = documentRoot.querySelector("#text-scale-toggle");
  const handleToggle = () => cycle();
  toggle?.addEventListener("click", handleToggle);

  const optionEntries = [...documentRoot.querySelectorAll("[data-text-scale-option]")].map((option) => {
    const handleOption = () => setScale(option.dataset.textScaleOption);
    option.addEventListener("click", handleOption);
    return [option, handleOption];
  });

  render();

  return {
    get scale() {
      return scale;
    },
    setScale,
    destroy() {
      toggle?.removeEventListener("click", handleToggle);
      optionEntries.forEach(([option, handleOption]) => option.removeEventListener("click", handleOption));
    },
  };
}

export function initVisualTheme({
  documentRoot = document,
  storage = globalThis.localStorage,
  mediaQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)"),
} = {}) {
  let preference = readStoredMode(storage);
  const button = documentRoot.querySelector("#theme-toggle");

  const render = () => {
    const result = applyVisualTheme(documentRoot, preference, Boolean(mediaQuery?.matches));
    updateToggle(button, result.preference, result.resolved);
    return result;
  };

  const handleSystemChange = () => {
    if (preference === "system") render();
  };
  mediaQuery?.addEventListener?.("change", handleSystemChange);

  const handleToggle = () => {
    const currentIndex = THEME_MODES.indexOf(preference);
    preference = THEME_MODES[(currentIndex + 1) % THEME_MODES.length];
    storeMode(storage, preference);
    render();
  };
  button?.addEventListener("click", handleToggle);
  preloadAppearanceAssets(documentRoot);
  const initial = render();

  return {
    ...initial,
    destroy() {
      button?.removeEventListener("click", handleToggle);
      mediaQuery?.removeEventListener?.("change", handleSystemChange);
    },
  };
}
