#!/bin/bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/app/package.json" ]]; then
  BUNDLE_DIR="$SCRIPT_DIR"
  APP_DIR="$SCRIPT_DIR/app"
else
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  BUNDLE_DIR="$(cd "$APP_DIR/.." && pwd)"
fi
TRANSFER_FILE="$BUNDLE_DIR/migration/contacts.relationship-echo-transfer"
CHECKSUM_FILE="$BUNDLE_DIR/SHA256SUMS.txt"
FINAL_APP_DIR="$HOME/Applications"
FINAL_APP="$FINAL_APP_DIR/关系回响.app"
LEGACY_STAGING_APP="$FINAL_APP_DIR/.relationship-echo-incoming.app"
LEGACY_ROLLBACK_APP="$FINAL_APP_DIR/.relationship-echo-rollback.app"
STAGING_APP=""
ROLLBACK_APP=""
ACTIVE_TRANSACTION_ID=""
INSTALL_JOURNAL="$FINAL_APP_DIR/.relationship-echo-install.journal"
JOURNAL_PENDING="$FINAL_APP_DIR/.relationship-echo-install.journal.pending"
LOCK_DIR="$FINAL_APP_DIR/.relationship-echo-install.lock"
LOCK_OWNER_FILE="$LOCK_DIR/owner"
LOCK_OWNER_TOKEN="$$-$(date +%s)-$RANDOM"
TARGET_DATABASE="$HOME/Library/Application Support/Relationship Echo/relationship-care.sqlite"
APP_SWAP_COMPLETE=0
FINAL_PUBLISHED=0
RECOVERED_COMPLETE=0
CLEANUP_ENABLED=0
PRESERVE_RECOVERY_STATE=0
LOCK_HELD=0
TRANSFER_PASSWORD=""
. "$APP_DIR/scripts/mac-install-lock.sh"

set_transaction_paths() {
  local transaction_id="$1"
  if [[ ! "$transaction_id" =~ ^[0-9]+-[0-9]+-[0-9]+$ ]]; then
    echo "安装事务标识无效；未操作任何暂存或回滚 App。" >&2
    return 1
  fi
  ACTIVE_TRANSACTION_ID="$transaction_id"
  STAGING_APP="$FINAL_APP_DIR/.relationship-echo-incoming-${transaction_id}.app"
  ROLLBACK_APP="$FINAL_APP_DIR/.relationship-echo-rollback-${transaction_id}.app"
}

write_install_journal() {
  local phase="$1"
  case "$phase" in
    prepared|old-moved|app-published|data-installing|data-committed|complete) ;;
    *) echo "拒绝写入未知安装阶段：$phase" >&2; exit 1 ;;
  esac
  if [[ -z "$ACTIVE_TRANSACTION_ID" ]]; then
    echo "缺少安装事务标识，拒绝写入安装日志。" >&2
    exit 1
  fi
  printf 'version=2\ntransaction_id=%s\nphase=%s\n' "$ACTIVE_TRANSACTION_ID" "$phase" > "$JOURNAL_PENDING"
  chmod 600 "$JOURNAL_PENDING"
  sync
  mv -f -- "$JOURNAL_PENDING" "$INSTALL_JOURNAL"
  sync
}

verify_installed_identity() {
  if ! command -v node >/dev/null 2>&1; then return 1; fi
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [[ "$node_major" -lt 24 || ! -f "$TRANSFER_FILE" ]]; then return 1; fi
  node "$APP_DIR/scripts/verify-installed-mac-data.mjs" \
    --input "$TRANSFER_FILE" \
    --database "$TARGET_DATABASE"
}

