import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import {
  colorVars,
  durationVars,
  radiusVars,
  sizeVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import type { ToastViewportProps } from '@astryxdesign/core/Toast';
import { getRouteApi } from '@tanstack/react-router';
import { useSelector } from '@tanstack/react-store';
import { Grid3x3, Minus, Plus, Redo2, Undo2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { RefObject } from 'react';
import { CanvasSurface, MAX_ZOOM, MIN_ZOOM } from '../../canvas';
import type { CanvasInput, CanvasPointerSample, OverlayState } from '../../canvas';
import type { BitmapDocument } from '../../document';
import type { DocumentStore } from '../../files';
import {
  ColorPanel,
  ColorPickerPopover,
  ColorSheet,
  ColorWell,
  DEFAULT_PALETTE,
  PaletteColorSpace,
  RECENT_LIMIT,
} from '../../palette';
import type { EditorCommand } from '../core/shortcuts';
import { sameToolPreferences } from '../core/preferences';
import { toolPreferences } from '../core/state';
import type { ColorSlot, ToolPreferences } from '../core/state';
import { usesBrush } from '../core/tools';
import type { EditorTool, ShapeKind } from '../core/tools';
import { useColorScheme } from '../session/appearance';
import type { ColorScheme } from '../session/appearance';
import { readToolPreferences, writeToolPreferences } from '../session/preferences';
import { createEditorSession, DESKTOP_FRAME } from '../session/session';
import type { EditorSession, Layout } from '../session/session';
import {
  ExportDialog,
  NewCanvasDialog,
  ResizeDialog,
  ShapesPopover,
  ShortcutsDialog,
} from './dialogs';
import { EditorProvider, useEditor, useEditorState } from './EditorContext';
import { DropOverlay } from './files/DropOverlay';
import { FileActionsProvider, useFileActions } from './files/FileActions';
import { useAutosave } from './files/useAutosave';
import { useClipboard } from './files/useClipboard';
import { Island, IslandDivider } from './Island';
import { DocMenu, ZoomMenu } from './menus';
import { prefetchWhenIdle } from './prefetch';
import { DocumentMeta, StatusPill } from './Status';
import { ToastHost } from './toasts';
import { pixelVars } from './tokens.stylex';
import { ToolOptions } from './ToolOptions';
import { ToolRail } from './ToolRail';
import { useShortcuts } from './useShortcuts';

/**
 * Narrow windows and short touch screens take the phone layout. A phone turned sideways is short,
 * and the desktop rail and palette need about 540px of height to sit beside each other.
 */
const PHONE_QUERY = '(max-width: 640px), (max-height: 539px) and (pointer: coarse)';

const CANVAS_COLORS: Record<ColorScheme, NonNullable<OverlayState['colors']>> = {
  light: {
    checkerA: '#ffffff',
    checkerB: '#ebebef',
    gridMinor: 'rgba(0, 0, 0, 0.08)',
    gridMajor: 'rgba(0, 0, 0, 0.2)',
    gridMinorLight: 'rgba(255, 255, 255, 0.16)',
    gridMajorLight: 'rgba(255, 255, 255, 0.25)',
    edge: 'rgba(0, 0, 0, 0.08)',
    shadow: 'rgba(0, 0, 0, 0.16)',
  },
  dark: {
    checkerA: '#3a3a3c',
    checkerB: '#313133',
    gridMinor: 'rgba(0, 0, 0, 0.08)',
    gridMajor: 'rgba(0, 0, 0, 0.2)',
    gridMinorLight: 'rgba(255, 255, 255, 0.16)',
    gridMajorLight: 'rgba(255, 255, 255, 0.25)',
    edge: 'rgba(255, 255, 255, 0.1)',
    shadow: 'rgba(0, 0, 0, 0.6)',
  },
};

/** Below this zoom a brush footprint is too small to read, so the system crosshair stays. */
const FOOTPRINT_CURSOR_ZOOM = 4;

const documentRoute = getRouteApi('/d/$docId');

/**
 * Toasts clear the chrome: bottom right on desktop, just above the dock on a phone. ToastViewport
 * pads 16px inside its inset. These cancel that padding so toasts line up with the islands' 12px
 * edge on desktop and float 12px above the phone dock, measured at its tallest: two rows upright,
 * one sideways. A sideways phone's notch inset replaces that padding, so there the end edge already
 * matches the dock's.
 */
const TOAST_INSETS: Record<Layout | 'sideways', ToastViewportProps['inset']> = {
  desktop: { bottom: -4, end: -4 },
  phone: { bottom: 122, start: -4, end: -4 },
  sideways: { bottom: 65, end: 0 },
};
// The query for the dock's one-row arrangement, which `LANDSCAPE` styles.
const SIDEWAYS_QUERY = '(orientation: landscape) and (min-width: 600px)';

/** The `/d/$docId` route. Each document gets its own session, so switching never mixes history. */
export function EditorShell() {
  const { document, isNew } = documentRoute.useLoaderData();
  const { documentStore } = documentRoute.useRouteContext();
  const layout = useLayout();
  const sideways = useMediaQuery(SIDEWAYS_QUERY);
  // Kept current while editing, since the next document mounts before the previous one unmounts.
  const [saved] = useState(readToolPreferences);
  const preferences = useRef(saved);
  useEffect(prefetchWhenIdle, []);
  return (
    <ToastHost inset={TOAST_INSETS[layout === 'phone' && sideways ? 'sideways' : layout]}>
      <Editor
        key={document.id}
        document={document}
        isNew={isNew}
        store={documentStore}
        layout={layout}
        preferences={preferences}
      />
    </ToastHost>
  );
}

interface EditorProps {
  document: BitmapDocument;
  /** A blank canvas that has never been stored. It shows no save status until the first edit. */
  isNew: boolean;
  store: DocumentStore;
  layout: Layout;
  /** Seeds this document's tools and receives every change, for the next document to pick up. */
  preferences: RefObject<ToolPreferences>;
}

/** Set when a document switch removes the editor that held focus, so the next canvas takes it. */
let focusNextCanvas = false;

function Editor({ document, isNew, store, layout, preferences }: EditorProps) {
  const [session] = useState(() =>
    createEditorSession({
      document,
      save: isNew ? null : 'saved',
      preferences: preferences.current,
    }),
  );
  const scheme = useColorScheme();
  const colorSpace = useSelector(session.bitmap, (bitmap) => bitmap.colorSpace);

  useEffect(() => {
    const subscription = session.state.subscribe(() => {
      const next = toolPreferences(session.state.state);
      if (sameToolPreferences(next, preferences.current)) return;
      preferences.current = next;
      writeToolPreferences(next);
    });
    return () => subscription.unsubscribe();
  }, [session, preferences]);
  useEffect(() => session.setLayout(layout), [session, layout]);
  useEffect(() => session.setCanvasColors(CANVAS_COLORS[scheme]), [session, scheme]);
  useAutosave(session, store);
  // Create, Open, and Back leave focus on chrome that is about to unmount. Keyboard users
  // land on the new canvas rather than the page body.
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = main.current;
    if (focusNextCanvas) {
      focusNextCanvas = false;
      element?.querySelector<HTMLElement>('[role="application"]')?.focus({ preventScroll: true });
    }
    return () => {
      if (element?.contains(globalThis.document.activeElement)) focusNextCanvas = true;
    };
  }, []);

  return (
    <EditorProvider value={session}>
      <PaletteColorSpace value={colorSpace}>
        <FileActionsProvider session={session} store={store} layout={layout}>
          <main ref={main} {...stylex.props(styles.app, layout === 'phone' && styles.phone)}>
            <Canvas session={session} />
            {layout === 'phone' ? <PhoneChrome /> : <DesktopChrome />}
            <Panels layout={layout} />
            <DropOverlay />
          </main>
        </FileActionsProvider>
      </PaletteColorSpace>
    </EditorProvider>
  );
}

