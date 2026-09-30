import { columns, md, type CardElement } from './cards';
import { renderRichText } from './markdown-render';
import { hasMarkdownTable, renderReport } from './report-render';

/** Tokens exist only between preparation and rendering; no local path is put
 * into callback data. Each occurrence has its own CardKit element, while all
 * aliases of a file share the same delivery record. */
export interface InlineFiles {
  text: string;
  links: Array<{ token: string; fallback: string; element: CardElement }>;
}

export function renderFileAnswer(files: InlineFiles, images?: ReadonlyMap<string, string>): CardElement[] {
  const rendered = hasMarkdownTable(files.text) ? renderReport(files.text, { images }) : renderRichText(files.text, images);
  return placeInlineFiles(rendered, files);
}

/** Count nested containers too: a table converted to a grid can be much larger
 * than its native paginated equivalent. Leave room for process and controls. */
export function fileComponentCount(elements: CardElement[]): number {
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1)
    + (Array.isArray(element.elements) ? fileComponentCount(element.elements as CardElement[]) : 0)
    + (Array.isArray(element.columns) && element.tag !== 'table' ? fileComponentCount(element.columns as CardElement[]) : 0), 0);
}

/** Markdown has no inline callbacks. Keep prose in one full-width paragraph
 * and place clickable files below it. Mixing long prose and file controls in
 * auto-width columns squeezes Chinese filenames into vertical stacks. */
export function placeInlineFiles(elements: CardElement[], files: InlineFiles): CardElement[] {
  if (!files.links.length) return elements;
  const links = new Map(files.links.map((link) => [link.token, link]));
  const tokens = [...links.keys()];
  const tokenPattern = new RegExp(`(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  const replacementPattern = new RegExp(tokenPattern.source, 'g');
  const hasToken = (text: string): boolean => tokens.some((token) => text.includes(token));
  const renderText = (element: CardElement): CardElement[] => {
    const text = String(element.content ?? '');
    if (!hasToken(text)) return [element];
    const result: CardElement[] = [];
    for (const block of text.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const references = block.split(tokenPattern).flatMap((part) => {
        const link = links.get(part);
        return link ? [link] : [];
      });
      // A standalone file already has a visible label on its clickable control.
      const standalone = references.length === 1 &&
        [references[0]!.token, `**${references[0]!.token}**`].includes(block.trim());
      if (!standalone) result.push({ ...element, content: block.replace(replacementPattern, (token) => links.get(token)!.fallback) });
      result.push(...references.map((link) => link.element));
    }
    return result;
  };
  const visit = (element: CardElement): CardElement[] => {
    if (element.tag === 'markdown') return renderText(element);
    if (element.tag === 'table' && hasToken(JSON.stringify(element))) {
      // Native table cells cannot contain callbacks. Keep the same row/column
      // order in a column grid at the original position instead of hoisting files.
      const cols = element.columns as Array<{ name: string; display_name: string }>;
      const rows = element.rows as Array<Record<string, unknown>>;
      return [cols.map((c) => c.display_name), ...rows.map((r) => cols.map((c) => String(r[c.name] ?? '')))]
        .map((cells, row) => columns(cells.map((cell) => ({
          width: 'weighted', weight: 1, verticalAlign: 'top',
          elements: renderText(md(row === 0 && !hasToken(cell) ? `**${cell}**` : cell)),
        })), { spacing: 'small' }));
    }
    const out = { ...element };
    if (Array.isArray(out.elements)) out.elements = (out.elements as CardElement[]).flatMap(visit);
    if (Array.isArray(out.columns)) out.columns = (out.columns as CardElement[]).flatMap(visit);
    return [out];
  };
  return elements.flatMap(visit);
}
