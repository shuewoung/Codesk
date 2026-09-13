const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  {
    ignores: [
      'android/**',
      'dist/**',
      'dist-web/**',
      'dist-web.bak-*/**',
      'node_modules/**',
      'src/jpush-stub.js',
    ],
  },
  ...expoConfig,
  {
    rules: {
      // 核心是 hooks 规则与明显错误；风格类问题降级为 warn，避免一次性大改。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
