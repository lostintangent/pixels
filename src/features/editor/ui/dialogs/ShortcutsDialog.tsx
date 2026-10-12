import * as stylex from '@stylexjs/stylex';
import { Kbd } from '@astryxdesign/core/Kbd';
import { colorVars, fontWeightVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Fragment, useId, useMemo } from 'react';
import { sheetGroups } from '../../core/shortcutSheet';
import type { SheetGroup, SheetRow, SheetWay } from '../../core/shortcutSheet';
import type { Layout } from '../../session/session';
import { useEditor, useEditorState } from '../EditorContext';
import { Surface } from './Surface';

/**
 * Every key and gesture on one calm page: three balanced columns on desktop, one list on phones.
 * Gestures lead where touch is the main input. Nothing here is interactive, so it is an info
 * surface that a scrim tap or swipe dismisses.
 */
export function ShortcutsDialog({ layout }: { layout: Layout }) {
  const session = useEditor();
  const isOpen = useEditorState((state) => state.panel === 'shortcuts');
  // Read on open: a pointer change mid-sheet shouldn't reshuffle what the artist is reading.
  const groups = useMemo(
    () => sheetGroups(isOpen && matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'),
    [isOpen],
  );
  const phone = layout === 'phone';

  return (
    <Surface
      layout={layout}
      isOpen={isOpen}
      onOpenChange={(open) => !open && session.setPanel(null)}
      title="Shortcuts and gestures"
      width={880}
      maxHeight="calc(100dvh - 48px)"
      purpose="info"
    >
      <div {...stylex.props(styles.groups, phone && styles.groupsPhone)}>
        {groups.map((group) => (
          <Group key={group.title} group={group} phone={phone} />
        ))}
      </div>
    </Surface>
  );
}

function Group({ group, phone }: { group: SheetGroup; phone: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.group, phone && styles.groupPhone)}>
      <h3 id={id} {...stylex.props(styles.title)}>
        {group.title}
      </h3>
      <dl {...stylex.props(styles.rows)}>
        {group.rows.map((row) => (
          <Row key={row.label} row={row} phone={phone} />
        ))}
      </dl>
    </section>
  );
}

function Row({ row, phone }: { row: SheetRow; phone: boolean }) {
  return (
    <div {...stylex.props(styles.row, phone && styles.rowPhone)}>
      <dt {...stylex.props(styles.label, phone && styles.labelPhone)}>{row.label}</dt>
      <dd {...stylex.props(styles.ways)}>
        {row.ways.map((way, index) => (
          <Fragment key={index}>
            {index > 0 && !row.isList && <span {...stylex.props(styles.or)}>or</span>}
            <Way way={way} phone={phone} />
          </Fragment>
        ))}
      </dd>
    </div>
  );
}

function Way({ way, phone }: { way: SheetWay; phone: boolean }) {
  return (
    <span {...stylex.props(styles.way)}>
      {way.map((token, index) =>
        'keys' in token ? (
          <Kbd key={index} keys={token.keys} />
        ) : (
          <span key={index} {...stylex.props(styles.text, phone && styles.textPhone)}>
            {token.text}
          </span>
        ),
      )}
    </span>
  );
}

const styles = stylex.create({
  groups: {
    columns: '3 232px',
    columnGap: spacingVars['--spacing-8'],
    paddingTop: spacingVars['--spacing-4'],
    paddingInline: spacingVars['--spacing-5'],
    paddingBottom: spacingVars['--spacing-3'],
  },
  groupsPhone: {
    columns: 'auto',
    paddingTop: spacingVars['--spacing-3'],
    paddingBottom: `max(${spacingVars['--spacing-5']}, env(safe-area-inset-bottom))`,
  },
  group: {
    breakInside: 'avoid',
    paddingBottom: spacingVars['--spacing-4'],
  },
  groupPhone: { paddingBottom: spacingVars['--spacing-5'] },
  title: {
    margin: 0,
    paddingBottom: spacingVars['--spacing-1'],
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: fontWeightVars['--font-weight-semibold'],
    color: colorVars['--color-text-secondary'],
  },
  rows: { margin: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacingVars['--spacing-3'],
    minHeight: 28,
  },
  // Rows aren't controls, but a thumb-height rhythm keeps the list as calm as the menus it sits in.
  rowPhone: {
    minHeight: 44,
    // Forced colors would draw every hairline as loud as text, and the rhythm reads without them.
    borderBottomWidth: { default: 1, ':last-child': 0, '@media (forced-colors: active)': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: colorVars['--color-border'],
  },
  label: { fontSize: 13, lineHeight: '18px', color: colorVars['--color-text-primary'] },
  labelPhone: { fontSize: 15, lineHeight: '20px' },
  ways: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: spacingVars['--spacing-2'],
    rowGap: spacingVars['--spacing-1'],
    margin: 0,
  },
  way: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    whiteSpace: 'nowrap',
  },
  or: { fontSize: 12, color: colorVars['--color-text-secondary'] },
  text: { fontSize: 13, color: colorVars['--color-text-secondary'] },
  textPhone: { fontSize: 15 },
});
