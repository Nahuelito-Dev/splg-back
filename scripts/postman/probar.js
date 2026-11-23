#!/usr/bin/env node
// Corre la colección con newman sin la carpeta Manual (cuentas, mails, archivos).
//   npm run postman:probar -- --base-url=http://localhost:3010/api --reporte=.orq/newman-final.json
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.cwd();
const NEWMAN = 'newman@6.2.1';

function arg(nombre, defecto) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : defecto;
}

const coleccion = path.resolve(
  BASE,
  arg('coleccion', 'postman/SPLG.postman_collection.json'),
);
const entorno = path.resolve(
  BASE,
  arg('entorno', 'postman/SPLG-local.postman_environment.json'),
);
const reporte = path.resolve(BASE, arg('reporte', '.orq/newman-reporte.json'));
const baseUrl = arg('base-url', null);

const carpetas = JSON.parse(fs.readFileSync(coleccion, 'utf8'))
  .item.map((i) => i.name)
  .filter((n) => n !== 'Manual');
const args = [
  '-y',
  NEWMAN,
  'run',
  coleccion,
  '-e',
  entorno,
  '-r',
  'cli,json',
  '--reporter-json-export',
  reporte,
  '--timeout-request',
  '20000',
];
if (baseUrl) args.push('--env-var', `baseUrl=${baseUrl}`);
for (const nombre of carpetas) args.push('--folder', nombre);

const res = spawnSync('npx', args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
