import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint } from './matriz';
import { EscenarioT7, sembrarBaseT7 } from './t7-base';

type C = EscenarioT7;
const ADMIN = 'adminA';
const lista = endpoint<C>('get', '/v2/insurers', '/v2/insurers');
const una = endpoint<C>(
  'get',
  '/v2/insurers/{id}',
  (c) => `/v2/insurers/${c.aseguradoraA}`,
);
const crear = endpoint<C>('post', '/v2/insurers', '/v2/insurers');
const editar = endpoint<C>(
  'patch',
  '/v2/insurers/{id}',
  (c) => `/v2/insurers/${c.aseguradoraA}`,
);
const baja = endpoint<C>(
  'delete',
  '/v2/insurers/{id}',
  (c) => `/v2/insurers/${c.aseguradoraA}`,
);
const valida = {
  name: 'Aseguradora T7 Nueva',
  paymentUrl: 'https://pagos.example.com/cuotas',
};

const casos: Array<Caso<C>> = [
  lista('lista del tenant', ADMIN, 200, {
    verificar: (b, c) => expect(JSON.stringify(b)).toContain(c.aseguradoraA),
  }),
  lista('no lista otro tenant', ADMIN, 200, {
    verificar: (b, c) =>
      expect(JSON.stringify(b)).not.toContain(c.aseguradoraB),
  }),
  lista('filtro inválido', ADMIN, 400, { ruta: '/v2/insurers?limit=0' }),
  lista('sin token', undefined, 401),
  lista('rol sin permiso', 'clienteA', 403),
  una('lee una aseguradora propia', ADMIN, 200),
  una('id inválido', ADMIN, 400, { ruta: '/v2/insurers/no' }),
  una('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.inexistente}`,
  }),
  una('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.aseguradoraB}`,
  }),
  una('sin token', undefined, 401),
  una('rol sin permiso', 'clienteA', 403),
  crear('da de alta', ADMIN, 201, { body: valida }),
  crear('nombre falta', ADMIN, 400, { body: {} }),
  crear('nombre vacío', ADMIN, 400, { body: { name: '   ' } }),
  crear('nombre largo', ADMIN, 400, { body: { name: 'x'.repeat(121) } }),
  crear('correo inválido', ADMIN, 400, { body: { ...valida, email: 'no' } }),
  crear('CUIT inválido', ADMIN, 400, { body: { ...valida, taxId: '123' } }),
  crear('teléfono inválido', ADMIN, 400, { body: { ...valida, phone: 'abc' } }),
  crear('URL de pago no segura', ADMIN, 400, {
    body: { ...valida, paymentUrl: 'http://pagos.example.com' },
  }),
  crear('campo extra', ADMIN, 400, { body: { ...valida, ajeno: true } }),
  crear('nombre duplicado', ADMIN, 409, {
    body: { ...valida, name: 'Seguros T7 A' },
  }),
  crear('sin token', undefined, 401, { body: valida }),
  crear('rol sin permiso', 'clienteA', 403, { body: valida }),
  editar('modifica datos', ADMIN, 200, { body: { phone: '+54 351 555-1234' } }),
  editar('id inválido', ADMIN, 400, {
    ruta: '/v2/insurers/no',
    body: { name: 'Otra' },
  }),
  editar('campo extra', ADMIN, 400, { body: { ajeno: true } }),
  editar('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.inexistente}`,
    body: { name: 'Otra' },
  }),
  editar('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.aseguradoraB}`,
    body: { name: 'Otra' },
  }),
  editar('sin token', undefined, 401, { body: { name: 'Otra' } }),
  editar('rol sin permiso', 'clienteA', 403, { body: { name: 'Otra' } }),
  baja('da de baja', ADMIN, 204),
  baja('id inválido', ADMIN, 400, { ruta: '/v2/insurers/no' }),
  baja('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.inexistente}`,
  }),
  baja('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurers/${c.aseguradoraB}`,
  }),
  baja('sin token', undefined, 401),
  baja('rol sin permiso', 'clienteA', 403),
];

