import { MAX_BATCH_SELECTION } from "./limits.js";

export { MAX_BATCH_SELECTION };

function pageIdList(pageContactIds) {
  const unique = [];
  const seen = new Set();
  for (const id of pageContactIds || []) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length === MAX_BATCH_SELECTION) break;
  }
  return unique;
}

export function reconcileContactSelection(selection, pageContactIds) {
  const allowedIds = new Set(pageIdList(pageContactIds));
  return new Set([...selection].filter((id) => allowedIds.has(id)));
}

export function toggleContactSelection(selection, contactId, checked, pageContactIds) {
  const next = reconcileContactSelection(selection, pageContactIds);
  const allowedIds = new Set(pageIdList(pageContactIds));
  if (!allowedIds.has(contactId)) return next;
  if (checked) next.add(contactId);
  else next.delete(contactId);
  return next;
}

export function selectCurrentPage(pageContactIds, checked = true) {
  return checked ? new Set(pageIdList(pageContactIds)) : new Set();
}

export function summarizeContactSelection(selection, pageContactIds) {
  const ids = pageIdList(pageContactIds);
  const reconciled = reconcileContactSelection(selection, ids);
  const selectedCount = reconciled.size;
  return {
    pageIds: ids,
    pageCount: ids.length,
    selectedCount,
    checked: ids.length > 0 && selectedCount === ids.length,
    indeterminate: selectedCount > 0 && selectedCount < ids.length,
  };
}
