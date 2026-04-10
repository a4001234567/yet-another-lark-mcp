/**
 * Auth card templates.
 *
 * buildAuthCard(url)     — blue card with an "Authorize" button (before auth)
 * buildAuthSuccessCard() — green card, button disabled, "授权成功"
 * buildAuthFailCard()    — red card, button disabled, "授权失败"
 */

export function buildAuthCard(authUrl: string, description?: string): object {
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title:    { tag: 'plain_text', content: '用户授权' },
      subtitle: { tag: 'plain_text', content: '点击下方按钮完成授权' },
    },
    body: {
      elements: [
        {
          tag:     'markdown',
          content: description ?? '请点击下方按钮完成授权',
        },
        {
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: '进入授权' },
          behaviors: [{ type: 'open_url', default_url: authUrl }],
        },
      ],
    },
  };
}

export function buildAuthSuccessCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'green',
      title:    { tag: 'plain_text', content: '用户授权' },
      subtitle: { tag: 'plain_text', content: '授权成功' },
    },
    body: {
      elements: [
        {
          tag:      'button',
          name:     'DUMMY',
          type:     'primary',
          text:     { tag: 'plain_text', content: '进入授权' },
          disabled: true,
          behaviors: [],
        },
      ],
    },
  };
}

export function buildAuthFailCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'grey',
      title:    { tag: 'plain_text', content: '用户授权' },
      subtitle: { tag: 'plain_text', content: '授权失败，请重试' },
    },
    body: {
      elements: [
        {
          tag:      'button',
          name:     'DUMMY',
          type:     'primary',
          text:     { tag: 'plain_text', content: '进入授权' },
          disabled: true,
          behaviors: [],
        },
      ],
    },
  };
}

export function buildAuthDeniedCard(): object {
  return {
    schema: '2.0',
    header: {
      template: 'grey',
      title:    { tag: 'plain_text', content: '用户授权' },
      subtitle: { tag: 'plain_text', content: '已拒绝授权' },
    },
    body: {
      elements: [
        {
          tag:     'markdown',
          content: '您已取消授权。如需使用相关功能，请重新发起授权。',
        },
        {
          tag:      'button',
          name:     'DUMMY',
          type:     'primary',
          text:     { tag: 'plain_text', content: '进入授权' },
          disabled: true,
          behaviors: [],
        },
      ],
    },
  };
}
