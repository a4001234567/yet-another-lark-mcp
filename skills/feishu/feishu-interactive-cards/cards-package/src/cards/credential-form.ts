/**
 * Credential form card templates.
 *
 * buildCredentialFormCard()          — wathet card with username + password inputs
 * buildCredentialSubmittedCard(user) — same card, all fields disabled, shows "已提交"
 */

export function buildCredentialFormCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'wathet',
      title:    { tag: 'plain_text', content: '用户信息录入' },
      subtitle: { tag: 'plain_text', content: '记录您的学号与密码' },
    },
    body: {
      elements: [
        {
          tag:       'form',
          name:      'form',
          direction: 'vertical',
          elements: [
            {
              tag:         'input',
              element_id:  'username_01',
              name:        'username_input',
              required:    true,
              label:       { tag: 'plain_text', content: '学号：' },
              placeholder: { tag: 'plain_text', content: '请输入学号' },
            },
            {
              tag:         'input',
              element_id:  'password_01',
              name:        'password_input',
              required:    true,
              input_type:  'password',
              label:       { tag: 'plain_text', content: '密码：' },
              placeholder: { tag: 'plain_text', content: '请输入密码' },
            },
            {
              tag:             'button',
              element_id:      'button_01',
              name:            'dummy',
              type:            'primary',
              form_action_type: 'submit',
              action_type:     'form_submit',
              text:            { tag: 'plain_text', content: '提交' },
              required:        true,
            },
          ],
        },
      ],
    },
  };
}

export function buildCredentialSubmittedCard(username: string): object {
  return {
    schema: '2.0',
    header: {
      template: 'wathet',
      title:    { tag: 'plain_text', content: '用户信息录入' },
      subtitle: { tag: 'plain_text', content: '记录您的学号与密码' },
    },
    body: {
      elements: [
        {
          tag:       'form',
          name:      'form',
          direction: 'vertical',
          elements: [
            {
              tag:         'input',
              element_id:  'username_01',
              name:        'username_input',
              disabled:    true,
              label:       { tag: 'plain_text', content: '学号：' },
              placeholder: { tag: 'plain_text', content: username },
            },
            {
              tag:         'input',
              element_id:  'password_01',
              name:        'password_input',
              disabled:    true,
              input_type:  'password',
              label:       { tag: 'plain_text', content: '密码：' },
              placeholder: { tag: 'plain_text', content: '已提交' },
            },
            {
              tag:             'button',
              element_id:      'button_01',
              name:            'dummy',
              type:            'primary',
              form_action_type: 'submit',
              disabled:        true,
              text:            { tag: 'plain_text', content: '已提交' },
            },
          ],
        },
      ],
    },
  };
}
