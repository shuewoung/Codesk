const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const stub = path.resolve(__dirname, 'src/jpush-stub.js');
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName === 'jpush-react-native' || moduleName === 'jcore-react-native') && platform === 'web') {
    return { type: 'sourceFile', filePath: stub };
  }
  if (defaultResolve) return defaultResolve(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
