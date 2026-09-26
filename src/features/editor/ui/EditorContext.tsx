import { useSelector } from '@tanstack/react-store';
import { createContext, useContext } from 'react';
import type { EditorState } from '../core/state';
import type { EditorSession } from '../session/session';

const EditorContext = createContext<EditorSession | null>(null);

export const EditorProvider = EditorContext.Provider;

export function useEditor(): EditorSession {
  const session = useContext(EditorContext);
  if (!session) throw new Error('useEditor must be used inside EditorProvider');
  return session;
}

/** Subscribes to one slice of editor state. Pointer-rate stores are read through refs instead. */
export function useEditorState<T>(selector: (state: EditorState) => T): T {
  return useSelector(useEditor().state, selector);
}
