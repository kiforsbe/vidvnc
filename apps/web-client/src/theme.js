(() => {
  const root = document.documentElement;
  let choice = 'system';
  try {
    choice = localStorage.getItem('vidvnc-appearance') || 'system';
  } catch {
    /* Storage can be unavailable in private contexts. */
  }
  const apply = (value) => {
    choice = ['light', 'dark'].includes(value) ? value : 'system';
    root.dataset.theme = choice;
  };
  apply(choice);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('appearance');
    // A page that reuses the theme without the appearance control must not throw here.
    if (!select) return;
    select.value = choice;
    select.addEventListener('change', () => {
      apply(select.value);
      try {
        if (choice === 'system') localStorage.removeItem('vidvnc-appearance');
        else localStorage.setItem('vidvnc-appearance', choice);
      } catch {
        /* The theme still works for this visit. */
      }
    });
  });
})();
