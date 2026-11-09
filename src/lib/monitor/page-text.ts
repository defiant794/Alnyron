import { MONITOR_SNAPSHOT_MAX_CHARS } from "@/config/monitor";

/**
 * Page text: what the change detector compares. A fetched page becomes the
 * text a reader sees (title, then the body's text, one block per line), so
 * markup noise such as nonces, CSRF tokens, asset hashes and inline scripts
 * never changes it. Pure string code (no DOM, no HTMLRewriter), so it runs the
 * same in the cron Worker and in Node tests.
 */

/**
 * Prefix of every page hash. Bump it when {@link pageText} changes its output:
 * the engine then takes a silent new baseline instead of reporting every page
 * as changed.
 */
export const PAGE_HASH_VERSION = "v1";

/** Dropped with their content, which the parser reads as raw text up to the closing tag. */
const RAW_TEXT_DROPPED = new Set(["script", "style", "noscript", "iframe"]);

/** Dropped with their content, which may nest the same element. */
const NESTED_DROPPED = new Set(["template", "svg", "math", "object", "canvas"]);

/** Tags that start a new line (opening and closing). */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "table",
  "blockquote",
  "pre",
  "form",
  "fieldset",
  "figure",
  "figcaption",
  "address",
  "hr",
  "br",
]);

