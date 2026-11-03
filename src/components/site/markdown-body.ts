/**
 * Styles for HTML from `sanitizeMarkdown` (no typography plugin): each
 * heading level at its DESIGN.md size (h1 36/44, h2 28/36, h3 20/28) and
 * the link treatment, for the elements it can emit. Never `display: flex`
 * on lists, which would drop their markers.
 */
export const MARKDOWN_BODY_CLASSES = [
  "flex flex-col gap-4",
  "[&_h1]:mt-8 [&_h1]:text-h1 [&_h1]:font-bold",
  "[&_h2]:mt-8 [&_h2]:text-h2 [&_h2]:font-bold",
  "[&_h3]:mt-4 [&_h3]:text-h3 [&_h3]:font-semibold",
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li+li]:mt-1",
  "[&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted",
  "[&_code]:rounded-input [&_code]:bg-surface [&_code]:px-1",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-input [&_pre]:bg-surface [&_pre]:p-4",
  "[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-4 [&_a]:transition-[text-decoration-color] [&_a:focus-visible]:decoration-current [&_a:hover]:decoration-current",
].join(" ");
