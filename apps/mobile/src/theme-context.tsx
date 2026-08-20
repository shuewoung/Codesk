import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadTheme, saveTheme } from './storage';
import { dark, light, type Palette, type ThemeName } from './theme';

type ThemeValue = {
  theme: ThemeName;
  colors: Palette;
  setTheme: (name: ThemeName) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>('light');

  useEffect(() => {
    void loadTheme().then(setThemeState);
  }, []);

  const setTheme = useCallback((name: ThemeName) => {
    setThemeState(name);
    void saveTheme(name);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      colors: theme === 'dark' ? dark : light,
      setTheme,
      toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeProvider missing');
  return ctx;
}
