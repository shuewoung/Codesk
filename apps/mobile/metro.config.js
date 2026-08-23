const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const { createHubProxyMiddleware, installHubProxy } = require('./scripts/hub-proxy');
installHubProxy();

const config = getDefaultConfig(__dirname);
const stub = path.resolve(__dirname, 'src/jpush-stub.js');
const defaultResolve = config.resolver.resolveRequest;
const prevEnhance = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const inner = prevEnhance ? prevEnhance(middleware, server) : middleware;
  return createHubProxyMiddleware(inner);
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName === 'jpush-react-native' || moduleName === 'jcore-react-native') && platform === 'web') {
    return { type: 'sourceFile', filePath: stub };
  }
  if (defaultResolve) return defaultResolve(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
