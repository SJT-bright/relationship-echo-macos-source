#!/bin/bash

# Shared by the Mac installer and its concurrency test. Callers provide the
# fixed LOCK_DIR, LOCK_OWNER_FILE and per-process LOCK_OWNER_TOKEN variables.
release_stale_reclaim_guard() {
  if [[ "${LOCK_RECLAIM_HELD:-0}" -ne 1 ]]; then return 0; fi
  local reclaim_dir="${LOCK_DIR}.reclaim"
  local reclaim_owner_file="$reclaim_dir/owner"
  local current_owner
  current_owner="$(sed -n 's/^owner=//p' "$reclaim_owner_file" 2>/dev/null | tail -n 1)"
  if [[ "$current_owner" == "$LOCK_OWNER_TOKEN" ]]; then
    rm -f -- "$reclaim_owner_file"
    rmdir -- "$reclaim_dir" 2>/dev/null || true
  fi
  LOCK_RECLAIM_HELD=0
}

acquire_install_lock() {
  LOCK_RECLAIM_HELD=0
  local reclaim_dir="${LOCK_DIR}.reclaim"
  local reclaim_owner_file="$reclaim_dir/owner"
  while true; do
    if [[ -e "$reclaim_dir" ]]; then
      echo "另一进程正在回收陈旧安装锁；本次未执行任何恢复或清理。" >&2
      exit 1
    fi
    if mkdir -- "$LOCK_DIR" 2>/dev/null; then
      LOCK_HELD=1
      printf 'pid=%s\nowner=%s\n' "$$" "$LOCK_OWNER_TOKEN" > "$LOCK_OWNER_FILE"
      chmod 600 "$LOCK_OWNER_FILE"
      command -v sync >/dev/null 2>&1 && sync
      return 0
    fi
    if [[ -L "$LOCK_DIR" || ! -d "$LOCK_DIR" ]]; then
      echo "安装锁路径异常，未移动任何 App：$LOCK_DIR" >&2
      exit 1
    fi
    local existing_pid
    local existing_owner
    existing_pid="$(sed -n 's/^pid=//p' "$LOCK_OWNER_FILE" 2>/dev/null | tail -n 1)"
    existing_owner="$(sed -n 's/^owner=//p' "$LOCK_OWNER_FILE" 2>/dev/null | tail -n 1)"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "另一份关系回响构建迁移正在运行（PID ${existing_pid}）；本次未执行任何恢复或清理。" >&2
      exit 1
    fi
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
      echo "发现归属不明的安装锁。为避免干扰仍在启动的任务，本次未执行任何恢复：$LOCK_DIR" >&2
      exit 1
    fi

    # Only the process holding this second atomic mkdir may remove a stale
    # fixed lock. This prevents two stale reclaimers from deleting each
    # other's newly acquired live lock.
    if ! mkdir -- "$reclaim_dir" 2>/dev/null; then
      echo "另一进程正在回收陈旧安装锁；本次未执行任何恢复或清理。" >&2
      exit 1
    fi
    LOCK_RECLAIM_HELD=1
    printf 'pid=%s\nowner=%s\n' "$$" "$LOCK_OWNER_TOKEN" > "$reclaim_owner_file"
    chmod 600 "$reclaim_owner_file"

    local current_pid
    local current_owner
    current_pid="$(sed -n 's/^pid=//p' "$LOCK_OWNER_FILE" 2>/dev/null | tail -n 1)"
    current_owner="$(sed -n 's/^owner=//p' "$LOCK_OWNER_FILE" 2>/dev/null | tail -n 1)"
    if [[ "$current_pid" != "$existing_pid" || "$current_owner" != "$existing_owner" ]]; then
      release_stale_reclaim_guard
      continue
    fi
    if kill -0 "$current_pid" 2>/dev/null; then
      release_stale_reclaim_guard
      echo "另一份关系回响构建迁移仍在运行（PID ${current_pid}）；本次未执行任何恢复或清理。" >&2
      exit 1
    fi
    local unexpected_entry
    unexpected_entry="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 ! -name owner -print -quit 2>/dev/null)"
    if [[ -n "$unexpected_entry" ]]; then
      release_stale_reclaim_guard
      echo "陈旧安装锁中含未知内容，未自动删除：$LOCK_DIR" >&2
      exit 1
    fi
    rm -f -- "$LOCK_OWNER_FILE"
    if ! rmdir -- "$LOCK_DIR" 2>/dev/null; then
      release_stale_reclaim_guard
      echo "陈旧安装锁中含未知内容，未自动删除：$LOCK_DIR" >&2
      exit 1
    fi
    if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
      release_stale_reclaim_guard
      continue
    fi
    LOCK_HELD=1
    printf 'pid=%s\nowner=%s\n' "$$" "$LOCK_OWNER_TOKEN" > "$LOCK_OWNER_FILE"
    chmod 600 "$LOCK_OWNER_FILE"
    command -v sync >/dev/null 2>&1 && sync
    release_stale_reclaim_guard
    return 0
  done
}

release_install_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    local current_owner
    current_owner="$(sed -n 's/^owner=//p' "$LOCK_OWNER_FILE" 2>/dev/null | tail -n 1)"
    if [[ "$current_owner" == "$LOCK_OWNER_TOKEN" ]]; then
      rm -f -- "$LOCK_OWNER_FILE"
      rmdir -- "$LOCK_DIR" 2>/dev/null || true
    else
      echo "安装锁归属已经变化，未替其他进程释放锁。" >&2
    fi
    LOCK_HELD=0
  fi
  release_stale_reclaim_guard
}
