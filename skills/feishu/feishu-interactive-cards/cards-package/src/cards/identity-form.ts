/**
 * Identity verification form card.
 *
 * buildIdentityFormCard()             — wathet form with name, ID number, phone
 * buildIdentitySubmittedCard(name)    — same card, all fields disabled, shows "已提交"
 */

export function buildIdentityFormCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'wathet',
      title:    { tag: 'plain_text', content: '身份信息录入' },
      subtitle: { tag: 'plain_text', content: '请填写真实姓名、身份证号和手机号' },
    },
    body: {
      elements: [
        {
          tag:       'form',
          name:      'identity_form',
          direction: 'vertical',
          elements: [
            {
              tag:         'input',
              element_id:  'name_01',
              name:        'name_input',
              required:    true,
              label:       { tag: 'plain_text', content: '姓名：' },
              placeholder: { tag: 'plain_text', content: '请输入真实姓名' },
            },
            {
              tag:         'input',
              element_id:  'id_number_01',
              name:        'id_number_input',
              required:    true,
              label:       { tag: 'plain_text', content: '身份证号：' },
              placeholder: { tag: 'plain_text', content: '请输入18位身份证号' },
            },
            {
              tag:         'input',
              element_id:  'phone_01',
              name:        'phone_input',
              required:    true,
              label:       { tag: 'plain_text', content: '手机号：' },
              placeholder: { tag: 'plain_text', content: '请输入手机号' },
            },
            {
              tag:              'button',
              element_id:       'submit_01',
              name:             'dummy',
              type:             'primary',
              form_action_type: 'submit',
              text:             { tag: 'plain_text', content: '提交' },
              required:         true,
            },
          ],
        },
      ],
    },
  };
}

export function buildIdentitySubmittedCard(name: string): object {
  return {
    schema: '2.0',
    header: {
      template: 'green',
      title:    { tag: 'plain_text', content: '身份信息录入' },
      subtitle: { tag: 'plain_text', content: '提交成功' },
    },
    body: {
      elements: [
        {
          tag:       'form',
          name:      'identity_form',
          direction: 'vertical',
          elements: [
            {
              tag:         'input',
              element_id:  'name_01',
              name:        'name_input',
              disabled:    true,
              label:       { tag: 'plain_text', content: '姓名：' },
              placeholder: { tag: 'plain_text', content: name },
            },
            {
              tag:         'input',
              element_id:  'id_number_01',
              name:        'id_number_input',
              disabled:    true,
              label:       { tag: 'plain_text', content: '身份证号：' },
              placeholder: { tag: 'plain_text', content: '已提交' },
            },
            {
              tag:         'input',
              element_id:  'phone_01',
              name:        'phone_input',
              disabled:    true,
              label:       { tag: 'plain_text', content: '手机号：' },
              placeholder: { tag: 'plain_text', content: '已提交' },
            },
            {
              tag:              'button',
              element_id:       'submit_01',
              name:             'dummy',
              type:             'primary',
              form_action_type: 'submit',
              disabled:         true,
              text:             { tag: 'plain_text', content: '已提交' },
            },
          ],
        },
      ],
    },
  };
}
