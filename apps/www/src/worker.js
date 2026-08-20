const FILES = {
  '/CodeskHub-windows.zip': { key: 'CodeskHub-windows.zip', type: 'application/zip' },
  '/codesk-latest.apk': { key: 'codesk-latest.apk', type: 'application/vnd.android.package-archive' },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const file = FILES[url.pathname];
    if (file) {
      const obj = await env.DOWNLOADS.get(file.key);
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      headers.set('Content-Type', file.type);
      headers.set('Content-Disposition', 'attachment; filename="' + file.key + '"');
      headers.set('Cache-Control', 'public, max-age=300');
      if (obj.size != null) headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { headers });
    }
    return env.ASSETS.fetch(request);
  },
};
