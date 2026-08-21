import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadListDensity, loadTheme, saveListDensity, saveTheme, type ListDensity } from './storage';
import { dark, light, type Palette, type ThemeName } from './theme';

type ThemeValue = {
  theme: ThemeName;
  colors: Palette;
  listDensity: ListDensity;
  setTheme: (name: ThemeName) => void;
  setListDensity: (name: ListDensity) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>('light');
  const [listDensity, setDensityState] = useState<ListDensity>('compact');

  useEffect(() => {
    void loadTheme().then(setThemeState);
    void loadListDensity().then(setDensityState);
  }, []);

  const setTheme = useCallback((name: ThemeName) => {
    setThemeState(name);
    void saveTheme(name);
  }, []);

  const setListDensity = useCallback((name: ListDensity) => {
    setDensityState(name);
    void saveListDensity(name);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      colors: theme === 'dark' ? dark : light,
      listDensity,
      setTheme,
      setListDensity,
      toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    }),
    [theme, listDensity, setTheme, setListDensity],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeProvider missing');
  return ctx;
}
