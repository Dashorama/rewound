export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// FTS5 snippet() wraps matches in \x01...\x02 marker bytes (see search.ts).
// Escape first (control bytes pass through untouched), then swap markers for
// <mark> tags so injected match text can never break out of the tag.
export function highlightSnippetHtml(snippet: string): string {
  return escapeHtml(snippet).replace(/\x01/g, "<mark>").replace(/\x02/g, "</mark>");
}
