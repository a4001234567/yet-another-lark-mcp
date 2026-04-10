/**
 * Info / markdown display card — renders structured text content in a Lark card.
 *
 * buildInfoCard(options)
 *   General-purpose display card for presenting information to the user.
 *   Supports a title, optional subtitle, and one or more content sections.
 *
 * Each section can be:
 *   { type: 'markdown', content: '...' }   — rich markdown block
 *   { type: 'kv', key: '...', value: '...' } — key-value row (label: value)
 *   { type: 'divider' }                     — horizontal rule
 *
 * Usage:
 *   buildInfoCard({
 *     title:    '深圳天气',
 *     template: 'blue',
 *     sections: [
 *       { type: 'kv', key: '温度', value: '23°C（体感 25°C）' },
 *       { type: 'kv', key: '天气', value: '晴' },
 *       { type: 'divider' },
 *       { type: 'markdown', content: '建议穿**轻薄长袖**，无需外套。' },
 *     ],
 *   });
 */

export type InfoSection =
  | { type: 'markdown'; content: string }
  | { type: 'kv';       key: string; value: string }
  | { type: 'divider' };

export type InfoCardOptions = {
  title:     string;
  subtitle?: string;
  template?: 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'wathet' | 'indigo' | 'purple';
  sections:  InfoSection[];
};

export function buildInfoCard(opts: InfoCardOptions): object {
  const { title, subtitle, template = 'blue', sections } = opts;

  const elements: object[] = sections.map((s) => {
    if (s.type === 'divider') {
      return { tag: 'hr' };
    }
    if (s.type === 'kv') {
      return {
        tag: 'column_set',
        flex_mode: 'stretch',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{ tag: 'markdown', content: `**${s.key}**` }],
          },
          {
            tag: 'column', width: 'weighted', weight: 2,
            elements: [{ tag: 'markdown', content: s.value }],
          },
        ],
      };
    }
    // markdown
    return { tag: 'markdown', content: s.content };
  });

  const header: any = {
    template,
    title: { tag: 'plain_text', content: title },
  };
  if (subtitle) {
    header.subtitle = { tag: 'plain_text', content: subtitle };
  }

  return {
    schema: '2.0',
    header,
    body: { elements },
  };
}
