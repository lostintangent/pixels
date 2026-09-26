import * as stylex from '@stylexjs/stylex';
import type { Store } from '@tanstack/store';
import { useEffect, useRef } from 'react';
import type { BitmapDocument } from '../../document';
import type { DocumentPoint, ScreenPoint, Viewport } from '../core/contracts';
import { clampZoom, screenToDocument, settleZoom, stepZoom, zoomAt } from '../core/viewport';
import type { OverlayState } from '../render/contracts';
import { createCanvasRenderer } from '../render/renderer';

/** One pointer sample translated into fractional document coordinates. */
export interface CanvasPointerSample {
  point: DocumentPoint;
  shift: boolean;
  alt: boolean;
}

/** What the canvas asks of its owner. The surface knows gestures, never tools. */
export interface CanvasInput {
  hover(point: DocumentPoint | null): void;
  begin(sample: CanvasPointerSample): void;
  extend(samples: readonly CanvasPointerSample[]): void;
  end(): void;
  /** Rolls back the gesture, for a touch that turns into a pinch. */
  cancel(): void;
  undo(): void;
  redo(): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
}

export interface CanvasSurfaceProps {
  document: Store<BitmapDocument>;
  viewport: Store<Viewport>;
  overlay: Store<OverlayState>;
  input: CanvasInput;
  /** CSS cursor for a document point while nothing is panning. */
  cursorAt: (point: DocumentPoint) => string;
}

const TAP_MS = 250;
const TAP_SLOP = 10;
const SETTLE_MS = 180;

type Mode =
  | { kind: 'idle' }
  | { kind: 'draw'; pointerId: number }
  | { kind: 'pan'; pointerId: number; origin: ScreenPoint; view: Viewport }
  | {
      kind: 'pinch';
      distance: number;
      midpoint: ScreenPoint;
      /** Document point under the starting midpoint: it stays under the fingers. */
      anchor: DocumentPoint;
      zoom: number;
      startedAt: number;
      fingers: number;
      moved: boolean;
      latest: ScreenPoint;
    }
  /** A pinch ended with fingers still down. Wait for all to lift. */
  | { kind: 'drain' };

