export function terminalPageHtml(bg: string, fg: string) {
  const safeBg = String(bg || '#0b1220').replace(/[^#a-zA-Z0-9(),.% ]/g, '');
  const safeFg = String(fg || '#e2e8f0').replace(/[^#a-zA-Z0-9(),.% ]/g, '');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
  html, body, #term { height: 100%; width: 100%; margin: 0; background: ${safeBg}; overflow: hidden; }
  .xterm, .xterm-viewport { background: ${safeBg} !important; }
</style>
</head>
<body>
<div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
(function () {
  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: ${JSON.stringify(safeBg)}, foreground: ${JSON.stringify(safeFg)}, cursor: ${JSON.stringify(safeFg)} }
  });
  var FitAddonCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
  var fit = FitAddonCtor ? new FitAddonCtor() : null;
  if (fit) term.loadAddon(fit);
  term.open(document.getElementById('term'));
  function reportSize() {
    try { if (fit) fit.fit(); } catch (e) {}
    post({ type: 'resize', cols: term.cols, rows: term.rows });
  }
  term.onData(function (data) { post({ type: 'input', data: data }); });
  if (window.ResizeObserver) {
    new ResizeObserver(reportSize).observe(document.getElementById('term'));
  }
  setTimeout(function () {
    reportSize();
    post({ type: 'ready', cols: term.cols, rows: term.rows });
  }, 40);
  function onMsg(raw) {
    var text = typeof raw === 'string' ? raw : (raw && raw.data);
    if (typeof text !== 'string') return;
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.type === 'data' && msg.data) term.write(msg.data);
    if (msg.type === 'clear') term.reset();
  }
  document.addEventListener('message', function (e) { onMsg(e.data); });
  window.addEventListener('message', function (e) { onMsg(e.data); });
})();
</script>
</body>
</html>`;
}
