// Datos de prueba y flujos por operación. El generador (generar-coleccion.js)
// arma con esto cada carpeta de endpoint: pasos de preparación (recursos
// propios, para no gastar los de la demo), el caso feliz, el 400 y la limpieza.
//
// Claves de cada operación:
//   rol        quién la llama en el caso feliz (por defecto, el primer rol permitido)
//   ok / malo  cuerpo válido / inválido (JSON). '@@{{x}}' inserta {{x}} sin comillas (números)
//   query      parámetros de query del caso feliz;  maloQuery  los del 400
//   params     variable que va en cada parámetro de ruta (por defecto la del recurso)
//   inexistente / paramsMalos  valor literal de un parámetro de ruta para el 404 / el 400
//   pasos      requests de preparación que corren antes del caso feliz
//   limpiar    requests que corren al final de la carpeta
//   okStatus   status de éxito real cuando difiere del OpenAPI
//   no400 / no404  motivo por el que ese caso no existe (queda en la descripción)
//   pre        líneas de pre-request del caso feliz
//   testsOk    líneas de test que se suman al caso feliz
//   extras     casos adicionales { nombre, status, rol, params, query, body, sinDistribuidor,
//              tokenInvalido, sinClave, pasos, limpiar, tests }
//
// Lo que crea la colección lleva "Prueba API" en el nombre y se da de baja al final de la
// carpeta (limpieza automática del generador, según LIMPIEZA). El stock de las pruebas usa
// un producto propio (gasPruebaId) para no mover el de la demo.

const PRE_CUIT = [
  'const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];',
  'let cuit = "";',
  'while (!cuit) {',
  '  const base = "20" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");',
  '  const suma = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0);',
  '  let dv = 11 - (suma % 11);',
  '  if (dv === 11) dv = 0;',
  '  if (dv !== 10) cuit = base + dv;',
  '}',
  'pm.variables.set("cuitNuevo", cuit);',
];

const PRE_CODIGOS = [
  'const azar = Date.now().toString(36).toUpperCase().slice(-6);',
  'pm.variables.set("codigoNuevo", "PA" + azar);',
  'pm.variables.set("patenteNueva", "PA" + azar + String(Math.floor(Math.random() * 90) + 10));',
  'pm.variables.set("serialNuevo", "PRUEBA-API-" + Date.now() + "-" + Math.floor(Math.random() * 1000));',
];

const paso = (nombre, rol, m, ruta, body, cap, extra = {}) => ({ nombre, rol, m, ruta, body, cap, ...extra });

const PEDIDO = {
  customerId: '{{clienteUserId}}',
  addressId: '{{addressId}}',
  items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 1, unitPrice: 100 }],
  paymentMethod: 'cash',
  notes: 'Pedido de prueba de la API (corrida automática)',
};

const S = {
  pedido: (v) => paso('Preparar · pedido pendiente', 'customer', 'POST', 'orders', PEDIDO, { [v]: ['order_id'] }),
  asignar: (v) => paso('Preparar · asignar al chofer', 'admin', 'PATCH', `orders/{{${v}}}/assign/{{deliveryId}}`),
  codigo: (v) => paso('Preparar · código de entrega', 'delivery', 'GET', `orders/{{${v}}}/delivery-code`, undefined, { codigoEntrega: ['deliveryCode'] }),
  enCamino: (v) => paso('Preparar · pedido en camino', 'delivery', 'PATCH', `orders/{{${v}}}/status`, { status: 'on_the_way' }),
  entregar: (v) => paso('Preparar · confirmar entrega', 'customer', 'POST', `orders/{{${v}}}/confirm-delivery`, { code: '{{codigoEntrega}}' }),
  cobrar: (v) => paso('Preparar · cobro en efectivo', 'delivery', 'PATCH', `orders/{{${v}}}/payment/cash-received`),
  impago: (v) => paso('Preparar · informar impago', 'delivery', 'PATCH', `orders/{{${v}}}/payment/unpaid`, { note: 'El cliente no tenia efectivo' }),
  pedidoTransferencia: (v) => paso('Preparar · pedido por transferencia', 'customer', 'POST', 'orders', { ...PEDIDO, paymentMethod: 'transfer' }, { [v]: ['order_id'] }),
  transferencia: (v) => [S.pedidoTransferencia(v), S.asignar(v), S.codigo(v), S.enCamino(v), S.entregar(v)],
  reasignar: (v) => paso('Preparar · reasignar al chofer libre', 'admin', 'PATCH', `orders/{{${v}}}/assign/{{deliveryLibreId}}`),
  cobrada: (v) => [...S.entregado(v), S.cobrar(v)],
  proveedor: (v) => paso('Preparar · proveedor', 'admin', 'POST', 'suppliers', { businessName: 'Proveedor Prueba API {{unico}}', cuit: '{{cuitNuevo}}', kind: 'filling_plant' }, { [v]: ['supplierId'] }, { pre: PRE_CUIT }),
  deposito: (v) => paso('Preparar · depósito', 'admin', 'POST', 'warehouses', { name: 'Depósito Prueba API {{unico}}', code: '{{codigoNuevo}}' }, { [v]: ['warehouseId'] }, { pre: PRE_CODIGOS }),
  conteo: (w, cap) => paso('Preparar · conteo inicial', 'admin', 'POST', 'stock/initial-counts', { warehouseId: `{{${w}}}`, items: [{ gasCylinderId: '{{gasPruebaId}}', full: 30, empty: 5 }] }, cap),
  auto: (v) => paso('Preparar · vehículo', 'admin', 'POST', 'car', { user_id: '{{deliveryLibreUserId}}', type_car: 'Utilitario', car_patent: '{{patenteNueva}}' }, { [v]: ['car_id'] }, { pre: PRE_CODIGOS }),
  vehiculoEnUso: (c) => paso('Preparar · poner el vehículo en uso', 'admin', 'PUT', 'delivery/{{deliveryLibreId}}/vehicle', { carId: `{{${c}}}` }),
  restaurarVehiculo: () => paso('Limpiar · devolver su vehículo al chofer', 'admin', 'PUT', 'delivery/{{deliveryLibreId}}/vehicle', { carId: '{{libreCarId}}' }),
  cilindro: (v) => paso('Preparar · envase', 'admin', 'POST', 'cylinders', { serial: '{{serialNuevo}}', gasCylinderId: '{{gasPruebaId}}', deposit: 5000 }, { [v]: ['cylinder_id'] }, { pre: PRE_CODIGOS }),
  orden: (v, prov, dep) => paso('Preparar · orden de compra', 'admin', 'POST', 'purchase-orders', { supplierId: `{{${prov}}}`, destinationWarehouseId: `{{${dep}}}`, items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 5, unitCost: 7000 }] }, { [v]: ['purchaseOrderId'] }),
  enviarOrden: (v) => paso('Preparar · enviar la orden', 'admin', 'PATCH', `purchase-orders/{{${v}}}/send`),
  recepcion: (v, ord) => paso('Preparar · recepción', 'admin', 'POST', 'purchase-receipts', { purchaseOrderId: `{{${ord}}}`, supplierDocumentType: 'invoice', supplierDocumentNumber: 'F-{{unico}}', items: [{ gasCylinderId: '{{gasPruebaId}}', quantityFull: 2 }] }, { [v]: ['receiptId'] }),
  entregado: (v) => [S.pedido(v), S.asignar(v), S.codigo(v), S.enCamino(v), S.entregar(v)],
  enCurso: (v) => [S.pedido(v), S.asignar(v), S.enCamino(v)],
  aceptado: (v) => [S.pedido(v), S.asignar(v)],
  reclamo: (v, ped) => paso('Preparar · reclamo', 'customer', 'POST', 'claims', { orderId: `{{${ped}}}`, customerId: '{{clienteUserId}}', reason: 'Carga incompleta', description: 'La garrafa llego con menos gas' }, { [v]: ['claim_id'] }),
  calificacion: (v, ped) => paso('Preparar · calificación', 'customer', 'POST', 'ratings', { orderId: `{{${ped}}}`, stars: 4, comment: 'Entrega correcta' }, { [v]: ['rating_id'] }),
  incidencia: (v, ped) => paso('Preparar · incidencia', 'delivery', 'POST', 'incidents', { orderId: `{{${ped}}}`, type: 'no_show', description: 'Cliente ausente en el domicilio' }, { [v]: ['incident_id'] }),
  puesto: (v) => paso('Preparar · puesto', 'admin', 'POST', 'job-positions', { name: 'Puesto Prueba API {{unico}}', category: 'administration' }, { [v]: ['positionId'] }),
  empleado: (v, pos = 'positionAdminId') => paso('Preparar · legajo', 'admin', 'POST', 'employees', LEGAJO(pos), { [v]: ['employeeId'] }),
  plan: (v) => paso('Preparar · plan de flota', 'admin', 'POST', 'fleet/plans', PLAN, { [v]: ['planId'] }),
  tarea: (v, plan, car = 'carId') => paso('Preparar · tarea de flota', 'admin', 'POST', 'fleet/tasks', { planId: `{{${plan}}}`, carId: `{{${car}}}`, dueAt: '2026-12-01' }, { [v]: ['taskId'] }),
  carga: (v, w) => paso('Preparar · carga del camión', 'admin', 'POST', 'truck-loads', CARGA(w), { [v]: ['loadId'] }),
  camion: (w) => [S.deposito(w), S.conteo(w)],
};