const seguroAuto = endpoint<C>(
  'get',
  '/v2/cars/{carId}/insurance',
  (c) => `/v2/cars/${c.autoA}/insurance`,
);
const poliza = endpoint<C>(
  'get',
  '/v2/insurance-policies/{id}',
  (c) => `/v2/insurance-policies/${c.polizaA}`,
);
const cuotas = endpoint<C>(
  'get',
  '/v2/insurance-installments',
  '/v2/insurance-installments',
);
const cuota = endpoint<C>(
  'get',
  '/v2/insurance-installments/{id}',
  (c) => `/v2/insurance-installments/${c.cuotaA}`,
);
const crearPoliza = endpoint<C>(
  'post',
  '/v2/insurance-policies',
  '/v2/insurance-policies',
);
const editarPoliza = endpoint<C>(
  'patch',
  '/v2/insurance-policies/{id}',
  (c) => `/v2/insurance-policies/${c.polizaA}`,
);
const cancelarPoliza = endpoint<C>(
  'post',
  '/v2/insurance-policies/{id}/cancel',
  (c) => `/v2/insurance-policies/${c.polizaA}/cancel`,
);
const editarCuota = endpoint<C>(
  'patch',
  '/v2/insurance-installments/{id}',
  (c) => `/v2/insurance-installments/${c.cuotaA}`,
);
const subirComprobante = endpoint<C>(
  'post',
  '/v2/insurance-installments/{id}/receipt',
  (c) => `/v2/insurance-installments/${c.cuotaA}/receipt`,
);
const pagarCuota = endpoint<C>(
  'post',
  '/v2/insurance-installments/{id}/pay',
  (c) => `/v2/insurance-installments/${c.cuotaA}/pay`,
);

const polizaValida = (c: C) => ({
  carId: c.autoA,
  insurerId: c.aseguradoraPolizaA,
  policyNumber: 'NUEVA-T7-001',
  coverage: 'Todo riesgo',
  validFrom: '2031-01-01',
  validTo: '2031-12-31',
  installments: { count: 1, amount: 1000, firstDueDate: '2031-01-10' },
});

