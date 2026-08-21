const FILES = {
  '/CodeskHub-windows.zip': 'CodeskHub-windows.zip',
  '/codesk-latest.apk': 'codesk-latest.apk',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = FILES[url.pathname];
    if (key) {
      return Response.redirect('https://github.com/shuewoung/codesk/releases/latest/download/' + key, 302);
    }
    return env.ASSETS.fetch(request);
  },
};
