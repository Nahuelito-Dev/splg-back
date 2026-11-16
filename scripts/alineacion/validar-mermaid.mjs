// Valida la sintaxis de diagramas Mermaid con el parser de la misma versión que el sitio.
import { JSDOM } from 'jsdom';
import fs from 'fs';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });
let fallas = 0;
for (const f of process.argv.slice(2)) {
  try {
    await mermaid.parse(fs.readFileSync(f, 'utf8'));
    console.log('ok   ', f.split('/').pop());
  } catch (e) {
    fallas++;
    console.log(
      'FALLA',
      f.split('/').pop(),
      '→',
      String(e.message || e)
        .split('\n')
        .slice(0, 3)
        .join(' | '),
    );
  }
}
process.exit(fallas ? 1 : 0);
