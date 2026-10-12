import { describe, expect, test } from 'bun:test';
import { exposeCheckedState } from './checked';
import type { CheckedAnchor } from './checked';

class Node {
  attributes = new Map<string, string>();
  constructor(
    readonly tag: string,
    role?: string,
    readonly children: Node[] = [],
  ) {
    if (role) this.attributes.set('role', role);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  querySelector(selector: string): Node | null {
    for (const child of this.children) {
      if (child.tag === selector) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

function anchorIn(ancestors: Node[]): CheckedAnchor {
  return {
    closest(selector) {
      return (
        ancestors.find((node) =>
          selector === '[role^="menuitem"]'
            ? node.attributes.get('role')?.startsWith('menuitem')
            : node.tag === selector,
        ) ?? null
      );
    },
  };
}

describe('exposeCheckedState', () => {
  test('a popover row becomes a checked menu item radio or checkbox', () => {
    const row = new Node('div', 'menuitem');
    exposeCheckedState(anchorIn([row]), 'radio', true);
    expect(row.attributes.get('role')).toBe('menuitemradio');
    expect(row.attributes.get('aria-checked')).toBe('true');

    const grid = new Node('div', 'menuitem');
    exposeCheckedState(anchorIn([grid]), 'checkbox', false);
    expect(grid.attributes.get('role')).toBe('menuitemcheckbox');
    expect(grid.attributes.get('aria-checked')).toBe('false');
  });

  test('a row it already marked keeps updating as the state changes', () => {
    const row = new Node('div', 'menuitem');
    exposeCheckedState(anchorIn([row]), 'checkbox', true);
    exposeCheckedState(anchorIn([row]), 'checkbox', false);
    expect(row.attributes.get('role')).toBe('menuitemcheckbox');
    expect(row.attributes.get('aria-checked')).toBe('false');
  });

  test("a sheet row marks its button, the row's only control", () => {
    const button = new Node('button');
    const item = new Node('li', undefined, [button]);
    exposeCheckedState(anchorIn([item]), 'radio', true);
    expect(button.attributes.get('role')).toBe('radio');
    expect(button.attributes.get('aria-checked')).toBe('true');
    expect(item.attributes.has('role')).toBe(false);
  });

  test('outside a row it changes nothing', () => {
    expect(() => exposeCheckedState(anchorIn([]), 'radio', true)).not.toThrow();
  });
});
