/**
 * Focus swaps "64 px" for "64" on the next render, which drops the caret at the end, so the whole
 * value is selected on the next frame. A key pressed before that frame selects first, so fast
 * typing still replaces the value however late the frame is on a big document. A press inside the
 * field places the caret itself and cancels the select.
 */
export function selectOnceEditable(event: { currentTarget: HTMLInputElement }): void {
  const input = event.currentTarget;
  const pending = new AbortController();
  const stop = () => {
    pending.abort();
    cancelAnimationFrame(frame);
  };
  const select = () => {
    stop();
    if (document.activeElement === input) input.select();
  };
  const frame = requestAnimationFrame(select);
  const options = { signal: pending.signal };
  input.addEventListener('keydown', select, options);
  input.addEventListener('pointerdown', stop, options);
  input.addEventListener('blur', stop, options);
}
