import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contactAssetDirectory = join(projectRoot, "assets", "appearance", "contact");

const CONTACT_ASSETS = Object.freeze([
  { manifestKey: "contactCardSurface", filename: "contact-card-surface-v2.webp", alphaExpected: false },
  { manifestKey: "avatarMedallion", filename: "avatar-echo-medallion-v2.webp", alphaExpected: true },
  { manifestKey: "contactPrimaryAction", filename: "contact-action-primary-v2.webp", alphaExpected: true },
  { manifestKey: "contactSecondaryAction", filename: "contact-action-secondary-v2.webp", alphaExpected: true },
  { manifestKey: "brandFlourish", filename: "brand-echo-flourish-v2.webp", alphaExpected: true },
]);

function declarationsForSelector(css, targetSelector) {
  const declarations = new Map();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of source.matchAll(rulePattern)) {
    const selectors = match[1].split(",").map((selector) => selector.trim());
    if (!selectors.includes(targetSelector)) continue;

    for (const declaration of match[2].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator === -1) continue;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      if (property) declarations.set(property, value);
    }
  }

  return declarations;
}

function bodiesForAtRule(css, atRule) {
  const bodies = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const atRuleStart = source.indexOf(atRule, searchFrom);
    if (atRuleStart === -1) break;
    const bodyStart = source.indexOf("{", atRuleStart + atRule.length);
    assert.notEqual(bodyStart, -1, `${atRule} 必须包含规则体`);

    let depth = 1;
    let cursor = bodyStart + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    assert.equal(depth, 0, `${atRule} 的花括号必须闭合`);
    bodies.push(source.slice(bodyStart + 1, cursor - 1));
    searchFrom = cursor;
  }

  return bodies;
}

function uint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inspectWebp(buffer) {
  let width;
  let height;
  let alpha = false;
  let imageChunk;

  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    assert.ok(dataEnd <= buffer.length, `${chunkType} chunk 不能越过文件末尾`);

    if (chunkType === "VP8X") {
      assert.ok(chunkSize >= 10, "VP8X chunk 至少需要 10 字节头部");
      imageChunk = chunkType;
      alpha = Boolean(buffer[dataOffset] & 0x10);
      width = uint24LE(buffer, dataOffset + 4) + 1;
      height = uint24LE(buffer, dataOffset + 7) + 1;
    } else if (chunkType === "VP8 " && width === undefined) {
      assert.ok(chunkSize >= 10, "VP8 chunk 太短，无法读取帧尺寸");
      assert.equal(buffer.subarray(dataOffset + 3, dataOffset + 6).toString("hex"), "9d012a");
      imageChunk = chunkType;
      width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
      height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
    } else if (chunkType === "VP8L" && width === undefined) {
      assert.ok(chunkSize >= 5, "VP8L chunk 太短，无法读取帧尺寸");
      assert.equal(buffer[dataOffset], 0x2f, "VP8L 签名字节不正确");
      const dimensions = buffer.readUInt32LE(dataOffset + 1);
      imageChunk = chunkType;
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
      alpha = Boolean((dimensions >>> 28) & 1);
    } else if (chunkType === "ALPH") {
      alpha = true;
    }

    offset = dataEnd + (chunkSize % 2);
  }

  assert.ok(imageChunk, "WebP 必须包含 VP8X、VP8 或 VP8L 图像 chunk");
  assert.ok(Number.isInteger(width) && width > 0, "WebP 宽度必须可解析");
  assert.ok(Number.isInteger(height) && height > 0, "WebP 高度必须可解析");
  return { width, height, alpha, imageChunk };
}

test("队列联系人姓名按钮在图片主题中保留真实 44px 逻辑命中盒", async () => {
  const [css, app] = await Promise.all([
    readFile(join(projectRoot, "styles.css"), "utf8"),
    readFile(join(projectRoot, "src", "app.js"), "utf8"),
  ]);
  const declarations = declarationsForSelector(css, ".image-theme .queue-name");

  assert.equal(declarations.get("display"), "inline-flex", "命中尺寸必须落在真实元素盒，而非伪元素");
  assert.equal(declarations.get("min-inline-size"), "44px", "按钮行内方向至少应有 44px");
  assert.equal(declarations.get("min-block-size"), "44px", "按钮块方向至少应有 44px");
  assert.equal(declarations.get("align-items"), "center");
  assert.match(
    app,
    /const nameButton = element\("button",\s*\{[^}]*className:\s*"queue-name private-name"[^}]*type:\s*"button"/s,
    "queue-name 必须绑定到真实语义 button",
  );
});

