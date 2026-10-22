import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

// The initial theme is resolved by the inline script in index.html, before first paint.
// Until the user picks one with the navbar toggle, the dashboard follows the OS setting.
const STORAGE_KEY = 'dash_theme';
const OS_LIGHT = '(prefers-color-scheme: light)';

function readStored(): Theme | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    const mq = window.matchMedia(OS_LIGHT);
    const onChange = () => {
      if (readStored()) return; // an explicit choice wins over the OS
      const t: Theme = mq.matches ? 'light' : 'dark';
      applyTheme(t);
      setTheme(t);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice still applies for this page load
    }
    setTheme(next);
  }, []);

  return [theme, toggle];
}