restore_previous_app() {
  if [[ -n "$ROLLBACK_APP" && -e "$ROLLBACK_APP" ]]; then
    rm -rf -- "$FINAL_APP"
    mv -- "$ROLLBACK_APP" "$FINAL_APP"
  elif [[ "$FINAL_PUBLISHED" -eq 1 ]]; then
    rm -rf -- "$FINAL_APP"
  fi
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  unset TRANSFER_PASSWORD
  if [[ "$CLEANUP_ENABLED" -eq 1 && "$PRESERVE_RECOVERY_STATE" -ne 1 ]]; then
    if [[ -n "$STAGING_APP" ]]; then rm -rf -- "$STAGING_APP"; fi
    rm -f -- "$JOURNAL_PENDING"
    if [[ "$APP_SWAP_COMPLETE" -ne 1 ]]; then
      restore_previous_app
      rm -f -- "$INSTALL_JOURNAL"
      sync
    fi
  fi
  release_install_lock
  exit "$exit_code"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个脚本只能在 Mac 上运行。"
  exit 1
fi
mkdir -p "$FINAL_APP_DIR"
for managed_path in "$FINAL_APP" "$LEGACY_STAGING_APP" "$LEGACY_ROLLBACK_APP" "$INSTALL_JOURNAL" "$JOURNAL_PENDING" "$LOCK_DIR" "$TARGET_DATABASE"; do
  if [[ -L "$managed_path" ]]; then
    echo "检测到符号链接，无法安全继续安装：$managed_path" >&2
    exit 1
  fi
done
acquire_install_lock
CLEANUP_ENABLED=1

# A transaction-bound journal lets the next run converge after SIGKILL or
# power loss. Only paths derived from the journal's strict transaction ID may
# be removed or moved during recovery.
if [[ -f "$INSTALL_JOURNAL" ]]; then
  RECOVERY_VERSION="$(sed -n 's/^version=//p' "$INSTALL_JOURNAL" | tail -n 1)"
  RECOVERY_TRANSACTION_ID="$(sed -n 's/^transaction_id=//p' "$INSTALL_JOURNAL" | tail -n 1)"
  RECOVERY_PHASE="$(sed -n 's/^phase=//p' "$INSTALL_JOURNAL" | tail -n 1)"
  if [[ "$RECOVERY_VERSION" != "2" ]] || ! set_transaction_paths "$RECOVERY_TRANSACTION_ID"; then
    PRESERVE_RECOVERY_STATE=1
    echo "安装日志缺少可验证的事务身份；未自动移动或删除任何 App：$INSTALL_JOURNAL" >&2
    exit 1
  fi
  case "$RECOVERY_PHASE" in
    prepared|old-moved|app-published|data-installing|data-committed|complete) ;;
    *)
      PRESERVE_RECOVERY_STATE=1
      echo "发现无法识别的安装日志，未自动移动任何 App：$INSTALL_JOURNAL" >&2
      exit 1
      ;;
  esac
  for transaction_path in "$STAGING_APP" "$ROLLBACK_APP"; do
    if [[ -L "$transaction_path" ]]; then
      PRESERVE_RECOVERY_STATE=1
      echo "事务路径被替换为符号链接，已停止且未执行清理：$transaction_path" >&2
      exit 1
    fi
  done
  rm -f -- "$JOURNAL_PENDING"

  if [[ "$RECOVERY_PHASE" == "data-installing" || "$RECOVERY_PHASE" == "data-committed" || "$RECOVERY_PHASE" == "complete" ]] \
    && [[ -e "$TARGET_DATABASE" ]]; then
    if [[ -d "$FINAL_APP" ]] \
      && codesign --verify --deep --strict "$FINAL_APP" >/dev/null 2>&1 \
      && verify_installed_identity; then
      rm -rf -- "$ROLLBACK_APP" "$STAGING_APP"
      rm -f -- "$INSTALL_JOURNAL" "$JOURNAL_PENDING"
      sync
      RECOVERED_COMPLETE=1
      APP_SWAP_COMPLETE=1
      echo "已复核数据库哈希、修订与完整性，并收敛上次被中断的安装。"
    else
      PRESERVE_RECOVERY_STATE=1
      echo "检测到未完成的数据提交，但无法证明目标数据库属于本次迁移。" >&2
      echo "为避免误删，App 回滚副本、安装日志和数据库均已原样保留；请勿手动覆盖。" >&2
      exit 1
    fi
  else
    if [[ -e "$ROLLBACK_APP" ]]; then
      rm -rf -- "$FINAL_APP"
      mv -- "$ROLLBACK_APP" "$FINAL_APP"
    elif [[ "$RECOVERY_PHASE" != "prepared" ]]; then
      rm -rf -- "$FINAL_APP"
    fi
    rm -rf -- "$STAGING_APP"
    rm -f -- "$INSTALL_JOURNAL" "$JOURNAL_PENDING"
    sync
    echo "已自动恢复上次被中断的 App 安装；现在重新执行完整流程。"
  fi