/** `</name` of each element whose content is skipped up to its closing tag. */
const CLOSING_TAG = new Map(
  [...RAW_TEXT_DROPPED, "title"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>]|$)`, "gi")]),
);

/** Opening and closing tags of each element dropped with nesting. */
const NESTED_TAG = new Map([...NESTED_DROPPED].map((name) => [name, new RegExp(`</?${name}(?=[\\s/>]|$)`, "gi")]));

/** Named entities decoded (others stay as written). `&nbsp;` becomes a plain space. */
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["aelig", "æ"],
  ["AElig", "Æ"],
  ["oslash", "ø"],
  ["Oslash", "Ø"],
  ["aring", "å"],
  ["Aring", "Å"],
  ["auml", "ä"],
  ["Auml", "Ä"],
  ["ouml", "ö"],
  ["Ouml", "Ö"],
  ["uuml", "ü"],
  ["Uuml", "Ü"],
  ["eacute", "é"],
  ["Eacute", "É"],
  ["szlig", "ß"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["hellip", "…"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["bull", "•"],
  ["middot", "·"],
  ["deg", "°"],
  ["times", "×"],
  ["euro", "€"],
]);

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/** A tag's name (`<name` or `</name`), read from just after its `<`. */
const TAG_NAME = /\/?([A-Za-z][^\s/>]*)/y;

type Tag = { name: string; closing: boolean; selfClosing: boolean; end: number };

/** Index just past the next `needle` at or after `from`, or the end of `text` when there is none. */
function skipPast(text: string, needle: string, from: number): number {
  const at = text.indexOf(needle, from);
  return at === -1 ? text.length : at + needle.length;
}

/**
 * The tag starting at `html[start]` (a `<`), or null when that `<` starts no
 * tag (`5 < 10`) and is text. A `>` inside a quoted attribute value does not
 * end the tag; an unterminated tag runs to the end of the document.
 */
function readTag(html: string, start: number): Tag | null {
  TAG_NAME.lastIndex = start + 1;
  const match = TAG_NAME.exec(html);
  if (match === null) return null;
  const tag = { name: (match[1] ?? "").toLowerCase(), closing: html[start + 1] === "/", selfClosing: false };
  let at = TAG_NAME.lastIndex;
  while (at < html.length) {
    const char = html[at];
    if (char === ">") return { ...tag, selfClosing: html[at - 1] === "/", end: at + 1 };
    at += 1;
    if (char === "=") {
      while (at < html.length && /\s/.test(html[at] ?? "")) at += 1;
      const quote = html[at];
      if (quote === '"' || quote === "'") at = skipPast(html, quote, at + 1);
    }
  }
  return { ...tag, end: html.length };
}

/** Index just past the tag that closes the `name` element whose content starts at `from` (same-name nesting counted). */
function skipNested(html: string, name: string, from: number): number {
  const pattern = NESTED_TAG.get(name);
  if (pattern === undefined) return html.length;
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const tag = readTag(html, match.index);
    if (tag === null) continue;
    pattern.lastIndex = tag.end;
    if (tag.closing) depth -= 1;
    else if (!tag.selfClosing) depth += 1;
    if (depth === 0) return tag.end;
  }
  return html.length;
}

/** Decodes numeric character references and the {@link NAMED_ENTITIES}; invalid code points become U+FFFD. */
function decodeEntities(text: string): string {
  return text.replace(
    ENTITY,
    (match: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES.get(name) ?? match;
      const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(decimal, 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    },
  );
}

/**
 * An HTML document as lines of text: the first `<title>` (one line), then the
 * document's text. `<head>` needs no handling of its own: the title is lifted
 * out here, its script / style / noscript / template children are dropped like
 * anywhere else, and its other tags are stripped. Comments, CDATA, doctype and
 * the {@link RAW_TEXT_DROPPED} / {@link NESTED_DROPPED} elements are dropped
 * whole, {@link BLOCK_TAGS} become line breaks, every other tag is removed, and
 * entities are decoded last (so `&lt;b&gt;` stays the text `<b>`).
 */
function htmlText(html: string): string {
  const parts: string[] = [];
  let title: string | null = null;
  let at = 0;

  while (at < html.length) {
    const lt = html.indexOf("<", at);
    const text = html.slice(at, lt === -1 ? html.length : lt);
    if (text !== "") parts.push(text);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      at = skipPast(html, "-->", lt + 4);
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      at = skipPast(html, "]]>", lt + 9);
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      at = skipPast(html, ">", lt + 2);
      continue;
    }

    const tag = readTag(html, lt);
    if (tag === null) {
      parts.push("<");
      at = lt + 1;
      continue;
    }
    at = tag.end;

    if (tag.closing) {
      if (BLOCK_TAGS.has(tag.name)) parts.push("\n");
      continue;
    }

    const closingTag = CLOSING_TAG.get(tag.name);
    if (closingTag !== undefined) {
      closingTag.lastIndex = at;
      const close = closingTag.exec(html);
      if (tag.name === "title" && title === null) title = html.slice(at, close?.index ?? html.length);
      at = close === null ? html.length : skipPast(html, ">", close.index);
      continue;
    }
    if (NESTED_DROPPED.has(tag.name)) {
      if (!tag.selfClosing) at = skipNested(html, tag.name, at);
      continue;
    }

    if (BLOCK_TAGS.has(tag.name)) parts.push("\n");
  }

  const titleLine = title === null ? "" : decodeEntities(title).replace(/\s+/g, " ");
  return `${titleLine}\n${decodeEntities(parts.join(""))}`;
}

/**
 * The text of a fetched page as the engine hashes and diffs it. HTML
 * (`text/html`, `application/xhtml+xml`) is reduced to its visible text (see
 * {@link htmlText}); `text/plain` is taken as is. Both are then NFC
 * normalised, each line's whitespace runs collapsed to one space and trimmed,
 * empty lines dropped, and lines joined with `\n`. NUL characters are removed
 * (Postgres text cannot hold them).
 */
export function pageText(body: string, contentType: string): string {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const text = mediaType === "text/html" || mediaType === "application/xhtml+xml" ? htmlText(body) : body;
  return text
    .normalize("NFC")
    .replaceAll("\0", "")
    .split(/\r\n?|[\n\u2028\u2029]/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** `v1:` + the lower-hex SHA-256 of the UTF-8 text: what `monitors.last_hash` stores. */
export async function hashPageText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${PAGE_HASH_VERSION}:${hex}`;
}

/**
 * Whether a stored hash was made by the current {@link pageText}. False for
 * null (never checked) and older or unknown formats: the engine then takes a
 * new baseline without reporting a change.
 */
export function isCurrentPageHash(hash: string | null): boolean {
  return hash !== null && hash.startsWith(`${PAGE_HASH_VERSION}:`);
}

/**
 * What `monitors.last_snapshot` stores of a page's text: all of it when it
 * fits {@link MONITOR_SNAPSHOT_MAX_CHARS}, otherwise the whole lines that fit
 * (a single over-long first line is cut without splitting a surrogate pair),
 * so the next change summary never compares a half line.
 */
export function pageSnapshot(text: string): string {
  if (text.length <= MONITOR_SNAPSHOT_MAX_CHARS) return text;
  const lastBreak = text.lastIndexOf("\n", MONITOR_SNAPSHOT_MAX_CHARS);
  if (lastBreak > 0) return text.slice(0, lastBreak);
  const cut = text.slice(0, MONITOR_SNAPSHOT_MAX_CHARS);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}
