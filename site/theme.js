// Light, dark or the system's choice. Loaded in <head> so a saved choice applies before the
// page paints; the switch and the screenshots are wired once the page has loaded.
(function () {
  const key = 'vidvnc-theme';
  const root = document.documentElement;
  root.classList.add('js');

  function saved() {
    try {
      const value = localStorage.getItem(key);
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
      return 'system';
    }
  }

  // Each screenshot is a <picture> whose dark <source> normally follows the system. A chosen
  // theme pins it: 'all' always matches, 'not all' never does.
  const media = { system: '(prefers-color-scheme: dark)', dark: 'all', light: 'not all' };

  function apply(mode) {
    if (mode === 'system') delete root.dataset.theme;
    else root.dataset.theme = mode;
    for (const source of document.querySelectorAll('source[data-dark]')) source.media = media[mode];
    for (const button of document.querySelectorAll('[data-theme-choice]'))
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === mode));
  }

  function choose(mode) {
    try {
      if (mode === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, mode);
    } catch {
      // Private browsing or blocked storage: the choice lasts until the page closes.
    }
    apply(mode);
  }

  apply(saved());
  document.addEventListener('DOMContentLoaded', () => {
    apply(saved());
    for (const button of document.querySelectorAll('[data-theme-choice]'))
      button.addEventListener('click', () => choose(button.dataset.themeChoice));
  });
})();
