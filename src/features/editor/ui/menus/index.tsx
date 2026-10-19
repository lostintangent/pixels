import * as stylex from '@stylexjs/stylex';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuButtonProps } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
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
          // Lets the name give way to the size and save status when its island runs out of room.
          xstyle: styles.docButton,
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
  const level = formatZoom(displayZoom(session.viewport.state, session.viewBounds()?.minZoom));
  return (
    <DeferredMenu
      surface="ZoomMenu"
      layout={layout}
      button={{
        label: `Zoom ${level}`,
        variant: 'ghost',
        xstyle: styles.zoom,
        // The widest levels share the cell invisibly, so a new level never resizes its island.
        children: <ZoomLevel initialLevel={level} />,
      }}
      hasChevron={false}
    />
  );
}

/** A pinch can cross several labels. Keep the small trigger current without rendering its menu. */
function ZoomLevel({ initialLevel }: { initialLevel: string }) {
  const session = useEditor();
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const update = (forceName = false) => {
      const node = label.current;
      if (!node) return;
      const level = formatZoom(displayZoom(session.viewport.state, session.viewBounds()?.minZoom));
      if (node.textContent !== level) {
        node.textContent = level;
        forceName = true;
      }
      if (forceName) node.closest('button')?.setAttribute('aria-label', `Zoom ${level}`);
    };
    update(true);
    const { unsubscribe } = session.viewport.subscribe(() => update());
    return unsubscribe;
  });
  return (
    <span {...stylex.props(styles.level)}>
      <span ref={label} {...stylex.props(styles.stack)}>
        {initialLevel}
      </span>
      {WIDEST_LEVELS.map((widest) => (
        <span key={widest} aria-hidden {...stylex.props(styles.stack, styles.ghost)}>
          {widest}
        </span>
      ))}
    </span>
  );
}

/** The longest labels formatZoom can produce, at and below 1×. */
const WIDEST_LEVELS = ['128×', '12.5%'];

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
  docButton: { minWidth: 0 },
  name: {
    display: 'block',
    minWidth: 0,
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Short levels like 1× would otherwise fall under a touch target.
  zoom: { minWidth: { default: null, '@media (pointer: coarse)': 44 } },
  level: { display: 'inline-grid', justifyItems: 'center', fontVariantNumeric: 'tabular-nums' },
  stack: { gridArea: '1 / 1' },
  ghost: { visibility: 'hidden' },
  logo: { display: 'grid', gridTemplateColumns: 'repeat(2, 8px)', gap: 1, marginInlineEnd: 2 },
  logoPixel: { display: 'block', width: 8, height: 8, borderRadius: 1.5 },
  color: (color: string) => ({ backgroundColor: color }),
});
