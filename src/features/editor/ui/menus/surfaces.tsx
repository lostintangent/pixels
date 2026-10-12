import * as stylex from '@stylexjs/stylex';
import { colorVars, sizeVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
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
  SquareDot,
  Sun,
  TextCursorInput,
} from 'lucide-react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { DOCUMENT_NAME_MAX_LENGTH } from '../../../files';
import { GRID_MIN_ZOOM } from '../../core/zoom';
import { setAppearance, useAppearance } from '../../session/appearance';
import type { Appearance } from '../../session/appearance';
import { preloadDialogs } from '../dialogs';
import { useEditor, useEditorState } from '../EditorContext';
import { useFileActions } from '../files/FileActions';
import { formatEdited, useRecents } from '../files/useRecents';
import type { RecentDocument } from '../files/useRecents';
import { exposeCheckedState } from './checked';
import type { CheckedKind } from './checked';
import { Logo } from './index';
import type { MenuSurfaceProps } from './index';

const icon = (Glyph: typeof Check) => <Glyph size={16} strokeWidth={1.75} aria-hidden />;
const APPEARANCE_ICON: Record<Appearance, typeof Check> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * The menus behind the chrome's triggers. This module loads at idle or on first intent, so
 * item lists, recents, and their icons never weigh on the first paint.
 */

/**
 * The document menu: file actions and app appearance behind the document's name.
 * Recent documents and appearance fly out so the top level stays one short, scannable list.
 */
export function DocMenu({ layout, isMenuOpen, ...trigger }: MenuSurfaceProps) {
  const session = useEditor();
  const files = useFileActions();
  const id = useSelector(session.bitmap, (document) => document.id);
  const { recents, refresh } = useRecents(files.store, id);
  const mode = useAppearance();
  const phone = layout === 'phone';
  const keys = (shortcut: string) => (phone ? undefined : <Shortcut keys={shortcut} />);
  const appearance = (
    value: Appearance,
    label: string,
    glyph: typeof Check,
  ): DropdownMenuItemData => ({
    label,
    icon: icon(glyph),
    endContent: <Checked kind="radio" isChecked={mode === value} />,
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
      label: 'Rename…',
      icon: icon(TextCursorInput),
      onClick: () => session.setPanel('rename'),
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

  // Runs however the menu opened, including a press handed over from the stand-in trigger.
  const opened = useEffectEvent(() => {
    refresh();
    preloadDialogs();
  });
  useEffect(() => {
    if (isMenuOpen) opened();
  }, [isMenuOpen]);

  return (
    <DropdownMenu
      {...trigger}
      isMenuOpen={isMenuOpen}
      items={items}
      presentation={phone ? 'bottom-sheet' : 'popover'}
      menuWidth={264}
    />
  );
}

/** Zoom level as the trigger, with fit, actual size, and the grid behind it. */
export function ZoomMenu({ layout, isMenuOpen, ...trigger }: MenuSurfaceProps) {
  const session = useEditor();
  const gridTooSmall = useSelector(session.viewport, (view) => view.zoom < GRID_MIN_ZOOM);
  const grid = useEditorState((state) => state.gridEnabled);
  const phone = layout === 'phone';
  const keys = (shortcut: string) => (phone ? undefined : <Shortcut keys={shortcut} />);

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
      // U+2212, the minus sign the zoom button's tooltip shows, not a hyphen.
      endContent: keys('mod+\u2212'),
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
      icon: icon(SquareDot),
      endContent: keys('mod+1'),
      onClick: () => session.run({ type: 'zoom-actual' }),
    },
    { type: 'divider' },
    {
      label: 'Pixel grid',
      icon: icon(Grid3x3),
      description: grid && gridTooSmall ? `Shows from ${GRID_MIN_ZOOM}×` : undefined,
      endContent: (
        <Checked kind="checkbox" isChecked={grid}>
          {keys("mod+'")}
        </Checked>
      ),
      onClick: () => session.run({ type: 'toggle-grid' }),
    },
  ];

  return (
    <DropdownMenu
      {...trigger}
      isMenuOpen={isMenuOpen}
      items={items}
      menuWidth={220}
      alignment={phone ? 'center' : 'end'}
      presentation={phone ? 'bottom-sheet' : 'popover'}
    />
  );
}

