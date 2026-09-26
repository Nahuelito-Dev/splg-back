// Conecta cliente, chofer y admin a sus namespaces, corre el recorrido del
// pedido con newman y cuenta los eventos que le llegan a cada uno.
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
const require = createRequire('/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-admin/package.json');
const { io } = require('socket.io-client');
const [,, base, envPath] = process.argv;
const env = Object.fromEntries(JSON.parse(fs.readFileSync(envPath)).values.map(v => [v.key, v.value]));
const login = async (ruta, origen, email) => {
  const r = await fetch(`${base}/api/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Source': origen, 'X-Distributor': 'jeny-gas' }, body: JSON.stringify({ email, password: 'Test1234' }) });
  return (await r.json()).accessToken;
};
const actores = [
  ['customers', 'customer:join', await login('auth/login', 'customer-app', env.clienteEmail)],
  ['drivers', 'driver:join', await login('auth/login', 'driver-app', env.choferEmail)],
  ['admin', null, await login('auth/login/dashboard', 'panel-app', env.superAdminEmail)],
];
const recibidos = {};
const sockets = await Promise.all(actores.map(([ns, join, token]) => new Promise((ok) => {
  const s = io(`${base}/${ns}`, { auth: { token }, transports: ['websocket'] });
  recibidos[ns] = {};
  s.onAny((ev) => { recibidos[ns][ev] = (recibidos[ns][ev] || 0) + 1; if (ev === 'server:ack') ok(s); });
  s.on('connect', () => { if (join) s.emit(join, {}); });
  s.on('disconnect', (r) => { recibidos[ns]['(desconectado: ' + r + ')'] = 1; });
  setTimeout(() => ok(s), 5000);
})));
execSync(`npx --no-install newman run postman/SPLG.postman_collection.json -e ${envPath} --folder "00 · Acceso" --folder "02 · Recorrido del pedido" --reporters json --reporter-json-export ${process.env.S}/rt-newman.json`, { cwd: '/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend', stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
const st = JSON.parse(fs.readFileSync(`${process.env.S}/rt-newman.json`)).run.stats.assertions;
console.log('recorrido: aserciones', st.total, 'fallas', st.failed);
console.log(JSON.stringify(recibidos, null, 1));
sockets.forEach(s => s.close());
process.exit(0);
