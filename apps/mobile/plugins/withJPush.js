const { AndroidConfig, withAppBuildGradle } = require('@expo/config-plugins');

function injectPlaceholders(contents, appKey, channel) {
  const line = `manifestPlaceholders += [JPUSH_APPKEY: "${appKey}", JPUSH_CHANNEL: "${channel}"]`;
  if (contents.includes('JPUSH_APPKEY')) {
    return contents.replace(
      /manifestPlaceholders \+= \[JPUSH_APPKEY: "[^"]*", JPUSH_CHANNEL: "[^"]*"\]/,
      line
    );
  }
  if (contents.includes('defaultConfig {')) {
    return contents.replace(/defaultConfig \{/, `defaultConfig {\n        ${line}`);
  }
  return contents;
}

function withJPush(config, { appKey = '', channel = 'developer-default' } = {}) {
  config = withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') {
      mod.modResults.contents = injectPlaceholders(
        mod.modResults.contents,
        String(appKey),
        String(channel)
      );
    }
    return mod;
  });
  return AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.VIBRATE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ]);
}

module.exports = withJPush;
