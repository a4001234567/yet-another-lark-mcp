/**
 * Progress card builder for Lark interactive cards (schema 2.0).
 *
 * Renders a collapsible-panel step list with a linear progress bar.
 * - Done steps:    grey background, grey text, collapsed
 * - Active step:   blue background, white bold text, expanded
 * - Pending steps: no background, normal text, collapsed
 */

export type ProgressStep = {
  label: string;
  detail?: string;  // content shown when panel is expanded
};

/**
 * Build a Lark card 2.0 JSON object for task progress display.
 *
 * @param title        Card header title (e.g. "任务进度")
 * @param steps        Ordered list of steps
 * @param currentStep  0-based index of the currently active step.
 *                     Pass steps.length to render the completed state (green header, 100%).
 */
export function buildProgressCard(
  title: string,
  steps: ProgressStep[],
  currentStep: number,
): object {
  const total   = steps.length;
  const done    = currentStep >= total;
  const percent = done ? 1 : currentStep / total;
  const subtitle = done ? '已完成' : `第 ${currentStep + 1}/${total} 步进行中`;

  const panels = steps.map((step, i) => {
    const isDone    = done || i < currentStep;
    const isActive  = !done && i === currentStep;
    const isPending = !done && i > currentStep;

    let titleContent: string;
    let bgColor: string | undefined;
    let iconColor: string;
    let textColor: string;

    if (isDone) {
      titleContent = `<font color="grey">${step.label}</font>`;
      bgColor      = 'grey';
      iconColor    = 'grey';
      textColor    = 'grey';
    } else if (isActive) {
      titleContent = `**<font color="white">${step.label}</font>**`;
      bgColor      = 'blue';
      iconColor    = 'white';
      textColor    = 'white';
    } else {
      titleContent = step.label;
      bgColor      = undefined;
      iconColor    = 'grey';
      textColor    = 'default';
    }

    const panel: any = {
      tag: 'collapsible_panel',
      expanded: isActive,
      header: {
        title: { tag: 'markdown', content: titleContent },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          color: iconColor,
          size: '16px 16px',
        },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        { tag: 'markdown', content: step.detail ?? step.label },
      ],
    };

    if (bgColor !== undefined) {
      panel.header.background_color = bgColor;
    }

    return panel;
  });

  const progressBar = {
    tag: 'chart',
    height: '32px',
    preview: false,
    chart_spec: {
      type: 'linearProgress',
      height: 20,
      data: {
        values: [{ type: '', value: Math.min(1, Math.max(0, percent)) }],
      },
      direction: 'horizontal',
      xField: 'value',
      yField: 'type',
      seriesField: 'type',
      axes: [
        { orient: 'left',   visible: false },
        { orient: 'bottom', visible: false },
      ],
      label:   { visible: false },
      padding: [8, 8, 4, 8],
    },
  };

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: done ? 'green' : 'blue',
      title:    { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: subtitle },
    },
    body: {
      elements: [
        ...panels,
        { tag: 'hr' },
        progressBar,
      ],
    },
  };
}
