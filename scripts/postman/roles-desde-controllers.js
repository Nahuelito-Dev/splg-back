// Lee los controllers de src/ y devuelve, por operación ("GET /api/users/{id}"),
// quién puede llamarla: pública, pública identificable, roles permitidos o
// cualquier usuario autenticado (roles = null).
const fs = require('node:fs');
const path = require('node:path');

const VERBOS = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE' };

function sinComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function cierre(texto, i, abre, cierra) {
  let profundidad = 0;
  for (let k = i; k < texto.length; k += 1) {
    const c = texto[k];
    if (c === '\'' || c === '"' || c === '`') {
      const comilla = c;
      k += 1;
      while (k < texto.length && texto[k] !== comilla) k += texto[k] === '\\' ? 2 : 1;
      continue;
    }
    if (c === abre) profundidad += 1;
    if (c === cierra) {
      profundidad -= 1;
      if (profundidad === 0) return k;
    }
  }
  throw new Error('Paréntesis sin cerrar');
}

function leerDecorador(texto, i) {
  const m = /^@(\w+)/.exec(texto.slice(i));
  const nombre = m[1];
  let k = i + m[0].length;
  let args = '';
  if (texto[k] === '(') {
    const fin = cierre(texto, k, '(', ')');
    args = texto.slice(k + 1, fin);
    k = fin + 1;
  }
  return { nombre, args, fin: k };
}

function roles(args) {
  return [...args.matchAll(/RoleType\.(\w+)/g)].map((m) => m[1].toLowerCase());
}

function primerString(args) {
  const m = /['"`]([^'"`]*)['"`]/.exec(args);
  return m ? m[1] : '';
}

function unir(...partes) {
  const limpio = partes.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return `/api/${limpio}`.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}');
}

function analizarArchivo(texto) {
  const limpio = sinComentarios(texto);
  const idxClase = limpio.search(/export\s+class\s+\w+/);
  if (idxClase < 0) return [];
  const antes = limpio.slice(0, idxClase);
  const decClase = [];
  for (const m of antes.matchAll(/@(\w+)/g)) {
    const d = leerDecorador(antes, m.index);
    if (m.index >= d.fin) continue;
    decClase.push(d);
  }
  const controller = decClase.find((d) => d.nombre === 'Controller');
  if (!controller) return [];
  const prefijo = primerString(controller.args);
  const claseAuth = decClase.find((d) => d.nombre === 'Auth');
  const clasePublica = decClase.some((d) => d.nombre === 'Public');
  const inicio = limpio.indexOf('{', idxClase);
  const fin = cierre(limpio, inicio, '{', '}');
  const cuerpo = limpio.slice(inicio + 1, fin);
  const out = [];
  let pendientes = [];
  let i = 0;
  while (i < cuerpo.length) {
    if (/\s/.test(cuerpo[i])) { i += 1; continue; }
    if (cuerpo[i] === '@') {
      const d = leerDecorador(cuerpo, i);
      pendientes.push(d);
      i = d.fin;
      continue;
    }
    const m = /^[\w$]+/.exec(cuerpo.slice(i));
    if (!m) { i += 1; continue; }
    let k = i + m[0].length;
    while (/\s/.test(cuerpo[k])) k += 1;
    if (/^(async|public|private|protected|readonly|static)$/.test(m[0]) && cuerpo[k] !== '(') {
      i = k;
      continue;
    }
    if (cuerpo[k] === '(') {
      const finParams = cierre(cuerpo, k, '(', ')');
      let b = finParams + 1;
      let angulos = 0;
      while (b < cuerpo.length && !(cuerpo[b] === '{' && angulos <= 0)) {
        if (cuerpo[b] === '<') angulos += 1;
        if (cuerpo[b] === '>' && cuerpo[b - 1] !== '=') angulos -= 1;
        b += 1;
      }
      const finCuerpo = cierre(cuerpo, b, '{', '}');
      const verbo = pendientes.find((d) => VERBOS[d.nombre]);
      if (verbo) {
        const sub = primerString(verbo.args);
        const metodoAuth = pendientes.find((d) => d.nombre === 'Auth');
        const publico = pendientes.some((d) => d.nombre === 'Public') || (clasePublica && !metodoAuth);
        const identificable = pendientes.some((d) => d.nombre === 'PublicIdentificable');
        const auth = metodoAuth || claseAuth;
        out.push({
          clave: `${VERBOS[verbo.nombre]} ${unir(prefijo, sub)}`,
          publico: publico || identificable,
          identificable,
          roles: publico || identificable || !auth ? null : roles(auth.args),
        });
      }
      pendientes = [];
      i = finCuerpo + 1;
    } else {
      let p = k;
      while (p < cuerpo.length && cuerpo[p] !== ';') {
        if (cuerpo[p] === '(') p = cierre(cuerpo, p, '(', ')');
        else if (cuerpo[p] === '{') p = cierre(cuerpo, p, '{', '}');
        p += 1;
      }
      pendientes = [];
      i = p + 1;
    }
  }
  return out;
}

function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return archivos(p);
    return e.name.endsWith('.controller.ts') ? [p] : [];
  });
}

function leerRoles(srcDir) {
  const mapa = new Map();
  for (const archivo of archivos(srcDir)) {
    for (const op of analizarArchivo(fs.readFileSync(archivo, 'utf8'))) mapa.set(op.clave, op);
  }
  return mapa;
}

module.exports = { leerRoles, analizarArchivo };

if (require.main === module) {
  const mapa = leerRoles(path.resolve(process.argv[2] || 'src'));
  for (const op of mapa.values()) {
    console.log(op.clave, op.publico ? (op.identificable ? 'PUBLICA-IDENT' : 'PUBLICA') : op.roles ? op.roles.join(',') : 'AUTENTICADO');
  }
}