const casosPolizas: Array<Caso<C>> = [
  seguroAuto('consulta el seguro del vehículo', ADMIN, 200),
  seguroAuto('id inválido', ADMIN, 400, { ruta: '/v2/cars/no/insurance' }),
  seguroAuto('vehículo ajeno', ADMIN, 404, {
    ruta: (c) => `/v2/cars/${c.autoB}/insurance`,
  }),
  seguroAuto('sin token', undefined, 401),
  seguroAuto('rol sin permiso', 'clienteA', 403),
  poliza('consulta una póliza', ADMIN, 200),
  poliza('id inválido', ADMIN, 400, { ruta: '/v2/insurance-policies/no' }),
  poliza('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-policies/${c.inexistente}`,
  }),
  poliza('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-policies/${c.polizaB}`,
  }),
  poliza('sin token', undefined, 401),
  poliza('rol sin permiso', 'clienteA', 403),
  crearPoliza('crea una póliza', ADMIN, 201, { body: polizaValida }),
  crearPoliza('fechas inválidas', ADMIN, 400, {
    body: (c) => ({ ...polizaValida(c), validTo: '2030-01-01' }),
  }),
  crearPoliza('cuotas faltantes', ADMIN, 400, {
    body: (c) => ({ ...polizaValida(c), installments: undefined }),
  }),
  crearPoliza('campo extra', ADMIN, 400, {
    body: (c) => ({ ...polizaValida(c), ajeno: true }),
  }),
  crearPoliza('aseguradora ajena', ADMIN, 404, {
    body: (c) => ({ ...polizaValida(c), insurerId: c.aseguradoraPolizaB }),
  }),
  crearPoliza('sin token', undefined, 401, { body: polizaValida }),
  crearPoliza('rol sin permiso', 'clienteA', 403, { body: polizaValida }),
  editarPoliza('edita cobertura', ADMIN, 200, {
    body: { coverage: 'Terceros completo' },
  }),
  editarPoliza('campo extra', ADMIN, 400, { body: { ajeno: true } }),
  editarPoliza('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-policies/${c.polizaB}`,
    body: { coverage: 'Otra' },
  }),
  editarPoliza('sin token', undefined, 401, { body: { coverage: 'Otra' } }),
  editarPoliza('rol sin permiso', 'clienteA', 403, {
    body: { coverage: 'Otra' },
  }),
  cancelarPoliza('motivo faltante', ADMIN, 400, { body: {} }),
  cancelarPoliza('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-policies/${c.inexistente}/cancel`,
    body: { reason: 'Prueba' },
  }),
  cancelarPoliza('sin token', undefined, 401, { body: { reason: 'Prueba' } }),
  cancelarPoliza('rol sin permiso', 'clienteA', 403, {
    body: { reason: 'Prueba' },
  }),
  cuotas('lista cuotas', ADMIN, 200),
  cuotas('filtro inválido', ADMIN, 400, {
    ruta: '/v2/insurance-installments?status=no',
  }),
  cuotas('sin token', undefined, 401),
  cuotas('rol sin permiso', 'clienteA', 403),
  cuota('consulta una cuota', ADMIN, 200),
  cuota('id inválido', ADMIN, 400, { ruta: '/v2/insurance-installments/no' }),
  cuota('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-installments/${c.inexistente}`,
  }),
  cuota('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-installments/${c.cuotaB}`,
  }),
  cuota('sin token', undefined, 401),
  cuota('rol sin permiso', 'clienteA', 403),
  editarCuota('corrige importe', ADMIN, 200, { body: { amount: 1100 } }),
  editarCuota('importe inválido', ADMIN, 400, { body: { amount: 0 } }),
  editarCuota('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-installments/${c.cuotaB}`,
    body: { amount: 1100 },
  }),
  editarCuota('sin token', undefined, 401, { body: { amount: 1100 } }),
  editarCuota('rol sin permiso', 'clienteA', 403, { body: { amount: 1100 } }),
  subirComprobante('sin archivo', ADMIN, 400),
  subirComprobante('id inválido', ADMIN, 400, {
    ruta: '/v2/insurance-installments/no/receipt',
  }),
  subirComprobante('cuota ajena', ADMIN, 404, {
    ruta: (c) => `/v2/insurance-installments/${c.cuotaB}/receipt`,
  }),
  subirComprobante('tipo no permitido', ADMIN, 415, {
    adjunto: {
      campo: 'file',
      contenido: Buffer.from('no soy un comprobante'),
      nombre: 'texto.txt',
      tipo: 'text/plain',
    },
  }),
  subirComprobante('archivo demasiado grande', ADMIN, 413, {
    adjunto: {
      campo: 'file',
      contenido: Buffer.alloc(10 * 1024 * 1024 + 1),
      nombre: 'grande.pdf',
      tipo: 'application/pdf',
    },
  }),
  subirComprobante('sin token', undefined, 401),
  subirComprobante('rol sin permiso', 'clienteA', 403),
  pagarCuota('cuerpo incompleto', ADMIN, 400, { body: {} }),
  pagarCuota('id inválido', ADMIN, 400, {
    ruta: '/v2/insurance-installments/no/pay',
    body: (c) => ({
      attachmentId: c.inexistente,
      paidAt: '2026-01-01',
      amount: 1000,
      cashBoxId: c.inexistente,
    }),
    mensajeExacto: 'El identificador no es válido',
  }),
  pagarCuota('sin token', undefined, 401, { body: {} }),
  pagarCuota('rol sin permiso', 'clienteA', 403, { body: {} }),
];

describe('Matriz HTTP T7 · seguros', () => {
  let env: TestEnv;
  let ctx: C;
  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT7(env);
  });
  afterAll(async () => env?.cleanup());
  correrMatriz('Aseguradoras v2', () => ctx, casos);
  correrMatriz('Pólizas y cuotas v2', () => ctx, casosPolizas);
});