/** Dialogs and sheets, plus the input that reaches beyond the canvas: shortcuts and clipboard. */
function Panels({ layout }: { layout: Layout }) {
  const session = useEditor();
  const files = useFileActions();
  const run = useCallback(
    (command: EditorCommand) => {
      if (command.type === 'open-file') files.pickFile();
      else session.run(command);
    },
    [session, files],
  );
  useShortcuts(session, run);
  useClipboard(session, files);
  const panel = useEditorState((state) => state.panel);

  return (
    <>
      <NewCanvasDialog when={panel === 'new'} layout={layout} />
      <ResizeDialog when={panel === 'resize'} layout={layout} />
      <ShortcutsDialog when={panel === 'shortcuts'} layout={layout} />
      <ExportDialog
        when={panel === 'export'}
        layout={layout}
        onExport={(fileName, scale) => {
          files.exportPng(fileName, scale);
          session.setPanel(null);
        }}
      />
    </>
  );
}

function Canvas({ session }: { session: EditorSession }) {
  const input = useMemo<CanvasInput>(
    () => ({
      active: () => session.gesturing,
      hover: (sample) => session.hover(sample && sample.point, sample?.alt),
      begin: (sample, pointer) => session.beginGesture(sample, pointer),
      extend: (samples) => session.extendGesture(samples),
      end: () => session.endGesture(),
      cancel: () => session.cancelGesture(),
      undo: () => session.run({ type: 'undo' }),
      redo: () => session.run({ type: 'redo' }),
      resize: (width, height, ratio) => session.setViewportSize(width, height, ratio),
    }),
    [session],
  );
  const cursorAt = useCallback(
    ({ point, alt }: CanvasPointerSample) => {
      const { tool, selection, document } = session.state.state;
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      if (tool === 'select') {
        const within =
          selection !== null &&
          x >= selection.x &&
          y >= selection.y &&
          x < selection.x + selection.width &&
          y < selection.y + selection.height;
        if (within) return alt ? 'copy' : 'move';
        return session.shapeCursorAt(point, alt) ?? 'crosshair';
      }
      if (tool === 'shapes') return session.shapeCursorAt(point, alt) ?? 'crosshair';
      // The renderer draws the brush footprint, so a second cursor would only add noise.
      const inside = x >= 0 && y >= 0 && x < document.width && y < document.height;
      const brush = usesBrush(tool) && !alt;
      if (inside && brush && session.viewport.state.zoom >= FOOTPRINT_CURSOR_ZOOM) return 'none';
      return 'crosshair';
    },
    [session],
  );
  return (
    <CanvasSurface
      document={session.bitmap}
      viewport={session.viewport}
      overlay={session.overlay}
      input={input}
      cursorAt={cursorAt}
      bounds={session.viewBounds}
    />
  );
}

