export function getNavigationTargetUrl(event, detailsOrUrl) {
  if (typeof detailsOrUrl === "string") return detailsOrUrl;
  if (typeof detailsOrUrl?.url === "string") return detailsOrUrl.url;
  if (typeof event?.url === "string") return event.url;
  return null;
}

export function isAllowedNavigation(targetUrl, allowedOrigin) {
  if (!targetUrl || !allowedOrigin) return false;
  try {
    return new URL(targetUrl).origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function preventUnexpectedNavigation(event, detailsOrUrl, allowedOrigin) {
  const targetUrl = getNavigationTargetUrl(event, detailsOrUrl);
  const allowed = isAllowedNavigation(targetUrl, allowedOrigin);
  if (!allowed) event.preventDefault();
  return allowed;
}
