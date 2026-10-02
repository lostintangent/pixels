import * as stylex from '@stylexjs/stylex';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Copy, CopyPlus, Scissors, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EditorSession } from '../session/session';
import { useEditor, useEditorState } from './EditorContext';
import { copyFromChrome } from './files/useClipboard';

interface Action {
  label: string;
  tooltip: string;
  icon: ReactNode;
  run: (session: EditorSession) => void;
}

type Kind = 'select' | 'selection' | 'shape';

const ACTIONS: Record<Exclude<Kind, 'select'>, { actions: Action[]; deselect: Action }> = {
  selection: {
    actions: [
      {
        label: 'Copy',
        tooltip: 'Copy  ·  ⌘C',
        icon: <Copy size={18} />,
        run: (session) => copyFromChrome(session, 'copy'),
      },
      {
        label: 'Cut',
        tooltip: 'Cut  ·  ⌘X',
        icon: <Scissors size={18} />,
        run: (session) => copyFromChrome(session, 'cut'),
      },
      {
        label: 'Duplicate',
        tooltip: 'Duplicate in place',
        icon: <CopyPlus size={18} />,
        run: (session) => session.run({ type: 'selection', action: 'duplicate' }),
      },
      {
        label: 'Clear pixels',
        tooltip: 'Clear  ·  Delete',
        icon: <Trash2 size={18} />,
        run: (session) => session.run({ type: 'selection', action: 'clear' }),
      },
    ],
    deselect: {
      label: 'Deselect',
      tooltip: 'Deselect  ·  Enter',
      icon: null,
      run: (session) => session.run({ type: 'selection', action: 'commit' }),
    },
  },
  shape: {
    actions: [
      {
        label: 'Duplicate shape',
        tooltip: 'Duplicate  ·  ⌥ drag',
        icon: <CopyPlus size={18} />,
        run: (session) => session.run({ type: 'shape', action: 'duplicate' }),
      },
      {
        label: 'Delete shape',
        tooltip: 'Delete  ·  ⌫',
        icon: <Trash2 size={18} />,
        run: (session) => session.run({ type: 'shape', action: 'delete' }),
      },
    ],
    deselect: {
      label: 'Deselect',
      tooltip: 'Deselect  ·  Esc',
      icon: null,
      run: (session) => session.run({ type: 'shape', action: 'deselect' }),
    },
  },
};

/**
 * The Select tool's actions: Select all and Paste, then the actions for a pixel selection or a
 * selected shape. They load with the other rare surfaces, at idle or when Select or Shapes is armed.
 */
export function ToolActions({ kind, phone }: { kind: Kind; phone: boolean }) {
  const session = useEditor();
  if (kind === 'select') return <SelectActions phone={phone} />;
  const { actions, deselect } = ACTIONS[kind];
  return (
    <>
      {!phone && <span aria-hidden {...stylex.props(styles.divider)} />}
      {actions.map((action) => (
        <IconButton
          key={action.label}
          variant="ghost"
          label={action.label}
          tooltip={phone ? undefined : action.tooltip}
          icon={action.icon}
          onClick={() => action.run(session)}
        />
      ))}
      {/* Phones keep a 44 px icon target. Desktop spells the word out beside its shortcut. */}
      {phone ? (
        <IconButton
          variant="ghost"
          label={deselect.label}
          icon={<X size={20} />}
          onClick={() => deselect.run(session)}
        />
      ) : (
        <Button
          variant="ghost"
          label={deselect.label}
          tooltip={deselect.tooltip}
          onClick={() => deselect.run(session)}
        />
      )}
    </>
  );
}

// Touch has no ⌘A or ⌘V, so Select offers both. Paste waits until there's something to paste.
function SelectActions({ phone }: { phone: boolean }) {
  const session = useEditor();
  const canPaste = useEditorState((state) => state.hasClipboardPixels);
  const run = (action: 'all' | 'paste') => session.run({ type: 'selection', action });
  return (
    <>
      {!phone && <span aria-hidden {...stylex.props(styles.divider)} />}
      <Button
        variant="ghost"
        label="Select all"
        tooltip={phone ? undefined : 'Select all  ·  ⌘A'}
        onClick={() => run('all')}
      />
      {canPaste && (
        <Button
          variant="ghost"
          label="Paste"
          tooltip={phone ? undefined : 'Paste  ·  ⌘V'}
          onClick={() => run('paste')}
        />
      )}
    </>
  );
}

const styles = stylex.create({
  divider: { width: 1, height: 20, marginInline: 2, backgroundColor: colorVars['--color-border'] },
});
