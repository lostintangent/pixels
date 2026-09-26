import * as stylex from '@stylexjs/stylex';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import type { DropdownMenuItemData, DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Kbd } from '@astryxdesign/core/Kbd';
import { useSelector } from '@tanstack/react-store';
import {
  Check,
  Download,
  FilePlus2,
  FolderOpen,
  Grid3x3,
  Maximize,
  Minus,
  Monitor,
  Moon,
  Plus,
  Scaling,
  Scan,
  Sun,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { formatZoom, GRID_MIN_ZOOM } from '../core/zoom';
import { setAppearance, useAppearance } from '../session/appearance';
import type { Appearance } from '../session/appearance';
import type { Layout } from '../session/session';
import { useEditor, useEditorState } from './EditorContext';

const icon = (Glyph: typeof Check) => <Glyph size={16} strokeWidth={1.75} aria-hidden />;
const checked = (on: boolean): ReactElement | undefined => (on ? icon(Check) : undefined);

/** The document menu: file actions and app appearance behind the document's name. */
export function DocMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  const name = useEditorState((state) => state.document.name);
  const mode = useAppearance();
  const phone = layout === 'phone';
  const keys = (shortcut: string) => (phone ? undefined : <Kbd keys={shortcut} />);
  const appearance = (
    value: Appearance,
    label: string,
    glyph: typeof Check,
  ): DropdownMenuItemData => ({
    label,
    icon: icon(glyph),
    endContent: checked(mode === value),
    onClick: () => setAppearance(value),
  });

  const items: DropdownMenuOption[] = [
    {
      label: 'New canvas…',
      icon: icon(FilePlus2),
      endContent: keys('mod+alt+n'),
      onClick: () => session.run({ type: 'open', panel: 'new' }),
    },
    {
      label: 'Open PNG…',
      icon: icon(FolderOpen),
      endContent: keys('mod+o'),
      onClick: () => session.run({ type: 'open-file' }),
    },
    {
      label: 'Export PNG…',
      icon: icon(Download),
      endContent: keys('mod+shift+e'),
      onClick: () => session.run({ type: 'open', panel: 'export' }),
    },
    {
      label: 'Resize canvas…',
      icon: icon(Scaling),
      endContent: keys('mod+alt+c'),
      onClick: () => session.run({ type: 'open', panel: 'resize' }),
    },
    ...appearanceGroup(phone, [
      appearance('system', 'System', Monitor),
      appearance('light', 'Light', Sun),
      appearance('dark', 'Dark', Moon),
    ]),
  ];

  return (
    <DropdownMenu
      button={{ label: name, variant: 'ghost', icon: <Logo /> }}
      items={items}
      presentation={phone ? 'bottom-sheet' : 'popover'}
      menuWidth={264}
    />
  );
}

/** Zoom level as the trigger, with fit, actual size, and the grid behind it. */
export function ZoomMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  const zoom = useSelector(session.viewport, (view) => view.zoom);
  const grid = useEditorState((state) => state.gridEnabled);
  const phone = layout === 'phone';
  const keys = (shortcut: string) => (phone ? undefined : <Kbd keys={shortcut} />);

  const items: DropdownMenuOption[] = [
    {
      label: 'Zoom in',
      icon: icon(Plus),
      endContent: keys('mod+plus'),
      hasCloseOnSelect: false,
      onClick: () => session.run({ type: 'zoom', direction: 1 }),
    },
    {
      label: 'Zoom out',
      icon: icon(Minus),
      endContent: keys('mod+-'),
      hasCloseOnSelect: false,
      onClick: () => session.run({ type: 'zoom', direction: -1 }),
    },
    { type: 'divider' },
    {
      label: 'Fit to screen',
      icon: icon(Maximize),
      endContent: keys('mod+0'),
      onClick: () => session.run({ type: 'zoom-fit' }),
    },
    {
      label: 'Actual size',
      icon: icon(Scan),
      endContent: keys('mod+1'),
      onClick: () => session.run({ type: 'zoom-actual' }),
    },
    { type: 'divider' },
    {
      label: 'Pixel grid',
      icon: icon(Grid3x3),
      description: grid && zoom < GRID_MIN_ZOOM ? `Shows from ${GRID_MIN_ZOOM}×` : undefined,
      endContent: grid ? icon(Check) : keys("mod+'"),
      onClick: () => session.run({ type: 'toggle-grid' }),
    },
  ];

  return (
    <DropdownMenu
      button={{ label: formatZoom(zoom), variant: 'ghost' }}
      hasChevron={false}
      items={items}
      menuWidth={220}
      alignment={phone ? 'center' : 'end'}
      presentation={phone ? 'bottom-sheet' : 'popover'}
    />
  );
}

/** Four chunky pixels: the app mark, drawn in the product's own medium. */
function Logo() {
  return (
    <span aria-hidden {...stylex.props(styles.logo)}>
      {['#e8553d', '#ffd08a', '#1f8a8a', '#2c4cb0'].map((color) => (
        <i key={color} {...stylex.props(styles.logoPixel, styles.color(color))} />
      ))}
    </span>
  );
}

const styles = stylex.create({
  logo: { display: 'grid', gridTemplateColumns: 'repeat(2, 8px)', gap: 1, marginInlineEnd: 2 },
  logoPixel: { display: 'block', width: 8, height: 8, borderRadius: 1.5 },
  color: (color: string) => ({ backgroundColor: color }),
});

/** Pointer menus title the group. Touch sheets use a divider, since their headings sit flush left. */
function appearanceGroup(phone: boolean, items: DropdownMenuItemData[]): DropdownMenuOption[] {
  return phone
    ? [{ type: 'divider' }, ...items]
    : [{ type: 'section', title: 'Appearance', items }];
}