/**
 * The title pill, editable in place like a Finder or Preview title. It opens with the whole name
 * selected. Enter or a press elsewhere commits, and Escape cancels. A press on the canvas only
 * commits, so dismissing the field never paints.
 */
export function RenameField({ onDone }: { onDone: (restoreFocus: boolean) => void }) {
  const files = useFileActions();
  const name = useEditorState((state) => state.document.name);
  const field = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  const finish = useEffectEvent((commit: boolean, restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit && input.current) files.rename(input.current.value);
    onDone(restoreFocus);
  });

  // Focus within the menu press that asked for it, so a phone raises its keyboard.
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);

  useEffect(() => {
    const press = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && field.current?.contains(target)) return;
      if (target?.closest('[role="application"]')) {
        event.preventDefault();
        event.stopPropagation();
      }
      finish(true, false);
    };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, []);

  return (
    <span ref={field} {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.mark)}>
        <Logo />
      </span>
      <input
        ref={input}
        defaultValue={name}
        aria-label="Document name"
        maxLength={DOCUMENT_NAME_MAX_LENGTH}
        enterKeyHint="done"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        {...stylex.props(styles.input)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== 'Enter' && event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === 'Enter', true);
        }}
        onBlur={() => finish(true, false)}
      />
    </span>
  );
}

const styles = stylex.create({
  // Same box, mark, and type as the title pill, so the name doesn't move when it becomes editable.
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    boxSizing: 'border-box',
    height: sizeVars['--size-element-md'],
    paddingInline: spacingVars['--spacing-3'],
    borderRadius: 10,
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: `inset 0 0 0 2px ${colorVars['--color-text-primary']}`,
    cursor: 'text',
    minWidth: 0,
    flexShrink: 1,
  },
  // Astryx centers a button's icon in a 16px slot. The mark is wider, so it overhangs evenly.
  mark: { display: 'flex', justifyContent: 'center', flexShrink: 0, width: 16 },
  input: {
    // No wider than the resting name, and narrower when its island runs out of room.
    minWidth: 96,
    maxWidth: 240,
    flexShrink: 1,
    fieldSizing: 'content',
    padding: 0,
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '20px',
    textOverflow: 'ellipsis',
  },
  checked: { display: 'flex', alignItems: 'center', gap: spacingVars['--spacing-2'] },
  shortcut: { display: { default: 'contents', '@media (pointer: coarse)': 'none' } },
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

/** A menu row's shortcut. Hidden on touch, where it's noise beside a 44px row. */
function Shortcut({ keys }: { keys: string }) {
  return (
    <span {...stylex.props(styles.shortcut)}>
      <Kbd keys={keys} />
    </span>
  );
}

/**
 * A row's trailing check, which also gives the row its checked role and state. A shortcut stays
 * beside the check rather than giving way to it.
 */
function Checked({
  kind,
  isChecked,
  children,
}: {
  kind: CheckedKind;
  isChecked: boolean;
  children?: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (anchor.current) exposeCheckedState(anchor.current, kind, isChecked);
  }, [kind, isChecked]);
  return (
    <span ref={anchor} {...stylex.props(styles.checked)}>
      {isChecked && icon(Check)}
      {children}
    </span>
  );
}

/** The stored thumbnail at icon size, crisp and on a checker so transparency reads. */
function Thumbnail({ recent }: { recent: RecentDocument }) {
  return (
    <span aria-hidden {...stylex.props(styles.thumb)}>
      <img src={recent.thumbnail} alt="" {...stylex.props(styles.thumbImage)} />
    </span>
  );
}