/*
 * The chrome reads only whether it is hidden. Each island selects the state it shows, so the
 * change a stroke makes (history, save status, recent colors) re-renders only what displays it.
 */
interface Fade {
  xstyle: StyleXStyles;
  /** Hidden chrome leaves the tab order and the accessibility tree, not just the screen. */
  inert: boolean;
}

function useFade(): Fade {
  const hidden = useEditorState((state) => state.chromeHidden);
  return { xstyle: [styles.chrome, hidden && styles.hidden], inert: hidden };
}

function DesktopChrome() {
  const session = useEditor();
  const fade = useFade();
  const doc = useRef<HTMLElement>(null);
  const options = useRef<HTMLElement>(null);
  const actions = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  useRoomBeside(doc, [options, actions]);
  useDesktopFitFrame(session, options, rail, pill);

  return (
    <>
      <Island
        as="header"
        ref={doc}
        xstyle={[styles.doc, styles.topRow, fade.xstyle]}
        inert={fade.inert}
      >
        <DocMenu layout="desktop" />
        <DocumentMeta />
      </Island>
      <Island
        role="toolbar"
        aria-label="Tool options"
        ref={options}
        xstyle={[styles.options, styles.topRow, fade.xstyle]}
        inert={fade.inert}
      >
        <ToolOptions layout="desktop" />
      </Island>
      <Island
        role="toolbar"
        aria-label="History and view"
        ref={actions}
        xstyle={[styles.actions, styles.topRow, fade.xstyle]}
        inert={fade.inert}
      >
        <HistoryButtons hasTooltips />
        <IslandDivider />
        <ZoomControls />
      </Island>
      <DesktopTools fade={fade} rail={rail} />
      <DesktopColors fade={fade} />
      <StatusPill ref={pill} />
    </>
  );
}

