import { remark } from "remark";
import type {
  Root,
  Heading,
  List,
  ListItem,
  Paragraph,
  Text,
  Strong,
  BlockContent,
  PhrasingContent,
} from "mdast";

// Reuse a single processor — remark freezes on first use anyway
const processor = remark();

// Serialize an mdast tree to a markdown string.
// The serializer automatically escapes any characters in text nodes
// that would be structurally ambiguous (code fences, headings, list
// markers, thematic breaks, etc.), so callers never need to pre-escape.
export function serialize(tree: Root): string {
  return processor.stringify(tree);
}

// Collapse newlines in LLM-generated text before inserting into a text node.
// Embedded blank lines (\n\n) cause list items to become "spread" (loose),
// which then breaks the surrounding markdown structure on re-parse.
// Newlines within a single fact/narrative are replaced with a space.
export function inline(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").trim();
}

// Normalize arbitrary markdown via parse → stringify roundtrip.
// Used for content we don't control (e.g. existing text parts in Layer 4
// after tool parts are stripped out), where we can't build from AST.
// Two passes are needed: remark's asterisk/underscore escaping can introduce
// new sequences on the first pass that the second pass then stabilizes.
export function normalize(md: string): string {
  const once = processor.stringify(processor.parse(md));
  return processor.stringify(processor.parse(once));
}

// --- Node builders ---

export function h(depth: 1 | 2 | 3 | 4 | 5 | 6, value: string): Heading {
  return { type: "heading", depth, children: [t(value)] };
}

export function p(value: string): Paragraph {
  return { type: "paragraph", children: [t(value)] };
}

export function ul(items: ListItem[]): List {
  return { type: "list", ordered: false, spread: false, children: items };
}

export function li(...children: BlockContent[]): ListItem {
  return { type: "listItem", spread: false, children };
}

// List item containing a single paragraph (the common case for facts/entries)
export function lip(value: string): ListItem {
  return li(p(value));
}

// List item with inline phrasing content — e.g. **bold**: text
export function liph(...children: PhrasingContent[]): ListItem {
  return li({ type: "paragraph", children });
}

export function t(value: string): Text {
  return { type: "text", value };
}

export function strong(value: string): Strong {
  return { type: "strong", children: [t(value)] };
}

export function root(...children: Root["children"]): Root {
  return { type: "root", children };
}
