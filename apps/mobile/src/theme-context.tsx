import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadListDensity, loadShowProcess, loadTheme, saveListDensity, saveShowProcess, saveTheme, type ListDensity } from './storage';
import { dark, light, type Palette, type ThemeName } from './theme';

type ThemeValue = {
  theme: ThemeName;
  colors: Palette;
  listDensity: ListDensity;
  showProcess: boolean;
  setTheme: (name: ThemeName) => void;
  setListDensity: (name: ListDensity) => void;
  setShowProcess: (on: boolean) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>('light');
  const [listDensity, setDensityState] = useState<ListDensity>('compact');
  const [showProcess, setProcessState] = useState(false);

  useEffect(() => {
    void loadTheme().then(setThemeState);
    void loadListDensity().then(setDensityState);
    void loadShowProcess().then(setProcessState);
  }, []);

  const setTheme = useCallback((name: ThemeName) => {
    setThemeState(name);
    void saveTheme(name);
  }, []);

  const setListDensity = useCallback((name: ListDensity) => {
    setDensityState(name);
    void saveListDensity(name);
  }, []);

  const setShowProcess = useCallback((on: boolean) => {
    setProcessState(on);
    void saveShowProcess(on);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      colors: theme === 'dark' ? dark : light,
      listDensity,
      showProcess,
      setTheme,
      setListDensity,
      setShowProcess,
      toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    }),
    [theme, listDensity, showProcess, setTheme, setListDensity, setShowProcess],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeProvider missing');
  return ctx;
}
