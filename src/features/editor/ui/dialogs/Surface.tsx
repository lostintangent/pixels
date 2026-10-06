import * as stylex from '@stylexjs/stylex';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Link2, Unlink2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { canStepSide, sideProblem } from '../../core/dimensions';
import type { Layout } from '../../session/session';

export interface SurfaceProps {
  layout: Layout;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
}

/** One document flow, two presentations: a dialog on desktop, a sheet under the thumb on phones. */
export function Surface({
  layout,
  isOpen,
  onOpenChange,
  title,
  subtitle,
  width = 440,
  children,
}: SurfaceProps) {
  const finalFocus = useReturnFocus(isOpen, layout);
  if (layout === 'phone') {
    return (
      <BottomSheet
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        label={title}
        height="hug"
        purpose="form"
        finalFocusRef={finalFocus}
      >
        <div onKeyDown={wrapTab} {...stylex.props(styles.sheet)}>
          <div {...stylex.props(styles.sheetHead)}>
            <div {...stylex.props(styles.sheetTitle)}>{title}</div>
            {subtitle && <div {...stylex.props(styles.hint)}>{subtitle}</div>}
          </div>
          {children}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={width} purpose="form" padding={0}>
      <div onKeyDown={wrapTab} {...stylex.props(styles.contents)}>
        <div {...stylex.props(styles.header)}>
          <DialogHeader
            title={title}
            subtitle={subtitle}
            onOpenChange={onOpenChange}
            hasDivider={false}
          />
        </div>
        {children}
      </div>
    </Dialog>
  );
}

/**
 * Returns focus to whatever opened the surface, or to the canvas once that is gone, for
 * example a closed menu's item. The opener is read in a layout effect: a surface that mounts
 * already open would otherwise see its own header, which focuses its title on mount. The first
 * capture stands, since a replayed effect would see that title too.
 * The dialog restores in this parent effect, after Astryx's own attempt; the sheet takes the
 * target through `finalFocusRef` when its exit motion ends.
 */
function useReturnFocus(isOpen: boolean, layout: Layout) {
  const opener = useRef<HTMLElement | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!isOpen) return;
    opener.current ??= openerOf(document.activeElement);
  }, [isOpen]);
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const target = returnTarget(opener.current);
    opener.current = null;
    if (layout === 'phone') finalFocus.current = target;
    else target?.focus({ preventScroll: true });
  }, [isOpen, layout]);
  return finalFocus;
}

/**
 * A menu item closes with its menu, so the opener is the button that showed the menu: the one
 * naming it in `aria-controls`, or for a phone's sheet menu, the popup trigger it renders beside.
 */
function openerOf(active: Element | null): HTMLElement | null {
  let element = active;
  // A submenu climbs through its parent menu. The bound only guards against a malformed tree.
  for (let hops = 0; element && hops < 4; hops++) {
    const popup = element.closest('[role="menu"], dialog');
    if (!popup) break;
    element = triggerOf(popup);
  }
  return element instanceof HTMLElement && element !== document.body ? element : null;
}

function triggerOf(popup: Element): Element | null {
  if (popup.id) {
    const controller = document.querySelector(`[aria-controls="${CSS.escape(popup.id)}"]`);
    if (controller) return controller;
  }
  for (let host = popup.parentElement; host; host = host.parentElement) {
    const trigger = [...host.querySelectorAll('[aria-haspopup]')].find(
      (candidate) => !popup.contains(candidate),
    );
    if (trigger) return trigger;
  }
  return null;
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]';

/**
 * A modal dialog leaves the last Tab to the browser, which reads as focus escaping to the page.
 * The cycle wraps here instead, whichever controls are disabled.
 */
function wrapTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const dialog = event.currentTarget.closest('dialog');
  if (!dialog) return;
  const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.closest('[inert]') && element.checkVisibility(),
  );
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const wraps = event.shiftKey
    ? active === first || !stops.includes(active as HTMLElement)
    : active === last;
  if (!wraps) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  if (opener?.isConnected && !opener.closest('[inert], dialog:not([open])')) return opener;
  return document.querySelector<HTMLElement>('[role="application"]');
}

export function Form({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.form)}>{children}</div>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.hint)}>{children}</div>;
}

export interface FooterProps {
  layout: Layout;
  note: ReactNode;
  action: string;
  actionIcon?: ReactNode;
  isDisabled?: boolean;
  onAction: () => void;
  onCancel: () => void;
}