/**
 * Caps an island's width so it stops one screen-edge gap short of the first island to its right
 * in the same row. The tool options change width with the tool and selection, and drop to the
 * bottom on narrow screens, so the room is measured rather than fixed. A long name then ends in
 * an ellipsis instead of running under its neighbor.
 */
function useRoomBeside(
  island: RefObject<HTMLElement | null>,
  neighbors: RefObject<HTMLElement | null>[],
) {
  useLayoutEffect(() => {
    const self = island.current;
    if (!self) return;
    const fit = () => {
      const box = self.getBoundingClientRect();
      let right = window.innerWidth;
      for (const { current } of neighbors) {
        const other = current?.getBoundingClientRect();
        if (other && other.left > box.left && other.top < box.bottom && other.bottom > box.top) {
          right = Math.min(right, other.left);
        }
      }
      self.style.maxWidth = `${Math.max(0, right - box.left * 2)}px`;
    };
    const observer = new ResizeObserver(fit);
    for (const { current } of neighbors) if (current) observer.observe(current);
    window.addEventListener('resize', fit);
    fit();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
    // The refs are stable, and their elements live as long as the chrome.
  }, []);
}

/**
 * The rail's Shapes item: a press arms the last shape and opens the popover, and a second press
 * on the armed item closes it. Picking a shape arms it and closes the popover.
 */
function useShapesMenu() {
  const session = useEditor();
  const tool = useEditorState((state) => state.tool);
  const shapeKind = useEditorState((state) => state.shapeKind);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const onClose = useCallback(() => setOpen(false), []);
  const onPick = useCallback(
    (kind: ShapeKind) => {
      session.run({ type: 'shape-tool', kind });
      setOpen(false);
    },
    [session],
  );
  return {
    tool,
    shapeKind,
    open,
    anchor,
    onClose,
    onPick,
    onSelect: (next: EditorTool) => {
      if (next === 'shapes') session.run({ type: 'shape-tool', kind: shapeKind });
      else session.run({ type: 'tool', tool: next });
    },
    onShapesPress: () => {
      setOpen((current) => (tool === 'shapes' ? !current : true));
      session.run({ type: 'shape-tool', kind: shapeKind });
    },
  };
}

function DesktopTools({ fade, rail }: { fade: Fade; rail: RefObject<HTMLElement | null> }) {
  const session = useEditor();
  const shapes = useShapesMenu();
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const [editing, setEditing] = useState<ColorSlot | null>(null);

  return (
    <>
      <Island
        ref={rail}
        as="nav"
        axis="y"
        aria-label="Tools"
        xstyle={[styles.rail, fade.xstyle]}
        inert={fade.inert}
      >
        <ToolRail
          tool={shapes.tool}
          onSelect={shapes.onSelect}
          orientation="vertical"
          hasTooltips
          shapeKind={shapes.shapeKind}
          onShapesPress={shapes.onShapesPress}
          shapesRef={shapes.anchor}
        />
        <IslandDivider axis="y" />
        <ColorWell
          primary={primary}
          secondary={secondary}
          onEdit={(slot) => setEditing((current) => (current === slot ? null : slot))}
          onSwap={() => session.run({ type: 'swap-colors' })}
          onPress={() => setEditing((current) => (current === null ? 'primary' : null))}
          hasTooltips
        />
      </Island>
      <ShapesPopover
        when={shapes.open}
        open={shapes.open}
        layout="desktop"
        kind={shapes.shapeKind}
        anchor={shapes.anchor}
        onPick={shapes.onPick}
        onClose={shapes.onClose}
      />
      <ColorPickerPopover
        anchorRef={rail}
        isOpen={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing === 'secondary' ? 'Secondary color' : 'Primary color'}
        color={editing === 'secondary' ? secondary : primary}
        onChange={(color) => session.chooseColor(color, editing ?? 'primary')}
        placement="end"
        alignment="end"
        slots={{
          editing: editing ?? 'primary',
          onEditingChange: setEditing,
          primary,
          secondary,
          onSwap: () => session.run({ type: 'swap-colors' }),
        }}
      />
    </>
  );
}