else
  if [[ -e "$LEGACY_STAGING_APP" || -e "$LEGACY_ROLLBACK_APP" || -e "$JOURNAL_PENDING" ]]; then
    PRESERVE_RECOVERY_STATE=1
    echo "发现没有事务日志可以证明归属的旧暂存/回滚文件；为避免误删，已停止。" >&2
    echo "请先人工检查 $FINAL_APP_DIR 中以 .relationship-echo- 开头的旧文件。" >&2
    exit 1
  fi
  set_transaction_paths "$LOCK_OWNER_TOKEN"
  for transaction_path in "$STAGING_APP" "$ROLLBACK_APP"; do
    if [[ -e "$transaction_path" || -L "$transaction_path" ]]; then
      PRESERVE_RECOVERY_STATE=1
      echo "本轮唯一事务路径已存在，无法证明其归属，已停止：$transaction_path" >&2
      exit 1
    fi
  done
fi

if [[ "$RECOVERED_COMPLETE" -eq 1 ]]; then
  echo "完成。以后只需打开：$FINAL_APP"
  open "$FINAL_APP" || true
  exit 0
fi
if [[ -e "$TARGET_DATABASE" || -e "${TARGET_DATABASE}-wal" || -e "${TARGET_DATABASE}-shm" ]]; then
  echo "Mac 上已经存在关系回响联系人数据库；本迁移包不会覆盖它。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 Node.js 24。请先从 https://nodejs.org 安装 Node.js 24 LTS，再重新双击本脚本。"
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "需要 Node.js 24 或更高版本；当前版本：$(node --version)"
  exit 1
fi
if [[ ! -f "$TRANSFER_FILE" ]]; then
  echo "没有找到加密联系人迁移文件：$TRANSFER_FILE"
  exit 1
fi

echo "关系回响将在本机校验文件、安装锁定依赖、运行测试、构建 App，并迁移联系人。"
cd "$APP_DIR"
echo "[1/9] 校验百度网盘下载文件……"
IFS= read -r -p "请先对照未上传网盘的 SHA-256；确认完全一致后输入 YES：" HASH_CONFIRMED
if [[ "$HASH_CONFIRMED" != "YES" ]]; then
  echo "没有确认外部 SHA-256，已停止。"
  exit 1
fi
unset HASH_CONFIRMED
if [[ ! -f "$CHECKSUM_FILE" ]]; then
  echo "没有找到 SHA256SUMS.txt，已停止构建。"
  exit 1
fi
(
  cd "$BUNDLE_DIR"
  shasum -a 256 -c SHA256SUMS.txt
)

echo "[2/9] 安装锁定依赖……"
npm ci
echo "[3/9] 运行全部自动化测试……"
npm test
echo "[4/9] 运行隔离的 Electron 源码 smoke……"
npm run test:electron-smoke
echo "[5/9] 构建 universal Mac App……"
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac:dir

