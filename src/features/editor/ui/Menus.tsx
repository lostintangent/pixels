import * as stylex from '@stylexjs/stylex';
import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
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
  History,
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
import { snapZoom } from '../../canvas';
import { formatZoom, GRID_MIN_ZOOM } from '../core/zoom';
import { setAppearance, useAppearance } from '../session/appearance';
import type { Appearance } from '../session/appearance';
import type { Layout } from '../session/session';
import { preloadDialogs } from './dialogs';
import { useEditor, useEditorState } from './EditorContext';
import { useFileActions } from './files/FileActions';
import { formatEdited, useRecents } from './files/useRecents';
import type { RecentDocument } from './files/useRecents';

const icon = (Glyph: typeof Check) => <Glyph size={16} strokeWidth={1.75} aria-hidden />;
const checked = (on: boolean): ReactElement | undefined => (on ? icon(Check) : undefined);
const APPEARANCE_ICON: Record<Appearance, typeof Check> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * The document menu: file actions and app appearance behind the document's name.
 * Recent documents and appearance fly out so the top level stays one short, scannable list.
 */
export function DocMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  const files = useFileActions();
  const name = useEditorState((state) => state.document.name);
  const id = useSelector(session.bitmap, (document) => document.id);
  const { recents, refresh } = useRecents(files.store, id);
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
      onClick: () => files.pickFile(),
    },
    {
      label: 'Open recent',
      icon: icon(History),
      isDisabled: recents.length === 0,
      items: recents.map((recent) => ({
        id: recent.id,
        label: recent.name,
        description: `${recent.width} × ${recent.height} · ${formatEdited(recent.updatedAt)}`,
        icon: <Thumbnail recent={recent} />,
        onClick: () => files.openRecent(recent.id),
      })),
    },
    { type: 'divider' },
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
    { type: 'divider' },
    {
      label: 'Appearance',
      icon: icon(APPEARANCE_ICON[mode]),
      items: [
        appearance('system', 'System', Monitor),
        appearance('light', 'Light', Sun),
        appearance('dark', 'Dark', Moon),
      ],
    },
  ];

  return (
    <DropdownMenu
      button={{
        label: name,
        variant: 'ghost',
        icon: <Logo />,
        width: '100%',
        children: <span {...stylex.props(styles.name)}>{name}</span>,
      }}
      items={items}
      presentation={phone ? 'bottom-sheet' : 'popover'}
      menuWidth={264}
      onOpenChange={(open) => {
        if (!open) return;
        refresh();
        preloadDialogs();
      }}
    />
  );
}

/** Zoom level as the trigger, with fit, actual size, and the grid behind it. */
export function ZoomMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  // Every rest state sits on a ladder step. Mid-gesture, the label names the step the zoom
  // will settle to, so a pinch re-renders only when it crosses one.
  const zoom = useSelector(session.viewport, (view) => snapZoom(view.zoom));
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
  name: {
    minWidth: 0,
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  logo: { display: 'grid', gridTemplateColumns: 'repeat(2, 8px)', gap: 1, marginInlineEnd: 2 },
  logoPixel: { display: 'block', width: 8, height: 8, borderRadius: 1.5 },
  color: (color: string) => ({ backgroundColor: color }),
  thumb: {
    display: 'grid',
    placeItems: 'center',
    width: 28,
    height: 28,
    overflow: 'hidden',
    borderRadius: 6,
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-border']}`,
    backgroundImage:
      'repeating-conic-gradient(light-dark(#fff, #3a3a3c) 0 25%, light-dark(#ebebef, #313133) 0 50%)',
    backgroundSize: '6px 6px',
  },
  thumbImage: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    imageRendering: 'pixelated',
  },
});

/** The stored thumbnail at icon size, crisp and on a checker so transparency reads. */
function Thumbnail({ recent }: { recent: RecentDocument }) {
  return (
    <span aria-hidden {...stylex.props(styles.thumb)}>
      <img src={recent.thumbnail} alt="" {...stylex.props(styles.thumbImage)} />
    </span>
  );
}