function DesktopColors({ fade }: { fade: Fade }) {
  const session = useEditor();
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const recent = useEditorState((state) => state.recent);
  const panel = useRef<HTMLElement>(null);
  useFitClearance(session, panel);
  return (
    <Island
      ref={panel}
      as="aside"
      aria-label="Colors"
      xstyle={[styles.panel, fade.xstyle]}
      inert={fade.inert}
    >
      <ColorPanel
        anchorRef={panel}
        palette={DEFAULT_PALETTE}
        recent={recent}
        recentSlots={RECENT_LIMIT}
        primary={primary}
        secondary={secondary}
        onChoose={(color, slot) => session.chooseColor(color, slot)}
      />
    </Island>
  );
}

/**
 * Tells fit where this island sits so a document can center beneath it. Offsets measure the
 * layout box, unaffected by the fade's transform, relative to the full-bleed editor.
 */
function useFitClearance(session: EditorSession, island: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = island.current;
    if (!element) return;
    const report = () =>
      session.setIslands([
        {
          left: element.offsetLeft,
          top: element.offsetTop,
          right: element.offsetLeft + element.offsetWidth,
          bottom: element.offsetTop + element.offsetHeight,
        },
      ]);
    report();
    // A right-anchored island moves with the window without changing size.
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      session.setIslands([]);
    };
  }, [session, island]);
}

function PhoneChrome() {
  const session = useEditor();
  const fade = useFade();
  // Which color the sheet edits, chosen by the dock's well.
  const [editing, setEditing] = useState<ColorSlot>('primary');
  const top = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  useMeasuredFrame(session, top, dock);

  return (
    <>
      {/* One row, so a long title truncates instead of running under the zoom and history. */}
      <div ref={top} {...stylex.props(styles.phoneTop)}>
        <Island
          as="header"
          xstyle={[styles.inRow, styles.docPhone, fade.xstyle]}
          inert={fade.inert}
        >
          <DocMenu layout="phone" />
        </Island>
        <Island xstyle={[styles.inRow, fade.xstyle]} inert={fade.inert}>
          <ZoomMenu layout="phone" />
        </Island>
        <Island
          role="toolbar"
          aria-label="History"
          xstyle={[styles.inRow, fade.xstyle]}
          inert={fade.inert}
        >
          <HistoryButtons hasTooltips={false} />
        </Island>
      </div>
      <PhoneDock fade={fade} dock={dock} onEdit={setEditing} />
      <PhoneColors editing={editing} onEditingChange={setEditing} />
    </>
  );
}

/** A fit keeps this far from the top row and the dock. */
const FRAME_GAP = 16;

/**
 * Keeps a fitted document above Tool options and the status pill when the tablet layout docks
 * them at the bottom, and keeps the lifted pill clear of the tool rail.
 */
function useDesktopFitFrame(
  session: EditorSession,
  options: RefObject<HTMLElement | null>,
  rail: RefObject<HTMLElement | null>,
  pill: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const toolbar = options.current;
    const editor = toolbar?.offsetParent as HTMLElement | null;
    if (!toolbar || !editor) return;
    const report = () => {
      const height = editor.clientHeight;
      if (!height) return;
      const docked = toolbar.offsetTop > height / 2;
      const above = height - toolbar.offsetTop;
      // Docked at the bottom, the options would run under the pill on any narrow window, so the
      // pill rides one row up for as long as they're docked. It moves only when the options do,
      // never with the pointer or with how wide the options or coordinates grow. The fit frame
      // then clears the pill, as the undocked frame already does.
      const lift = docked ? above + PILL_GAP : 0;
      const top = docked ? lift + (pill.current?.offsetHeight ?? 0) : 0;
      // On a short window the centered rail reaches down into that row, so the pill moves out
      // beside the rail instead of covering the color well.
      const tools = rail.current;
      const railBottom = tools ? tools.offsetTop + tools.offsetHeight / 2 : 0;
      const beside = docked && tools && railBottom + PILL_GAP > height - top;
      if (pill.current) {
        pill.current.style.bottom = docked ? `${lift}px` : '';
        pill.current.style.left = beside
          ? `${tools.offsetLeft + tools.offsetWidth + PILL_GAP}px`
          : '';
      }
      const bottom = docked ? Math.max(DESKTOP_FRAME.bottom, top + 12) : DESKTOP_FRAME.bottom;
      session.setFrame(bottom === DESKTOP_FRAME.bottom ? null : { ...DESKTOP_FRAME, bottom });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(toolbar);
    observer.observe(editor);
    if (rail.current) observer.observe(rail.current);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      session.setFrame(null);
    };
  }, [session, options, rail, pill]);
}
/** The gap between stacked islands, like the colors panel under the top row. */
const PILL_GAP = 8;
// Sideways, past the chrome's edge, which already clears the safe area: 16px from a plain edge.
const SIDE_GAP = 4;

