import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  shell: {
    minHeight: '100%',
    display: 'grid',
    placeItems: 'center',
    backgroundColor: 'var(--color-bg, #f7f7f5)',
    color: 'var(--color-text, #242424)',
  },
  title: { fontSize: 18, fontWeight: 600, letterSpacing: '-0.03em' },
});

export function EditorShell() {
  return (
    <main {...stylex.props(styles.shell)}>
      <h1 {...stylex.props(styles.title)}>Pixels</h1>
    </main>
  );
}
