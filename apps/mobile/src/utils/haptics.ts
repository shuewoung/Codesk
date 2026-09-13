import { Platform, Vibration } from 'react-native';

export type HapticType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

/**
 * 跨平台轻量触觉反馈工具。
 * 在 Android / iOS 原生上基于 Vibration 实现微震动，零外部原生依赖；
 * 在 Web 上基于 navigator.vibrate 实现。
 */
export function triggerHaptic(type: HapticType = 'light') {
  try {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.navigator && typeof window.navigator.vibrate === 'function') {
        const duration = type === 'light' ? 8 : type === 'medium' ? 15 : type === 'success' ? [10, 30, 15] : 25;
        window.navigator.vibrate(duration);
      }
      return;
    }

    if (Platform.OS === 'android') {
      switch (type) {
        case 'light':
          Vibration.vibrate(10);
          break;
        case 'medium':
          Vibration.vibrate(20);
          break;
        case 'heavy':
          Vibration.vibrate(35);
          break;
        case 'success':
          Vibration.vibrate([0, 10, 40, 15]);
          break;
        case 'warning':
        case 'error':
          Vibration.vibrate([0, 20, 40, 20]);
          break;
      }
      return;
    }

    if (Platform.OS === 'ios') {
      // iOS 支持短震动
      Vibration.vibrate();
    }
  } catch {
    // 忽略不支持的环境
  }
}