export function CanvasSurface({
  document,
  viewport,
  overlay,
  input,
  cursorAt,
}: CanvasSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ input, cursorAt });
  latest.current = { input, cursorAt };

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = createCanvasRenderer({
      documentCanvas: globalThis.document.createElement('canvas'),
      viewportCanvas: viewportRef.current!,
      overlayCanvas: overlayRef.current!,
    });
    renderer.setDocument(document.state);
    renderer.setViewport(viewport.state);
    renderer.setOverlay(overlay.state);
    const subscriptions = [
      document.subscribe((next) => renderer.setDocument(next)),
      viewport.subscribe((next) => renderer.setViewport(next)),
      overlay.subscribe((next) => renderer.setOverlay(next)),
    ];

    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      latest.current.input.resize(Math.round(width), Math.round(height), devicePixelRatio || 1);
    });
    resize.observe(host);

    const pointers = new Map<number, ScreenPoint>();
    let mode: Mode = { kind: 'idle' };
    let penSeen = false;
    let spaceHeld = false;
    let hovered: ScreenPoint | null = null;
    let settleFrame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let wheelNotches = 0;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    const local = (event: { clientX: number; clientY: number }): ScreenPoint => {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const sample = (event: PointerEvent): CanvasPointerSample => ({
      point: screenToDocument(viewport.state, local(event)),
      shift: event.shiftKey,
      alt: event.altKey,
    });
    const setView = (next: Viewport) => viewport.setState(() => next);

    function updateCursor(): void {
      if (mode.kind === 'pan') host.style.cursor = 'grabbing';
      else if (spaceHeld) host.style.cursor = 'grab';
      else if (hovered)
        host.style.cursor = latest.current.cursorAt(screenToDocument(viewport.state, hovered));
      else host.style.cursor = '';
    }

    function hover(point: ScreenPoint | null): void {
      hovered = point;
      const pan = mode.kind === 'pan' || spaceHeld;
      latest.current.input.hover(point && !pan ? screenToDocument(viewport.state, point) : null);
      updateCursor();
    }

    /** Pinch pans and zooms at once: keeps `anchor` (a document point) under the moving midpoint. */
    function anchored(zoom: number, anchor: DocumentPoint, screen: ScreenPoint): Viewport {
      return {
        ...viewport.state,
        zoom,
        panX: screen.x - anchor.x * zoom,
        panY: screen.y - anchor.y * zoom,
      };
    }

    function stopSettle(): void {
      cancelAnimationFrame(settleFrame);
      settleFrame = 0;
      clearTimeout(settleTimer);
    }

    /** Eases a free zoom onto the nearest ladder step with pixel-aligned pan. */
    function settle(screen: ScreenPoint): void {
      stopSettle();
      const from = viewport.state;
      const end = settleZoom(from, screen);
      const target = end.zoom;
      const final = { ...end, panX: Math.round(end.panX), panY: Math.round(end.panY) };
      if (reducedMotion.matches || target === from.zoom) return setView(final);
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / SETTLE_MS);
        if (t >= 1) {
          settleFrame = 0;
          return setView(final);
        }
        const eased = 1 - (1 - t) ** 3;
        setView(zoomAt(from, from.zoom * (target / from.zoom) ** eased, screen));
        settleFrame = requestAnimationFrame(step);
      };
      settleFrame = requestAnimationFrame(step);
    }

    function fingers(): { distance: number; midpoint: ScreenPoint } {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return { distance: 1, midpoint: a ?? { x: 0, y: 0 } };
      return {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }

    function beginPinch(): void {
      if (mode.kind === 'draw') latest.current.input.cancel();
      stopSettle();
      const { distance, midpoint } = fingers();
      mode = {
        kind: 'pinch',
        distance,
        midpoint,
        anchor: screenToDocument(viewport.state, midpoint),
        zoom: viewport.state.zoom,
        startedAt: performance.now(),
        fingers: pointers.size,
        moved: false,
        latest: midpoint,
      };
      latest.current.input.hover(null);
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button === 2) return;
      host.setPointerCapture(event.pointerId);
      host.focus({ preventScroll: true });
      pointers.set(event.pointerId, local(event));
      if (event.pointerType === 'pen') penSeen = true;

      if (event.pointerType === 'touch' && pointers.size >= 2) {
        if (mode.kind === 'pinch') {
          mode.fingers = Math.max(mode.fingers, pointers.size);
          return;
        }
        if (mode.kind === 'idle' || mode.kind === 'draw' || mode.kind === 'pan') beginPinch();
        return;
      }
      if (mode.kind !== 'idle') return;
      stopSettle();

      // Middle button, held space, or a finger once a pen is in play: all pan.
      const palm = event.pointerType === 'touch' && penSeen;
      if (event.button === 1 || spaceHeld || palm) {
        mode = {
          kind: 'pan',
          pointerId: event.pointerId,
          origin: local(event),
          view: viewport.state,
        };
        hover(null);
        return;
      }
      mode = { kind: 'draw', pointerId: event.pointerId };
      latest.current.input.begin(sample(event));
    }

    function onPointerMove(event: PointerEvent): void {
      const tracked = pointers.has(event.pointerId);
      if (tracked) pointers.set(event.pointerId, local(event));

      if (mode.kind === 'pinch') {
        if (!tracked || pointers.size < 2) return;
        const { distance, midpoint } = fingers();
        if (
          Math.abs(distance - mode.distance) > TAP_SLOP ||
          Math.hypot(midpoint.x - mode.midpoint.x, midpoint.y - mode.midpoint.y) > TAP_SLOP
        )
          mode.moved = true;
        mode.latest = midpoint;
        setView(anchored(clampZoom(mode.zoom * (distance / mode.distance)), mode.anchor, midpoint));
        return;
      }
      if (mode.kind === 'pan') {
        if (event.pointerId !== mode.pointerId) return;
        const point = local(event);
        setView({
          ...mode.view,
          panX: Math.round(mode.view.panX + point.x - mode.origin.x),
          panY: Math.round(mode.view.panY + point.y - mode.origin.y),
        });
        return;
      }
      if (mode.kind === 'drain') return;
      if (event.pointerType !== 'touch') hover(local(event));
      if (mode.kind === 'draw' && event.pointerId === mode.pointerId) {
        const events = event.getCoalescedEvents?.() ?? [];
        latest.current.input.extend((events.length ? events : [event]).map(sample));
      }
    }

    function onPointerUp(event: PointerEvent): void {
      if (!pointers.delete(event.pointerId)) return;
      if (mode.kind === 'pinch') {
        if (pointers.size > 0) {
          // Lifting one finger ends the pinch, so the last finger can't start a stroke.
          if (mode.moved) settle(mode.latest);
          else if (performance.now() - mode.startedAt < TAP_MS) return;
          mode = mode.moved ? { kind: 'drain' } : mode;
          return;
        }
        const tap = !mode.moved && performance.now() - mode.startedAt < TAP_MS;
        if (tap) {
          if (mode.fingers >= 3) latest.current.input.redo();
          else latest.current.input.undo();
        } else settle(mode.latest);
        mode = { kind: 'idle' };
        return;
      }
      if (mode.kind === 'drain') {
        if (pointers.size === 0) mode = { kind: 'idle' };
        return;
      }
      if (mode.kind === 'pan' && event.pointerId === mode.pointerId) {
        mode = { kind: 'idle' };
        hover(event.pointerType === 'touch' ? null : local(event));
        return;
      }
      if (mode.kind === 'draw' && event.pointerId === mode.pointerId) {
        mode = { kind: 'idle' };
        if (event.type === 'pointercancel') latest.current.input.cancel();
        else latest.current.input.end();
        if (event.pointerType === 'touch') hover(null);
      }
    }

    function onPointerLeave(event: PointerEvent): void {
      if (mode.kind === 'idle' && event.pointerType !== 'touch') hover(null);
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      const point = local(event);
      if (!(event.ctrlKey || event.metaKey)) {
        stopSettle();
        const view = viewport.state;
        setView({
          ...view,
          panX: Math.round(view.panX - event.deltaX),
          panY: Math.round(view.panY - event.deltaY),
        });
        hover(point);
        return;
      }
      // A mouse wheel clicks in whole notches; trackpad pinches stream small deltas.
      const notch =
        event.deltaMode === 1 || (Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
      if (notch) {
        stopSettle();
        wheelNotches += Math.sign(event.deltaY);
        const direction = wheelNotches < 0 ? 1 : -1;
        wheelNotches = 0;
        setView(stepZoom(viewport.state, direction, point));
      } else {
        stopSettle();
        const view = viewport.state;
        const zoom = clampZoom(view.zoom * Math.exp(-event.deltaY * 0.01));
        setView(zoomAt(view, zoom, point));
        settleTimer = setTimeout(() => settle(point), 140);
      }
      hover(point);
    }

    const editable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== ' ' || editable(event.target) || event.repeat) {
        if (event.key === ' ' && spaceHeld) event.preventDefault();
        return;
      }
      // A keyboard user activating a focused control keeps Space. Everyone else pans.
      if (event.target instanceof HTMLElement && event.target.matches('button:focus-visible'))
        return;
      event.preventDefault();
      spaceHeld = true;
      if (hovered) latest.current.input.hover(null);
      updateCursor();
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== ' ' || !spaceHeld) return;
      event.preventDefault();
      spaceHeld = false;
      if (hovered) hover(hovered);
      else updateCursor();
    }

    function onBlur(): void {
      spaceHeld = false;
      updateCursor();
    }

    const block = (event: Event) => event.preventDefault();
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', block);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    // iOS Safari: keep pinches on the canvas from zooming the page.
    globalThis.document.addEventListener('gesturestart', block);

    return () => {
      stopSettle();
      resize.disconnect();
      for (const subscription of subscriptions) subscription.unsubscribe();
      renderer.dispose();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', block);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      globalThis.document.removeEventListener('gesturestart', block);
    };
  }, [document, viewport, overlay]);

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="Canvas"
      aria-roledescription="Pixel canvas"
      tabIndex={-1}
      {...stylex.props(styles.host)}
    >
      <canvas ref={viewportRef} {...stylex.props(styles.layer)} />
      <canvas ref={overlayRef} {...stylex.props(styles.layer)} />
    </div>
  );
}

const styles = stylex.create({
  host: {
    position: 'absolute',
    inset: 0,
    touchAction: 'none',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  layer: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
  },
});
