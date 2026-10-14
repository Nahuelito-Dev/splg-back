#!/usr/bin/env node
// Reemplaza los saved responses de cada request por la respuesta real que dio en una
// corrida de newman (reporte JSON).
//   newman run ... -r json --reporter-json-export .orq/newman-reporte.json
//   node scripts/postman/guardar-ejemplos.js --report=.orq/newman-reporte.json
// Los ejemplos documentales (500, 503 y 504, que el back no produce a pedido) se conservan.
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.cwd();
const MAX_ELEMENTOS = 3;
const CLAVES_SECRETAS = /^(accessToken|refreshToken|idToken|authorization|password|token|deliveryCode)$/i;

function arg(nombre, defecto) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : defecto;
}

function limpiarTexto(texto) {
  return texto
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <oculto>')
    .replace(/([?&])X-Amz-[^"'\s]*/g, '$1<firma-oculta>');
}

// Oculta secretos y recorta las listas largas a unos pocos elementos.
function seguro(valor, profundidad = 0) {
  if (valor == null) return valor;
  if (Array.isArray(valor)) return valor.slice(0, MAX_ELEMENTOS).map((v) => seguro(v, profundidad + 1));
  if (typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, CLAVES_SECRETAS.test(k) && typeof v === 'string' ? '<oculto>' : seguro(v, profundidad + 1)]),
    );
  }
  if (typeof valor === 'string') return limpiarTexto(valor);
  return valor;
}

function cuerpoDe(response) {
  const stream = response?.stream;
  if (stream == null) return '';
  const texto = Buffer.from(stream.data || stream).toString('utf8');
  if (!texto) return '';
  try {
    return JSON.stringify(seguro(JSON.parse(texto)), null, 2);
  } catch {
    return /^[\x20-\x7e\s]*$/.test(texto.slice(0, 200)) ? limpiarTexto(texto).slice(0, 2000) : '<contenido binario>';
  }
}

function headersBasicos(headers) {
  const lista = Array.isArray(headers) ? headers : Object.entries(headers || {}).map(([key, value]) => ({ key, value }));
  return lista
    .filter((h) => /^(content-type|location)$/i.test(h.key || h.name || ''))
    .map((h) => ({ key: h.key || h.name, value: String(h.value) }));
}

function walk(items, cb) {
  for (const item of items || []) {
    if (item.item) walk(item.item, cb);
    else cb(item);
  }
}

function main() {
  const collectionPath = path.resolve(BASE, arg('collection', 'postman/SPLG.postman_collection.json'));
  const reportPath = path.resolve(BASE, arg('report', '.orq/newman-reporte.json'));
  const outPath = path.resolve(BASE, arg('out', collectionPath));
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const porId = new Map();
  for (const execution of report.run?.executions || []) {
    if (execution.item?.id && execution.response?.code) porId.set(execution.item.id, execution.response);
  }

  let reemplazados = 0;
  let sinCorrida = 0;
  walk(collection.item, (item) => {
    const response = porId.get(item.id);
    if (!response) {
      sinCorrida += 1;
      return;
    }
    const documentales = (item.response || []).filter((r) => [500, 503, 504].includes(r.code));
    const real = {
      name: `Respuesta real ${response.code} ${response.status || ''}`.trim(),
      originalRequest: item.request,
      status: response.status,
      code: response.code,
      _postman_previewlanguage: 'json',
      header: headersBasicos(response.header || response.headers),
      body: cuerpoDe(response),
    };
    const yaDocumentada = documentales.some((r) => r.code === response.code);
    item.response = yaDocumentada ? documentales : [real, ...documentales];
    reemplazados += 1;
  });

  fs.writeFileSync(outPath, JSON.stringify(collection, null, 2) + '\n');
  console.log(JSON.stringify({ reemplazados, sinCorrida }, null, 2));
}

main();