/** Summary on the left, one primary action on the right. Phones stack a full-width action. */
export function Footer({
  layout,
  note,
  action,
  actionIcon,
  isDisabled,
  onAction,
  onCancel,
}: FooterProps) {
  const phone = layout === 'phone';
  return (
    <div {...stylex.props(styles.footer, phone && styles.footerPhone)}>
      <span {...stylex.props(styles.note, phone && styles.notePhone)}>{note}</span>
      {!phone && <Button variant="ghost" label="Cancel" onClick={onCancel} />}
      <Button
        variant="primary"
        label={action}
        icon={actionIcon}
        isDisabled={isDisabled}
        width={phone ? '100%' : undefined}
        size={phone ? 'lg' : 'md'}
        onClick={onAction}
      />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>{label}</span>
      {children}
    </div>
  );
}

export function sideError(value: number): { type: 'error'; message: string } | undefined {
  const message = sideProblem(value);
  return message === null ? undefined : { type: 'error', message };
}

export interface DimensionsProps {
  width: number;
  height: number;
  onWidthChange: (value: number) => void;
  onHeightChange: (value: number) => void;
  isLinked: boolean;
  onLinkedChange: (isLinked: boolean) => void;
}

export function Dimensions({
  width,
  height,
  onWidthChange,
  onHeightChange,
  isLinked,
  onLinkedChange,
}: DimensionsProps) {
  const Glyph = isLinked ? Link2 : Unlink2;
  return (
    <div {...stylex.props(styles.dimensions)}>
      <SideInput label="Width" value={width} onChange={onWidthChange} />
      <div {...stylex.props(styles.link)}>
        <IconButton
          variant="ghost"
          label={isLinked ? 'Unlink width and height' : 'Link width and height'}
          tooltip={isLinked ? 'Unlink' : 'Link'}
          icon={<Glyph size={18} />}
          onClick={() => onLinkedChange(!isLinked)}
        />
      </div>
      <SideInput label="Height" value={height} onChange={onHeightChange} />
    </div>
  );
}

// No min or max: NumberInput would clamp silently, and a typo shouldn't become a 64 MiB canvas.
function SideInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <NumberInput
      label={label}
      value={value}
      onChange={onChange}
      formatValue={(side) => `${side} px`}
      status={sideError(value)}
      statusVariant="detached"
      onFocus={selectOnceEditable}
      onKeyDown={keepStepsInRange}
    />
  );
}

// Focus swaps "64 px" for "64" on the next render, which drops the caret at the end.
function selectOnceEditable(event: FocusEvent<HTMLInputElement>): void {
  const input = event.currentTarget;
  requestAnimationFrame(() => {
    if (document.activeElement === input) input.select();
  });
}

function keepStepsInRange(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const text = event.currentTarget.value.trim();
  if (!canStepSide(text === '' ? Number.NaN : Number(text), event.key === 'ArrowUp' ? 1 : -1))
    event.preventDefault();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = stylex.create({
  contents: { display: 'contents' },
  sheet: { display: 'flex', flexDirection: 'column', paddingTop: spacingVars['--spacing-5'] },
  sheetHead: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    paddingInline: 20,
    paddingBottom: 4,
  },
  sheetTitle: { fontSize: 17, fontWeight: 600 },
  hint: { fontSize: 13, color: colorVars['--color-text-secondary'] },
  header: {
    paddingTop: spacingVars['--spacing-5'],
    paddingInlineStart: spacingVars['--spacing-5'],
    paddingInlineEnd: spacingVars['--spacing-4'],
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    paddingTop: spacingVars['--spacing-4'],
    paddingInline: spacingVars['--spacing-5'],
    paddingBottom: spacingVars['--spacing-5'],
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingTop: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-5'],
    paddingBottom: spacingVars['--spacing-5'],
  },
  footerPhone: {
    flexDirection: 'column-reverse',
    alignItems: 'stretch',
    gap: spacingVars['--spacing-3'],
  },
  note: {
    flex: 1,
    fontSize: 13,
    color: colorVars['--color-text-secondary'],
    fontVariantNumeric: 'tabular-nums',
  },
  notePhone: { textAlign: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: 500 },
  dimensions: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    // Top-aligned so an error under one side doesn't shift the other.
    alignItems: 'start',
    gap: spacingVars['--spacing-2'],
  },
  // The field label's line plus its gap, which puts the button on the input row.
  link: { display: 'flex', marginTop: 24 },
});
