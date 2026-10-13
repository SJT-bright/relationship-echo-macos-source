import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_APPEARANCE_ASSETS,
  BUNDLED_BACKGROUND_PROMPTS,
  BUNDLED_CONTACT_VISUAL_PROMPTS,
  buildBackgroundPrompt,
  buildContactVisualPrompt,
} from "../src/background-prompt.js";

const COLOR_MODES = ["light", "dark"];
const FORMATS = ["wide", "portrait"];
const ACCENTS = ["celadon-cobalt", "emerald-cobalt", "mist-blue"];
const TEXTURES = ["mineral-glass", "frosted-acrylic", "soft-paper"];

test("背景提示词只接受闭集视觉枚举，完整组合稳定且不生成界面文字", () => {
  const prompts = [];
  for (const colorMode of COLOR_MODES) {
    for (const format of FORMATS) {
      for (const accent of ACCENTS) {
        for (const texture of TEXTURES) {
          const prompt = buildBackgroundPrompt({ colorMode, format, accent, texture });
          prompts.push(prompt);
          assert.match(prompt, /no text, no letters, no numerals, no icons, no people, no faces/i);
          assert.match(prompt, /real semantic HTML controls remain legible/i);
          assert.match(prompt, /no UI screenshots/i, "最终提示词必须明确禁止生成烘焙式 UI 截图");
        }
      }
    }
  }
  assert.equal(prompts.length, 36);
  assert.equal(new Set(prompts).size, 36, "每个闭集组合都应形成可复现且可区分的提示词");
});

test("自由文本、联系人隐私和 Token 不能进入生图提示词", () => {
  const secrets = [
    "林小满",
    "wxid-private-contact",
    "上次消息：明晚见",
    "Bearer super-secret-token",
  ];
  const prompt = buildBackgroundPrompt({
    colorMode: secrets[0],
    format: secrets[1],
    accent: secrets[2],
    texture: secrets[3],
    contactName: secrets[0],
    messageText: secrets[2],
    token: secrets[3],
    freeText: secrets.join(" | "),
  });

  assert.equal(prompt, buildBackgroundPrompt(), "未知枚举和额外自由字段必须退回完全相同的安全默认提示词");
  for (const secret of secrets) assert.doesNotMatch(prompt, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("打包提示词和外观资产形成 light/dark × wide/portrait 完整矩阵", () => {
  assert.deepEqual(Object.keys(BUNDLED_BACKGROUND_PROMPTS).sort(), [
    "darkPortrait",
    "darkWide",
    "lightPortrait",
    "lightWide",
  ]);
  for (const key of Object.keys(BUNDLED_BACKGROUND_PROMPTS)) {
    assert.equal(typeof BUNDLED_BACKGROUND_PROMPTS[key], "string");
    assert.ok(BUNDLED_BACKGROUND_PROMPTS[key].length > 200);
    assert.match(BUNDLED_APPEARANCE_ASSETS[key], /^\.\/assets\/appearance\/backgrounds\/.*\.webp$/);
  }
  assert.match(BUNDLED_APPEARANCE_ASSETS.primaryControl, /control-primary\.webp$/);
  assert.match(BUNDLED_APPEARANCE_ASSETS.neutralControl, /control-neutral\.webp$/);
});

test("联系人视觉只生成五种共享无数据资产，未知和自由字段退回安全默认值", () => {
  assert.deepEqual(Object.keys(BUNDLED_CONTACT_VISUAL_PROMPTS).sort(), [
    "avatarMedallion",
    "brandFlourish",
    "contactCardSurface",
    "contactPrimaryAction",
    "contactSecondaryAction",
  ]);
  const secrets = ["周紫悦", "wxid-private", "明晚见", "D:\\private\\contacts.sqlite", "Bearer secret"];
  const fallback = buildContactVisualPrompt({
    asset: secrets[0],
    contactName: secrets[0],
    wechatId: secrets[1],
    messageText: secrets[2],
    path: secrets[3],
    token: secrets[4],
  });
  assert.equal(fallback, buildContactVisualPrompt());
  for (const prompt of Object.values(BUNDLED_CONTACT_VISUAL_PROMPTS)) {
    assert.match(prompt, /Never include contact names, message text, WeChat identifiers, filesystem paths, access tokens, database content/i);
    assert.match(prompt, /real semantic HTML/i);
    for (const secret of secrets) assert.doesNotMatch(prompt, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("联系人共享视觉资产均为版本化本地 WebP 路径", () => {
  const expected = {
    contactCardSurface: "contact-card-surface-v2.webp",
    avatarMedallion: "avatar-echo-medallion-v2.webp",
    contactPrimaryAction: "contact-action-primary-v2.webp",
    contactSecondaryAction: "contact-action-secondary-v2.webp",
    brandFlourish: "brand-echo-flourish-v2.webp",
  };
  for (const [key, filename] of Object.entries(expected)) {
    assert.equal(BUNDLED_APPEARANCE_ASSETS[key], `./assets/appearance/contact/${filename}`);
  }
});