/**
 * Tells fit where the phone chrome leaves the canvas clear. The dock is a single row on a sideways
 * phone and two rows upright, and the side safe areas only matter sideways, so the frame is
 * measured from the layout boxes rather than fixed. Offsets ignore the fade, which only changes
 * opacity.
 */
function useMeasuredFrame(
  session: EditorSession,
  top: RefObject<HTMLElement | null>,
  dock: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const row = top.current;
    const tools = dock.current;
    const editor = row?.offsetParent as HTMLElement | null;
    if (!row || !tools || !editor) return;
    const report = () => {
      const width = editor.clientWidth;
      const height = editor.clientHeight;
      if (!width || !height) return;
      session.setFrame({
        top: row.offsetTop + row.offsetHeight + FRAME_GAP,
        bottom: height - tools.offsetTop + FRAME_GAP,
        left: Math.min(row.offsetLeft, tools.offsetLeft) + SIDE_GAP,
        right:
          width -
          Math.max(row.offsetLeft + row.offsetWidth, tools.offsetLeft + tools.offsetWidth) +
          SIDE_GAP,
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(row);
    observer.observe(tools);
    observer.observe(editor);
    return () => {
      observer.disconnect();
      session.setFrame(null);
    };
  }, [session, top, dock]);
}

interface PhoneDockProps {
  fade: Fade;
  dock: RefObject<HTMLElement | null>;
  onEdit: (slot: ColorSlot) => void;
}

function PhoneDock({ fade, dock, onEdit }: PhoneDockProps) {
  const session = useEditor();
  const shapes = useShapesMenu();
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  return (
    <Island ref={dock} aria-label="Tools" xstyle={[styles.dock, fade.xstyle]} inert={fade.inert}>
      <div {...stylex.props(styles.dockOptions)}>
        <ToolOptions layout="phone" />
      </div>
      <span aria-hidden {...stylex.props(styles.dockRule)} />
      <div {...stylex.props(styles.dockTools)}>
        <ToolRail
          tool={shapes.tool}
          onSelect={shapes.onSelect}
          orientation="horizontal"
          hasTooltips={false}
          shapeKind={shapes.shapeKind}
          onShapesPress={shapes.onShapesPress}
          shapesRef={shapes.anchor}
        />
      </div>
      <div {...stylex.props(styles.dockWell)}>
        <ColorWell
          size="lg"
          primary={primary}
          secondary={secondary}
          onEdit={(slot) => {
            onEdit(slot);
            session.setPanel('colors');
          }}
          onSwap={() => session.run({ type: 'swap-colors' })}
        />
      </div>
      {/* After the rail, so the anchor ref is attached before the popover measures it. */}
      <ShapesPopover
        when={shapes.open}
        open={shapes.open}
        layout="phone"
        kind={shapes.shapeKind}
        anchor={shapes.anchor}
        dock={dock}
        onPick={shapes.onPick}
        onClose={shapes.onClose}
      />
    </Island>
  );
}

function PhoneColors({
  editing,
  onEditingChange,
}: {
  editing: ColorSlot;
  onEditingChange: (slot: ColorSlot) => void;
}) {
  const session = useEditor();
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const recent = useEditorState((state) => state.recent);
  const isOpen = useEditorState((state) => state.panel === 'colors');
  return (
    <ColorSheet
      isOpen={isOpen}
      onOpenChange={(open) => session.setPanel(open ? 'colors' : null)}
      editing={editing}
      onEditingChange={onEditingChange}
      palette={DEFAULT_PALETTE}
      recent={recent}
      recentSlots={RECENT_LIMIT}
      primary={primary}
      secondary={secondary}
      onChoose={(color, slot) => session.chooseColor(color, slot)}
      onSwap={() => session.run({ type: 'swap-colors' })}
    />
  );
}

function HistoryButtons({ hasTooltips }: { hasTooltips: boolean }) {
  const session = useEditor();
  const canUndo = useEditorState((state) => state.canUndo);
  const canRedo = useEditorState((state) => state.canRedo);
  return (
    <>
      <IconButton
        variant="ghost"
        label="Undo"
        tooltip={hasTooltips ? 'Undo  ·  ⌘Z' : undefined}
        icon={<Undo2 size={18} />}
        isDisabled={!canUndo}
        onClick={() => session.run({ type: 'undo' })}
      />
      <IconButton
        variant="ghost"
        label="Redo"
        tooltip={hasTooltips ? 'Redo  ·  ⇧⌘Z' : undefined}
        icon={<Redo2 size={18} />}
        isDisabled={!canRedo}
        onClick={() => session.run({ type: 'redo' })}
      />
    </>
  );
}

function ZoomControls() {
  const session = useEditor();
  // Pinch changes zoom every frame, so read only the edges that change what renders.
  const atMin = useSelector(
    session.viewport,
    (view) => view.zoom <= (session.viewBounds()?.minZoom ?? MIN_ZOOM),
  );
  const atMax = useSelector(session.viewport, (view) => view.zoom >= MAX_ZOOM);
  const grid = useEditorState((state) => state.gridEnabled);
  return (
    <>
      <IconButton
        variant="ghost"
        label="Zoom out"
        tooltip="Zoom out  ·  ⌘−"
        icon={<Minus size={18} />}
        isDisabled={atMin}
        onClick={() => session.run({ type: 'zoom', direction: -1 })}
      />
      <ZoomMenu layout="desktop" />
      <IconButton
        variant="ghost"
        label="Zoom in"
        tooltip="Zoom in  ·  ⌘+"
        icon={<Plus size={18} />}
        isDisabled={atMax}
        onClick={() => session.run({ type: 'zoom', direction: 1 })}
      />
      <IslandDivider />
      <ToggleButton
        label="Pixel grid"
        isIconOnly
        icon={<Grid3x3 size={18} />}
        isPressed={grid}
        onPressedChange={() => session.run({ type: 'toggle-grid' })}
        tooltip="Pixel grid  ·  ⌘'"
      />
    </>
  );
}

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
}

