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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  RECENT_LIMIT,
} from '../../palette';
import type { EditorCommand } from '../core/shortcuts';
import { DEFAULT_TOOL_PREFERENCES, toolPreferences } from '../core/state';
import type { ColorSlot, ToolPreferences } from '../core/state';
import { usesBrush } from '../core/tools';
import { useColorScheme } from '../session/appearance';
import type { ColorScheme } from '../session/appearance';
import { createEditorSession } from '../session/session';
import type { EditorSession, Layout } from '../session/session';
import { ExportDialog, NewCanvasDialog, ResizeDialog } from './dialogs';
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

const PHONE_QUERY = '(max-width: 640px)';

const CANVAS_COLORS: Record<ColorScheme, NonNullable<OverlayState['colors']>> = {
  light: {
    checkerA: '#ffffff',
    checkerB: '#ebebef',
    gridMinor: 'rgba(0, 0, 0, 0.08)',
    gridMajor: 'rgba(0, 0, 0, 0.2)',
  },
  dark: {
    checkerA: '#3a3a3c',
    checkerB: '#313133',
    gridMinor: 'rgba(255, 255, 255, 0.07)',
    gridMajor: 'rgba(255, 255, 255, 0.16)',
  },
};

/** Below this zoom a brush footprint is too small to read, so the system crosshair stays. */
const FOOTPRINT_CURSOR_ZOOM = 4;

const documentRoute = getRouteApi('/d/$docId');

/** Toasts clear the chrome: bottom right on desktop, just above the dock on a phone. */
/**
 * ToastViewport pads 16px inside its inset. These cancel that padding so toasts line up with the
 * islands' 12px edge on desktop and float 12px above the phone dock, measured at its tallest.
 */
const TOAST_INSETS: Record<Layout, ToastViewportProps['inset']> = {
  desktop: { bottom: -4, end: -4 },
  phone: { bottom: 122, start: -4, end: -4 },
};

