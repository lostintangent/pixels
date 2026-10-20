import * as stylex from '@stylexjs/stylex';
import type { Store } from '@tanstack/store';
import { useEffect, useRef } from 'react';
import type { BitmapDocument } from '../../document';
import type { DocumentPoint, ScreenPoint, Viewport } from '../core/contracts';
import { watchPixelDensity } from '../core/density';
import {
  type GestureEvent,
  type GesturePointer,
  type PointerKind,
  initialGestureState,
  isNavigating,
  stepGesture,
  wasDrawFinishedExternally,
} from '../core/gestures';
import { type ViewBounds, boundView, settleView, startFit } from '../core/bounds';
import { MIN_ZOOM, clampZoom, screenToDocument, stepZoom, zoomAt } from '../core/viewport';
import { initialWheelState, wheelIntent } from '../core/wheel';
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
  /** A dialog may finish a press while its pointer is still captured by the canvas. */
  active(): boolean;
  /** The point under a mouse or pen that isn't navigating, with Alt for a temporary eyedropper. */
  hover(sample: CanvasPointerSample | null): void;
  /** Which kind of pointer started it, since touch and pen can't hold modifier keys. */
  begin(sample: CanvasPointerSample, pointer: PointerKind): void;
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
  /** CSS cursor for a hovered sample while nothing is panning. */
  cursorAt: (sample: CanvasPointerSample) => string;
  /** How far the view may zoom out and pan. Without it the view roams freely. */
  bounds?: () => ViewBounds | null;
}

const SETTLE_MS = 180;
/** A drag stretched past a limit springs back over this long. */
const RELEASE_MS = 200;
/** A trackpad pinch settles onto the ladder once it pauses this long. */
const PINCH_SETTLE_MS = 140;
/** Safari reports trackpad pinches twice. The wheel copy wins inside this window. */
const WHEEL_ZOOM_MS = 200;

/** WebKit's trackpad pinch event, which other browsers report as a Ctrl wheel. */
type WebKitGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

