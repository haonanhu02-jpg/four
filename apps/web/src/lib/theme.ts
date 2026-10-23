export type ThemePreference = 'system' | 'light' | 'dark';
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function preference(): ThemePreference {
  try {
    const value = localStorage.getItem('workbench-theme');
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(value = preference()) {
  const dark = value === 'dark' || (value === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#111827' : '#4361ee');
}
export function setTheme(value: ThemePreference) {
  try {
    localStorage.setItem('workbench-theme', value);
  } catch {
    /* Preference is optional; business writes use IndexedDB. */
  }
  applyTheme(value);
}
applyTheme();
media.addEventListener('change', () => applyTheme());
window.addEventListener('storage', (event) => {
  if (event.key === 'workbench-theme') applyTheme();
});