const LEGAJO = (pos) => ({
  positionId: `{{${pos}}}`,
  firstName: 'Prueba API',
  lastName: 'Prueba {{unico}}',
  documentType: 'dni',
  documentNumber: '{{unicoNum}}',
  hireDate: '2026-01-10',
  employmentType: 'permanent',
});

const PLAN = { name: 'Plan Prueba API {{unico}}', subject: 'vehicle', trigger: 'by_time', intervalMonths: 12, leadTimeDays: 15, criticality: 'non_blocking' };

const CARGA = (w) => ({
  carId: '{{libreCarId}}',
  deliveryId: '{{deliveryLibreId}}',
  originWarehouseId: `{{${w}}}`,
  items: [{ gasCylinderId: '{{gasPruebaId}}', loadedFull: 3, loadedEmpty: 0 }],
});

const ITEMS_CARGA = { items: [{ gasCylinderId: '{{gasPruebaId}}', loadedFull: 4, loadedEmpty: 0 }] };

// Camión listo para cada operación de la carga: depósito con stock propio y carga abierta en el
// vehículo que el chofer libre ya tiene asignado (no se le cambia el vehículo).
const conCarga = (extra = []) => [...S.camion('cargaDepId'), S.carga('cargaId', 'cargaDepId'), ...extra];
const DEVOLVER = paso('Limpiar · declarar la vuelta', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/return', { items: [{ gasCylinderId: '{{gasPruebaId}}', declaredFull: 3, declaredEmpty: 0 }] });
const DEVOLVER_4 = paso('Limpiar · declarar la vuelta', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/return', { items: [{ gasCylinderId: '{{gasPruebaId}}', declaredFull: 4, declaredEmpty: 0 }] });
const CERRAR = paso('Limpiar · cerrar la rendición', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/close', { differenceNote: 'Cierre de la prueba' });

const OPS = {
  'POST /api/auth/login': {
    ok: { email: '{{clienteEmail}}', password: '{{clientePassword}}' },
    malo: { email: 'no-es-un-email', password: '' },
    rol: 'customer',
    okStatus: [200],
    extras: [{ nombre: '401 · credenciales inválidas', status: 401, rol: 'customer', body: { email: '{{clienteEmail}}', password: 'ClaveIncorrecta99' }, tests: ['pm.test("el mensaje no revela si el email existe", () => pm.expect(pm.response.json().message).to.match(/email o la contraseña/));'] }],
  },
  'POST /api/auth/login/dashboard': {
    ok: { email: '{{adminEmail}}', password: '{{adminPassword}}' },
    malo: { email: 'no-es-un-email', password: '' },
    rol: 'admin',
    okStatus: [200],
    extras: [{ nombre: '401 · credenciales inválidas', status: 401, rol: 'admin', body: { email: '{{adminEmail}}', password: 'ClaveIncorrecta99' }, tests: ['pm.test("el mensaje no revela si el email existe", () => pm.expect(pm.response.json().message).to.match(/email o la contraseña/));'] }],
  },
  'POST /api/auth': {
    rol: 'admin',
    okStatus: [201],
    extras: [{ nombre: '401 · token inválido', status: 401, tokenInvalido: true, tests: ['pm.test("el mensaje pide volver a iniciar sesión", () => pm.expect(pm.response.json().message).to.match(/token es inválido/));'] }],
  },

  // ---- pedidos: cotización, historial de estados, ruta y pedido en curso del chofer
  'POST /api/orders/quote': {
    rol: 'customer',
    ok: { ...PEDIDO, paymentMethod: 'transfer' },
    malo: { items: [], paymentMethod: 'efectivo' },
    okStatus: [200],
    testsOk: ['const cot = pm.response.json();', 'pm.test("el total suma subtotal, recargo de zona y recargo de pago", () => pm.expect(cot.total).to.equal(cot.subtotal + cot.zoneSurcharge + cot.paymentSurcharge));', 'pm.test("el saldo es el total menos la seña", () => pm.expect(cot.balance).to.equal(cot.total - cot.deposit));'],
    extras: [
      { nombre: '200 · cotización del administrador', status: 200, rol: 'admin', body: PEDIDO },
      { nombre: '400 · la misma garrafa en dos renglones', status: 400, body: { ...PEDIDO, items: [PEDIDO.items[0], PEDIDO.items[0]] } },
      { nombre: '404 · garrafa inexistente', status: 404, body: { ...PEDIDO, items: [{ gasCylinderId: '{{idInexistente}}', quantity: 1, unitPrice: 100 }] } },
      { nombre: '404 · dirección inexistente', status: 404, body: { ...PEDIDO, addressId: '{{idInexistente}}' } },
      { nombre: '400 · super administrador sin X-Distributor', status: 400, rol: 'super_admin', sinDistribuidor: true, body: PEDIDO },
    ],
  },
  'GET /api/orders/{id}/status-history': {
    id: 'pedidoEntregadoId',
    testsOk: ['const hist = pm.response.json();', 'pm.test("el alta es la primera fila y no viene de ningún estado", () => { pm.expect(hist).to.be.an("array").that.is.not.empty; pm.expect(hist[0].fromStatus).to.equal(null); pm.expect(hist[0].toStatus).to.equal("pending"); });', 'pm.test("el pedido terminó entregado", () => pm.expect(hist[hist.length - 1].toStatus).to.equal("delivered"));'],
    extras: [
      { nombre: '400 · super administrador sin X-Distributor', status: 400, rol: 'super_admin', sinDistribuidor: true },
      { nombre: '404 · el cliente pide el historial de un pedido ajeno', status: 404, rol: 'customer', params: { id: '{{pedidoAjenoId}}' } },
      { nombre: '410 · el chofer ya no tiene el pedido', status: 410, rol: 'delivery', params: { id: '{{pedidoTmpId}}' }, pasos: [S.pedido('pedidoTmpId'), S.asignar('pedidoTmpId'), S.reasignar('pedidoTmpId')], tests: ['pm.test("avisa que ya no es suyo", () => pm.expect(pm.response.json().message).to.match(/ya no está asignado/));'] },
    ],
  },
  'GET /api/routes/driving': {
    rol: 'delivery',
    pasos: [...S.enCurso('pedidoTmpId'), paso('Preparar · posición del chofer', 'delivery', 'PATCH', 'orders/{{pedidoTmpId}}/location', { lat: '-27.3671', lng: '-55.8961' })],
    query: { orderId: '{{pedidoTmpId}}' },
    maloQuery: { orderId: 'no-es-uuid' },
    okStatus: [200, 502, 503],
    descripcionOk: 'Con un proveedor de rutas configurado responde 200 con la ruta. Si el proveedor no está configurado (503) o no responde (502), el caso lo acepta: el back no produce ninguno de los dos a pedido.',
    testsOk: ['if (pm.response.code === 200) {', '  const ruta = pm.response.json();', '  pm.test("trae distancia, duración y puntos", () => { pm.expect(ruta.distanceMeters).to.be.a("number"); pm.expect(ruta.durationSeconds).to.be.a("number"); pm.expect(ruta.points).to.be.an("array"); });', '}'],
    extras: [
      { nombre: '404 · pedido inexistente', status: 404, rol: 'delivery', query: { orderId: '{{idInexistente}}' } },
      { nombre: '404 · pedido de otro chofer', status: 404, rol: 'delivery', query: { orderId: '{{pedidoAjenoId}}' } },
      { nombre: '403 · pedido que ya no está en curso', status: 403, rol: 'delivery', query: { orderId: '{{pedidoEntregadoId}}' } },
    ],
  },
  'GET /api/orders/delivery/me/active': {
    rol: 'delivery',
    pasos: S.enCurso('pedidoTmpId'),
    okStatus: [200, 204],
    descripcionOk: 'El pedido en camino que el chofer lleva (o, sin ninguno, el aceptado más antiguo). Sin pedidos activos responde 204 sin cuerpo.',
    testsOk: ['if (pm.response.code === 200) {', '  const activo = pm.response.json();', '  pm.test("devuelve el pedido en camino que acaba de salir", () => pm.expect(activo.order_id).to.equal(pm.collectionVariables.get("pedidoTmpId")));', '}'],
  },
  'PATCH /api/orders/{id}/payment/register-cash': {
    pasos: S.entregado('pedidoTmpId'),
    id: 'pedidoTmpId',
    ok: { reason: 'Efectivo entregado en el local por el chofer' },
    malo: { reason: 'corto' },
    testsOk: ['pm.test("el pedido queda cobrado", () => pm.expect(pm.response.json().paymentStatus).to.equal("paid"));'],
    extras: [
      { nombre: '400 · el pedido todavía no se entregó', status: 400, pasos: [S.pedido('pedidoPendienteId')], params: { id: '{{pedidoPendienteId}}' }, body: { reason: 'Efectivo entregado en el local por el chofer' } },
      { nombre: '400 · super administrador sin X-Distributor', status: 400, rol: 'super_admin', sinDistribuidor: true, body: { reason: 'Efectivo entregado en el local por el chofer' } },
    ],
  },
  'PATCH /api/orders/{id}/payment/register-unpaid': {
    pasos: S.entregado('pedidoTmpId'),
    id: 'pedidoTmpId',
    ok: { reason: 'El cliente no tenía efectivo al recibirlo' },
    malo: { reason: 'corto' },
    limpiar: [paso('Limpiar · dar el impago por perdido', 'admin', 'PATCH', 'orders/{{pedidoTmpId}}/payment/resolve-unpaid', { resolution: 'written_off', note: 'Limpieza de la prueba' }, undefined, { tolerante: true })],
  },
  'PATCH /api/orders/{id}/payment/confirm-transfer': {
    pasos: S.transferencia('pedidoTmpId'),
    id: 'pedidoTmpId',
    ok: { received: true, reason: 'Transferencia verificada en el banco' },
    malo: { received: 'si', reason: 'x' },
    testsOk: ['pm.test("el pedido queda cobrado", () => pm.expect(pm.response.json().paymentStatus).to.equal("paid"));'],
    extras: [
      { nombre: '409 · la transferencia ya se confirmó', status: 409, body: { received: false, reason: 'Se marca como no recibida' } },
    ],
  },


  // ---- Manual: tocan cuentas (Firebase) o mandan mails; se corren a mano con usuarios descartables
  'POST /api/auth/registro': { rol: 'customer', ok: { email: 'qa.registro.{{unico}}@splg-test.com', password: 'Test1234', full_name: 'QA Registro', phone_number: '+54937{{$randomInt}}00000' }, malo: { email: 'no-es-un-email', password: '', full_name: 'x' } },
  'POST /api/users/customer-registration': { rol: 'customer', ok: { email: 'qa.cliente.{{unico}}@splg-test.com', password: 'Test1234', full_name: 'QA Cliente', phone_number: '+54938{{$randomInt}}00000' }, malo: { email: 'no-es-un-email', password: '', full_name: 'x' } },
  'POST /api/users': { ok: { email: 'qa.chofer.{{unico}}@splg-test.com', password: 'Test1234', full_name: 'QA Chofer', phone_number: '+54939{{$randomInt}}00000', rol: 'delivery', distributorId: '{{distribuidoraBaseId}}' }, malo: { email: 'no-es-un-email', rol: 'inexistente' } },
  'PATCH /api/users/{id}': { ok: { full_name: 'Nombre editado' }, malo: { full_name: 12345 } },
  'PATCH /api/users/{id}/block': { ok: { block: false }, malo: { block: 'si' } },
  'POST /api/admin': { ok: { user_id: '{{adminUserId}}' }, malo: { user_id: 'no-es-uuid' } },
  'POST /api/employees/{id}/account': { ok: { email: 'qa.empleado.{{unico}}@splg-test.com', password: 'Test1234' }, malo: { email: 'no-es-un-email', password: '1' } },
  'POST /api/employees/{id}/termination': { ok: { terminationDate: '2026-10-12', reason: 'resignation' }, malo: { reason: 'inexistente' } },
  'POST /api/employees/{id}/reinstatement': { ok: { hireDate: '2026-10-13' }, malo: { hireDate: 12345 } },
  'POST /api/email/password-reset': { ok: { email: 'qa.reset@splg-test.com' }, malo: { email: 'no-es-un-email' } },
  'POST /api/email/change-email': { ok: { currentEmail: 'qa.viejo@splg-test.com', newEmail: 'qa.nuevo@splg-test.com', idToken: '<idToken de Firebase del usuario>' }, malo: { currentEmail: 'x', newEmail: 'y', idToken: '' } },
  'POST /api/email/test': { ok: { email: 'qa.mail@splg-test.com' }, malo: { email: 'no-es-un-email' } },


  // ---- listados: un parámetro de query inválido responde 400
  'GET /api/users': { maloQuery: { limit: 'abc' } },
  'GET /api/claims/mine': { rol: 'customer', maloQuery: { limit: 'abc' } },
  'GET /api/user-address': { rol: 'super_admin', maloQuery: { limit: 'abc' } },
  'GET /api/admin': { maloQuery: { distributorId: 'no-es-uuid' } },
  'GET /api/customers': { maloQuery: { status: 'inexistente' } },
  'GET /api/delivery': { maloQuery: { status: 'inexistente' } },
  'GET /api/delivery/active': { maloQuery: { limit: 'abc' } },
  'GET /api/employees': { query: { documentStatus: 'expired' }, maloQuery: { documentStatus: 'inexistente' } },
  'GET /api/orders': { maloQuery: { status: 'inexistente' } },
  'GET /api/orders/available': { rol: 'delivery', maloQuery: { limit: 'abc' } },
  'GET /api/gascylinder': { maloQuery: { limit: 'abc' } },
  'GET /api/cylinders': { maloQuery: { state: 'inexistente' } },
  'GET /api/fleet/plans': { maloQuery: { subject: 'inexistente' } },
  'GET /api/fleet/tasks': { maloQuery: { status: 'inexistente' } },
  'GET /api/fleet/expirations': { maloQuery: { withinDays: 'abc' } },
  'GET /api/stock': { maloQuery: { warehouseId: 'no-es-uuid' } },
  'GET /api/stock/movements': { maloQuery: { reason: 'inexistente' } },
  'GET /api/stock/adjustments': { maloQuery: { reason: 'inexistente' } },
  'GET /api/truck-loads': { maloQuery: { status: 'inexistente' } },
  'GET /api/reports/sales-by-driver': { maloQuery: { from: 'no-es-fecha' } },
  'GET /api/reports/sales-by-product': { maloQuery: { from: 'no-es-fecha' } },
  'GET /api/reports/sales-by-payment': { maloQuery: { from: 'no-es-fecha' } },
  'GET /api/reports/sales-evolution': { maloQuery: { granularity: 'inexistente' } },
  'GET /api/reports/collections': { maloQuery: { from: 'no-es-fecha' } },
  'GET /api/audit': { maloQuery: { result: 'inexistente' } },
  'GET /api/audit/entries': { maloQuery: { actionType: 'abc' } },
  'GET /api/suppliers': { maloQuery: { kind: 'inexistente' } },
  'GET /api/purchase-orders': { maloQuery: { status: 'inexistente' } },
  'GET /api/purchase-receipts': { maloQuery: { status: 'inexistente' } },

  // ---- usuarios
  'GET /api/users/email/{email}': { params: { email: '{{clienteEmail}}' }, inexistente: { email: 'nadie.existe@splg-test.com' } },
  'GET /api/users/phone/{phoneNumber}': { params: { phoneNumber: '{{phoneNumber}}' }, no400: 'el teléfono es texto libre: el back no lo valida', no404: 'si no existe responde 200 vacío' },
  'POST /api/users/check-exists': { ok: { email: '{{clienteEmail}}' }, malo: { email: 'no-es-un-email' } },
  'GET /api/users/{id}': { params: { id: '{{clienteUserId}}' } },

  // ---- administradores
  'GET /api/admin/term/{term}': {
    params: { term: '{{adminEmail}}' },
    inexistente: { term: 'nadie.existe@splg-test.com' },
    paramsMalos: { term: 'x'.repeat(300) },
  },
  'GET /api/admin/{id}': { params: { id: '{{adminId}}' } },
  'PATCH /api/admin/{id}': { rol: 'super_admin', params: { id: '{{adminId}}' }, ok: { fullName: '{{adminFullName}}' }, malo: { fullName: 12345 } },

  // ---- roles
  'POST /api/role': { ok: { type: 'rol_prueba_api_{{unico}}' }, malo: { type: 12345 } },
  'POST /api/role/seed': {},
  'GET /api/role/{id}': {},
  'PATCH /api/role/{id}': {
    pasos: [paso('Preparar · rol', 'super_admin', 'POST', 'role', { type: 'rol_prueba_api_{{unico}}' }, { rolTmpId: ['role_id'] })],
    id: 'rolTmpId',
    ok: { type: 'rol_prueba_api_editado_{{unico}}' },
    malo: { type: 12345 },
  },
  'DELETE /api/role/{id}': { pasos: [paso('Preparar · rol', 'super_admin', 'POST', 'role', { type: 'rol_prueba_api_{{unico}}' }, { rolTmpId: ['role_id'] })], id: 'rolTmpId' },

  // ---- clientes
  'GET /api/customers/{id}': {},
  'PATCH /api/customers/{id}': { ok: { lat_lang: '-27.3671,-55.8961' }, malo: { lat_lang: 'no-son-coordenadas' } },
  'PATCH /api/customers/{id}/location': { ok: { latLng: '-27.3671,-55.8961' }, malo: { latLng: 'no-son-coordenadas' } },
  'GET /api/customers/user/{userId}': { params: { userId: '{{clienteUserId}}' } },

  // ---- choferes (los de escritura usan al chofer libre, no al del login)
  'GET /api/delivery/{id}': {},
  'GET /api/delivery/user/{userId}': { params: { userId: '{{deliveryUserId}}' } },
  'PATCH /api/delivery/{id}': { id: 'deliveryLibreId', ok: { validated: true }, malo: { validated: 'tal vez' } },
  'PATCH /api/delivery/{id}/validate': { id: 'deliveryLibreId' },
  'PATCH /api/delivery/{id}/invalidate': { id: 'deliveryLibreId', limpiar: [paso('Limpiar · volver a validar', 'admin', 'PATCH', 'delivery/{{deliveryLibreId}}/validate')] },
  'PATCH /api/delivery/{id}/location': { id: 'deliveryLibreId', ok: { latLng: '{{libreLatLng}}' }, malo: { latLng: 'no-son-coordenadas' } },
  'PATCH /api/delivery/{id}/balance': { id: 'deliveryLibreId', ok: { amount: 0 }, malo: { amount: 'mucho' } },
  'PATCH /api/delivery/{id}/status': { id: 'deliveryLibreId', ok: { isEnabled: true }, malo: { isEnabled: 'si' } },
  'PATCH /api/delivery/user/{userId}/availability': {
    params: { userId: '{{deliveryLibreUserId}}' },
    pasos: [paso('Preparar · validar al chofer', 'admin', 'PATCH', 'delivery/{{deliveryLibreId}}/validate')],
    ok: { available: false },
    malo: { available: 'si' },
  },
  'GET /api/delivery/{id}/vehicle': {},
  'PUT /api/delivery/{id}/vehicle': {
    id: 'deliveryLibreId',
    pasos: [S.auto('autoTmpId')],
    ok: { carId: '{{autoTmpId}}' },
    malo: { carId: 'no-es-uuid' },
    limpiar: [S.restaurarVehiculo()],
  },
  'DELETE /api/delivery/{id}/vehicle': { id: 'deliveryLibreId', pasos: [S.auto('autoTmpId'), S.vehiculoEnUso('autoTmpId')], limpiar: [S.restaurarVehiculo()] },

  // ---- distribuidoras (las de escritura sobre una propia: la sembrada no se toca)
  'POST /api/distributor': { ok: { name: 'Distribuidora Prueba API {{unico}}', slug: 'prueba-api-{{unico}}', email: 'prueba-api-{{unico}}@splg-test.com' }, malo: { name: 'x', slug: 'Slug Invalido' } },
  'GET /api/distributor/{id}': { id: 'distribuidoraBaseId' },
  'PATCH /api/distributor/{id}': {
    pasos: [paso('Preparar · distribuidora', 'super_admin', 'POST', 'distributor', { name: 'Distribuidora Prueba API {{unico}}', slug: 'prueba-api-{{unico}}' }, { distribuidoraTmpId: ['distributor_id'] })],
    id: 'distribuidoraTmpId',
    ok: { name: 'Distribuidora Prueba API editada {{unico}}' },
    malo: { name: 'x' },
  },
  'DELETE /api/distributor/{id}': {
    pasos: [paso('Preparar · distribuidora', 'super_admin', 'POST', 'distributor', { name: 'Distribuidora Prueba API {{unico}}', slug: 'prueba-api-{{unico}}' }, { distribuidoraTmpId: ['distributor_id'] })],
    id: 'distribuidoraTmpId',
  },

  // ---- puestos y legajos
  'POST /api/job-positions': { ok: { name: 'Puesto Prueba API {{unico}}', category: 'administration' }, malo: { name: 'x', category: 'inexistente' } },
  'PATCH /api/job-positions/{id}': { pasos: [S.puesto('puestoTmpId')], id: 'puestoTmpId', ok: { name: 'Puesto Prueba API editado {{unico}}' }, malo: { name: 12345 } },
  'DELETE /api/job-positions/{id}': { pasos: [S.puesto('puestoTmpId')], id: 'puestoTmpId' },
  'POST /api/employees': { ok: LEGAJO('positionAdminId'), malo: { firstName: '', documentType: 'inexistente' } },
  'GET /api/employees/{id}': {},
  'PATCH /api/employees/{id}': { pasos: [S.empleado('empleadoTmpId')], id: 'empleadoTmpId', ok: { notes: 'Legajo de prueba de la API (editado)' }, malo: { employmentType: 'inexistente' } },
  'DELETE /api/employees/{id}': { pasos: [S.empleado('empleadoTmpId')], id: 'empleadoTmpId' },

  // ---- vehículos
  'POST /api/car': { ok: { user_id: '{{deliveryLibreUserId}}', type_car: 'Camioneta', car_capacity: 20, car_patent: '{{patenteNueva}}', car_brand: 'Ford', car_model: 'Ranger', car_year: 2020, car_color: 'Blanco' }, malo: { user_id: 'no-es-uuid', car_year: 'dos mil' }, pre: PRE_CODIGOS },
  'GET /api/car/{id}': {},
  'PATCH /api/car/{id}': { pasos: [S.auto('autoTmpId')], id: 'autoTmpId', ok: { car_color: 'Azul' }, malo: { car_year: 'dos mil' } },
  'DELETE /api/car/{id}': { pasos: [S.auto('autoTmpId')], id: 'autoTmpId' },
  'GET /api/car/user/{userId}': { params: { userId: '{{deliveryUserId}}' }, no404: 'sin vehículos para ese usuario responde 200 con lista vacía' },
  'GET /api/car/patent/{patent}': { params: { patent: '{{patent}}' }, no400: 'la patente es texto libre: el back no la valida', no404: 'si no existe responde 200 vacío' },
  'GET /api/car/{id}/assignments': {},

  // ---- adjuntos (la carga y la descarga son Manual)
  'GET /api/attachments/{ownerType}/{ownerId}': { params: { ownerType: 'employee', ownerId: '{{employeeId}}' }, paramsMalos: { ownerType: 'inexistente' } },

  // ---- pedidos
  'POST /api/orders': { rol: 'customer', ok: PEDIDO, malo: { customerId: 'no-es-uuid', items: [], paymentMethod: 'efectivo' }, capture: { pedidoNuevoId: ['order_id'] } },
  'GET /api/orders/{id}': {
    testsOk: ['pm.test("trae quién canceló (cancelledBy)", () => pm.expect(pm.response.json()).to.have.property("cancelledBy"));'],
    extras: [{ nombre: '410 · el chofer ya no tiene el pedido', status: 410, rol: 'delivery', params: { id: '{{pedidoTmpId}}' }, pasos: [S.pedido('pedidoTmpId'), S.asignar('pedidoTmpId'), S.reasignar('pedidoTmpId')], tests: ['pm.test("la respuesta no trae datos del pedido", () => pm.expect(pm.response.json()).to.not.have.property("order_id"));'] }],
  },
  'GET /api/orders/customer/{customerId}': { params: { customerId: '{{clienteUserId}}' }, no404: 'sin pedidos para ese cliente responde 200 con lista vacía' },
  'GET /api/orders/delivery/{deliveryId}': { params: { deliveryId: '{{deliveryId}}' }, no404: 'sin pedidos para ese chofer responde 200 con lista vacía' },
  'GET /api/orders/{id}/delivery-code': { rol: 'delivery', pasos: S.enCurso('pedidoTmpId'), id: 'pedidoTmpId' },
  'GET /api/orders/{id}/driver-photo': { rol: 'customer', pasos: S.aceptado('pedidoTmpId'), id: 'pedidoTmpId' },
  'PATCH /api/orders/{id}': { pasos: [S.pedido('pedidoTmpId')], id: 'pedidoTmpId', ok: { notes: 'Pedido de prueba de la API (editado)' }, malo: { addressId: 'no-es-uuid' } },
  'DELETE /api/orders/{id}': { pasos: [S.pedido('pedidoTmpId')], id: 'pedidoTmpId', testsOk: ['pm.test("el pedido cancelado dice que lo canceló el administrador", () => pm.expect(pm.response.json().cancelledBy).to.equal("admin"));'] },
  'PATCH /api/orders/{id}/status': { rol: 'delivery', pasos: S.aceptado('pedidoTmpId'), id: 'pedidoTmpId', ok: { status: 'on_the_way' }, malo: { status: 'inexistente' } },
  'POST /api/orders/{id}/reject': { rol: 'delivery', pasos: [S.pedido('pedidoTmpId')], id: 'pedidoTmpId', no404: 'con un pedido que no existe responde 200 con {rejected:false} (no hay nada que rechazar)' },
  'POST /api/orders/{id}/confirm-delivery': { rol: 'customer', pasos: [...S.enCurso('pedidoTmpId'), S.codigo('pedidoTmpId')], id: 'pedidoTmpId', ok: { code: '{{codigoEntrega}}' }, malo: { code: '' } },
  'PATCH /api/orders/{id}/payment/cash-received': { rol: 'delivery', pasos: S.entregado('pedidoTmpId'), id: 'pedidoTmpId' },
  'PATCH /api/orders/{id}/payment/unpaid': { rol: 'delivery', pasos: S.entregado('pedidoTmpId'), id: 'pedidoTmpId', ok: { note: 'El cliente no tenia efectivo' }, malo: { note: 12345 }, limpiar: [paso('Limpiar · dar el impago por perdido', 'admin', 'PATCH', 'orders/{{pedidoTmpId}}/payment/resolve-unpaid', { resolution: 'written_off', note: 'Limpieza de la prueba' }, undefined, { tolerante: true })] },
  'PATCH /api/orders/{id}/payment/resolve-unpaid': { pasos: [...S.entregado('pedidoTmpId'), S.impago('pedidoTmpId')], id: 'pedidoTmpId', ok: { resolution: 'paid', note: 'Cobrado en el local' }, malo: { resolution: 'inexistente' } },
  'PATCH /api/orders/{id}/assign/{deliveryId}': { pasos: [S.pedido('pedidoTmpId')], id: 'pedidoTmpId', params: { deliveryId: '{{deliveryId}}' } },
  'PATCH /api/orders/{id}/location': { rol: 'delivery', pasos: S.aceptado('pedidoTmpId'), id: 'pedidoTmpId', ok: { lat: '-27.3671', lng: '-55.8961' }, malo: { lat: 'x', lng: 'y' } },
  'PATCH /api/orders/{id}/cancel': { rol: 'customer', pasos: [S.pedido('pedidoTmpId')], id: 'pedidoTmpId', ok: { reason: 'Cambie de opinion' }, malo: { reason: 'x'.repeat(600) }, testsOk: ['pm.test("el pedido cancelado dice que lo canceló el cliente", () => pm.expect(pm.response.json().cancelledBy).to.equal("customer"));'], extras: [{ nombre: '400 · super administrador sin X-Distributor', status: 400, rol: 'super_admin', sinDistribuidor: true, body: { reason: 'Cambie de opinion' } }] },
  'PATCH /api/orders/{id}/arrived': { pasos: S.enCurso('pedidoTmpId'), id: 'pedidoTmpId' },
  'PATCH /api/orders/{id}/confirm-deposit': {
    pasos: [paso('Preparar · reserva con seña', 'customer', 'POST', 'orders', { ...PEDIDO, scheduledDate: '2026-12-20', timeSlotId: '{{timeSlotId}}', isReservation: true, depositAmount: 3000 }, { pedidoTmpId: ['order_id'] })],
    id: 'pedidoTmpId',
  },

  // ---- garrafas
  'POST /api/gascylinder': { ok: { type: 'Garrafa Prueba API {{unico}}', weight: 10, price: 8500, description: 'Producto de la prueba de la API' }, malo: { type: '', weight: 'diez', price: -1 } },
  'GET /api/gascylinder/{id}': {},
  'GET /api/gascylinder/type/{type}': { params: { type: '{{type}}' }, no400: 'el tipo es texto libre: el back no lo valida' },
  'PATCH /api/gascylinder/{id}': { pasos: [paso('Preparar · garrafa', 'admin', 'POST', 'gascylinder', { type: 'Garrafa Prueba API {{unico}}', weight: 10, price: 8500 }, { garrafaTmpId: ['gas_cylinder_id'] })], id: 'garrafaTmpId', ok: { price: 9000 }, malo: { price: -5 } },
  'DELETE /api/gascylinder/{id}': { pasos: [paso('Preparar · garrafa', 'admin', 'POST', 'gascylinder', { type: 'Garrafa Prueba API {{unico}}', weight: 10, price: 8500 }, { garrafaTmpId: ['gas_cylinder_id'] })], id: 'garrafaTmpId' },
  'PATCH /api/gascylinder/{id}/stock': { pasos: [paso('Preparar · garrafa', 'admin', 'POST', 'gascylinder', { type: 'Garrafa Prueba API {{unico}}', weight: 10, price: 8500 }, { garrafaTmpId: ['gas_cylinder_id'] })], id: 'garrafaTmpId', ok: { quantity: 5 }, malo: { quantity: 'muchas' } },

  // ---- direcciones (las administra el dueño: el cliente)
  'POST /api/user-address': { rol: 'customer', ok: { user_id: '{{clienteUserId}}', street: 'Calle Prueba API 742', city: 'Posadas', postalCode: '3300', latitude: '-27.3671', longitude: '-55.8961' }, malo: { user_id: 'no-es-uuid', street: 12345 } },
  'GET /api/user-address/{id}': {},
  'GET /api/user-address/user/{userId}': { params: { userId: '{{clienteUserId}}' } },
  'GET /api/user-address/user/{userId}/default': { params: { userId: '{{clienteUserId}}' } },
  'PATCH /api/user-address/{id}': { rol: 'customer', pasos: [paso('Preparar · dirección', 'customer', 'POST', 'user-address', { user_id: '{{clienteUserId}}', street: 'Calle Prueba API 123', city: 'Posadas', latitude: '-27.3671', longitude: '-55.8961' }, { direccionTmpId: ['address_id'] })], id: 'direccionTmpId', ok: { street: 'Calle Prueba API 456' }, malo: { street: 12345 } },
  'PATCH /api/user-address/{id}/set-default': { rol: 'customer', pasos: [paso('Preparar · dirección', 'customer', 'POST', 'user-address', { user_id: '{{clienteUserId}}', street: 'Calle Prueba API 123', city: 'Posadas', latitude: '-27.3671', longitude: '-55.8961' }, { direccionTmpId: ['address_id'] })], id: 'direccionTmpId' },
  'DELETE /api/user-address/{id}': { rol: 'customer', pasos: [paso('Preparar · dirección', 'customer', 'POST', 'user-address', { user_id: '{{clienteUserId}}', street: 'Calle Prueba API 123', city: 'Posadas', latitude: '-27.3671', longitude: '-55.8961' }, { direccionTmpId: ['address_id'] })], id: 'direccionTmpId' },

  // ---- notificaciones
  'POST /api/notifications/send-test': { ok: { token: 'token-de-prueba-api', title: 'Prueba', body: 'Notificación de prueba de la API' }, malo: { token: '', title: '' } },
  'POST /api/notifications/order-confirmation': { ok: { customerId: '{{clienteUserId}}', orderId: '{{orderId}}' }, malo: { customerId: 'no-es-uuid', orderId: 'no-es-uuid' } },
  'GET /api/notifications/user/{userId}': { rol: 'customer', params: { userId: '{{clienteUserId}}' }, no404: 'el back responde 403 si el userId no es el del token, exista o no' },
  'POST /api/notifications/token': { rol: 'customer', ok: { userId: '{{clienteUserId}}', token: 'token-de-prueba-api-{{unico}}', platform: 'android' }, malo: { userId: 'no-es-uuid', token: '', platform: 'otra' } },

  // ---- franjas
  'POST /api/time-slot': { ok: { name: 'Franja Prueba API {{unico}}', startTime: '14:00', endTime: '18:00', capacity: 30 }, malo: { name: '', startTime: '25:99', endTime: 5 } },
  'PATCH /api/time-slot/{id}': { pasos: [paso('Preparar · franja', 'admin', 'POST', 'time-slot', { name: 'Franja Prueba API {{unico}}', startTime: '14:00', endTime: '18:00' }, { franjaTmpId: ['time_slot_id'] })], id: 'franjaTmpId', ok: { capacity: 40 }, malo: { capacity: 'muchos' } },
  'DELETE /api/time-slot/{id}': { pasos: [paso('Preparar · franja', 'admin', 'POST', 'time-slot', { name: 'Franja Prueba API {{unico}}', startTime: '14:00', endTime: '18:00' }, { franjaTmpId: ['time_slot_id'] })], id: 'franjaTmpId' },
  'GET /api/time-slot/{id}': {},

  // ---- envases
  'POST /api/cylinders': { ok: { serial: '{{serialNuevo}}', gasCylinderId: '{{gasPruebaId}}', deposit: 5000 }, malo: { serial: '', gasCylinderId: 'no-es-uuid' }, pre: PRE_CODIGOS },
  'POST /api/cylinders/assign': {
    pasos: [S.cilindro('cilindroTmpId'), paso('Preparar · llenar el envase', 'admin', 'PATCH', 'cylinders/{{cilindroTmpId}}/transition', { toState: 'filled' }, { serialTmp: ['serial'] }), ...S.aceptado('pedidoTmpId')],
    ok: { orderId: '{{pedidoTmpId}}', serials: ['{{serialTmp}}'] },
    malo: { orderId: 'no-es-uuid', serials: [] },
  },
  'GET /api/cylinders/{id}': {},
  'GET /api/cylinders/{id}/history': {},
  'PATCH /api/cylinders/{id}': { pasos: [S.cilindro('cilindroTmpId')], id: 'cilindroTmpId', ok: { deposit: 6000 }, malo: { deposit: -1 } },
  'PATCH /api/cylinders/{id}/retire': { pasos: [S.cilindro('cilindroTmpId')], id: 'cilindroTmpId', ok: { reason: 'Fin de vida util' }, malo: { reason: 12345 } },
  'PATCH /api/cylinders/{id}/transition': { pasos: [S.cilindro('cilindroTmpId')], id: 'cilindroTmpId', ok: { toState: 'filled' }, malo: { toState: 'inexistente' } },

  // ---- zonas
  'POST /api/coverage-zones': { ok: { name: 'Zona Prueba API {{unico}}', polygon: [[-55.9, -27.36], [-55.88, -27.36], [-55.88, -27.38], [-55.9, -27.36]], surchargeType: 'percentage', surchargeValue: 10 }, malo: { name: '', polygon: 'no-es-un-poligono' } },
  'GET /api/coverage-zones/{id}': {},
  'PATCH /api/coverage-zones/{id}': { pasos: [paso('Preparar · zona', 'admin', 'POST', 'coverage-zones', { name: 'Zona Prueba API {{unico}}', polygon: [[-55.9, -27.36], [-55.88, -27.36], [-55.88, -27.38], [-55.9, -27.36]] }, { zonaTmpId: ['coverage_zone_id'] })], id: 'zonaTmpId', ok: { label: 'Zona Prueba API editada' }, malo: { color: 'rojo' } },
  'DELETE /api/coverage-zones/{id}': { pasos: [paso('Preparar · zona', 'admin', 'POST', 'coverage-zones', { name: 'Zona Prueba API {{unico}}', polygon: [[-55.9, -27.36], [-55.88, -27.36], [-55.88, -27.38], [-55.9, -27.36]] }, { zonaTmpId: ['coverage_zone_id'] })], id: 'zonaTmpId' },

  // ---- flota
  'POST /api/fleet/plans': { ok: PLAN, malo: { name: 'x', subject: 'inexistente' } },
  'GET /api/fleet/plans/{id}': {},
  'PATCH /api/fleet/plans/{id}': { pasos: [S.plan('planTmpId')], id: 'planTmpId', ok: { leadTimeDays: 30 }, malo: { leadTimeDays: 'mucho' } },
  'POST /api/fleet/tasks': { pasos: [S.plan('planTmpId')], ok: { planId: '{{planTmpId}}', carId: '{{carId}}', dueAt: '2026-12-01' }, malo: { planId: 'no-es-uuid' } },
  'GET /api/fleet/tasks/{id}': {},
  'GET /api/fleet/tasks/{id}/attachments': {},
  'PATCH /api/fleet/tasks/{id}': { pasos: [S.plan('planTmpId'), S.tarea('tareaTmpId', 'planTmpId')], id: 'tareaTmpId', ok: { notes: 'Tarea de prueba de la API (editada)' }, malo: { dueKm: 'lejos' } },
  'PATCH /api/fleet/tasks/{id}/close': { pasos: [S.plan('planTmpId'), S.tarea('tareaTmpId', 'planTmpId')], id: 'tareaTmpId', ok: { performedAt: '2026-10-12T15:00:00.000Z', cost: 1500 }, malo: { performedAt: 'ayer' } },
  'PATCH /api/fleet/tasks/{id}/cancel': { pasos: [S.plan('planTmpId'), S.tarea('tareaTmpId', 'planTmpId')], id: 'tareaTmpId', ok: { notes: 'Ya no hace falta' }, malo: { notes: 12345 } },
  'GET /api/cars/{carId}/documents': { params: { carId: '{{carId}}' } },
  'GET /api/delivery/{id}/documents': {},
  'GET /api/delivery/{id}/vehicle-history': {},

  // ---- depósitos y stock
  'POST /api/warehouses': { ok: { name: 'Depósito Prueba API {{unico}}', code: '{{codigoNuevo}}' }, malo: { name: '', code: '' }, pre: PRE_CODIGOS },
  'GET /api/warehouses/{id}': {},
  'PATCH /api/warehouses/{id}': { pasos: [S.deposito('depositoTmpId')], id: 'depositoTmpId', ok: { name: 'Depósito Prueba API editado {{unico}}' }, malo: { name: '' } },
  'DELETE /api/warehouses/{id}': { pasos: [S.deposito('depositoTmpId')], id: 'depositoTmpId' },
  'POST /api/stock/initial-counts': { pasos: [S.deposito('depositoTmpId')], ok: { warehouseId: '{{depositoTmpId}}', items: [{ gasCylinderId: '{{gasPruebaId}}', full: 30, empty: 5 }] }, malo: { warehouseId: 'no-es-uuid', items: [] } },
  'POST /api/stock/adjustments': { pasos: [S.deposito('depositoTmpId'), S.conteo('depositoTmpId')], ok: { location: { warehouseId: '{{depositoTmpId}}' }, reason: 'lost', notes: 'Merma de prueba', items: [{ gasCylinderId: '{{gasPruebaId}}', condition: 'full', quantityDelta: -1 }] }, malo: { location: 'x', reason: 'inexistente' } },
  'GET /api/stock/adjustments/{id}': { pasos: [S.deposito('depositoTmpId'), S.conteo('depositoTmpId', { ajusteTmpId: ['adjustmentId'] })], id: 'ajusteTmpId' },
  'POST /api/stock/transfers': { pasos: [S.deposito('depositoTmpId'), S.conteo('depositoTmpId'), S.deposito('depositoDestinoId')], ok: { from: { warehouseId: '{{depositoTmpId}}' }, to: { warehouseId: '{{depositoDestinoId}}' }, items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 2 }], notes: 'Transferencia de prueba' }, malo: { from: 'x', items: [] } },
  'POST /api/stock/movements/batches/{batchId}/reverse': {
    pasos: [S.deposito('depositoTmpId'), S.conteo('depositoTmpId'), S.deposito('depositoDestinoId'), paso('Preparar · transferencia', 'admin', 'POST', 'stock/transfers', { from: { warehouseId: '{{depositoTmpId}}' }, to: { warehouseId: '{{depositoDestinoId}}' }, items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 2 }] }, { batchId: ['batchId'] })],
    ok: { notes: 'Transferencia cargada por error' },
    malo: { notes: 12345 },
  },
  'PUT /api/stock/thresholds': { pasos: [S.deposito('depositoTmpId')], ok: { thresholds: [{ warehouseId: '{{depositoTmpId}}', gasCylinderId: '{{gasPruebaId}}', minFull: 3 }] }, malo: { thresholds: [] } },
  'POST /api/stock/reconciliation/reapply-deliveries': { okStatus: [201] },
  'POST /api/stock/reconciliation/adjustments': { pasos: [paso('Preparar · garrafa sin movimientos', 'admin', 'POST', 'gascylinder', { type: 'Garrafa Prueba API {{unico}}', weight: 10, price: 100 }, { garrafaTmpId: ['gas_cylinder_id'] })], sinExito: 'el 201 sólo existe con el vendible desalineado del físico, y ninguna operación de la API lo produce (ajustes, pedidos y entregas mantienen la invariante)', ok: { gasCylinderId: '{{garrafaTmpId}}', notes: 'Conciliacion de prueba' }, malo: { gasCylinderId: 'no-es-uuid', notes: '' } },

  // ---- cargas de camión
  'PUT /api/truck-loads/settings': { ok: { requireOpenTruckLoad: false }, malo: { requireOpenTruckLoad: 'si' } },
  'GET /api/truck-loads/cars/{carId}/stock': { params: { carId: '{{carId}}' } },
  'POST /api/truck-loads': { pasos: S.camion('cargaDepId'), ok: CARGA('cargaDepId'), malo: { carId: 'no-es-uuid', deliveryId: 'no-es-uuid' } },
  'GET /api/truck-loads/{id}': {},
  'PUT /api/truck-loads/{id}/items': { pasos: conCarga(), id: 'cargaId', ok: ITEMS_CARGA, malo: { items: 'x' } },
  'PATCH /api/truck-loads/{id}/depart': { pasos: conCarga(), id: 'cargaId', limpiar: [DEVOLVER, CERRAR] },
  'PATCH /api/truck-loads/{id}/reload': { pasos: conCarga([paso('Preparar · salida del camión', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/depart')]), id: 'cargaId', ok: { items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 1 }] }, malo: { items: 'x' }, limpiar: [DEVOLVER_4, CERRAR] },
  'PATCH /api/truck-loads/{id}/return': { pasos: conCarga([paso('Preparar · salida del camión', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/depart')]), id: 'cargaId', ok: { items: [{ gasCylinderId: '{{gasPruebaId}}', declaredFull: 3, declaredEmpty: 0 }] }, malo: { items: 'x' }, limpiar: [CERRAR] },
  'PATCH /api/truck-loads/{id}/close': {
    pasos: conCarga([paso('Preparar · salida del camión', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/depart'), paso('Preparar · vuelta del camión', 'admin', 'PATCH', 'truck-loads/{{cargaId}}/return', { items: [{ gasCylinderId: '{{gasPruebaId}}', declaredFull: 3, declaredEmpty: 0 }] })]),
    id: 'cargaId',
    ok: { differenceNote: 'Sin diferencias' },
    malo: { differenceNote: 12345 },
  },
  'PATCH /api/truck-loads/{id}/cancel': { pasos: conCarga(), id: 'cargaId', ok: { reason: 'Cambio de ruta' }, malo: { reason: 12345 } },

  // ---- reclamos
  'POST /api/claims': { rol: 'customer', ok: { orderId: '{{pedidoEntregadoId}}', customerId: '{{clienteUserId}}', reason: 'Carga incompleta', description: 'La garrafa llego con menos gas' }, malo: { orderId: 'no-es-uuid', customerId: 'no-es-uuid', reason: '' } },
  'GET /api/claims/{id}': {},
  'PATCH /api/claims/{id}': { pasos: [S.reclamo('reclamoTmpId', 'pedidoEntregadoId')], id: 'reclamoTmpId', ok: { reason: 'Carga incompleta', description: 'Faltaba gas en la garrafa' }, malo: { reason: 12345 } },
  'PATCH /api/claims/{id}/take': { pasos: [S.reclamo('reclamoTmpId', 'pedidoEntregadoId')], id: 'reclamoTmpId' },
  'PATCH /api/claims/{id}/resolve': { pasos: [S.reclamo('reclamoTmpId', 'pedidoEntregadoId'), paso('Preparar · tomar el reclamo', 'admin', 'PATCH', 'claims/{{reclamoTmpId}}/take')], id: 'reclamoTmpId', ok: { resolution: 'Se repuso la garrafa', status: 'resolved' }, malo: { status: 'inexistente' } },
  'PATCH /api/claims/{id}/reopen': { pasos: [S.reclamo('reclamoTmpId', 'pedidoEntregadoId'), paso('Preparar · tomar el reclamo', 'admin', 'PATCH', 'claims/{{reclamoTmpId}}/take'), paso('Preparar · resolver el reclamo', 'admin', 'PATCH', 'claims/{{reclamoTmpId}}/resolve', { resolution: 'Se repuso la garrafa', status: 'resolved' })], id: 'reclamoTmpId', ok: { reason: 'El cliente sigue sin gas' }, malo: { reason: 12345 } },

  // ---- calificaciones
  'POST /api/ratings': { rol: 'customer', pasos: S.entregado('pedidoTmpId'), ok: { orderId: '{{pedidoTmpId}}', stars: 5, comment: 'Entrega puntual' }, malo: { orderId: 'no-es-uuid', stars: 99 } },
  'GET /api/ratings/user/{userId}/summary': { params: { userId: '{{deliveryUserId}}' }, no404: 'sin calificaciones responde 200 con promedio 0' },
  'GET /api/ratings/user/{userId}': { params: { userId: '{{deliveryUserId}}' }, no404: 'sin calificaciones responde 200 con lista vacía' },
  'GET /api/ratings/{id}': { id: 'calificacionCompId' },
  'PATCH /api/ratings/{id}/hide': { id: 'calificacionCompId', ok: { reason: 'Contenido ofensivo' }, malo: { reason: 12345 }, limpiar: [paso('Limpiar · volver a mostrarla', 'admin', 'PATCH', 'ratings/{{calificacionCompId}}/unhide', { reason: 'Revisado, es correcto' }, undefined, { tolerante: true })] },
  'PATCH /api/ratings/{id}/unhide': { pasos: [paso('Preparar · ocultar', 'admin', 'PATCH', 'ratings/{{calificacionCompId}}/hide', { reason: 'Contenido ofensivo' }, undefined, { tolerante: true })], id: 'calificacionCompId', ok: { reason: 'Revisado, es correcto' }, malo: { reason: 12345 } },

  // ---- incidencias
  'POST /api/incidents': { rol: 'delivery', pasos: S.enCurso('pedidoTmpId'), ok: { orderId: '{{pedidoTmpId}}', type: 'no_show', description: 'Cliente ausente en el domicilio' }, malo: { orderId: 'no-es-uuid', type: 'inexistente' } },
  'GET /api/incidents/order/{orderId}': { params: { orderId: '{{orderId}}' } },
  'GET /api/incidents/{id}': {},
  'PATCH /api/incidents/{id}': { pasos: [...S.enCurso('pedidoTmpId'), S.incidencia('incidenciaTmpId', 'pedidoTmpId')], id: 'incidenciaTmpId', ok: { description: 'Cliente ausente, se reprograma' }, malo: { type: 'inexistente' } },
  'PATCH /api/incidents/{id}/resolve': { pasos: [...S.enCurso('pedidoTmpId'), S.incidencia('incidenciaTmpId', 'pedidoTmpId')], id: 'incidenciaTmpId', ok: { resolutionNote: 'Se reprogramo la entrega', status: 'resolved' }, malo: { status: 'inexistente' } },

  // ---- auditoría
  'GET /api/audit/entries/{id}': { id: 'auditEntryId' },

  // ---- compras
  'POST /api/suppliers': { ok: { businessName: 'Proveedor Prueba API {{unico}}', cuit: '{{cuitNuevo}}', kind: 'filling_plant', contactName: 'Marta Gomez', paymentTermsDays: 30 }, malo: { businessName: '', cuit: '123', kind: 'inexistente' }, pre: PRE_CUIT },
  'GET /api/suppliers/{id}': {},
  'GET /api/suppliers/{id}/purchase-history': {},
  'PATCH /api/suppliers/{id}': { pasos: [S.proveedor('proveedorTmpId')], id: 'proveedorTmpId', ok: { contactName: 'Marta Gomez' }, malo: { cuit: '123' } },
  'DELETE /api/suppliers/{id}': { pasos: [S.proveedor('proveedorTmpId')], id: 'proveedorTmpId' },
  'POST /api/purchase-orders': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId')], ok: { supplierId: '{{proveedorTmpId}}', destinationWarehouseId: '{{depositoTmpId}}', items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 5, unitCost: 7000 }] }, malo: { supplierId: 'no-es-uuid', items: [] } },
  'GET /api/purchase-orders/{id}': {},
  'GET /api/purchase-orders/{id}/pending': {},
  'PATCH /api/purchase-orders/{id}': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId')], id: 'ordenTmpId', ok: { notes: 'Orden de prueba de la API (editada)' }, malo: { supplierId: 'no-es-uuid' } },
  'PATCH /api/purchase-orders/{id}/send': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId')], id: 'ordenTmpId' },
  'PATCH /api/purchase-orders/{id}/cancel': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId')], id: 'ordenTmpId', ok: { reason: 'Ya no se necesita' }, malo: { reason: 12345 } },
  'PATCH /api/purchase-orders/{id}/close-short': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId'), S.enviarOrden('ordenTmpId'), S.recepcion('recepcionTmpId', 'ordenTmpId')], id: 'ordenTmpId', ok: { reason: 'La planta no tiene mas' }, malo: { reason: 12345 } },
  'POST /api/purchase-receipts': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId'), S.enviarOrden('ordenTmpId')], ok: { purchaseOrderId: '{{ordenTmpId}}', supplierDocumentType: 'invoice', supplierDocumentNumber: 'F-{{unico}}', items: [{ gasCylinderId: '{{gasPruebaId}}', quantityFull: 2 }] }, malo: { supplierDocumentType: 'inexistente', items: 'x' } },
  'GET /api/purchase-receipts/{id}': {},
  'PATCH /api/purchase-receipts/{id}/void': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId'), S.enviarOrden('ordenTmpId'), S.recepcion('recepcionTmpId', 'ordenTmpId')], id: 'recepcionTmpId', ok: { reason: 'Error de carga' }, malo: { reason: 12345 } },
  'PATCH /api/purchase-receipts/{id}/payment-status': { pasos: [S.proveedor('proveedorTmpId'), S.deposito('depositoTmpId'), S.orden('ordenTmpId', 'proveedorTmpId', 'depositoTmpId'), S.enviarOrden('ordenTmpId'), S.recepcion('recepcionTmpId', 'ordenTmpId')], id: 'recepcionTmpId', ok: { paymentStatus: 'paid' }, malo: { paymentStatus: 'inexistente' }, limpiar: [paso('Limpiar · volver a dejarla impaga', 'admin', 'PATCH', 'purchase-receipts/{{recepcionTmpId}}/payment-status', { paymentStatus: 'unpaid' })] },
};


const Z = '{{idInexistente}}';

// Casos de acceso ajeno (403 por dueño) y de referencia inexistente en el cuerpo (404).
const EXTRAS = {
  'GET /api/users/{id}': { ajeno: { rol: 'customer', params: { id: '{{choferUserId}}' } } },
  'GET /api/users/email/{email}': { ajeno: { rol: 'customer', params: { email: '{{choferEmail}}' } } },
  'GET /api/customers/{id}': { ajeno: { rol: 'customer', params: { id: '{{otroCustomerId}}' } } },
  'PATCH /api/customers/{id}': { ajeno: { rol: 'customer', params: { id: '{{otroCustomerId}}' } } },
  'PATCH /api/customers/{id}/location': { ajeno: { rol: 'customer', params: { id: '{{otroCustomerId}}' } } },
  'GET /api/customers/user/{userId}': { ajeno: { rol: 'customer', params: { userId: '{{otroClienteUserId}}' } } },
  'GET /api/user-address/{id}': { ajeno: { rol: 'customer', params: { id: '{{otraDireccionId}}' } } },
  'GET /api/user-address/user/{userId}': { ajeno: { rol: 'customer', params: { userId: '{{otroClienteUserId}}' } } },
  'GET /api/user-address/user/{userId}/default': { ajeno: { rol: 'customer', params: { userId: '{{otroClienteUserId}}' } } },
  'PATCH /api/user-address/{id}': { ajeno: { rol: 'customer', params: { id: '{{otraDireccionId}}' } } },
  'PATCH /api/user-address/{id}/set-default': { ajeno: { rol: 'customer', params: { id: '{{otraDireccionId}}' } } },
  'DELETE /api/user-address/{id}': { ajeno: { rol: 'customer', params: { id: '{{otraDireccionId}}' } } },
  'GET /api/orders/customer/{customerId}': { ajeno: { rol: 'customer', params: { customerId: '{{otroClienteUserId}}' } } },
  'GET /api/notifications/user/{userId}': { ajeno: { rol: 'customer', params: { userId: '{{otroClienteUserId}}' } } },
  'POST /api/orders': { ajeno: { rol: 'customer', body: { ...PEDIDO, customerId: '{{otroClienteUserId}}' } }, body404: [{ nombre: 'dirección inexistente', body: { ...PEDIDO, addressId: Z } }, { nombre: 'garrafa inexistente', body: { ...PEDIDO, items: [{ gasCylinderId: Z, quantity: 1, unitPrice: 100 }] } }] },
  'POST /api/ratings': { ajeno: { rol: 'customer', body: { orderId: '{{pedidoAjenoId}}', stars: 5 } }, body404: [{ nombre: 'pedido inexistente', body: { orderId: Z, stars: 5 } }] },
  'POST /api/orders/{id}/confirm-delivery': { ajeno: { rol: 'customer', params: { id: '{{pedidoAjenoId}}' }, body: { code: 'ABC123' } } },
  'POST /api/claims': { body404: [{ nombre: 'pedido inexistente', body: { orderId: Z, customerId: '{{clienteUserId}}', reason: 'Carga incompleta', description: 'x' } }] },
  'POST /api/incidents': { body404: [{ nombre: 'pedido inexistente', body: { orderId: Z, type: 'no_show', description: 'x' } }] },
  'POST /api/car': { body404: [{ nombre: 'chofer inexistente', body: { user_id: Z, car_patent: 'ZZ1234' } }] },
  'POST /api/fleet/tasks': { body404: [{ nombre: 'plan inexistente', body: { planId: Z, carId: '{{carId}}', dueAt: '2026-12-01' } }] },
  'POST /api/truck-loads': { body404: [{ nombre: 'vehículo inexistente', body: { carId: Z, deliveryId: '{{deliveryLibreId}}', items: [{ gasCylinderId: '{{gasPruebaId}}', loadedFull: 1 }] } }] },
  'POST /api/purchase-orders': { body404: [{ nombre: 'proveedor inexistente', body: { supplierId: Z, items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 1, unitCost: 100 }] } }] },
  'POST /api/purchase-receipts': { body404: [{ nombre: 'orden de compra inexistente', body: { purchaseOrderId: Z, supplierDocumentType: 'invoice', supplierDocumentNumber: 'F-1', items: [{ gasCylinderId: '{{gasPruebaId}}', quantityFull: 1 }] } }] },
  'POST /api/stock/transfers': { body404: [{ nombre: 'depósito inexistente', body: { from: { warehouseId: Z }, to: { warehouseId: Z }, items: [{ gasCylinderId: '{{gasPruebaId}}', quantity: 1 }] } }] },
  'POST /api/stock/initial-counts': { body404: [{ nombre: 'depósito inexistente', body: { warehouseId: Z, items: [{ gasCylinderId: '{{gasPruebaId}}', full: 1 }] } }] },
  'POST /api/stock/adjustments': { body404: [{ nombre: 'depósito inexistente', body: { location: { warehouseId: Z }, reason: 'lost', notes: 'x', items: [{ gasCylinderId: '{{gasPruebaId}}', condition: 'full', quantityDelta: -1 }] } }] },
  'POST /api/cylinders/assign': { body404: [{ nombre: 'pedido inexistente', body: { orderId: Z, serials: ['SERIAL-X'] } }] },
  'POST /api/cylinders': { body404: [{ nombre: 'garrafa inexistente', body: { serial: '{{serialNuevo}}', gasCylinderId: Z } }] },
  'POST /api/employees': { body404: [{ nombre: 'puesto inexistente', body: { ...LEGAJO('idInexistente') } }] },
  'PUT /api/delivery/{id}/vehicle': { body404: [{ nombre: 'vehículo inexistente', body: { carId: Z } }] },
  'PUT /api/stock/thresholds': { body404: [{ nombre: 'depósito inexistente', body: { thresholds: [{ warehouseId: Z, gasCylinderId: '{{gasPruebaId}}', minFull: 1 }] } }] },
};
for (const [clave, extra] of Object.entries(EXTRAS)) OPS[clave] = { ...(OPS[clave] || {}), ...extra };

// Datos que arma la colección antes de las pruebas: un producto propio (el stock de la demo no
// se toca; las entregas descuentan del camión del chofer, así la conciliación no queda con
// entregas sin movimiento) y un pedido entregado con su calificación, que comparten reclamos, calificaciones,
// historial y ruta. Un pedido entregado no se puede cancelar: por eso se arma uno solo.
const DATOS_DE_PRUEBA = [
  paso('Producto propio de la prueba', 'admin', 'POST', 'gascylinder', { type: 'Prueba API garrafa {{unico}}', weight: 10, price: 100, description: 'Producto de prueba de la API: aísla el stock de la demo' }, { gasPruebaId: ['gas_cylinder_id'] }),
  paso('Stock del producto propio en el camión del chofer', 'admin', 'POST', 'stock/adjustments', { location: { carId: '{{choferCarId}}' }, reason: 'found', notes: 'Stock de la prueba de la API: la entrega descuenta del camión', items: [{ gasCylinderId: '{{gasPruebaId}}', condition: 'full', quantityDelta: 60 }] }),
  ...S.entregado('pedidoEntregadoId'),
  S.calificacion('calificacionCompId', 'pedidoEntregadoId'),
];

// Al final de la corrida: el pedido de prueba queda cobrado, la calificación se oculta (no cuenta en el promedio del
// chofer) y el producto propio se da de baja.
const RESTAURACION = [
  paso('Dejar cobrado el pedido entregado de prueba', 'delivery', 'PATCH', 'orders/{{pedidoEntregadoId}}/payment/cash-received', undefined, undefined, { tolerante: true }),
  paso('Ocultar la calificación de prueba', 'admin', 'PATCH', 'ratings/{{calificacionCompId}}/hide', { reason: 'Limpieza de la prueba' }, undefined, { tolerante: true }),
  { vaciarProducto: 'gasPruebaId' },
  { vaciarProducto: 'gasPruebaId' },
  paso('Dar de baja el producto propio de la prueba', 'admin', 'DELETE', 'gascylinder/{{gasPruebaId}}'),
];

module.exports = { OPS, PRE_CUIT, PRE_CODIGOS, DATOS_DE_PRUEBA, RESTAURACION };