/** The `/d/$docId` route. Each document gets its own session, so switching never mixes history. */
export function EditorShell() {
  const { document, isNew } = documentRoute.useLoaderData();
  const { documentStore } = documentRoute.useRouteContext();
  const layout = useLayout();
  // Kept current while editing, since the next document mounts before the previous one unmounts.
  const preferences = useRef(DEFAULT_TOOL_PREFERENCES);
  useEffect(prefetchWhenIdle, []);
  return (
    <ToastHost inset={TOAST_INSETS[layout]}>
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

function Editor({ document, isNew, store, layout, preferences }: EditorProps) {
  const [session] = useState(() =>
    createEditorSession({
      document,
      save: isNew ? null : 'saved',
      preferences: preferences.current,
    }),
  );
  const scheme = useColorScheme();

  useEffect(() => {
    const subscription = session.state.subscribe(() => {
      preferences.current = toolPreferences(session.state.state);
    });
    return () => subscription.unsubscribe();
  }, [session, preferences]);
  useEffect(() => session.setLayout(layout), [session, layout]);
  useEffect(() => session.setCanvasColors(CANVAS_COLORS[scheme]), [session, scheme]);
  useAutosave(session, store);

  return (
    <EditorProvider value={session}>
      <FileActionsProvider session={session} store={store} layout={layout}>
        <main {...stylex.props(styles.app, layout === 'phone' && styles.phone)}>
          <Canvas session={session} />
          {layout === 'phone' ? <PhoneChrome /> : <DesktopChrome />}
          <Panels layout={layout} />
          <DropOverlay />
        </main>
      </FileActionsProvider>
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
      hover: (sample) => session.hover(sample && sample.point, sample?.alt),
      begin: (sample) => session.beginGesture(sample),
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
        return within ? 'move' : 'crosshair';
      }
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
    />
  );
}

/*
 * The chrome reads only whether it is hidden. Each island selects the state it shows, so the
 * change a stroke makes (history, save status, recent colors) re-renders only what displays it.
 */
type Fade = StyleXStyles;

function DesktopChrome() {
  const hidden = useEditorState((state) => state.chromeHidden);
  const fade = [styles.chrome, hidden && styles.hidden];

  return (
    <>
      <Island as="header" xstyle={[styles.doc, fade]}>
        <DocMenu layout="desktop" />
        <DocumentMeta />
      </Island>
      <Island role="toolbar" aria-label="Tool options" xstyle={[styles.options, fade]}>
        <ToolOptions layout="desktop" />
      </Island>
      <Island role="toolbar" aria-label="History and view" xstyle={[styles.actions, fade]}>
        <HistoryButtons hasTooltips />
        <IslandDivider />
        <ZoomControls />
      </Island>
      <DesktopTools fade={fade} />
      <DesktopColors fade={fade} />
      <StatusPill />
    </>
  );
}

function DesktopTools({ fade }: { fade: Fade }) {
  const session = useEditor();
  const tool = useEditorState((state) => state.tool);
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const [editing, setEditing] = useState<ColorSlot | null>(null);
  const rail = useRef<HTMLElement>(null);

  return (
    <>
      <Island ref={rail} as="nav" axis="y" aria-label="Tools" xstyle={[styles.rail, fade]}>
        <ToolRail
          tool={tool}
          onSelect={(next) => session.run({ type: 'tool', tool: next })}
          orientation="vertical"
          hasTooltips
        />
        <IslandDivider axis="y" />
        <ColorWell
          primary={primary}
          secondary={secondary}
          onEdit={(slot) => setEditing((current) => (current === slot ? null : slot))}
          onSwap={() => session.run({ type: 'swap-colors' })}
        />
      </Island>
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
  return (
    <Island ref={panel} as="aside" aria-label="Colors" xstyle={[styles.panel, fade]}>
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

function PhoneChrome() {
  const hidden = useEditorState((state) => state.chromeHidden);
  // Which color the sheet edits, chosen by the dock's well.
  const [editing, setEditing] = useState<ColorSlot>('primary');
  const fade = [styles.chrome, hidden && styles.hidden];

  return (
    <>
      {/* One row, so a long title truncates instead of running under the zoom and history. */}
      <div {...stylex.props(styles.phoneTop)}>
        <Island as="header" xstyle={[styles.inRow, styles.docPhone, fade]}>
          <DocMenu layout="phone" />
        </Island>
        <Island xstyle={[styles.inRow, fade]}>
          <ZoomMenu layout="phone" />
        </Island>
        <Island role="toolbar" aria-label="History" xstyle={[styles.inRow, fade]}>
          <HistoryButtons hasTooltips={false} />
        </Island>
      </div>
      <PhoneDock fade={fade} onEdit={setEditing} />
      <PhoneColors editing={editing} onEditingChange={setEditing} />
    </>
  );
}

function PhoneDock({ fade, onEdit }: { fade: Fade; onEdit: (slot: ColorSlot) => void }) {
  const session = useEditor();
  const tool = useEditorState((state) => state.tool);
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  return (
    <Island aria-label="Tools" axis="y" xstyle={[styles.dock, fade]}>
      <div {...stylex.props(styles.dockOptions)}>
        <ToolOptions layout="phone" />
      </div>
      <div {...stylex.props(styles.dockTools)}>
        <ToolRail
          tool={tool}
          onSelect={(next) => session.run({ type: 'tool', tool: next })}
          orientation="horizontal"
          hasTooltips={false}
        />
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
  const atMin = useSelector(session.viewport, (view) => view.zoom <= MIN_ZOOM);
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

function subscribeToLayout(onChange: () => void): () => void {
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function useLayout(): Layout {
  const isPhone = useSyncExternalStore(
    subscribeToLayout,
    () => matchMedia(PHONE_QUERY).matches,
    () => false,
  );
  return isPhone ? 'phone' : 'desktop';
}

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
  doc: {
    top: pixelVars.safeTop,
    left: pixelVars.edge,
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
    left: pixelVars.edge,
    right: pixelVars.edge,
    display: 'flex',
    gap: spacingVars['--spacing-2'],
    pointerEvents: 'none',
  },
  inRow: { position: 'relative', flexShrink: 0, pointerEvents: 'auto' },
  options: {
    top: pixelVars.safeTop,
    left: '50%',
    transform: 'translateX(-50%)',
    minHeight: islandHeight,
    paddingInline: spacingVars['--spacing-3'],
  },
  actions: { top: pixelVars.safeTop, right: pixelVars.edge },
  rail: { left: pixelVars.edge, top: '50%', transform: 'translateY(-50%)' },
  panel: {
    top: `calc(${pixelVars.safeTop} + ${islandHeight} + ${spacingVars['--spacing-2']})`,
    right: pixelVars.edge,
    width: 244,
    padding: spacingVars['--spacing-3'],
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: spacingVars['--spacing-3'],
  },
  dock: {
    left: pixelVars.edge,
    right: pixelVars.edge,
    bottom: pixelVars.safeBottom,
    alignItems: 'stretch',
    gap: 0,
    padding: 6,
    borderRadius: 22,
  },
  dockOptions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: 44,
    paddingInlineStart: spacingVars['--spacing-2'],
    marginBottom: 6,
  },
  dockTools: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
});