function useLayout(): Layout {
  return useMediaQuery(PHONE_QUERY) ? 'phone' : 'desktop';
}

const COARSE = '@media (pointer: coarse)';
// Where touch-sized selection options stop fitting between the document and history islands.
const NARROW = '@media (max-width: 1099px)';
// The phone layout's sideways arrangement: one dock row, so the short screen keeps its canvas.
// Narrower than this, the row can't hold the tools and a selection's actions, so it stays two rows.
const LANDSCAPE = '@media (orientation: landscape) and (min-width: 600px)';
// Seven 44px tools and the well stop fitting in one dock row below this width.
const SLIM = '@media (max-width: 387.98px) and (orientation: portrait)';

const islandHeight = `calc(${pixelVars.tool} + ${pixelVars.islandPad} * 2)`;

const styles = stylex.create({
  app: {
    position: 'fixed',
    inset: 0,
    overflow: 'hidden',
    backgroundColor: pixelVars.canvasBg,
    color: colorVars['--color-text-primary'],
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    WebkitTapHighlightColor: 'transparent',
    [radiusVars['--radius-element']]: '10px',
    // Any coarse pointer gets 44px Astryx controls, including a tablet in the desktop layout.
    [sizeVars['--size-element-md']]: { default: null, [COARSE]: '44px' },
    [sizeVars['--size-element-lg']]: { default: null, [COARSE]: '44px' },
  },
  phone: {
    [pixelVars.tool]: '44px',
    [sizeVars['--size-element-md']]: '44px',
    [sizeVars['--size-element-lg']]: '44px',
  },
  chrome: {
    transitionProperty: 'opacity',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      '@media (prefers-reduced-motion: reduce)': '0s',
    },
    transitionTimingFunction: pixelVars.ease,
  },
  hidden: { opacity: 0, pointerEvents: 'none' },
  // Top-row controls are tool-sized like the rail's, so every island is one thickness.
  topRow: { [sizeVars['--size-element-md']]: pixelVars.tool },
  doc: {
    top: pixelVars.safeTop,
    left: pixelVars.safeLeft,
    paddingInlineEnd: spacingVars['--spacing-3'],
    gap: spacingVars['--spacing-1'],
  },
  docPhone: {
    flexShrink: 1,
    minWidth: 0,
    marginInlineEnd: 'auto',
    paddingInlineEnd: pixelVars.islandPad,
  },
  phoneTop: {
    position: 'absolute',
    zIndex: 2,
    top: pixelVars.safeTop,
    left: pixelVars.safeLeft,
    right: pixelVars.safeRight,
    display: 'flex',
    gap: spacingVars['--spacing-2'],
    pointerEvents: 'none',
  },
  inRow: { position: 'relative', flexShrink: 0, pointerEvents: 'auto' },
  // Centered on top while it clears the islands beside it, then at the bottom, under the thumb.
  options: {
    top: { default: pixelVars.safeTop, [NARROW]: 'auto' },
    bottom: { default: null, [NARROW]: pixelVars.safeBottom },
    left: '50%',
    transform: 'translateX(-50%)',
    minHeight: islandHeight,
    paddingInline: spacingVars['--spacing-3'],
  },
  actions: { top: pixelVars.safeTop, right: pixelVars.safeRight },
  rail: { left: pixelVars.safeLeft, top: '50%', transform: 'translateY(-50%)' },
  panel: {
    top: `calc(${pixelVars.safeTop} + ${islandHeight} + ${spacingVars['--spacing-2']})`,
    right: pixelVars.safeRight,
    // Eight 44px swatch pitches on touch.
    width: { default: 244, [COARSE]: 370 },
    padding: spacingVars['--spacing-3'],
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: spacingVars['--spacing-3'],
  },
  /*
   * Upright, the tool options sit above the tools and the well ends the tool row. On a slim phone
   * the well moves up beside the options so seven tools keep 44px. Sideways, everything is one
   * row: options under the left thumb, then the tools and the well under the right.
   */
  dock: {
    left: pixelVars.safeLeft,
    right: pixelVars.safeRight,
    bottom: pixelVars.safeBottom,
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      [LANDSCAPE]: 'minmax(0, 1fr) 1px auto auto',
    },
    gridTemplateAreas: {
      default: '"options options" "rule rule" "tools well"',
      [SLIM]: '"options well" "rule rule" "tools tools"',
      [LANDSCAPE]: '"options rule tools well"',
    },
    alignItems: 'center',
    rowGap: 6,
    columnGap: { default: 0, [SLIM]: spacingVars['--spacing-2'], [LANDSCAPE]: 6 },
    padding: 6,
    borderRadius: 22,
  },
  dockOptions: {
    gridArea: 'options',
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
    minHeight: 44,
    paddingInlineStart: spacingVars['--spacing-2'],
    // Tool options fold their spacing and labels to the room this cell leaves them.
    containerType: 'inline-size',
  },
  dockRule: {
    gridArea: 'rule',
    alignSelf: 'stretch',
    height: { default: 1, [LANDSCAPE]: 'auto' },
    width: { default: 'auto', [LANDSCAPE]: 1 },
    marginBlock: { default: null, [LANDSCAPE]: 10 },
    backgroundColor: colorVars['--color-border'],
  },
  dockTools: { gridArea: 'tools', display: 'flex', minWidth: 0 },
  dockWell: { gridArea: 'well', display: 'flex', justifyContent: 'flex-end' },
});
