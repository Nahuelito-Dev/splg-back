#!/usr/bin/env node
// Genera la colección de Postman de SPLG desde el OpenAPI del back.
//   node scripts/postman/generar-coleccion.js --input=http://localhost:3010/docs-yaml
//   (con SWAGGER_USER y SWAGGER_PASSWORD en el entorno) o --input=<archivo .yaml>
// Los roles de cada operación salen de los controllers (roles-desde-controllers.js);
// los cuerpos y flujos de prueba, de casos.js.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { leerRoles } = require('./roles-desde-controllers');
const { OPS, DATOS_DE_PRUEBA, RESTAURACION } = require('./casos');

const METODOS = ['get', 'post', 'put', 'patch', 'delete'];
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';
const BASE = process.cwd();
const TODOS_LOS_ROLES = ['customer', 'delivery', 'admin', 'super_admin'];
const ORDEN_PRINCIPAL = ['admin', 'super_admin', 'customer', 'delivery'];
const ORDEN_PROHIBIDO = ['customer', 'delivery', 'admin', 'super_admin'];

const ROLES = {
  admin: { token: 'tokenAdmin', source: 'panel-app' },
  super_admin: { token: 'tokenSuperAdmin', source: 'panel-app' },
  customer: { token: 'tokenCliente', source: 'customer-app' },
  delivery: { token: 'tokenChofer', source: 'driver-app' },
};

let ACCESO = new Map();
// Lo que toca cuentas (Firebase), distribuidoras, archivos, mails o necesita un usuario
// nuevo queda fuera de la corrida automática: carpeta Manual.
const MANUAL_PATTERNS = [
  /^POST \/api\/distributor$/,
  /^(PATCH|DELETE) \/api\/distributor\/\{id\}$/,
  /^POST \/api\/stock\/reconciliation\/reapply-deliveries$/,
  /^POST \/api\/notifications\/(token|order-confirmation)$/,
  /^POST \/api\/auth\/registro$/,
  /^POST \/api\/users\/customer-registration$/,
  /^POST \/api\/users$/,
  /^PATCH \/api\/users\/\{id\}$/,
  /^PATCH \/api\/users\/\{id\}\/block$/,
  /^DELETE \/api\/users\/me$/,
  /^DELETE \/api\/users\/\{id\}$/,
  /^POST \/api\/admin$/,
  /^DELETE \/api\/admin\/\{id\}$/,
  /^DELETE \/api\/customers\/\{id\}$/,
  /^DELETE \/api\/delivery\/\{id\}$/,
  /^POST \/api\/employees\/\{id\}\/account$/,
  /^POST \/api\/employees\/\{id\}\/termination$/,
  /^POST \/api\/employees\/\{id\}\/reinstatement$/,
  /^POST \/api\/email\/password-reset$/,
  /^POST \/api\/email\/change-email$/,
  /^POST \/api\/email\/test$/,
  /^POST \/api\/attachments\//,
  /^GET \/api\/attachments\/.*\/download$/,
  /^DELETE \/api\/attachments\//,
  /^POST \/api\/fleet\/tasks\/\{id\}\/attachments$/,
  /^GET \/api\/fleet\/tasks\/\{id\}\/attachments\/\{attachmentId\}\/download$/,
  /^DELETE \/api\/fleet\/tasks\/\{id\}\/attachments\/\{attachmentId\}$/,
  /^(PUT|POST|DELETE|GET) .*\/photo$/,
  /^(PUT|DELETE|GET) .*\/logo$/,
];

const PREPARACION = [
  { name: 'Cliente de prueba', modo: 'objeto', path: 'users/email/{{clienteEmail}}', roles: 'admin', captures: { clienteUserId: ['user_id'], userId: ['user_id'], customerId: ['customer.customer_id'], phoneNumber: ['phone_number'] } },
  { name: 'Chofer de prueba', modo: 'objeto', path: 'users/email/{{choferEmail}}', roles: 'admin', captures: { choferUserId: ['user_id'], deliveryUserId: ['user_id'], deliveryId: ['delivery.delivery_id'] } },
  { name: 'Chofer libre (sin pedidos en curso)', modo: 'objeto', path: 'users/email/{{choferLibreEmail}}', roles: 'admin', captures: { deliveryLibreUserId: ['user_id'], deliveryLibreId: ['delivery.delivery_id'] } },
  { name: 'Administrador de prueba', modo: 'objeto', path: 'users/email/{{adminEmail}}', roles: 'admin', captures: { adminUserId: ['user_id'], adminFullName: ['full_name'] } },
  { name: 'Ubicación del chofer libre', modo: 'objeto', path: 'delivery/{{deliveryLibreId}}', roles: 'admin', captures: { libreLatLng: ['latLng'] } },
  { name: 'Vehículo del chofer', modo: 'objeto', path: 'delivery/{{deliveryId}}/vehicle', roles: 'admin', captures: { choferCarId: ['carId'] } },
  { name: 'Vehículo del chofer libre', modo: 'objeto', path: 'delivery/{{deliveryLibreId}}/vehicle', roles: 'admin', captures: { libreCarId: ['carId'] } },
  { name: 'Distribuidora base', path: 'distributor', roles: 'super_admin', captures: { distribuidoraBaseId: ['distributor_id'] } },
  { name: 'Administradores', path: 'admin', roles: 'admin', captures: { adminId: ['admin_id'] } },
  { name: 'Otro cliente (para probar acceso ajeno)', path: 'customers', roles: 'admin', excluir: { campo: 'user_id', variable: 'clienteUserId' }, captures: { otroCustomerId: ['customer_id'], otroClienteUserId: ['user_id'] } },
  { name: 'Dirección de otro cliente', path: 'user-address/user/{{otroClienteUserId}}', roles: 'admin', captures: { otraDireccionId: ['address_id'] } },
  { name: 'Pedido entregado de otro cliente', path: 'orders/customer/{{otroClienteUserId}}', roles: 'admin', donde: { campo: 'status', valor: 'delivered' }, captures: { pedidoAjenoId: ['order_id'] } },
  { name: 'Direcciones del cliente', path: 'user-address/user/{{clienteUserId}}', roles: 'customer', captures: { addressId: ['address_id'] } },
  { name: 'Catálogo de garrafas', path: 'gascylinder', roles: null, captures: { gasCylinderId: ['gas_cylinder_id'], type: ['type'], gasPrice: ['price'] } },
  { name: 'Envases', path: 'cylinders', roles: 'admin', captures: { cylinderId: ['cylinder_id'] } },
  { name: 'Vehículos', path: 'car', roles: 'admin', captures: { carId: ['car_id'], patent: ['car_patent'] } },
  { name: 'Zonas de cobertura', path: 'coverage-zones', roles: 'admin', captures: { coverageZoneId: ['coverage_zone_id'] } },
  { name: 'Franjas horarias', path: 'time-slot', roles: 'admin', captures: { timeSlotId: ['time_slot_id'] } },
  { name: 'Pedidos', path: 'orders', roles: 'admin', captures: { orderId: ['order_id'] } },
  { name: 'Reclamos', path: 'claims', roles: 'admin', captures: { claimId: ['claim_id'] } },
  { name: 'Incidencias', path: 'incidents', roles: 'admin', captures: { incidentId: ['incident_id'] } },
  { name: 'Roles', path: 'role', roles: 'super_admin', captures: { roleId: ['role_id'] } },
  { name: 'Proveedores', path: 'suppliers', roles: 'admin', captures: { supplierId: ['supplierId'] } },
  { name: 'Órdenes de compra', path: 'purchase-orders', roles: 'admin', captures: { purchaseOrderId: ['purchaseOrderId'] } },
  { name: 'Recepciones', path: 'purchase-receipts', roles: 'admin', captures: { receiptId: ['receiptId'] } },
  { name: 'Depósitos', path: 'warehouses', roles: 'admin', captures: { warehouseId: ['warehouseId'] } },
  { name: 'Cargas de camión', path: 'truck-loads', roles: 'admin', captures: { truckLoadId: ['loadId'] } },
  { name: 'Empleados', path: 'employees', roles: 'admin', captures: { employeeId: ['employeeId'] } },
  { name: 'Puestos', path: 'job-positions', roles: 'admin', captures: { positionAdminId: ['positionId'] } },
  { name: 'Planes de flota', path: 'fleet/plans', roles: 'admin', captures: { fleetPlanId: ['planId'] } },
  { name: 'Tareas de flota', path: 'fleet/tasks', roles: 'admin', captures: { fleetTaskId: ['taskId'] } },
  { name: 'Auditoría de datos', path: 'audit/entries', roles: 'admin', captures: { auditEntryId: ['auditId'] } },
];