test("520px 窄屏圆盘联系人入口的行内命中尺寸不低于 44px", async () => {
  const css = await readFile(join(projectRoot, "styles.css"), "utf8");
  const mobileBodies = bodiesForAtRule(css, "@media (max-width: 520px)");
  assert.ok(mobileBodies.length > 0, "必须存在 max-width: 520px 的移动端规则");

  const mobileDeclarations = new Map();
  for (const body of mobileBodies) {
    for (const [property, value] of declarationsForSelector(body, ".dial-contact")) {
      mobileDeclarations.set(property, value);
    }
  }

  const fixedInlineSizes = ["width", "min-inline-size"]
    .map((property) => mobileDeclarations.get(property))
    .filter(Boolean)
    .map((value) => value.match(/^(\d+(?:\.\d+)?)px$/)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(fixedInlineSizes.length > 0, "移动端 .dial-contact 必须声明固定 width 或 min-inline-size");
  assert.ok(Math.max(...fixedInlineSizes) >= 44, "移动端 .dial-contact 的行内命中尺寸至少应为 44px");
});

test("联系人头像哈希映射固定覆盖八种互不重复的图片主题色", async () => {
  const [css, app] = await Promise.all([
    readFile(join(projectRoot, "styles.css"), "utf8"),
    readFile(join(projectRoot, "src", "app.js"), "utf8"),
  ]);
  const toneFunction = app.match(/function toneForId\(id\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(toneFunction, /return\s+`tone-\$\{\(score\s*%\s*8\)\s*\+\s*1\}`;/);
  assert.match(app, /className:\s*`avatar-token echo-avatar \$\{toneForId\(/);

  const declaredToneNumbers = [...css.matchAll(/\.image-theme \.echo-avatar\.tone-(\d+)\b/g)]
    .map((match) => Number(match[1]));
  assert.deepEqual([...new Set(declaredToneNumbers)].sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8]);

  const fills = new Set();
  for (let tone = 1; tone <= 8; tone += 1) {
    const declarations = declarationsForSelector(css, `.image-theme .echo-avatar.tone-${tone}`);
    const fill = declarations.get("--avatar-fill");
    assert.match(fill || "", /^#[0-9a-f]{6}$/i, `tone-${tone} 必须声明六位十六进制底色`);
    assert.equal(declarations.get("background"), "var(--avatar-fill)");
    fills.add(fill.toLowerCase());
  }
  assert.equal(fills.size, 8, "八个 tone 不能复用同一个底色");
});

test("五个联系人 WebP 的 sidecar、manifest、提示词与真实字节保持一致", async (context) => {
  const manifest = JSON.parse(await readFile(join(projectRoot, "assets", "appearance", "theme-manifest.json"), "utf8"));
  const actualSidecars = (await readdir(contactAssetDirectory))
    .filter((filename) => filename.endsWith(".webp.json"))
    .sort();
  const expectedSidecars = CONTACT_ASSETS.map(({ filename }) => `${filename}.json`).sort();

  assert.deepEqual(actualSidecars, expectedSidecars, "联系人视觉目录必须恰好登记这五个 WebP sidecar");
  assert.equal(manifest.tool, "OpenAI built-in image generation (imagegen)");
  assert.equal(manifest.toolId, "image_gen.imagegen");

  for (const expected of CONTACT_ASSETS) {
    await context.test(expected.filename, async () => {
      const sidecarPath = join(contactAssetDirectory, `${expected.filename}.json`);
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
      const manifestAsset = manifest.assets[expected.manifestKey];

      assert.ok(manifestAsset, `${expected.manifestKey} 必须存在于 manifest.assets`);
      for (const field of ["assetPath", "bytes", "sha256", "width", "height", "alphaExpected", "tool", "toolId", "generationMode", "sourceGenerationId", "prompt"]) {
        assert.ok(Object.hasOwn(sidecar, field), `${basename(sidecarPath)} 缺少 ${field}`);
      }
      for (const field of ["path", "bytes", "sha256", "width", "height", "promptId", "generationMode", "sourceGenerationId"]) {
        assert.ok(Object.hasOwn(manifestAsset, field), `${expected.manifestKey} 缺少 ${field}`);
      }

      const expectedAssetPath = `assets/appearance/contact/${expected.filename}`;
      assert.equal(sidecar.assetPath, expectedAssetPath);
      assert.equal(manifestAsset.path, expectedAssetPath);
      assert.equal(resolve(projectRoot, ...sidecar.assetPath.split("/")), join(contactAssetDirectory, expected.filename));

      const image = await readFile(join(contactAssetDirectory, expected.filename));
      const digest = createHash("sha256").update(image).digest("hex");
      assert.equal(sidecar.bytes, image.byteLength);
      assert.equal(manifestAsset.bytes, image.byteLength);
      assert.match(sidecar.sha256, /^[0-9a-f]{64}$/);
      assert.equal(sidecar.sha256, digest);
      assert.equal(manifestAsset.sha256, digest);

      assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
      assert.equal(image.readUInt32LE(4) + 8, image.byteLength, "RIFF 声明长度必须等于真实文件长度");
      const metadata = inspectWebp(image);
      assert.equal(sidecar.width, metadata.width);
      assert.equal(sidecar.height, metadata.height);
      assert.equal(manifestAsset.width, metadata.width);
      assert.equal(manifestAsset.height, metadata.height);
      assert.equal(sidecar.alphaExpected, expected.alphaExpected);
      assert.equal(metadata.alpha, expected.alphaExpected, "alphaExpected 必须反映 WebP 的真实 alpha 特征");

      assert.equal(manifestAsset.promptId, expected.filename.replace(/\.webp$/, ""));
      assert.equal(typeof manifest.prompts[manifestAsset.promptId], "string");
      assert.ok(manifest.prompts[manifestAsset.promptId].length > 200, "登记提示词不能是空占位符");
      assert.equal(sidecar.prompt, manifest.prompts[manifestAsset.promptId]);
      assert.equal(sidecar.tool, manifest.tool);
      assert.equal(sidecar.toolId, manifest.toolId);
      assert.equal(sidecar.generationMode, "built-in-imagegen");
      assert.equal(sidecar.generationMode, manifestAsset.generationMode);
      assert.match(sidecar.sourceGenerationId, /^exec-[0-9a-f-]{36}\.png$/);
      assert.equal(sidecar.sourceGenerationId, manifestAsset.sourceGenerationId);
    });
  }
});
