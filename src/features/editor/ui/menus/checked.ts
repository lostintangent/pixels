/** The slice of `Element` the checked-state adapter touches, so its test runs without a DOM. */
export interface CheckedAnchor {
  closest(selector: string): CheckedTarget | null;
}

interface CheckedTarget {
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): CheckedTarget | null;
}

export type CheckedKind = 'radio' | 'checkbox';

/**
 * Astryx's data-driven menu renders every row as a plain `menuitem` in a popover and a plain
 * button in a phone sheet, and its compound radio and checkbox rows draw a leading control and
 * can't present as a sheet. So a row's trailing check marks its own row from inside: a popover
 * row becomes `menuitemradio` or `menuitemcheckbox`, which Astryx already roves and activates,
 * and a sheet row's button becomes `radio` or `checkbox`. Both carry `aria-checked`.
 */
export function exposeCheckedState(anchor: CheckedAnchor, kind: CheckedKind, checked: boolean) {
  const state = String(checked);
  const row = anchor.closest('[role^="menuitem"]');
  if (row) {
    row.setAttribute('role', kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox');
    row.setAttribute('aria-checked', state);
    return;
  }
  const control = anchor.closest('li')?.querySelector('button');
  if (!control) return;
  control.setAttribute('role', kind);
  control.setAttribute('aria-checked', state);
}
