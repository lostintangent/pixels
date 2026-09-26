import * as stylex from '@stylexjs/stylex';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Link2, Unlink2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { MAX_DOCUMENT_SIDE } from '../../../document';
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
  if (layout === 'phone') {
    return (
      <BottomSheet
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        label={title}
        height="hug"
        purpose="form"
      >
        <div {...stylex.props(styles.sheet)}>
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
      <div {...stylex.props(styles.header)}>
        <DialogHeader
          title={title}
          subtitle={subtitle}
          onOpenChange={onOpenChange}
          hasDivider={false}
        />
      </div>
      {children}
    </Dialog>
  );
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
  if (!Number.isInteger(value) || value < 1) return { type: 'error', message: 'At least 1 px' };
  if (value > MAX_DOCUMENT_SIDE) return { type: 'error', message: `Up to ${MAX_DOCUMENT_SIDE} px` };
  return undefined;
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
      <NumberInput
        label="Width"
        value={width}
        onChange={onWidthChange}
        min={1}
        max={MAX_DOCUMENT_SIDE}
        formatValue={(value) => `${value} px`}
        status={sideError(width)}
        statusVariant="detached"
      />
      <IconButton
        variant="ghost"
        label={isLinked ? 'Unlink width and height' : 'Link width and height'}
        tooltip={isLinked ? 'Unlink' : 'Link'}
        icon={<Glyph size={18} />}
        onClick={() => onLinkedChange(!isLinked)}
      />
      <NumberInput
        label="Height"
        value={height}
        onChange={onHeightChange}
        min={1}
        max={MAX_DOCUMENT_SIDE}
        formatValue={(value) => `${value} px`}
        status={sideError(height)}
        statusVariant="detached"
      />
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = stylex.create({
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
    alignItems: 'end',
    gap: spacingVars['--spacing-2'],
  },
});
