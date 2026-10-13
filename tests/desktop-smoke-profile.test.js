import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  ELECTRON_SMOKE_ENV,
  ELECTRON_SMOKE_RUN_ID_ENV,
  PACKAGED_ELECTRON_SMOKE_ENV,
  publicSmokeResult,
  resolveDesktopRuntimeProfile,
  SMOKE_DIRECTORY_PREFIX,
} from "../desktop/smoke-profile.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";

test("普通桌面模式固定使用应用级数据目录且不会创建 smoke 目录", () => {
  let temporaryCalls = 0;
  const appDataPath = resolve("test-app-data");
  const profile = resolveDesktopRuntimeProfile({
    environment: {},
    isPackaged: false,
    appDataPath,
    temporaryRoot: resolve("test-temp"),
    createTemporaryDirectory() {
      temporaryCalls += 1;
      return resolve("unexpected");
    },
  });

  assert.equal(profile.mode, "standard");
  assert.equal(profile.sourceOnly, false);
  assert.equal(profile.userDataPath, resolve(appDataPath, "Relationship Echo"));
  assert.equal(temporaryCalls, 0);
});

test("源码 smoke 目录只能由 App 在系统临时根内创建", () => {
  const temporaryRoot = resolve("test-temp-root");
  const ownedPrefix = `${SMOKE_DIRECTORY_PREFIX}${RUN_ID}-`;
  const createdPath = resolve(temporaryRoot, `${ownedPrefix}abc123`);
  let receivedPrefix = null;
  const profile = resolveDesktopRuntimeProfile({
    environment: {
      [ELECTRON_SMOKE_ENV]: "1",
      [ELECTRON_SMOKE_RUN_ID_ENV]: RUN_ID,
    },
    isPackaged: false,
    appDataPath: resolve("test-app-data"),
    temporaryRoot,
    createTemporaryDirectory(prefix) {
      receivedPrefix = prefix;
      return createdPath;
    },
  });

  assert.equal(receivedPrefix, resolve(temporaryRoot, ownedPrefix));
  assert.deepEqual(profile, { mode: "smoke", sourceOnly: true, userDataPath: createdPath });
});

test("最终 App smoke 只能在发行态运行且保持 production sandbox 标识", () => {
  const temporaryRoot = resolve("test-packaged-temp-root");
  const ownedPrefix = `${SMOKE_DIRECTORY_PREFIX}${RUN_ID}-`;
  const createdPath = resolve(temporaryRoot, `${ownedPrefix}packaged`);
  const profile = resolveDesktopRuntimeProfile({
    environment: {
      [PACKAGED_ELECTRON_SMOKE_ENV]: "1",
      [ELECTRON_SMOKE_RUN_ID_ENV]: RUN_ID,
    },
    isPackaged: true,
    appDataPath: resolve("test-app-data"),
    temporaryRoot,
    createTemporaryDirectory: () => createdPath,
  });

  assert.deepEqual(profile, { mode: "smoke", sourceOnly: false, userDataPath: createdPath });
});

test("源码与发行版 smoke 运行形态不匹配时失败关闭且不会创建目录", () => {
  let temporaryCalls = 0;
  assert.throws(
    () => resolveDesktopRuntimeProfile({
      environment: {
        [ELECTRON_SMOKE_ENV]: "1",
        [ELECTRON_SMOKE_RUN_ID_ENV]: RUN_ID,
      },
      isPackaged: true,
      appDataPath: resolve("test-app-data"),
      temporaryRoot: resolve("test-temp"),
      createTemporaryDirectory() {
        temporaryCalls += 1;
        return resolve("unexpected");
      },
    }),
    (error) => error.code === "SOURCE_SMOKE_REQUIRES_SOURCE",
  );
  assert.throws(
    () => resolveDesktopRuntimeProfile({
      environment: {
        [PACKAGED_ELECTRON_SMOKE_ENV]: "1",
        [ELECTRON_SMOKE_RUN_ID_ENV]: RUN_ID,
      },
      isPackaged: false,
      appDataPath: resolve("test-app-data"),
      temporaryRoot: resolve("test-temp"),
      createTemporaryDirectory() {
        temporaryCalls += 1;
        return resolve("unexpected");
      },
    }),
    (error) => error.code === "PACKAGED_SMOKE_REQUIRES_PACKAGED",
  );
  assert.equal(temporaryCalls, 0);
});

test("smoke 拒绝非法开关值和逃出临时根的目录", () => {
  assert.throws(
    () => resolveDesktopRuntimeProfile({
      environment: { [ELECTRON_SMOKE_ENV]: resolve("attacker-path") },
      isPackaged: false,
      appDataPath: resolve("test-app-data"),
    }),
    (error) => error.code === "SMOKE_CONFIG_INVALID",
  );
  assert.throws(
    () => resolveDesktopRuntimeProfile({
      environment: {
        [ELECTRON_SMOKE_ENV]: "1",
        [ELECTRON_SMOKE_RUN_ID_ENV]: RUN_ID,
      },
      isPackaged: false,
      appDataPath: resolve("test-app-data"),
      temporaryRoot: resolve("test-temp"),
      createTemporaryDirectory: () => resolve("outside-temp", `${SMOKE_DIRECTORY_PREFIX}${RUN_ID}-escape`),
    }),
    (error) => error.code === "SMOKE_PATH_ESCAPE",
  );
  assert.throws(
    () => resolveDesktopRuntimeProfile({
      environment: {
        [ELECTRON_SMOKE_ENV]: "1",
        [ELECTRON_SMOKE_RUN_ID_ENV]: "attacker-controlled-path",
      },
      isPackaged: false,
      appDataPath: resolve("test-app-data"),
    }),
    (error) => error.code === "SMOKE_RUN_ID_INVALID",
  );
});

test("公开 smoke 结果只有布尔合同，不包含路径、联系人或凭据", () => {
  const result = publicSmokeResult({
    ok: true,
    sourceOnly: true,
    rendererSandboxRequested: true,
    noSandboxSwitchAbsent: false,
    databaseExists: true,
    backupExists: true,
    databaseAndBackupsShareRoot: true,
    password: "must-not-leak",
    contacts: ["must-not-leak"],
    dataDir: "must-not-leak",
  });
  assert.deepEqual(Object.keys(result), [
    "event",
    "version",
    "ok",
    "sourceOnly",
    "appCreatedTemporaryRoot",
    "rendererSandboxRequested",
    "noSandboxSwitchAbsent",
    "databaseExists",
    "backupExists",
    "databaseAndBackupsShareRoot",
  ]);
  assert.equal(result.version, 2);
  assert.equal(result.rendererSandboxRequested, true);
  assert.equal(result.noSandboxSwitchAbsent, false);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|password|contacts|dataDir/i);
});
