import * as stylex from '@stylexjs/stylex';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import {
  colorVars,
  durationVars,
  radiusVars,
  sizeVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { useSelector } from '@tanstack/react-store';
import { Grid3x3, Minus, Plus, Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CanvasSurface, MAX_ZOOM, MIN_ZOOM } from '../../canvas';
import type { CanvasInput, DocumentPoint, OverlayState } from '../../canvas';
import {
  ColorPanel,
  ColorPickerPopover,
  ColorSheet,
  ColorWell,
  DEFAULT_PALETTE,
  RECENT_LIMIT,
} from '../../palette';
import type { EditorCommand } from '../core/shortcuts';
import type { ColorSlot } from '../core/state';
import { usesBrush } from '../core/tools';
import { useColorScheme } from '../session/appearance';
import type { ColorScheme } from '../session/appearance';
import { createEditorSession } from '../session/session';
import type { EditorSession, Layout } from '../session/session';
import { ExportDialog } from './dialogs/ExportDialog';
import { NewCanvasDialog } from './dialogs/NewCanvasDialog';
import { ResizeDialog } from './dialogs/ResizeDialog';
import { EditorProvider, useEditor, useEditorState } from './EditorContext';
import { Island, IslandDivider } from './Island';
import { DocMenu, ZoomMenu } from './Menus';
import { DocumentMeta, StatusPill } from './Status';
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

export function EditorShell() {
  const [session] = useState(createEditorSession);
  const layout = useLayout();
  const scheme = useColorScheme();

  useEffect(() => session.setLayout(layout), [session, layout]);
  useEffect(() => session.setCanvasColors(CANVAS_COLORS[scheme]), [session, scheme]);

  const run = useCallback((command: EditorCommand) => session.run(command), [session]);
  useShortcuts(session, run);

  return (
    <EditorProvider value={session}>
      <main {...stylex.props(styles.app, layout === 'phone' && styles.phone)}>
        <Canvas session={session} />
        {layout === 'phone' ? <PhoneChrome /> : <DesktopChrome />}
        <NewCanvasDialog layout={layout} />
        <ResizeDialog layout={layout} />
        <ExportDialog layout={layout} onExport={() => session.setPanel(null)} />
      </main>
    </EditorProvider>
  );
}

function Canvas({ session }: { session: EditorSession }) {
  const input = useMemo<CanvasInput>(
    () => ({
      hover: (point) => session.hover(point),
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
    (point: DocumentPoint) => {
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
      if (inside && usesBrush(tool) && session.viewport.state.zoom >= FOOTPRINT_CURSOR_ZOOM)
        return 'none';
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

function DesktopChrome() {
  const session = useEditor();
  const hidden = useEditorState((state) => state.chromeHidden);
  const tool = useEditorState((state) => state.tool);
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const recent = useEditorState((state) => state.recent);
  const [editing, setEditing] = useState<ColorSlot | null>(null);
  const well = useRef<HTMLDivElement>(null);
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
      <Island as="nav" axis="y" aria-label="Tools" xstyle={[styles.rail, fade]}>
        <ToolRail
          tool={tool}
          onSelect={(next) => session.run({ type: 'tool', tool: next })}
          orientation="vertical"
          hasTooltips
        />
        <IslandDivider axis="y" />
        <ColorWell
          ref={well}
          primary={primary}
          secondary={secondary}
          onEdit={(slot) => setEditing((current) => (current === slot ? null : slot))}
          onSwap={() => session.run({ type: 'swap-colors' })}
        />
      </Island>
      <ColorPickerPopover
        anchorRef={well}
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
      <Island as="aside" aria-label="Colors" xstyle={[styles.panel, fade]}>
        <ColorPanel
          palette={DEFAULT_PALETTE}
          recent={recent}
          recentSlots={RECENT_LIMIT}
          primary={primary}
          secondary={secondary}
          onChoose={(color, slot) => session.chooseColor(color, slot)}
        />
      </Island>
      <StatusPill />
    </>
  );
}

function PhoneChrome() {
  const session = useEditor();
  const hidden = useEditorState((state) => state.chromeHidden);
  const tool = useEditorState((state) => state.tool);
  const primary = useEditorState((state) => state.primary);
  const secondary = useEditorState((state) => state.secondary);
  const recent = useEditorState((state) => state.recent);
  const isSheetOpen = useEditorState((state) => state.panel === 'colors');
  const [editing, setEditing] = useState<ColorSlot>('primary');
  const fade = [styles.chrome, hidden && styles.hidden];

  return (
    <>
      <Island as="header" xstyle={[styles.doc, styles.docPhone, fade]}>
        <DocMenu layout="phone" />
      </Island>
      <Island xstyle={[styles.zoomPill, fade]}>
        <ZoomMenu layout="phone" />
      </Island>
      <Island role="toolbar" aria-label="History" xstyle={[styles.actions, fade]}>
        <HistoryButtons hasTooltips={false} />
      </Island>
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
              setEditing(slot);
              session.setPanel('colors');
            }}
            onSwap={() => session.run({ type: 'swap-colors' })}
          />
        </div>
      </Island>
      <ColorSheet
        isOpen={isSheetOpen}
        onOpenChange={(open) => session.setPanel(open ? 'colors' : null)}
        editing={editing}
        onEditingChange={setEditing}
        palette={DEFAULT_PALETTE}
        recent={recent}
        recentSlots={RECENT_LIMIT}
        primary={primary}
        secondary={secondary}
        onChoose={(color, slot) => session.chooseColor(color, slot)}
        onSwap={() => session.run({ type: 'swap-colors' })}
      />
    </>
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
  const zoom = useSelector(session.viewport, (view) => view.zoom);
  const grid = useEditorState((state) => state.gridEnabled);
  return (
    <>
      <IconButton
        variant="ghost"
        label="Zoom out"
        tooltip="Zoom out  ·  ⌘−"
        icon={<Minus size={18} />}
        isDisabled={zoom <= MIN_ZOOM}
        onClick={() => session.run({ type: 'zoom', direction: -1 })}
      />
      <ZoomMenu layout="desktop" />
      <IconButton
        variant="ghost"
        label="Zoom in"
        tooltip="Zoom in  ·  ⌘+"
        icon={<Plus size={18} />}
        isDisabled={zoom >= MAX_ZOOM}
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
  docPhone: { paddingInlineEnd: pixelVars.islandPad },
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
  zoomPill: {
    top: pixelVars.safeTop,
    left: '50%',
    transform: 'translateX(-50%)',
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
