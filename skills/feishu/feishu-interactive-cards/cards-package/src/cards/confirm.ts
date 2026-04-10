/**
 * Confirmation card — presents a question with two action buttons.
 *
 * buildConfirmCard(options)
 *   Renders a card with a title, optional body text, and two buttons.
 *   Each button carries a `value` that will arrive in the card callback payload.
 *
 * Default button labels: "确认" (primary) / "取消" (danger).
 * Override with confirmLabel / cancelLabel.
 * Override button values with confirmValue / cancelValue (defaults: "confirm" / "cancel").
 *
 * Usage:
 *   const card = buildConfirmCard({
 *     title: '删除事件',
 *     body:  '确定要删除「周五团队同步」吗？此操作不可撤销。',
 *     confirmLabel: '删除',
 *     cancelLabel:  '保留',
 *   });
 *   // send card, then wait for callback with value "confirm" or "cancel"
 */

export type ConfirmCardOptions = {
  title:         string;
  body?:         string;
  template?:     'orange' | 'red' | 'blue' | 'green' | 'grey' | 'wathet';
  confirmLabel?: string;
  cancelLabel?:  string;
  confirmValue?: string;
  cancelValue?:  string;
};

export function buildConfirmCard(opts: ConfirmCardOptions): object {
  const {
    title,
    body,
    template      = 'orange',
    confirmLabel  = '确认',
    cancelLabel   = '取消',
    confirmValue  = 'confirm',
    cancelValue   = 'cancel',
  } = opts;

  const elements: object[] = [];

  if (body) {
    elements.push({ tag: 'markdown', content: body });
    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    background_style: 'default',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        weight: 1,
        vertical_align: 'top',
        elements: [{
          tag:  'button',
          type: 'primary',
          text: { tag: 'plain_text', content: confirmLabel },
          behaviors: [{
            type:  'callback',
            value: { action: confirmValue },
          }],
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        weight: 1,
        vertical_align: 'top',
        elements: [{
          tag:  'button',
          type: 'danger',
          text: { tag: 'plain_text', content: cancelLabel },
          behaviors: [{
            type:  'callback',
            value: { action: cancelValue },
          }],
        }],
      },
    ],
  });

  return {
    schema: '2.0',
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: { elements },
  };
}

/**
 * Build the "responded" state of a confirm card — replaces buttons with a status note.
 */
export function buildConfirmRespondedCard(
  opts: Pick<ConfirmCardOptions, 'title' | 'template'>,
  chosenLabel: string,
): object {
  return {
    schema: '2.0',
    header: {
      template: opts.template ?? 'grey',
      title:    { tag: 'plain_text', content: opts.title },
      subtitle: { tag: 'plain_text', content: `已选择：${chosenLabel}` },
    },
    body: {
      elements: [{
        tag:  'markdown',
        content: `**已提交**：${chosenLabel}`,
      }],
    },
  };
}
