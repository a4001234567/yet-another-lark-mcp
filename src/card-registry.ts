/**
 * Card registry — tracks interactive cards sent by the MCP server.
 *
 * Registered cards have a type, expiry time, and optionally a blocking
 * Promise resolver. The ws.ts card.action.trigger handler looks up the
 * registry to return inline card updates; the watch loop drains expired
 * entries and patches them to a disabled state.
 */

export type CardType = 'confirm' | 'form';

export type FormField = {
  name:         string;
  label:        string;
  placeholder?: string;
  required?:    boolean;
  hidden?:      boolean;
};

export type CardEntry = {
  card_type: CardType;
  title:         string;
  body?:         string;
  // confirm-specific
  confirm_label: string;
  cancel_label:  string;
  template?:     'red' | 'orange' | 'blue' | 'green' | 'grey' | 'wathet';
  // form-specific
  fields?:       FormField[];
  submit_label?: string;
  expiry_at:     number;
  // Blocking mode — resolved by callback. Promise.race handles timeout, so reject is not needed.
  resolve?: (result: { action: string; form_value?: Record<string, string> }) => void;
};

const registry = new Map<string, CardEntry>();

export function registerCard(message_id: string, entry: CardEntry): void {
  registry.set(message_id, entry);
}

export function lookupCard(message_id: string): CardEntry | undefined {
  return registry.get(message_id);
}

export function removeCard(message_id: string): void {
  registry.delete(message_id);
}

/** Called by the watch loop each tick — returns expired entries and removes them. */
export function drainExpiredCards(): Array<{ message_id: string; entry: CardEntry }> {
  const now = Date.now();
  const expired: Array<{ message_id: string; entry: CardEntry }> = [];
  for (const [message_id, entry] of registry.entries()) {
    if (entry.expiry_at <= now) {
      expired.push({ message_id, entry });
      registry.delete(message_id);
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Shared button row builder
// ---------------------------------------------------------------------------

function confirmButtonRow(
  confirm_label: string,
  cancel_label:  string,
  laser:         'confirm' | 'cancel' | 'none',
  disabled:      boolean,
  disabled_tips?: string,
): object {
  const tip = disabled_tips ? { tag: 'plain_text', content: disabled_tips } : undefined;
  const btn = (label: string, action: string, isLaser: boolean) => ({
    tag:      'button',
    type:     isLaser ? 'laser' : 'default',
    disabled,
    ...(tip && { disabled_tips: tip }),
    text:     { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { action } }],
  });
  return {
    tag:              'column_set',
    flex_mode:        'bisect',
    background_style: 'default',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
        elements: [btn(confirm_label, 'confirm', laser === 'confirm')] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
        elements: [btn(cancel_label,  'cancel',  laser === 'cancel')]  },
    ],
  };
}

// ---------------------------------------------------------------------------
// Card state builders
// ---------------------------------------------------------------------------

type ConfirmBase = Pick<CardEntry, 'title' | 'body' | 'confirm_label' | 'cancel_label' | 'template'>;

export function buildConfirmActiveCard(e: ConfirmBase): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: e.template ?? 'red', title: { tag: 'plain_text', content: e.title } },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }, { tag: 'hr' }] : []),
        confirmButtonRow(e.confirm_label, e.cancel_label, 'none', false),
      ],
    },
  };
}

export function buildConfirmRespondedCard(e: ConfirmBase, action: string): object {
  const confirmed = action === 'confirm';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: confirmed ? 'green' : 'violet',
      title:    { tag: 'plain_text', content: e.title },
      subtitle: { tag: 'plain_text', content: confirmed ? '已确认' : '已取消' },
    },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }, { tag: 'hr' }] : []),
        confirmButtonRow(e.confirm_label, e.cancel_label,
          confirmed ? 'confirm' : 'cancel', true),
      ],
    },
  };
}

export function buildConfirmExpiredCard(e: ConfirmBase): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'grey',
      title:    { tag: 'plain_text', content: e.title },
      subtitle: { tag: 'plain_text', content: '已失效' },
    },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }, { tag: 'hr' }] : []),
        confirmButtonRow(e.confirm_label, e.cancel_label, 'none', true, '交互已失效'),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Form card builders
// ---------------------------------------------------------------------------

type FormBase = Pick<CardEntry, 'title' | 'body' | 'fields' | 'submit_label'>;

function formInputs(fields: FormField[], disabled: boolean, form_value?: Record<string, string>): object[] {
  return fields.map((f, i) => ({
    tag:         'input',
    element_id:  `field_${i}`,
    name:        f.name,
    required:    disabled ? false : (f.required ?? false),
    disabled,
    ...(f.hidden ? { input_type: 'password' } : {}),
    label:       { tag: 'plain_text', content: f.label },
    placeholder: { tag: 'plain_text', content:
      disabled
        ? (f.hidden ? '******' : (form_value?.[f.name] ?? ''))
        : (f.placeholder ?? '') },
  }));
}

export function buildFormActiveCard(e: FormBase): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template: 'wathet', title: { tag: 'plain_text', content: e.title } },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }] : []),
        {
          tag: 'form', name: 'form', direction: 'vertical',
          elements: [
            ...formInputs(e.fields ?? [], false),
            {
              tag: 'button', element_id: 'submit_btn', name: 'dummy',
              type: 'primary', form_action_type: 'submit',
              text: { tag: 'plain_text', content: e.submit_label ?? '提交' },
            },
          ],
        },
      ],
    },
  };
}

export function buildFormSubmittedCard(e: FormBase, form_value: Record<string, string>): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'green',
      title:    { tag: 'plain_text', content: e.title },
      subtitle: { tag: 'plain_text', content: '已提交' },
    },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }] : []),
        {
          tag: 'form', name: 'form', direction: 'vertical',
          elements: [
            ...formInputs(e.fields ?? [], true, form_value),
            {
              tag: 'button', element_id: 'submit_btn', name: 'dummy',
              type: 'primary', form_action_type: 'submit', disabled: true,
              text: { tag: 'plain_text', content: '已提交' },
            },
          ],
        },
      ],
    },
  };
}

export function buildFormExpiredCard(e: FormBase): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'grey',
      title:    { tag: 'plain_text', content: e.title },
      subtitle: { tag: 'plain_text', content: '已失效' },
    },
    body: {
      elements: [
        ...(e.body ? [{ tag: 'markdown', content: e.body }] : []),
        {
          tag: 'form', name: 'form', direction: 'vertical',
          elements: [
            ...formInputs(e.fields ?? [], true),
            {
              tag: 'button', element_id: 'submit_btn', name: 'dummy',
              type: 'default', form_action_type: 'submit', disabled: true,
              disabled_tips: { tag: 'plain_text', content: '交互已失效' },
              text: { tag: 'plain_text', content: '已失效' },
            },
          ],
        },
      ],
    },
  };
}

// Note: inline card updates via the WS response ARE supported.
// ws.ts returns { toast, card: { type: 'raw', data: <card> } } from the card.action.trigger
// handler, and Lark applies the update immediately. The monkey-patch that remaps
// type="card"→"event" for the SDK dispatcher does not affect Lark's ability to parse
// the card field in the ack response.