export function CanvasSurface({
  document,
  viewport,
  overlay,
  input,
  cursorAt,
  bounds,
}: CanvasSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLCanvasElement>(null);
  const annotationRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ input, cursorAt, bounds });
  latest.current = { input, cursorAt, bounds };

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = createCanvasRenderer({
      documentCanvas: globalThis.document.createElement('canvas'),
      viewportCanvas: viewportRef.current!,
      annotationCanvas: annotationRef.current!,
      overlayCanvas: overlayRef.current!,
      colorSpace: document.state.colorSpace,
    });
    renderer.setDocument(document.state);
    renderer.setViewport(viewport.state);
    renderer.setOverlay(overlay.state);
    let viewWrittenBySurface: Viewport | null = null;
    let cancelExternalSettle: (() => void) | null = null;
    let rehover = () => {};
    const subscriptions = [
      document.subscribe((next) => renderer.setDocument(next)),
      viewport.subscribe((next) => {
        // Fit and other session commands supersede an in-flight pinch settle.
        if (next !== viewWrittenBySurface) cancelExternalSettle?.();
        renderer.setViewport(next);
        // A still pointer now sits over a different pixel, so the brush and readout follow it.
        rehover();
      }),
      overlay.subscribe((next) => renderer.setOverlay(next)),
    ];

    // The host's origin is cached while pointers are down, so moves never force layout.
    const down = new Set<number>();
    let activeOrigin: { left: number; top: number } | null = null;
    const refreshOrigin = () => {
      const { left, top } = host.getBoundingClientRect();
      activeOrigin = { left, top };
    };
    const refreshActiveOrigin = () => {
      if (down.size > 0) refreshOrigin();
    };
    const reportSize = (width: number, height: number) => {
      latest.current.input.resize(Math.round(width), Math.round(height), devicePixelRatio || 1);
      refreshActiveOrigin();
    };
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      reportSize(entry.contentRect.width, entry.contentRect.height);
    });
    try {
      // Chromium reports density-only changes here when the window crosses displays.
      resize.observe(host, { box: 'device-pixel-content-box' });
    } catch {
      resize.observe(host);
    }
    const reportHostSize = () => {
      const { width, height } = host.getBoundingClientRect();
      reportSize(width, height);
    };
    const stopWatchingDensity = watchPixelDensity(window, reportHostSize);
    window.addEventListener('resize', reportHostSize);
    window.addEventListener('scroll', refreshActiveOrigin, true);
    window.visualViewport?.addEventListener('scroll', refreshActiveOrigin);
    window.visualViewport?.addEventListener('resize', refreshActiveOrigin);

    let gesture = initialGestureState;
    // A draw can exist only in the pointer machine, for example Fill pressed off the image.
    // Only a draw that once owned a session gesture can later be abandoned by a dialog.
    let drawingInSession = false;
    let wheel = initialWheelState;
    let spaceHeld = false;
    let altHeld = false;
    let hovered: ScreenPoint | null = null;
    let settleFrame = 0;
    let settleTarget: Viewport | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settlePending: ScreenPoint | null = null;
    /** The view a trackpad pinch began from, so it can come back to an off-ladder fit. */
    let settleStart: Viewport | undefined;
    let lastWheelZoomAt = -Infinity;
    let webkitPinch: { start: Viewport; at: ScreenPoint } | null = null;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    const local = (event: { clientX: number; clientY: number }): ScreenPoint => {
      const rect = activeOrigin ?? host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const sample = (event: PointerEvent): CanvasPointerSample => ({
      point: screenToDocument(viewport.state, local(event)),
      shift: event.shiftKey,
      alt: event.altKey,
    });
    const pointer = (event: PointerEvent): GesturePointer => ({
      id: event.pointerId,
      kind: pointerKind(event),
      point: local(event),
      time: event.timeStamp,
    });
    const setView = (next: Viewport) => {
      viewWrittenBySurface = next;
      viewport.setState(() => next);
    };
    /** Wheel and trackpad input stop dead at a limit, so momentum can't jitter against it. */
    const stopAt = (next: Viewport, at?: ScreenPoint): Viewport => {
      const limits = latest.current.bounds?.();
      return limits ? boundView(next, limits, at) : next;
    };
    /** A direct drag or pinch stretches past a limit, then eases back on release. */
    const stretch = (next: Viewport, at?: ScreenPoint): Viewport => {
      const limits = latest.current.bounds?.();
      return limits ? boundView(next, limits, at, true) : next;
    };
    /** Skips a write that changes nothing, such as a wheel still pushing against a limit. */
    const moveTo = (next: Viewport) => {
      const view = viewport.state;
      // Lifting a zoom back to the floor can differ from the view it started from by rounding.
      const moved =
        Math.abs(next.zoom / view.zoom - 1) > 1e-9 ||
        Math.abs(next.panX - view.panX) > 1e-6 ||
        Math.abs(next.panY - view.panY) > 1e-6;
      if (moved) setView(next);
    };

    function updateCursor(): void {
      if (gesture.mode.kind === 'pan') host.style.cursor = 'grabbing';
      else if (spaceHeld) host.style.cursor = 'grab';
      else if (hovered)
        host.style.cursor = latest.current.cursorAt({
          point: screenToDocument(viewport.state, hovered),
          shift: false,
          alt: altHeld,
        });
      else host.style.cursor = '';
    }

    function hover(point: ScreenPoint | null): void {
      hovered = point;
      const aside = spaceHeld || isNavigating(gesture);
      latest.current.input.hover(
        point && !aside
          ? { point: screenToDocument(viewport.state, point), shift: false, alt: altHeld }
          : null,
      );
      updateCursor();
    }

    rehover = () => {
      if (hovered && !isNavigating(gesture)) hover(hovered);
    };

    function stopSettle(): void {
      cancelAnimationFrame(settleFrame);
      settleFrame = 0;
      settleTarget = null;
      clearTimeout(settleTimer);
      settlePending = null;
      settleStart = undefined;
    }
    cancelExternalSettle = stopSettle;

    /** Jumps a settle in flight to its end, so a new gesture starts from a ladder zoom. */
    function finishSettle(): void {
      if (settlePending) return settle(settlePending, settleStart, false);
      const target = settleTarget;
      stopSettle();
      if (target) setView(target);
    }

    /**
     * Eases a free zoom onto the nearest ladder step, the floor, or the zoom it started from,
     * with pixel-aligned pan inside the bounds.
     */
    function settle(screen: ScreenPoint, start: Viewport | undefined, animate = true): void {
      stopSettle();
      const floor = latest.current.bounds?.()?.minZoom ?? MIN_ZOOM;
      const end = settleView(viewport.state, floor, screen, start);
      easeTo(stopAt(end, screen), screen, SETTLE_MS, animate);
    }

    /** Springs a drag that stretched past a limit back inside it. */
    function release(): void {
      const from = viewport.state;
      const end = stopAt(from);
      if (end !== from) easeTo(end, undefined, RELEASE_MS, true);
    }

    /**
     * Animates to `final`, zooming around `screen` while any correction a bound adds to the pan
     * eases in alongside. Without a bound correction this is a pure zoom around `screen`.
     */
    function easeTo(
      final: Viewport,
      screen: ScreenPoint | undefined,
      duration: number,
      animate: boolean,
    ): void {
      stopSettle();
      const from = viewport.state;
      const at = screen ?? { x: from.cssWidth / 2, y: from.cssHeight / 2 };
      const still =
        final.zoom === from.zoom &&
        Math.abs(final.panX - from.panX) < 1 &&
        Math.abs(final.panY - from.panY) < 1;
      if (!animate || reducedMotion.matches || still) return setView(final);
      settleTarget = final;
      const zoomed = zoomAt(from, final.zoom, at);
      const dx = final.panX - zoomed.panX;
      const dy = final.panY - zoomed.panY;
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / duration);
        if (t >= 1) {
          settleFrame = 0;
          settleTarget = null;
          return setView(final);
        }
        const eased = 1 - (1 - t) ** 3;
        const next = zoomAt(from, from.zoom * (final.zoom / from.zoom) ** eased, at);
        next.panX += dx * eased;
        next.panY += dy * eased;
        // Frames on the way to a fit keep naming it.
        next.fittedZoom = final.fittedZoom;
        setView(next);
        settleFrame = requestAnimationFrame(step);
      };
      settleFrame = requestAnimationFrame(step);
    }

    function run(event: GestureEvent, source: PointerEvent | null): void {
      const wasNavigating = isNavigating(gesture);
      const wasPanning = gesture.mode.kind === 'pan';
      const step = stepGesture(gesture, event, viewport.state);
      gesture = step.state;
      const { input } = latest.current;
      for (const command of step.commands) {
        switch (command.type) {
          case 'begin':
            if (source) {
              input.begin(sample(source), pointerKind(source));
              drawingInSession = input.active();
            }
            break;
          case 'extend':
            if (source) {
              const events = source.getCoalescedEvents?.() ?? [];
              input.extend((events.length ? events : [source]).map(sample));
            }
            break;
          case 'end':
            input.end();
            drawingInSession = false;
            break;
          case 'cancel':
            input.cancel();
            drawingInSession = false;
            break;
          case 'view':
            stopSettle();
            // A pinch stretches around its fingers, so the pixel under them stays put.
            setView(
              stretch(
                command.viewport,
                gesture.mode.kind === 'pinch' ? gesture.mode.latest : undefined,
              ),
            );
            break;
          case 'settle':
            settle(command.at, command.start);
            break;
          case 'undo':
            input.undo();
            break;
          case 'redo':
            input.redo();
            break;
        }
      }
      // A pan has no settle of its own, so one that ends past a limit springs back here.
      if (wasPanning && gesture.mode.kind === 'idle') release();
      if (isNavigating(gesture) !== wasNavigating) hover(isNavigating(gesture) ? null : hovered);
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button === 2) return;
      if (down.size === 0) refreshOrigin();
      down.add(event.pointerId);
      host.setPointerCapture(event.pointerId);
      host.focus({ preventScroll: true });
      finishSettle();
      altHeld = event.altKey;
      run({ type: 'down', pointer: pointer(event), button: event.button, space: spaceHeld }, event);
    }

    function onPointerMove(event: PointerEvent): void {
      if (event.pointerType !== 'touch') altHeld = event.altKey;
      if (wasDrawFinishedExternally(gesture, drawingInSession, latest.current.input.active()))
        run({ type: 'escape' }, null);
      if (event.pointerType === 'mouse' && event.buttons === 0 && down.has(event.pointerId)) {
        down.delete(event.pointerId);
        run({ type: 'move', pointer: pointer(event), buttons: 0 }, event);
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        hover(local(event));
        if (down.size === 0) activeOrigin = null;
        return;
      }
      if (down.has(event.pointerId))
        run({ type: 'move', pointer: pointer(event), buttons: event.buttons }, event);
      if (event.pointerType !== 'touch' && !isNavigating(gesture)) hover(local(event));
    }

    function onPointerUp(event: PointerEvent): void {
      if (!down.delete(event.pointerId)) return;
      const cancelled = event.type === 'pointercancel';
      run({ type: 'up', pointer: pointer(event), cancelled }, event);
      if (event.pointerType === 'touch') {
        if (!isNavigating(gesture)) hover(null);
      } else hover(cancelled ? null : local(event));
      if (down.size === 0) activeOrigin = null;
    }

    function onPointerLeave(event: PointerEvent): void {
      if (gesture.mode.kind === 'idle' && event.pointerType !== 'touch') hover(null);
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      const point = local(event);
      const before = viewport.state;
      hovered = point;
      const read = wheelIntent(wheel, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        zoomKey: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
        legacyDeltaY: (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
        time: event.timeStamp,
      });
      wheel = read.state;
      const { intent } = read;
      if (intent.kind === 'pan') {
        finishSettle();
        const view = viewport.state;
        moveTo(
          stopAt({
            ...view,
            panX: Math.round(view.panX + intent.dx),
            panY: Math.round(view.panY + intent.dy),
          }),
        );
      } else if (intent.kind === 'step') {
        finishSettle();
        const view = viewport.state;
        const floor = latest.current.bounds?.()?.minZoom ?? 0;
        // At or under the floor, zooming out only ever holds still.
        if (intent.direction > 0 || view.zoom > floor)
          moveTo(stopAt(stepZoom(view, intent.direction, point), point));
      } else if (intent.kind === 'zoom') {
        // A burst of pinch wheels keeps the view it began from, even across an interrupted settle.
        const start = settlePending ? settleStart : (settleTarget ?? viewport.state);
        stopSettle();
        lastWheelZoomAt = event.timeStamp;
        const view = viewport.state;
        const zoomed = zoomAt(view, clampZoom(view.zoom * intent.factor), point);
        zoomed.fittedZoom = startFit(start);
        moveTo(stopAt(zoomed, point));
        settlePending = point;
        settleStart = start;
        settleTimer = setTimeout(() => settle(point, start), PINCH_SETTLE_MS);
      }
      if (viewport.state === before) hover(point);
    }

    // Desktop Safari reports trackpad pinches as gesture events rather than Ctrl wheels.
    function onGestureStart(event: WebKitGestureEvent): void {
      event.preventDefault();
      if (down.size > 0 || !(event.target instanceof Node) || !host.contains(event.target)) return;
      finishSettle();
      const at =
        event.clientX === undefined || event.clientY === undefined
          ? (hovered ?? { x: viewport.state.cssWidth / 2, y: viewport.state.cssHeight / 2 })
          : local({ clientX: event.clientX, clientY: event.clientY });
      webkitPinch = { start: viewport.state, at };
    }

    function onGestureChange(event: WebKitGestureEvent): void {
      event.preventDefault();
      if (!webkitPinch || down.size > 0 || event.scale === undefined) return;
      if (event.timeStamp - lastWheelZoomAt < WHEEL_ZOOM_MS) return;
      const { start, at } = webkitPinch;
      const zoomed = zoomAt(viewport.state, clampZoom(start.zoom * event.scale), at);
      zoomed.fittedZoom = startFit(start);
      moveTo(stopAt(zoomed, at));
    }

    function onGestureEnd(event: WebKitGestureEvent): void {
      event.preventDefault();
      if (webkitPinch && event.timeStamp - lastWheelZoomAt >= WHEEL_ZOOM_MS)
        settle(webkitPinch.at, webkitPinch.start);
      webkitPinch = null;
    }

    const editable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    /** Escape abandons a drag in progress before any shortcut sees it. */
    function onEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || gesture.mode.kind !== 'draw') return;
      // A dialog already ended the document gesture. Leave Escape for the dialog to close.
      if (wasDrawFinishedExternally(gesture, drawingInSession, latest.current.input.active())) {
        run({ type: 'escape' }, null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      run({ type: 'escape' }, null);
    }

    function setAlt(held: boolean): void {
      if (altHeld === held) return;
      altHeld = held;
      if (hovered && gesture.mode.kind === 'idle') hover(hovered);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Alt') {
        if (hovered) event.preventDefault();
        return setAlt(true);
      }
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
      if (event.key === 'Alt') {
        if (hovered) event.preventDefault();
        return setAlt(false);
      }
      if (event.key !== ' ' || !spaceHeld) return;
      event.preventDefault();
      spaceHeld = false;
      if (hovered) hover(hovered);
      else updateCursor();
    }

    function onBlur(): void {
      spaceHeld = false;
      altHeld = false;
      if (hovered) hover(hovered);
      else updateCursor();
    }

    const block = (event: Event) => event.preventDefault();
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('pointerleave', onPointerLeave);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', block);
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    // iOS Safari zooms the page on pinch unless these are blocked everywhere.
    globalThis.document.addEventListener('gesturestart', onGestureStart);
    globalThis.document.addEventListener('gesturechange', onGestureChange);
    globalThis.document.addEventListener('gestureend', onGestureEnd);

    return () => {
      stopSettle();
      resize.disconnect();
      stopWatchingDensity();
      window.removeEventListener('resize', reportHostSize);
      window.removeEventListener('scroll', refreshActiveOrigin, true);
      window.visualViewport?.removeEventListener('scroll', refreshActiveOrigin);
      window.visualViewport?.removeEventListener('resize', refreshActiveOrigin);
      for (const subscription of subscriptions) subscription.unsubscribe();
      renderer.dispose();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', block);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      globalThis.document.removeEventListener('gesturestart', onGestureStart);
      globalThis.document.removeEventListener('gesturechange', onGestureChange);
      globalThis.document.removeEventListener('gestureend', onGestureEnd);
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
      <canvas ref={annotationRef} {...stylex.props(styles.layer)} />
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

function pointerKind(event: PointerEvent): PointerKind {
  return event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse';
}
