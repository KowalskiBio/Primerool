/** Ported verbatim from Oligool: clones the clicked structure SVG into a
 * blob-URL HTML page and opens it in a new tab, sized to fill the viewport. */
export function openSvgInNewTab(svg: SVGSVGElement, title: string): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', '100%');
  clone.setAttribute('style', 'max-height: 100vh');
  const markup = new XMLSerializer().serializeToString(clone);
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
html, body { margin: 0; height: 100%; }
body { display: flex; align-items: center; justify-content: center; background: #fafafa; }
@media (prefers-color-scheme: dark) { body { background: #18181b; } }
</style>
</head>
<body>${markup}</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
