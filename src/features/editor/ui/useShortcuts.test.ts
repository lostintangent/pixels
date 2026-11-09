import { describe, expect, test } from 'bun:test';
import { resolveShortcut } from '../core/shortcuts';
import { blocksBrowserDefault, shortcutReachesEditor } from './useShortcuts';
import type { BrowserKey, KeyTarget } from './useShortcuts';

/** Just enough of an element for the simple tag and attribute selectors key routing uses. */
class Node implements KeyTarget {
  readonly children: Node[] = [];
  parent: Node | null = null;
  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
  ) {}
  add(child: Node): Node {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  matches(selectors: string): boolean {
    return selectors.split(',').some((selector) => {
      const [, tag, name, value] = /^\s*(\w*)(?:\[([\w-]+)(?:="([^"]*)")?\])?\s*$/.exec(selector)!;
      if (tag && tag !== this.tag) return false;
      if (!name) return true;
      return name in this.attributes && (value === undefined || this.attributes[name] === value);
    });
  }
  closest(selectors: string): Node | null {
    return this.matches(selectors) ? this : (this.parent?.closest(selectors) ?? null);
  }
  querySelector(selectors: string): Node | null {
    for (const child of this.children) {
      const found = child.matches(selectors) ? child : child.querySelector(selectors);
      if (found) return found;
    }
    return null;
  }
}

const idle = { hasSelection: false, hasShapeSelection: true, gesturing: false };
function command(key: string, mod = false, shift = false) {
  return resolveShortcut({ key, mod, shift, alt: false }, idle)!.type;
}

/** The phone Colors sheet: BottomSheet's focus root holds the marked picker content. */
function colorSheet() {
  const body = new Node('body');
  const sheet = body.add(new Node('dialog', { role: 'dialog' }));
  const root = sheet.add(new Node('div', { tabindex: '-1' }));
  const content = root.add(new Node('div', { 'data-passes-history': '' }));
  const field = content.add(new Node('div', { role: 'slider' }));
  const hex = content.add(new Node('input'));
  return { root, field, hex };
}

describe('Undo and Redo from color surfaces', () => {
  test('reach the document from the sheet focus root, right after opening or a touch drag', () => {
    const { root } = colorSheet();
    expect(shortcutReachesEditor(root, command('z', true), true)).toBe(true);
    expect(shortcutReachesEditor(root, command('z', true, true), true)).toBe(true);
    expect(shortcutReachesEditor(root, command('y', true), true)).toBe(true);
  });

  test('reach the document from the picker sliders', () => {
    const { field } = colorSheet();
    expect(shortcutReachesEditor(field, command('z', true), true)).toBe(true);
  });

  test('leave every other key with the sheet', () => {
    const { root, field } = colorSheet();
    for (const target of [root, field]) {
      expect(shortcutReachesEditor(target, command('Backspace'), true)).toBe(false);
      expect(shortcutReachesEditor(target, command('b'), true)).toBe(false);
    }
  });

  test('leave the hex field its native text undo', () => {
    const { hex } = colorSheet();
    expect(shortcutReachesEditor(hex, command('z', true), true)).toBe(false);
  });

  test('stay with other dialogs and menus', () => {
    const body = new Node('body');
    const dialog = body.add(new Node('dialog')).add(new Node('div', { tabindex: '-1' }));
    const menu = body.add(new Node('div', { role: 'menu' }));
    expect(shortcutReachesEditor(dialog, command('z', true), true)).toBe(false);
    expect(shortcutReachesEditor(menu, command('z', true), false)).toBe(false);
  });

  test('reach the editor from the canvas as always', () => {
    const canvas = new Node('body').add(new Node('div', { role: 'application' }));
    expect(shortcutReachesEditor(canvas, command('z', true), false)).toBe(true);
    expect(shortcutReachesEditor(canvas, command('b'), false)).toBe(true);
  });
});

describe('Browser commands that would leave the editor', () => {
  const press = (key: string, modifiers: Partial<BrowserKey> = {}, code = ''): BrowserKey => ({
    key,
    code,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    ...modifiers,
  });
  const meta = { meta: true };

  test('are blocked on a Mac, even with nothing for the editor to do', () => {
    for (const key of ['d', 'f', '[', ']', 'ArrowLeft', 'ArrowRight'])
      expect(blocksBrowserDefault(press(key, meta), true, false)).toBe(true);
    // A layout that types another character on the bracket key still goes Back.
    expect(blocksBrowserDefault(press('ü', meta, 'BracketLeft'), true, false)).toBe(true);
  });

  test('leave Command arrows to move the caret in a field', () => {
    expect(blocksBrowserDefault(press('ArrowLeft', meta), true, true)).toBe(false);
    expect(blocksBrowserDefault(press('d', meta), true, true)).toBe(true);
  });

  test('leave tab switching, full screen, and plain typing alone', () => {
    expect(
      blocksBrowserDefault(press('{', { meta: true, shift: true }, 'BracketLeft'), true, false),
    ).toBe(false);
    expect(blocksBrowserDefault(press('f', { meta: true, ctrl: true }), true, false)).toBe(false);
    expect(blocksBrowserDefault(press('ArrowRight', { meta: true, alt: true }), true, false)).toBe(
      false,
    );
    expect(blocksBrowserDefault(press('d'), true, false)).toBe(false);
    expect(blocksBrowserDefault(press('ArrowLeft'), true, false)).toBe(false);
  });

  test('use Control and Alt elsewhere', () => {
    expect(blocksBrowserDefault(press('d', { ctrl: true }), false, false)).toBe(true);
    expect(blocksBrowserDefault(press('f', { ctrl: true }), false, true)).toBe(true);
    expect(blocksBrowserDefault(press('ArrowLeft', { alt: true }), false, true)).toBe(true);
    expect(blocksBrowserDefault(press('[', { ctrl: true }), false, false)).toBe(false);
    expect(blocksBrowserDefault(press('d', meta), false, false)).toBe(false);
    // AltGr types characters as Control+Alt.
    expect(blocksBrowserDefault(press('d', { ctrl: true, alt: true }), false, false)).toBe(false);
  });
});
