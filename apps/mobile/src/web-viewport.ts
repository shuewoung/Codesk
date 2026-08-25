import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Pin the Expo Web root to the visual viewport so the composer sits on the IME
 * instead of being scrolled into the middle of the screen (Safari/Chrome).
 */
export function useWebViewportLock() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const root = document.getElementById('root');
    if (!root) return;

    const apply = () => {
      const vv = window.visualViewport;
      const height = Math.round(vv ? vv.height : window.innerHeight);
      const top = Math.round(vv ? vv.offsetTop : 0);
      root.style.position = 'fixed';
      root.style.left = '0px';
      root.style.right = '0px';
      root.style.width = '100%';
      root.style.top = `${top}px`;
      root.style.height = `${height}px`;
      root.style.maxHeight = `${height}px`;
      root.style.overflow = 'hidden';
    };

    apply();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}