BUILT_APP="$(find "$APP_DIR/dist" -maxdepth 2 -type d -name '关系回响.app' -print -quit)"
if [[ -z "$BUILT_APP" || ! -f "$BUILT_APP/Contents/MacOS/关系回响" ]]; then
  echo "没有找到完整的关系回响.app，已停止安装。"
  exit 1
fi
ARCH_INFO="$(file "$BUILT_APP/Contents/MacOS/关系回响")"
if [[ "$ARCH_INFO" != *"arm64"* || "$ARCH_INFO" != *"x86_64"* ]]; then
  echo "构建产物不是同时支持 Apple 芯片和 Intel 的 universal App：$ARCH_INFO"
  exit 1
fi

echo "[6/9] 为个人本机使用添加临时签名……"
codesign --force --deep --sign - "$BUILT_APP"
codesign --verify --deep --strict "$BUILT_APP"

echo "[7/9] 运行最终 Mac App 的隔离 smoke……"
npm run test:electron-smoke -- --packaged-app "$BUILT_APP"

echo "[8/9] 使用可恢复事务安装最终 App……"
if [[ -e "$STAGING_APP" || -e "$ROLLBACK_APP" || -L "$STAGING_APP" || -L "$ROLLBACK_APP" ]]; then
  PRESERVE_RECOVERY_STATE=1
  echo "本轮事务路径在安装提交前被占用；为避免误删，已停止。" >&2
  exit 1
fi
write_install_journal prepared
ditto "$BUILT_APP" "$STAGING_APP"
codesign --verify --deep --strict "$STAGING_APP"
STAGED_ARCH_INFO="$(file "$STAGING_APP/Contents/MacOS/关系回响")"
if [[ "$STAGED_ARCH_INFO" != *"arm64"* || "$STAGED_ARCH_INFO" != *"x86_64"* ]]; then
  echo "待安装 App 不是 universal 架构，已停止：$STAGED_ARCH_INFO"
  exit 1
fi
if [[ -e "$FINAL_APP" ]]; then
  mv -- "$FINAL_APP" "$ROLLBACK_APP"
fi
write_install_journal old-moved
mv -- "$STAGING_APP" "$FINAL_APP"
FINAL_PUBLISHED=1
codesign --verify --deep --strict "$FINAL_APP"
write_install_journal app-published

echo "[9/9] 验证并安装加密联系人……"
IFS= read -r -s -p "请输入单独保存的迁移密码：" TRANSFER_PASSWORD
echo
printf '%s\n' "$TRANSFER_PASSWORD" | node scripts/verify-mac-transfer.mjs --input "$TRANSFER_FILE" --password-stdin
write_install_journal data-installing
PRESERVE_RECOVERY_STATE=1
printf '%s\n' "$TRANSFER_PASSWORD" | node scripts/install-mac-data.mjs --input "$TRANSFER_FILE" --password-stdin
unset TRANSFER_PASSWORD
if ! node scripts/verify-installed-mac-data.mjs --input "$TRANSFER_FILE" --database "$TARGET_DATABASE"; then
  PRESERVE_RECOVERY_STATE=1
  echo "联系人数据库已发布但身份复核失败；已保留 App 回滚副本、日志和数据库以便恢复。" >&2
  exit 1
fi
APP_SWAP_COMPLETE=1
write_install_journal data-committed
write_install_journal complete
rm -rf -- "$ROLLBACK_APP"
rm -f -- "$INSTALL_JOURNAL" "$JOURNAL_PENDING"
sync
PRESERVE_RECOVERY_STATE=0

echo
echo "完成。以后只需打开：$FINAL_APP"
echo "联系人数据位于：$HOME/Library/Application Support/Relationship Echo"
echo "这是个人本机构建的临时签名 App，不等同于 Apple Developer ID 签名或官方公证。"
open "$FINAL_APP" || {
  echo "macOS 没有自动打开 App。请在 Finder 中打开“应用程序 → 关系回响”，必要时到“系统设置 → 隐私与安全性”确认。"
}
