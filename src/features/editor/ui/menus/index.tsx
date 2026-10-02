import * as stylex from '@stylexjs/stylex';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuButtonProps } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { useSelector } from '@tanstack/react-store';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { displayZoom, formatZoom } from '../../core/zoom';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';

/**
 * The chrome's menus, split in two. The triggers here paint with the editor. Everything behind
 * them, including DropdownMenu, its bottom sheet, the item lists, and their icons, lives in
 * `./surfaces` and loads at idle or on first intent.
 */

/** What a trigger hands its menu: the same button it painted, plus a controlled open state. */
export interface MenuSurfaceProps {
  layout: Layout;
  button: DropdownMenuButtonProps;
  hasChevron: boolean;
  isMenuOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The document's name, behind which sit file actions and appearance. Rename edits it in place. */
export function DocMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  const name = useEditorState((state) => (state.opening ? 'Opening…' : state.document.name));
  const renaming = useEditorState((state) => state.panel === 'rename');
  // Rename is only offered from the menu, so its field has always arrived with it.
  const menus = useSyncExternalStore(subscribe, loaded, loaded);
  const host = useRef<HTMLSpanElement>(null);
  const refocus = useRef(false);

  // Enter and Escape hand focus back to the name. A press elsewhere keeps it where it landed.
  useLayoutEffect(() => {
    if (renaming || !refocus.current) return;
    refocus.current = false;
    host.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [renaming]);

  if (renaming && menus) {
    return (
      <span ref={host} {...stylex.props(styles.host)}>
        <menus.RenameField
          layout={layout}
          onDone={(restoreFocus) => {
            refocus.current = restoreFocus;
            session.setPanel(null);
          }}
        />
      </span>
    );
  }
  return (
    <span ref={host} {...stylex.props(styles.host)}>
      <DeferredMenu
        surface="DocMenu"
        layout={layout}
        button={{
          label: name,
          variant: 'ghost',
          icon: <Logo />,
          width: '100%',
          // Polite, so "Opening…" and a failed open's restored name reach screen readers.
          children: (
            <span aria-live="polite" {...stylex.props(styles.name)}>
              {name}
            </span>
          ),
        }}
      />
    </span>
  );
}

/** The zoom level, behind which sit fit, actual size, and the grid. */
export function ZoomMenu({ layout }: { layout: Layout }) {
  const session = useEditor();
  // Whole-number fits keep their exact label. Mid-pinch labels still change only at ladder steps.
  const zoom = useSelector(session.viewport, displayZoom);
  return (
    <DeferredMenu
      surface="ZoomMenu"
      layout={layout}
      button={{ label: formatZoom(zoom), variant: 'ghost', xstyle: styles.zoom }}
      hasChevron={false}
    />
  );
}

type Surfaces = typeof import('./surfaces');

let surfaces: Surfaces | null = null;
let loading: Promise<void> | undefined;
const arrivals = new Set<() => void>();

/** Fetches the menus. Safe to call often, and a failed fetch is retried on the next intent. */
export function preloadMenus(): void {
  loading ??= import('./surfaces').then(
    (module) => {
      surfaces = module;
      for (const notify of arrivals) notify();
    },
    (error: unknown) => {
      console.error(error);
      loading = undefined;
    },
  );
}

const subscribe = (notify: () => void) => {
  arrivals.add(notify);
  return () => void arrivals.delete(notify);
};
const loaded = () => surfaces;

interface DeferredMenuProps {
  surface: 'DocMenu' | 'ZoomMenu';
  layout: Layout;
  button: DropdownMenuButtonProps;
  hasChevron?: boolean;
}

/**
 * Until the menus arrive, the same Astryx Button stands in for DropdownMenu's trigger, pixel for
 * pixel. A press or focus that lands first is handed to the real menu when it mounts.
 */
function DeferredMenu({ surface, layout, button, hasChevron = true }: DeferredMenuProps) {
  const menus = useSyncExternalStore(subscribe, loaded, loaded);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const handoff = useRef({ open: false, focus: false });

  const takeOver = useEffectEvent(() => {
    const { open, focus } = handoff.current;
    handoff.current = { open: false, focus: false };
    if (focus || open) host.current?.querySelector('button')?.focus({ preventScroll: true });
    // Opening after mount, rather than mounting open, lets the menu move focus to its first item.
    if (open) setMenuOpen(true);
  });
  useEffect(() => {
    if (menus) takeOver();
  }, [menus]);

  if (menus) {
    const Surface = menus[surface];
    return (
      <span ref={host} {...stylex.props(styles.host)}>
        <Surface
          layout={layout}
          button={button}
          hasChevron={hasChevron}
          isMenuOpen={isMenuOpen}
          onOpenChange={setMenuOpen}
        />
      </span>
    );
  }

  return (
    <span ref={host} {...stylex.props(styles.host)}>
      <Button
        {...button}
        endContent={
          button.endContent ??
          (hasChevron && !button.isIconOnly ? (
            <Icon icon="chevronDown" size="sm" color="inherit" />
          ) : undefined)
        }
        aria-haspopup={layout === 'phone' ? 'dialog' : 'menu'}
        aria-expanded={false}
        onPointerEnter={preloadMenus}
        onFocus={() => {
          handoff.current.focus = true;
          preloadMenus();
        }}
        onBlur={() => {
          handoff.current.focus = false;
        }}
        onClick={() => {
          handoff.current.open = true;
          preloadMenus();
        }}
      />
    </span>
  );
}

/** Four chunky pixels: the app mark, drawn in the product's own medium. */
export function Logo() {
  return (
    <span aria-hidden {...stylex.props(styles.logo)}>
      {['#e8553d', '#ffd08a', '#1f8a8a', '#2c4cb0'].map((color) => (
        <i key={color} {...stylex.props(styles.logoPixel, styles.color(color))} />
      ))}
    </span>
  );
}

const styles = stylex.create({
  // The trigger stays a direct layout child of whichever island holds it.
  host: { display: 'contents' },
  name: {
    minWidth: 0,
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Short levels like 1× would otherwise fall under a touch target.
  zoom: { minWidth: { default: null, '@media (pointer: coarse)': 44 } },
  logo: { display: 'grid', gridTemplateColumns: 'repeat(2, 8px)', gap: 1, marginInlineEnd: 2 },
  logoPixel: { display: 'block', width: 8, height: 8, borderRadius: 1.5 },
  color: (color: string) => ({ backgroundColor: color }),
});