// Variable de colección para cada parámetro de ruta cuando no hay una más específica.
const VARS = {
  userId: 'userId',
  customerId: 'customerId',
  deliveryId: 'deliveryId',
  carId: 'carId',
  orderId: 'orderId',
  batchId: 'batchId',
  attachmentId: 'attachmentId',
  ownerId: 'orderId',
  ownerType: 'ownerType',
  email: 'email',
  phoneNumber: 'phoneNumber',
  patent: 'patent',
  term: 'term',
  type: 'type',
};

const ID_POR_RECURSO = [
  [/^\/api\/users\//, 'userId'],
  [/^\/api\/admin\//, 'adminId'],
  [/^\/api\/role\//, 'roleId'],
  [/^\/api\/employees\//, 'employeeId'],
  [/^\/api\/customers\//, 'customerId'],
  [/^\/api\/delivery\//, 'deliveryId'],
  [/^\/api\/distributor\//, 'distribuidoraBaseId'],
  [/^\/api\/job-positions\//, 'positionAdminId'],
  [/^\/api\/car\//, 'carId'],
  [/^\/api\/orders\//, 'orderId'],
  [/^\/api\/gascylinder\//, 'gasCylinderId'],
  [/^\/api\/user-address\//, 'addressId'],
  [/^\/api\/time-slot\//, 'timeSlotId'],
  [/^\/api\/cylinders\//, 'cylinderId'],
  [/^\/api\/coverage-zones\//, 'coverageZoneId'],
  [/^\/api\/fleet\/plans\//, 'fleetPlanId'],
  [/^\/api\/fleet\/tasks\//, 'fleetTaskId'],
  [/^\/api\/warehouses\//, 'warehouseId'],
  [/^\/api\/truck-loads\//, 'truckLoadId'],
  [/^\/api\/claims\//, 'claimId'],
  [/^\/api\/incidents\//, 'incidentId'],
  [/^\/api\/audit\/entries\//, 'auditEntryId'],
  [/^\/api\/suppliers\//, 'supplierId'],
  [/^\/api\/purchase-orders\//, 'purchaseOrderId'],
  [/^\/api\/purchase-receipts\//, 'receiptId'],
];

function arg(nombre, defecto) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((a) => a.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : defecto;
}

async function leerSpec(origen) {
  if (/^https?:\/\//.test(origen)) {
    // La documentación va detrás de Basic Auth: SWAGGER_USER y SWAGGER_PASSWORD del entorno.
    const headers = {};
    if (process.env.SWAGGER_USER) {
      headers.Authorization = `Basic ${Buffer.from(`${process.env.SWAGGER_USER}:${process.env.SWAGGER_PASSWORD || ''}`).toString('base64')}`;
    }
    const res = await fetch(origen, { headers });
    if (!res.ok) throw new Error(`No pude bajar OpenAPI: ${res.status} ${res.statusText}`);
    return yaml.parse(await res.text());
  }
  return yaml.parse(fs.readFileSync(path.resolve(BASE, origen), 'utf8'));
}

// ---------------------------------------------------------------- OpenAPI

function refNombre(ref) {
  return ref.split('/').pop();
}

function resolver(spec, schema) {
  if (!schema) return {};
  if (schema.$ref) return resolver(spec, spec.components?.schemas?.[refNombre(schema.$ref)]);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => resolver(spec, s)));
  if (schema.oneOf) return resolver(spec, schema.oneOf[0]);
  if (schema.anyOf) return resolver(spec, schema.anyOf[0]);
  return schema;
}

// Cuerpo de ejemplo para el saved response de éxito (se reemplaza por el real con guardar-ejemplos.js).
function ejemplo(spec, schema, nombre = '', profundidad = 0) {
  schema = resolver(spec, schema);
  if (!schema || profundidad > 6) return {};
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const tipo = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.format === 'uuid') return UUID_INEXISTENTE;
  if (schema.format === 'date-time') return '2026-10-15T14:00:00.000Z';
  if (schema.format === 'date') return '2026-10-15';
  if (tipo === 'array') return [ejemplo(spec, schema.items || {}, nombre, profundidad + 1)];
  if (tipo === 'object' || schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out[k] = ejemplo(spec, v, k, profundidad + 1);
    return out;
  }
  if (tipo === 'integer' || tipo === 'number') return schema.minimum ?? 1;
  if (tipo === 'boolean') return true;
  return `valor-${nombre || 'campo'}`;
}

function valorInvalido(schema, nombre) {
  const tipo = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.enum) return '__valor_fuera_de_enum__';
  if (schema.format === 'uuid') return 'no-es-uuid';
  if (schema.format === 'email') return 'no-es-email';
  if (schema.format === 'date' || schema.format === 'date-time') return 'no-es-fecha';
  if (tipo === 'number' || tipo === 'integer') return 'no-es-numero';
  if (tipo === 'boolean') return 'no-es-booleano';
  return nombre.toLowerCase().endsWith('id') ? 'no-es-uuid' : 'no-es-valido';
}

function esIdLike(nombre) {
  return nombre.toLowerCase().endsWith('id');
}

// ---------------------------------------------------------------- variables y rutas

function variablePara(nombre) {
  if (VARS[nombre]) return VARS[nombre];
  return nombre.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());
}

function varDelRecurso(ruta, nombre) {
  if (nombre !== 'id') return variablePara(nombre);
  const hit = ID_POR_RECURSO.find(([patron]) => patron.test(ruta));
  if (!hit) throw new Error(`No sé qué variable usar para {id} en ${ruta}`);
  return hit[1];
}

// modo: ok | inexistente | invalido
function segmentos(ruta, cfg, modo) {
  return ruta
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^\{(.+)\}$/);
      if (!m) return s;
      const nombre = m[1];
      if (modo === 'invalido') {
        if (cfg.paramsMalos?.[nombre] !== undefined) return cfg.paramsMalos[nombre];
        return esIdLike(nombre) ? 'no-es-uuid' : 'no-es-valido';
      }
      if (modo === 'inexistente') {
        if (cfg.inexistente?.[nombre] !== undefined) return cfg.inexistente[nombre];
        if (esIdLike(nombre)) return '{{idInexistente}}';
      }
      if (nombre === 'id' && cfg.id) return `{{${cfg.id}}}`;
      if (cfg.params?.[nombre] !== undefined) return cfg.params[nombre];
      return `{{${varDelRecurso(ruta, nombre)}}}`;
    });
}

function valorQuery(param) {
  const bajo = param.name.toLowerCase();
  const schema = param.schema || {};
  if (schema.enum?.length) return String(schema.enum[0]);
  if (schema.format === 'date-time') return '2026-10-15T14:00:00.000Z';
  if (schema.format === 'date' || bajo.includes('date') || bajo.includes('fecha')) return '2026-12-15';
  if (bajo === 'lat') return '-27.3671';
  if (bajo === 'lng') return '-55.8961';
  if (bajo.includes('limit')) return '10';
  if (bajo.includes('page')) return '1';
  if (bajo === 'distributor') return '{{distributorSlug}}';
  if (schema.format === 'uuid' || bajo.endsWith('id')) return `{{${variablePara(param.name)}}}`;
  return '1';
}

// ---------------------------------------------------------------- acceso

function claveOperacion(metodo, ruta) {
  return `${metodo.toUpperCase()} ${ruta}`;
}

function acceso(clave) {
  const a = ACCESO.get(clave);
  if (!a) throw new Error(`Sin datos de acceso para ${clave}: no está en los controllers`);
  return a;
}

function esPublico(clave) {
  return acceso(clave).publico;
}

function esManual(clave) {
  return MANUAL_PATTERNS.some((patron) => patron.test(clave));
}

function rolesPermitidos(clave) {
  const a = acceso(clave);
  if (a.publico) return [];
  return a.roles || TODOS_LOS_ROLES;
}

function rolPrincipal(clave, cfg) {
  if (cfg.rol) return ROLES[cfg.rol];
  const permitidos = rolesPermitidos(clave);
  const rol = ORDEN_PRINCIPAL.find((r) => permitidos.includes(r)) || 'super_admin';
  return ROLES[rol];
}

function rolNoPermitido(clave) {
  const permitidos = new Set(rolesPermitidos(clave));
  const rol = ORDEN_PROHIBIDO.find((r) => !permitidos.has(r));
  return rol ? ROLES[rol] : null;
}

// ---------------------------------------------------------------- requests

function crudo(texto) {
  return texto.replace(/"@@([^"]*)"/g, '$1');
}

function requestBase(metodo, ruta, op, cfg, opts = {}) {
  const clave = claveOperacion(metodo, ruta);
  const segs = segmentos(ruta, cfg, opts.modo || 'ok');
  const headers = [{ key: 'X-Client-Source', value: opts.source || '{{clientSource}}' }];
  if (!opts.sinDistribuidor) headers.push({ key: 'X-Distributor', value: '{{distributorSlug}}' });
  if (metodo !== 'get' && !opts.sinClave) headers.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
  const req = {
    method: metodo.toUpperCase(),
    header: headers,
    url: { raw: '', host: ['{{baseUrl}}'], path: segs },
    description: opts.descripcion,
  };
  const query = [];
  const pedidos = opts.modo === 'invalido' ? cfg.maloQuery || {} : cfg.query || {};
  for (const p of op.parameters || []) {
    if (p.in !== 'query') continue;
    if (pedidos[p.name] !== undefined) query.push({ key: p.name, value: String(pedidos[p.name]) });
    else if (p.required) query.push({ key: p.name, value: opts.modo === 'invalido' && !cfg.maloQuery ? valorInvalido(p.schema || {}, p.name) : valorQuery(p) });
    else query.push({ key: p.name, value: valorQuery(p), disabled: true });
  }
  if (query.length) req.url.query = query;
  const qs = query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
  req.url.raw = `{{baseUrl}}/${segs.join('/')}${qs ? `?${qs}` : ''}`;
  if (opts.noauth || esPublico(clave)) req.auth = { type: 'noauth' };
  else req.auth = { type: 'bearer', bearer: [{ key: 'token', value: opts.tokenLiteral || `{{${opts.token}}}`, type: 'string' }] };
  if (opts.body !== undefined) {
    req.header.unshift({ key: 'Content-Type', value: 'application/json' });
    req.body = { mode: 'raw', raw: crudo(JSON.stringify(opts.body, null, 2)), options: { raw: { language: 'json' } } };
  }
  return req;
}

function requestPaso(p) {
  const rol = ROLES[p.rol];
  const segs = p.ruta.split('/');
  const headers = [
    { key: 'X-Client-Source', value: rol.source },
    { key: 'X-Distributor', value: '{{distributorSlug}}' },
  ];
  if (p.m !== 'GET') headers.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
  const req = {
    method: p.m,
    header: headers,
    auth: { type: 'bearer', bearer: [{ key: 'token', value: `{{${rol.token}}}`, type: 'string' }] },
    url: { raw: `{{baseUrl}}/${p.ruta}`, host: ['{{baseUrl}}'], path: segs },
    description: 'Paso de preparación o limpieza: crea o deja en el estado que hace falta el recurso propio de esta prueba.',
  };
  if (p.body !== undefined) {
    req.header.unshift({ key: 'Content-Type', value: 'application/json' });
    req.body = { mode: 'raw', raw: crudo(JSON.stringify(p.body, null, 2)), options: { raw: { language: 'json' } } };
  }
  return req;
}

function itemPaso(p) {
  const req = requestPaso(p);
  const tests = [
    p.tolerante
      ? `pm.test("${p.nombre}: responde 2xx o 4xx (si ya no hay nada que limpiar)", () => pm.expect(pm.response.code).to.be.below(500));`
      : `pm.test("${p.nombre}: responde 2xx", () => pm.expect(pm.response.code).to.be.within(200, 299));`,
    ...scriptCaptura(p.cap),
  ];
  return item(p.nombre, req, tests, [savedResponse('Ejemplo', p.m === 'POST' ? 201 : 200, {}, req)], p.pre);
}

// ---------------------------------------------------------------- limpieza automática

const TOLERANTE = { tolerante: true };
const paso = (nombre, rol, m, ruta, body, cap, extra = {}) => ({ nombre, rol, m, ruta, body, cap, ...extra });
const MOTIVO_LIMPIEZA = 'Limpieza de la prueba';

// Lo que se crea con un POST se da de baja al final de la carpeta, en orden inverso al de alta.
// clave: ruta del POST. claves: campos de la respuesta que traen el id. Lo que depende del
// estado del recurso (cancelar un pedido ya entregado, por ejemplo) es tolerante: un 4xx no
// rompe la corrida; lo que quede sin limpiar se detecta comparando la base antes y después.
const LIMPIEZA = {
  role: { claves: ['role_id'], pasos: (v) => [paso('Limpiar · borrar el rol', 'super_admin', 'DELETE', `role/{{${v}}}`)] },
  gascylinder: {
    claves: ['gas_cylinder_id'],
    pasos: (v) => [{ vaciarProducto: v }, paso('Limpiar · dar de baja la garrafa', 'admin', 'DELETE', `gascylinder/{{${v}}}`)],
  },
  car: { claves: ['car_id'], pasos: (v) => [paso('Limpiar · dar de baja el vehículo', 'admin', 'DELETE', `car/{{${v}}}`)] },
  'job-positions': { claves: ['positionId'], pasos: (v) => [paso('Limpiar · dar de baja el puesto', 'admin', 'DELETE', `job-positions/{{${v}}}`)] },
  employees: { claves: ['employeeId'], pasos: (v) => [paso('Limpiar · borrar el legajo', 'admin', 'DELETE', `employees/{{${v}}}`)] },
  suppliers: { claves: ['supplierId'], pasos: (v) => [paso('Limpiar · dar de baja el proveedor', 'admin', 'DELETE', `suppliers/{{${v}}}`)] },
  warehouses: { claves: ['warehouseId'], pasos: (v) => [{ vaciarDeposito: v }, paso('Limpiar · dar de baja el depósito', 'admin', 'DELETE', `warehouses/{{${v}}}`)] },
  cylinders: {
    claves: ['cylinder_id'],
    pasos: (v) => [
      paso('Limpiar · devolver el envase al depósito', 'admin', 'PATCH', `cylinders/{{${v}}}/transition`, { toState: 'in_depot' }, undefined, TOLERANTE),
      paso('Limpiar · retirar el envase', 'admin', 'PATCH', `cylinders/{{${v}}}/retire`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE),
    ],
  },
  'coverage-zones': { claves: ['coverage_zone_id'], pasos: (v) => [paso('Limpiar · dar de baja la zona', 'admin', 'DELETE', `coverage-zones/{{${v}}}`)] },
  'time-slot': { claves: ['time_slot_id'], pasos: (v) => [paso('Limpiar · desactivar la franja', 'admin', 'DELETE', `time-slot/{{${v}}}`)] },
  'user-address': { claves: ['address_id'], pasos: (v) => [paso('Limpiar · borrar la dirección', 'customer', 'DELETE', `user-address/{{${v}}}`)] },
  orders: {
    claves: ['order_id'],
    pasos: (v) => [
      paso('Limpiar · cancelar el pedido', 'admin', 'DELETE', `orders/{{${v}}}`, undefined, undefined, TOLERANTE),
      paso('Limpiar · dejar cobrado el pedido entregado', 'delivery', 'PATCH', `orders/{{${v}}}/payment/cash-received`, undefined, undefined, TOLERANTE),
    ],
  },
  'fleet/plans': { claves: ['planId'], pasos: (v) => [paso('Limpiar · desactivar el plan', 'admin', 'PATCH', `fleet/plans/{{${v}}}`, { isActive: false })] },
  'fleet/tasks': { claves: ['taskId'], pasos: (v) => [paso('Limpiar · cancelar la tarea', 'admin', 'PATCH', `fleet/tasks/{{${v}}}/cancel`, { notes: MOTIVO_LIMPIEZA }, undefined, TOLERANTE)] },
  'purchase-orders': {
    claves: ['purchaseOrderId'],
    pasos: (v) => [
      paso('Limpiar · cancelar la orden de compra', 'admin', 'PATCH', `purchase-orders/{{${v}}}/cancel`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE),
      paso('Limpiar · cerrar la orden con lo recibido', 'admin', 'PATCH', `purchase-orders/{{${v}}}/close-short`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE),
    ],
  },
  'purchase-receipts': { claves: ['receiptId'], pasos: (v) => [paso('Limpiar · anular la recepción', 'admin', 'PATCH', `purchase-receipts/{{${v}}}/void`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE)] },
  'truck-loads': { claves: ['loadId'], pasos: (v) => [paso('Limpiar · cancelar la carga', 'admin', 'PATCH', `truck-loads/{{${v}}}/cancel`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE)] },
  claims: {
    claves: ['claim_id'],
    pasos: (v) => [
      paso('Limpiar · tomar el reclamo', 'admin', 'PATCH', `claims/{{${v}}}/take`, undefined, undefined, TOLERANTE),
      paso('Limpiar · cerrar el reclamo', 'admin', 'PATCH', `claims/{{${v}}}/resolve`, { resolution: MOTIVO_LIMPIEZA, status: 'rejected' }, undefined, TOLERANTE),
    ],
  },
  incidents: { claves: ['incident_id'], pasos: (v) => [paso('Limpiar · descartar la incidencia', 'admin', 'PATCH', `incidents/{{${v}}}/resolve`, { resolutionNote: MOTIVO_LIMPIEZA, status: 'discarded' }, undefined, TOLERANTE)] },
  ratings: { claves: ['rating_id'], pasos: (v) => [paso('Limpiar · ocultar la calificación', 'admin', 'PATCH', `ratings/{{${v}}}/hide`, { reason: MOTIVO_LIMPIEZA }, undefined, TOLERANTE)] },
};

// Variable en la que un paso guarda el id del recurso que crea, o null si no es de los que se limpian.
function creadoPor(p) {
  if (p.m !== 'POST' || !p.cap) return null;
  const regla = LIMPIEZA[p.ruta];
  if (!regla) return null;
  const variable = Object.keys(p.cap).find((k) => p.cap[k].some((c) => regla.claves.includes(c)));
  return variable ? { ruta: p.ruta, variable } : null;
}

// Lleva a cero un stock de prueba con un ajuste, para no dejar garrafas de prueba en la demo.
// Lee lo que hay (por depósito o por producto) y arma el ajuste; sin stock, no manda nada.
//   por depósito: el back no deja darlo de baja con garrafas.
//   por producto: el stock vendible de una garrafa propia cae en el depósito principal.
function itemVaciar(nombre, descripcion, filtro, variable) {
  const rol = ROLES.admin;
  const req = {
    method: 'POST',
    header: [
      { key: 'Content-Type', value: 'application/json' },
      { key: 'X-Client-Source', value: rol.source },
      { key: 'X-Distributor', value: '{{distributorSlug}}' },
      { key: 'Idempotency-Key', value: '{{$guid}}' },
    ],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: `{{${rol.token}}}`, type: 'string' }] },
    url: { raw: '{{baseUrl}}/stock/adjustments', host: ['{{baseUrl}}'], path: ['stock', 'adjustments'] },
    body: { mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } },
    description: descripcion,
  };
  const pre = [
    `const id = pm.variables.get("${variable}");`,
    'pm.sendRequest({',
    `  url: pm.environment.get("baseUrl") + "/stock?${filtro}=" + id,`,
    '  method: "GET",',
    '  header: [',
    '    { key: "Authorization", value: "Bearer " + pm.collectionVariables.get("tokenAdmin") },',
    `    { key: "X-Client-Source", value: "${rol.source}" },`,
    '    { key: "X-Distributor", value: pm.environment.get("distributorSlug") },',
    '  ],',
    '}, (err, res) => {',
    '  const filas = !err && res && res.code === 200 ? res.json().filter((f) => f.quantity > 0) : [];',
    '  if (!filas.length) { pm.execution.skipRequest(); return; }',
    '  const lugar = filas[0];',
    '  const mismoLugar = filas.filter((f) => f.locationId === lugar.locationId);',
    '  const location = lugar.warehouseId ? { warehouseId: lugar.warehouseId } : { carId: lugar.carId };',
    `  pm.request.body.update(JSON.stringify({ location, reason: "count_correction", notes: "${MOTIVO_LIMPIEZA}", items: mismoLugar.map((f) => ({ gasCylinderId: f.gasCylinderId, condition: f.condition, quantityDelta: -f.quantity })) }));`,
    '});',
  ];
  return item(nombre, req, [
    'pm.test("el ajuste que deja el stock en cero se registra", () => pm.expect(pm.response.code).to.equal(201));',
  ], [savedResponse('Ejemplo', 201, {}, req)], pre);
}

function itemLimpieza(p) {
  if (p.vaciarDeposito) return itemVaciar('Limpiar · dejar el depósito sin stock', 'Paso de limpieza: lleva a cero el stock del depósito de prueba con un ajuste. Si no tiene stock, no manda nada.', 'warehouseId', p.vaciarDeposito);
  if (p.vaciarProducto) return itemVaciar('Limpiar · dejar la garrafa sin stock', 'Paso de limpieza: lleva a cero el stock de la garrafa de prueba con un ajuste (el vendible que se le carga cae en el depósito principal). Si no tiene stock, no manda nada.', 'gasCylinderId', p.vaciarProducto);
  return itemPaso(p);
}

function descripcionOperacion(op) {
  return [op.summary, op.description].filter(Boolean).join('\n\n') || 'Endpoint generado desde OpenAPI.';
}

function testExito(esperados, extra = []) {
  return [
    `pm.test("status ${esperados.join(' o ')}", () => pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(esperados)}));`,
    'pm.test("responde en menos de 5s", () => pm.expect(pm.response.responseTime).to.be.below(5000));',
    'if (pm.response.code !== 204 && pm.response.text() && /json/.test(pm.response.headers.get("Content-Type") || "")) {',
    '  pm.test("la respuesta es JSON (objeto o lista)", () => pm.expect(pm.response.json()).to.be.an(Array.isArray(pm.response.json()) ? "array" : "object"));',
    '}',
    ...extra,
  ];
}

function testError(esperado) {
  return [
    `pm.test("status ${esperado}", () => pm.expect(pm.response.code).to.equal(${esperado}));`,
    'pm.test("error con forma del back (statusCode y message)", () => {',
    '  const j = pm.response.json();',
    `  pm.expect(j.statusCode).to.equal(${esperado});`,
    '  pm.expect(j).to.have.property("message");',
    '});',
  ];
}

function item(nombre, req, tests, responses = [], pre = null) {
  const event = [{ listen: 'test', script: { type: 'text/javascript', exec: tests } }];
  if (pre) event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } });
  return { name: nombre, request: req, response: responses, event };
}

const ESTADO_TEXTO = {
  200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function savedResponse(nombre, codigo, body, req) {
  return {
    name: nombre,
    originalRequest: req,
    status: ESTADO_TEXTO[codigo] || 'Response',
    code: codigo,
    _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: codigo === 204 ? '' : JSON.stringify(body, null, 2),
  };
}

function errorBody(codigo, mensaje, error) {
  return { statusCode: codigo, message: mensaje, error };
}

function ejemploOkBody(spec, op) {
  const res = op.responses?.['200'] || op.responses?.['201'] || op.responses?.['204'] || {};
  const schema = res.content?.['application/json']?.schema;
  return schema ? ejemplo(spec, schema) : {};
}

function tieneCuerpoJson(op) {
  return Boolean(op.requestBody?.content?.['application/json']);
}

function scriptCaptura(captura, modo = 'objeto', excluir = null, donde = null) {
  if (!captura) return [];
  return [
    'if (pm.response.code < 300 && pm.response.text()) {',
    '  const j = pm.response.json();',
    modo === 'lista'
      ? `  const lista = Array.isArray(j) ? j : (Object.values(j).find(Array.isArray) || []);\n  const base = ${excluir || donde ? `lista.find((x) => ${[excluir && `String(${JSON.stringify(excluir.campo)}.split(".").reduce((acc, parte) => (acc == null ? undefined : acc[parte]), x)) !== pm.collectionVariables.get(${JSON.stringify(excluir.variable)})`, donde && `x[${JSON.stringify(donde.campo)}] === ${JSON.stringify(donde.valor)}`].filter(Boolean).join(' && ')}) || {}` : 'lista[0] || {}'};`
      : '  const base = (j && typeof j === "object" && j.data && !Array.isArray(j.data) && typeof j.data === "object") ? j.data : j;',
    ...Object.entries(captura).flatMap(([variable, claves]) => [
      `  const ${variable} = ${JSON.stringify(claves)}.map((k) => k.split(".").reduce((acc, parte) => (acc == null ? undefined : acc[parte]), base)).find((v) => v !== undefined && v !== null && v !== "");`,
      `  if (${variable}) { pm.collectionVariables.set("${variable}", ${variable}); pm.environment.set("${variable}", ${variable}); }`,
    ]),
    '}',
  ];
}

// ---------------------------------------------------------------- casos por operación

function exigeClave(op) {
  return (op.parameters || []).some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key' && p.required);
}

function casosOperacion(spec, metodo, ruta, op) {
  const clave = claveOperacion(metodo, ruta);
  const cfg = OPS[clave] || {};
  const principal = rolPrincipal(clave, cfg);
  const respuestas = Object.keys(op.responses || {}).filter((r) => /^2\d\d$/.test(r)).map(Number);
  const okEsperados = cfg.okStatus || (respuestas.length ? respuestas : [metodo === 'post' ? 201 : 200]);
  const conCuerpo = tieneCuerpoJson(op);
  if (conCuerpo && (cfg.ok === undefined || cfg.malo === undefined)) {
    throw new Error(`Falta ok/malo en casos.js para ${clave}`);
  }
  const idsDeRuta = (ruta.match(/\{[^}]+\}/g) || []).map((s) => s.slice(1, -1));
  const out = [];
  const creados = [];
  const registrar = (p) => {
    const c = creadoPor(p);
    if (!c) return;
    if (creados.some((x) => x.variable === c.variable)) console.warn(`Aviso: ${clave} crea dos recursos en la variable ${c.variable}; sólo el último se limpia`);
    creados.push(c);
  };
  for (const p of cfg.pasos || []) {
    out.push(itemPaso(p));
    registrar(p);
  }

  if (cfg.sinExito) {
    const reqSin = requestBase(metodo, ruta, op, cfg, {
      body: cfg.ok,
      token: principal.token,
      source: principal.source,
      descripcion: `${descripcionOperacion(op)}\n\nNo hay caso 201: ${cfg.sinExito}. Con datos válidos, el back responde 400 porque no hay diferencia que corregir.`,
    });
    out.push(item('400 · sin diferencia que corregir', reqSin, [
      ...testError(400),
      'pm.test("el mensaje explica que no hay diferencia", () => pm.expect(pm.response.json().message).to.match(/no tiene diferencia/));',
    ], [savedResponse('Ejemplo 400 sin diferencia', 400, errorBody(400, 'Garrafa 10kg no tiene diferencia: el vendible ya coincide con el físico menos lo reservado', 'Bad Request'), reqSin)]));
  }
  const reqOk = requestBase(metodo, ruta, op, cfg, {
    body: conCuerpo ? cfg.ok : undefined,
    token: principal.token,
    source: principal.source,
    descripcion: `${descripcionOperacion(op)}\n\n${cfg.descripcionOk || 'Caso feliz con datos propios de la colección.'}`,
  });
  if (!cfg.sinExito) {
    const rutaPost = ruta.replace(/^\/api\//, '');
    const captura = cfg.capture || (metodo === 'post' && LIMPIEZA[rutaPost] ? { nuevoId: LIMPIEZA[rutaPost].claves } : undefined);
    out.push(item(
      `200/201 · correcto -> ${okEsperados.join(' o ')}`,
      reqOk,
      testExito(okEsperados, [...scriptCaptura(captura), ...(cfg.testsOk || [])]),
      [savedResponse('Ejemplo 2xx', okEsperados[0], ejemploOkBody(spec, op), reqOk)],
      cfg.pre,
    ));
    if (captura) registrar({ m: 'POST', ruta: rutaPost, cap: captura });
    // Un DELETE que anda ya dio de baja el recurso que armó la carpeta: no hay que volver a limpiarlo.
    if (metodo === 'delete' && cfg.id) {
      const hecho = creados.findIndex((c) => c.variable === cfg.id);
      if (hecho >= 0) creados.splice(hecho, 1);
    }
  }

  const hay400 = !cfg.no400 && (conCuerpo || cfg.paramsMalos || cfg.maloQuery
    || idsDeRuta.length > 0 || (op.parameters || []).some((p) => p.required && p.in === 'query'));
  if (hay400) {
    const req400 = requestBase(metodo, ruta, op, cfg, {
      body: conCuerpo ? cfg.malo : undefined,
      token: principal.token,
      source: principal.source,
      modo: conCuerpo ? 'ok' : 'invalido',
      descripcion: 'Datos inválidos: el ValidationPipe o los pipes de parámetros responden 400 con el detalle.',
    });
    out.push(item('400 · datos inválidos', req400, testError(400), [
      savedResponse('Ejemplo 400', 400, errorBody(400, ['campo inválido'], 'Bad Request'), req400),
    ]));
  }

  if (exigeClave(op)) {
    const reqSinClave = requestBase(metodo, ruta, op, cfg, {
      body: conCuerpo ? cfg.ok : undefined,
      token: principal.token,
      source: principal.source,
      sinClave: true,
      descripcion: 'Sin el header Idempotency-Key: el back lo exige en esta operación y responde 400 (un reintento duplicaría el movimiento).',
    });
    out.push(item('400 · sin Idempotency-Key', reqSinClave, [
      ...testError(400),
      'pm.test("el mensaje menciona Idempotency-Key", () => pm.expect(JSON.stringify(pm.response.json().message)).to.match(/Idempotency-Key/i));',
    ], [savedResponse('Ejemplo 400 sin clave', 400, errorBody(400, 'Idempotency-Key es obligatoria en esta operación', 'Bad Request'), reqSinClave)]));
  }

  if (!esPublico(clave)) {
    const req401 = requestBase(metodo, ruta, op, cfg, {
      body: conCuerpo ? cfg.ok : undefined,
      noauth: true,
      source: principal.source,
      descripcion: 'Sin token: el AuthGuard rechaza la request.',
    });
    out.push(item('401 · sin token', req401, testError(401), [
      savedResponse('Ejemplo 401', 401, errorBody(401, 'No token provided', 'Unauthorized'), req401),
    ]));
  }

  const prohibido = esPublico(clave) ? null : rolNoPermitido(clave);
  if (prohibido) {
    const req403 = requestBase(metodo, ruta, op, cfg, {
      body: conCuerpo ? cfg.ok : undefined,
      token: prohibido.token,
      source: prohibido.source,
      descripcion: 'Token de un rol que no tiene permiso sobre este endpoint (RolesGuard).',
    });
    out.push(item('403 · rol sin permiso', req403, testError(403), [
      savedResponse('Ejemplo 403', 403, errorBody(403, 'Acceso denegado. Requiere rol: admin, super_admin', 'Forbidden'), req403),
    ]));
  }

  if (cfg.ajeno) {
    const a = cfg.ajeno;
    const rol = ROLES[a.rol];
    const cfgAjeno = { ...cfg, id: a.id, params: { ...(a.id ? {} : cfg.params), ...a.params } };
    if (a.id === undefined && a.params?.id === undefined) cfgAjeno.id = cfg.id;
    const reqAjeno = requestBase(metodo, ruta, op, cfgAjeno, {
      body: conCuerpo ? (a.body ?? cfg.ok) : undefined,
      token: rol.token,
      source: rol.source,
      descripcion: 'Un cliente intenta usar un recurso de otro usuario: el back responde 403.',
    });
    out.push(item('403 · recurso de otro usuario', reqAjeno, testError(403), [
      savedResponse('Ejemplo 403', 403, errorBody(403, 'No autorizado a acceder a datos de otro cliente', 'Forbidden'), reqAjeno),
    ]));
  }

  for (const c of cfg.body404 || []) {
    const req = requestBase(metodo, ruta, op, cfg, {
      body: c.body,
      token: principal.token,
      source: principal.source,
      descripcion: `Referencia con formato válido pero inexistente en el cuerpo: ${c.nombre}.`,
    });
    out.push(item(`404 · ${c.nombre}`, req, testError(404), [
      savedResponse('Ejemplo 404', 404, errorBody(404, 'No encontrado', 'Not Found'), req),
    ]));
  }

  const hay404 = !cfg.no404 && (idsDeRuta.some(esIdLike) || cfg.inexistente);
  if (hay404) {
    const req404 = requestBase(metodo, ruta, op, cfg, {
      body: conCuerpo ? cfg.ok : undefined,
      token: principal.token,
      source: principal.source,
      modo: 'inexistente',
      descripcion: 'Identificador con formato válido que no existe.',
    });
    out.push(item('404 · no existe', req404, testError(404), [
      savedResponse('Ejemplo 404', 404, errorBody(404, 'No encontrado', 'Not Found'), req404),
    ]));
  }

  for (const e of cfg.extras || []) {
    for (const p of e.pasos || []) {
      out.push(itemPaso(p));
      registrar(p);
    }
    const rol = ROLES[e.rol] || principal;
    const cfgE = { ...cfg, params: { ...(cfg.params || {}), ...(e.params || {}) }, query: e.query || cfg.query };
    if (e.params && e.params.id !== undefined) cfgE.id = undefined;
    const body = e.body !== undefined ? e.body : cfg.ok;
    const req = requestBase(metodo, ruta, op, cfgE, {
      body: conCuerpo ? body : undefined,
      token: rol.token,
      source: rol.source,
      sinDistribuidor: e.sinDistribuidor,
      tokenLiteral: e.tokenInvalido ? 'token-invalido' : undefined,
      descripcion: e.descripcion || e.nombre,
    });
    const error = e.status >= 400;
    out.push(item(
      e.nombre,
      req,
      error ? [...testError(e.status), ...(e.tests || [])] : testExito([e.status], e.tests || []),
      [savedResponse(`Ejemplo ${e.status}`, e.status, error ? errorBody(e.status, 'Mensaje del back', ESTADO_TEXTO[e.status] || 'Error') : ejemploOkBody(spec, op), req)],
    ));
  }

  if (ruta === '/api/health' || ruta === '/api/health/ready') {
    const req503 = requestBase(metodo, ruta, op, cfg, {
      noauth: true,
      descripcion: '503 real de Terminus: detener Postgres o Redis y ejecutar esta request. Con todo sano responde 200.',
    });
    out.push(item('503 · dependencia caída', req503, [
      'pm.test("200 con todo sano o 503 si cayó una dependencia", () => pm.expect(pm.response.code).to.be.oneOf([200, 503]));',
      'pm.test("el estado del cuerpo coincide con el status", () => pm.expect(pm.response.json().status).to.equal(pm.response.code === 200 ? "ok" : "error"));',
    ], [
      savedResponse('Ejemplo 503 real de health', 503, { status: 'error', info: {}, error: { postgres: { status: 'down' } }, details: { postgres: { status: 'down' } } }, req503),
    ]));
  }

  for (const p of cfg.limpiar || []) out.push(itemPaso(p));
  for (const c of [...creados].reverse()) {
    for (const p of LIMPIEZA[c.ruta].pasos(c.variable)) out.push(itemLimpieza(p));
  }
  return out;
}

// ---------------------------------------------------------------- carpetas fijas

function carpetaAcceso() {
  const accesos = [
    ['Entrar como cliente', 'auth/login', 'customer-app', '{{clienteEmail}}', '{{clientePassword}}', 'tokenCliente'],
    ['Entrar como chofer', 'auth/login', 'driver-app', '{{choferEmail}}', '{{choferPassword}}', 'tokenChofer'],
    ['Entrar como administrador', 'auth/login/dashboard', 'panel-app', '{{adminEmail}}', '{{adminPassword}}', 'tokenAdmin'],
    ['Entrar como super administrador', 'auth/login/dashboard', 'panel-app', '{{superAdminEmail}}', '{{superAdminPassword}}', 'tokenSuperAdmin'],
  ];
  return {
    name: '00 · Acceso',
    description: 'Correr primero: guarda el token de cada rol. La colección también inicia sesión sola si falta un token o venció.',
    item: accesos.map(([nombre, ruta, source, email, password, tokenVar]) => {
      const req = {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Client-Source', value: source }, { key: 'X-Distributor', value: '{{distributorSlug}}' }],
        auth: { type: 'noauth' },
        url: { raw: `{{baseUrl}}/${ruta}`, host: ['{{baseUrl}}'], path: ruta.split('/') },
        body: { mode: 'raw', raw: JSON.stringify({ email, password }, null, 2), options: { raw: { language: 'json' } } },
        description: `Guarda el token en {{${tokenVar}}}.`,
      };
      return item(nombre, req, [
        'pm.test("login responde 200", () => pm.response.to.have.status(200));',
        'const j = pm.response.json();',
        'pm.test("devuelve accessToken", () => pm.expect(j.accessToken).to.be.a("string"));',
        `if (j.accessToken) { pm.collectionVariables.set("${tokenVar}", j.accessToken); pm.collectionVariables.set("${tokenVar}Vence", String(Date.now() + 50 * 60 * 1000)); }`,
      ], [savedResponse('Ejemplo login correcto', 200, { accessToken: '<jwt>', expiresIn: 3599, user: { uid: '<uid>', email: 'usuario@splg.com' } }, req)]);
    }),
  };
}

function carpetaErrores() {
  const reqLive = {
    method: 'GET',
    header: [],
    auth: { type: 'noauth' },
    url: { raw: '{{baseUrl}}/health/live', host: ['{{baseUrl}}'], path: ['health', 'live'] },
    description: 'El back no produce 500 ni 504 a pedido: se documentan como ejemplos guardados con el formato real del filtro de excepciones. 503 es real en /health y /health/ready cuando cae Postgres o Redis.',
  };
  const reqReady = { ...reqLive, url: { raw: '{{baseUrl}}/health/ready', host: ['{{baseUrl}}'], path: ['health', 'ready'] }, description: 'Para provocar el 503: detener Postgres o Redis en un entorno descartable y ejecutar esta request.' };
  const sano = ['pm.test("el back responde 200 si está sano", () => pm.expect(pm.response.code).to.equal(200));'];
  return {
    name: '00 · Errores documentados',
    description: '500 y 504 no se disparan a pedido: son ejemplos guardados. El 503 es real en /health/ready con una dependencia caída.',
    item: [
      item('500 · ejemplo guardado', reqLive, sano, [savedResponse('500 Internal Server Error', 500, errorBody(500, 'Internal server error', 'Internal Server Error'), reqLive)]),
      item('503 · health/ready con dependencia caída', reqReady, ['pm.test("200 sano o 503 con una dependencia caída", () => pm.expect(pm.response.code).to.be.oneOf([200, 503]));'], [savedResponse('503 Terminus', 503, { status: 'error', info: {}, error: { redis: { status: 'down' } }, details: { redis: { status: 'down' } } }, reqReady)]),
      item('504 · ejemplo guardado', reqLive, sano, [savedResponse('504 Gateway Timeout (proxy)', 504, errorBody(504, 'Gateway Timeout', 'Gateway Timeout'), reqLive)]),
    ],
  };
}

function urlDePaso(ruta) {
  const [soloRuta, qs] = ruta.split('?');
  const url = { raw: `{{baseUrl}}/${ruta}`, host: ['{{baseUrl}}'], path: soloRuta.split('/') };
  if (qs) url.query = qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] }));
  return url;
}

function pasoSinControlDeCamion() {
  const rol = ROLES.admin;
  const req = {
    method: 'PUT',
    header: [
      { key: 'Content-Type', value: 'application/json' },
      { key: 'X-Client-Source', value: rol.source },
      { key: 'X-Distributor', value: '{{distributorSlug}}' },
      { key: 'Idempotency-Key', value: '{{$guid}}' },
    ],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: `{{${rol.token}}}`, type: 'string' }] },
    url: { raw: '{{baseUrl}}/truck-loads/settings', host: ['{{baseUrl}}'], path: ['truck-loads', 'settings'] },
    body: { mode: 'raw', raw: JSON.stringify({ requireOpenTruckLoad: false }, null, 2), options: { raw: { language: 'json' } } },
    description: 'Las pruebas de pedidos asumen el valor por defecto: la distribuidora no exige una carga de camión abierta para asignar pedidos.',
  };
  return item('Control de carga de camión desactivado (valor por defecto)', req, [
    'pm.test("responde 200", () => pm.response.to.have.status(200));',
    'pm.test("queda desactivado", () => pm.expect(pm.response.json().requireOpenTruckLoad).to.equal(false));',
  ], [savedResponse('Ejemplo', 200, { requireOpenTruckLoad: false }, req)]);
}

function carpetaPreparacion() {
  return {
    name: '00 · Preparación',
    description: 'Deja el control de camión en su valor por defecto y lee los datos de la demo que las pruebas necesitan (cliente, chofer, catálogo, etc.) guardando sus ids en variables.',
    item: [pasoSinControlDeCamion(), ...PREPARACION.map((p) => {
      const rol = p.roles ? ROLES[p.roles] : null;
      const req = {
        method: 'GET',
        header: [
          { key: 'X-Client-Source', value: rol?.source || '{{clientSource}}' },
          { key: 'X-Distributor', value: '{{distributorSlug}}' },
        ],
        auth: rol ? { type: 'bearer', bearer: [{ key: 'token', value: `{{${rol.token}}}`, type: 'string' }] } : { type: 'noauth' },
        url: urlDePaso(p.path),
        description: 'Toma el primer registro visible y guarda sus ids.',
      };
      const variables = Object.keys(p.captures);
      return item(p.name, req, [
        'pm.test("preparación responde 200", () => pm.response.to.have.status(200));',
        ...scriptCaptura(p.captures, p.modo || 'lista', p.excluir, p.donde),
        `pm.test("se capturaron: ${variables.join(', ')}", () => {`,
        ...variables.map((v) => `  pm.expect(String(pm.collectionVariables.get("${v}")), "${v}").to.not.be.oneOf(["undefined", "null", ""]);`),
        '});',
      ], [savedResponse('Ejemplo preparación', 200, [], req)]);
    })],
  };
}

function carpetaDatos() {
  return {
    name: '00 · Datos de prueba',
    description: 'Arma lo que comparten las pruebas: un producto propio (así el stock de la demo no se toca) y un pedido entregado con su calificación. Un pedido entregado no se puede cancelar: por eso se arma uno solo y las pruebas de reclamos, calificaciones, historial y ruta lo reutilizan. `99 · Restauración` lo deja ordenado.',
    item: DATOS_DE_PRUEBA.map(itemPaso),
  };
}

function carpetaRestauracion() {
  return {
    name: '99 · Restauración',
    description: 'Cierra la corrida: oculta la calificación de prueba (no cuenta en el promedio del chofer), deja en cero el stock del producto propio y lo da de baja.',
    item: RESTAURACION.map(itemLimpieza),
  };
}

function collectionPrerequest() {
  return `
const accesos = [
  { token: 'tokenCliente', email: 'clienteEmail', password: 'clientePassword', source: 'customer-app', path: 'auth/login' },
  { token: 'tokenChofer', email: 'choferEmail', password: 'choferPassword', source: 'driver-app', path: 'auth/login' },
  { token: 'tokenAdmin', email: 'adminEmail', password: 'adminPassword', source: 'panel-app', path: 'auth/login/dashboard' },
  { token: 'tokenSuperAdmin', email: 'superAdminEmail', password: 'superAdminPassword', source: 'panel-app', path: 'auth/login/dashboard' },
];
pm.variables.set('unico', Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
pm.variables.set('unicoNum', String(Date.now() % 100000000) + String(Math.floor(Math.random() * 1000)).padStart(3, '0'));
const ahora = Date.now();
for (const a of accesos) {
  const vigente = pm.collectionVariables.get(a.token) && Number(pm.collectionVariables.get(a.token + 'Vence') || 0) > ahora;
  const email = pm.environment.get(a.email);
  const password = pm.environment.get(a.password);
  if (vigente || !email || !password) continue;
  pm.sendRequest({
    url: pm.environment.get('baseUrl') + '/' + a.path,
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Client-Source', value: a.source }, { key: 'X-Distributor', value: pm.environment.get('distributorSlug') }],
    body: { mode: 'raw', raw: JSON.stringify({ email, password }) },
  }, (err, res) => {
    if (!err && res && res.code === 200) {
      const token = res.json().accessToken;
      if (token) {
        pm.collectionVariables.set(a.token, token);
        pm.collectionVariables.set(a.token + 'Vence', String(Date.now() + 50 * 60 * 1000));
      }
    }
  });
}
`.trim().split('\n');
}

function environment(coleccionTexto) {
  const values = [
    ['baseUrl', 'http://localhost:3010/api'],
    ['clientSource', 'panel-app'],
    ['distributorSlug', 'demo'],
    ['idInexistente', UUID_INEXISTENTE],
    ['adminEmail', 'admin@splg.com'],
    ['adminPassword', 'Test1234', 'secret'],
    ['superAdminEmail', 'superadmin@splg.com'],
    ['superAdminPassword', 'Test1234', 'secret'],
    ['clienteEmail', 'cliente@splg.com'],
    ['clientePassword', 'Test1234', 'secret'],
    ['choferEmail', 'chofer@splg.com'],
    ['choferPassword', 'Test1234', 'secret'],
    ['choferLibreEmail', 'cristian.maidana@gmail.com'],
    ['email', 'cliente@splg.com'],
    ['ownerType', 'car'],
  ];
  const conocidos = new Set(values.map(([k]) => k));
  const usadas = new Set([...coleccionTexto.matchAll(/\{\{([A-Za-z]\w*)\}\}/g)].map((m) => m[1]));
  for (const k of [...usadas].sort()) {
    if (conocidos.has(k) || /^token/.test(k) || VARIABLES_LOCALES.has(k)) continue;
    conocidos.add(k);
    values.push([k, '']);
  }
  return {
    name: 'SPLG local',
    values: values.map(([key, value, type]) => ({ key, value, type: type || 'default', enabled: true })),
  };
}

function contar(collection) {
  const porStatus = {};
  let requests = 0;
  let examples = 0;
  function walk(items) {
    for (const it of items || []) {
      if (it.item) walk(it.item);
      else {
        requests += 1;
        const m = it.name.match(/^(\d{3}|200\/201)/);
        const k = m ? m[1] : 'otros';
        porStatus[k] = (porStatus[k] || 0) + 1;
        examples += (it.response || []).length;
      }
    }
  }
  walk(collection.item);
  return { requests, examples, porStatus };
}

// Id estable por request (hash de su posición): newman lo devuelve en el reporte y
// guardar-ejemplos.js lo usa para ligar cada respuesta real con su request.
function asignarIds(items, prefijo = '') {
  items.forEach((it, i) => {
    const clave = `${prefijo}/${i}:${it.name}`;
    if (it.item) asignarIds(it.item, clave);
    else {
      const h = crypto.createHash('sha1').update(clave).digest('hex');
      it.id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }
  });
}

const VARIABLES_LOCALES = new Set(['unico', 'unicoNum', 'cuitNuevo', 'codigoNuevo', 'patenteNueva', 'serialNuevo']);
const RANGO_METODO = { get: 0, post: 1, put: 2, patch: 3, delete: 4 };

async function main() {
  const input = arg('input', 'http://localhost:3010/docs-yaml');
  const outCollection = arg('collection', 'postman/SPLG.postman_collection.json');
  const outEnv = arg('environment', 'postman/SPLG-local.postman_environment.json');
  const spec = await leerSpec(input);
  ACCESO = leerRoles(path.resolve(BASE, arg('src', 'src')));
  const carpetas = new Map();
  const manuales = [];
  for (const [ruta, ops] of Object.entries(spec.paths || {})) {
    for (const metodo of METODOS) {
      const op = ops[metodo];
      if (!op) continue;
      const clave = claveOperacion(metodo, ruta);
      const tag = (op.tags || ['Sin clasificar'])[0];
      const folder = { name: `${metodo.toUpperCase()} ${ruta}`, metodo, ruta, item: casosOperacion(spec, metodo, ruta, op) };
      if (esManual(clave)) {
        folder.name = `Manual · ${folder.name}`;
        manuales.push(folder);
      } else {
        if (!carpetas.has(tag)) carpetas.set(tag, []);
        carpetas.get(tag).push(folder);
      }
    }
  }
  const ordenar = (a, b) => (RANGO_METODO[a.metodo] - RANGO_METODO[b.metodo]) || a.ruta.localeCompare(b.ruta, 'es');
  const limpio = ({ metodo, ruta, ...resto }) => resto;
  const collection = {
    info: {
      name: 'SPLG - API completa',
      description: `Generada desde ${input} con scripts/postman/generar-coleccion.js. Cubre ${Object.keys(spec.paths || {}).length} paths y todas las operaciones HTTP publicadas.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tokenSuperAdmin}}', type: 'string' }] },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: collectionPrerequest() } }],
    variable: [
      { key: 'tokenSuperAdmin', value: '' },
      { key: 'tokenAdmin', value: '' },
      { key: 'tokenCliente', value: '' },
      { key: 'tokenChofer', value: '' },
    ],
    item: [
      carpetaAcceso(),
      carpetaPreparacion(),
      carpetaDatos(),
      carpetaErrores(),
      { name: 'Manual', description: 'Requests que tocan cuentas (Firebase), mandan mails, suben archivos o necesitan un usuario nuevo. No se corren en la corrida automática (newman sin esta carpeta).', item: manuales.sort(ordenar).map(limpio) },
      ...[...carpetas.entries()].sort(([a], [b]) => a.localeCompare(b, 'es')).map(([name, items]) => ({
        name,
        item: items.sort(ordenar).map(limpio),
      })),
      carpetaRestauracion(),
    ],
  };
  asignarIds(collection.item);
  const texto = JSON.stringify(collection, null, 2) + '\n';
  fs.writeFileSync(path.resolve(BASE, outCollection), texto);
  fs.writeFileSync(path.resolve(BASE, outEnv), JSON.stringify(environment(texto), null, 2) + '\n');
  console.log(JSON.stringify(contar(collection), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
