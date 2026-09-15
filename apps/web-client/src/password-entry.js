// Shared with the server: normalize presentation, never guess or truncate secrets.
export function normalizePassword(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  if (!/^[A-Z]{4}-?[A-Z]{4}$/.test(text)) return null;
  const letters = text.replace('-', '');
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}
export function formatPasswordEntry(value, caret = value.length) {
  // Invalid characters remain visible and fail validation, rather than silently
  // transforming a mistyped password into a different valid password.
  if (!/^[a-zA-Z\s-]*$/.test(value)) return { value, caret };
  const letters = value.replace(/[\s-]/g, '').toUpperCase();
  const before = value.slice(0, caret).replace(/[\s-]/g, '').length;
  return {
    value: letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters,
    caret: before + (before > 4 ? 1 : 0),
  };
}
export function formatSegmentedPasswordEntry(value, start = value.length, end = start) {
  if (!/^[a-zA-Z\s-]*$/.test(value)) return { value, start, end };
  const first = formatPasswordEntry(value, start);
  return { value: first.value, start: first.caret, end: formatPasswordEntry(value, end).caret };
}
export function bindPasswordEntry(input) {
  if (input.closest('.code-entry')) {
    const wrapper = input.closest('.code-entry');
    const cells = [...wrapper.querySelectorAll('.code-cells span')];
    // Keep native editing/accessibility, but paint text and selection per cell.
    // Native letter-spacing selections and horizontal input scrolling must never
    // move characters away from their boxes or paint across the separator.
    const render = () => {
      const focused = document.activeElement === input;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      const letters = input.value.replace('-', '');
      const caret = Math.min(7, input.value.slice(0, start).replace('-', '').length);
      cells.forEach((cell, index) => {
        const offset = index + (index >= 4 ? 1 : 0);
        cell.textContent = letters[index] || '';
        cell.classList.toggle(
          'selected',
          focused && start < end && offset >= start && offset < end && Boolean(letters[index]),
        );
        cell.classList.toggle('active', focused && start === end && index === caret);
      });
    };
    const resize = () => wrapper.style.setProperty('--cell-pitch', `${wrapper.clientWidth / 9}px`);
    new ResizeObserver(resize).observe(wrapper);
    const update = () => {
      const formatted = formatSegmentedPasswordEntry(
        input.value,
        input.selectionStart ?? input.value.length,
        input.selectionEnd ?? input.value.length,
      );
      input.value = formatted.value;
      input.setSelectionRange(formatted.start, formatted.end);
      wrapper.classList.toggle(
        'invalid-format',
        !/^(?:[A-Z]{0,4}|[A-Z]{4}-[A-Z]{1,4})$/.test(input.value),
      );
      input.setCustomValidity('');
      input.removeAttribute('aria-invalid');
      const error = document.getElementById('passwordError');
      if (error) error.textContent = '';
      render();
    };
    input.addEventListener('input', (event) => {
      if (!event.isComposing) update();
    });
    input.addEventListener('compositionend', update);
    input.addEventListener('focus', render);
    input.addEventListener('blur', render);
    input.addEventListener('select', render);
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === input) render();
    });
    render();
    input.addEventListener('beforeinput', (event) => {
      if (
        event.inputType === 'deleteContentBackward' &&
        input.selectionStart === 5 &&
        input.selectionEnd === 5 &&
        input.value[4] === '-'
      ) {
        event.preventDefault();
        input.value = input.value.slice(0, 3) + input.value.slice(5);
        input.setSelectionRange(3, 3);
        update();
      }
    });
    return;
  }
  input.addEventListener('input', (event) => {
    if (event.isComposing) return;
    const formatted = formatPasswordEntry(input.value, input.selectionStart ?? input.value.length);
    input.value = formatted.value;
    input.setSelectionRange(formatted.caret, formatted.caret);
    input.setCustomValidity('');
  });
  // Backspace directly after the automatic separator should delete a letter,
  // not repeatedly remove and reinsert the same separator.
  input.addEventListener('beforeinput', (event) => {
    if (
      event.inputType === 'deleteContentBackward' &&
      input.selectionStart === 5 &&
      input.selectionEnd === 5 &&
      input.value[4] === '-'
    ) {
      event.preventDefault();
      const formatted = formatPasswordEntry(input.value.slice(0, 3) + input.value.slice(5), 3);
      input.value = formatted.value;
      input.setSelectionRange(formatted.caret, formatted.caret);
      input.setCustomValidity('');
    }
  });
}
