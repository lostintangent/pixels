import { decodeToolPreferences } from '../core/preferences';
import { DEFAULT_TOOL_PREFERENCES } from '../core/state';
import type { ToolPreferences } from '../core/state';

const STORAGE_KEY = 'pixels.tools';

/** Your tools as you left them, so a reload or a new tab picks up where you were. */
export function readToolPreferences(): ToolPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_TOOL_PREFERENCES : decodeToolPreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_TOOL_PREFERENCES;
  }
}

export function writeToolPreferences(preferences: ToolPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private browsing can refuse storage. The tools still carry between documents this visit.
  }
}
