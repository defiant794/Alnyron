import MarkdownIt from "markdown-it";

/** Link schemes a page body may use; scheme-less links (relative paths, `#anchors`) are allowed too. */
const SAFE_SCHEME = /^(?:https?|mailto|tel):/i;
const ANY_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * A CommonMark renderer for page bodies. Safe by construction, not by
 * filtering its output afterwards:
 * - `html: false`: raw HTML in the source (`<script>`, `<img onerror>`,
 *   `<a href="javascript:">`, `<iframe>`, `<style>`) is escaped and shows as
 *   text; it never becomes an element.
 * - Links and autolinks keep only http(s), mailto, tel or scheme-less URLs;
 *   anything else (`javascript:`, `data:`, `vbscript:`, ...) stays plain text.
 * - Images are off: page bodies are text only, so a body never loads a
 *   remote URL.
 * `breaks` renders a single line break inside a paragraph as `<br>`.
 */
function safeMarkdown(breaks: boolean) {
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks }).disable("image");
  markdown.validateLink = (url) => {
    const trimmed = url.trim();
    return SAFE_SCHEME.test(trimmed) || !ANY_SCHEME.test(trimmed);
  };
  return markdown;
}

const markdown = safeMarkdown(false);
const markdownWithBreaks = safeMarkdown(true);

/**
 * Markdown (`page_translations.body_md`, or the versioned legal texts) to
 * HTML that is safe to render with `dangerouslySetInnerHTML`: headings,
 * paragraphs, emphasis, lists, quotes, code and safe links; no raw HTML,
 * event handlers or script URLs. With `breaks`, a single line break inside a
 * paragraph is kept (`<br>`), as in the terms' seller address block.
 */
export function sanitizeMarkdown(md: string, options: { breaks?: boolean } = {}): string {
  return (options.breaks ? markdownWithBreaks : markdown).render(md);
}
