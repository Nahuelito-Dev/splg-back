import { createTestApp, TestEnv } from '../setup/test-env';
import { DataSource } from 'typeorm';
import { Car } from '../../../src/car/entities/car.entity';
import { Caso, correrMatriz, endpoint } from './matriz';
import { EscenarioT7, sembrarBaseT7 } from './t7-base';
import { casosEnModoSoporte } from './soporte';

type C = EscenarioT7;
const ADMIN = 'adminA';
const auto = endpoint<C>('get', '/car/{id}', (c) => `/car/${c.autoA}`);
const lista = endpoint<C>('get', '/car', '/car');
const crear = endpoint<C>('post', '/car', '/car');
const editar = endpoint<C>('patch', '/car/{id}', (c) => `/car/${c.autoA}`);
const baja = endpoint<C>('delete', '/car/{id}', (c) => `/car/${c.autoA}`);
const subirFoto = endpoint<C>(
  'put',
  '/car/{id}/photo',
  (c) => `/car/${c.autoA}/photo`,
);
const quitarFoto = endpoint<C>(
  'delete',
  '/car/{id}/photo',
  (c) => `/car/${c.autoA}/photo`,
);
const verFoto = endpoint<C>(
  'get',
  '/car/{id}/photo',
  (c) => `/car/${c.autoA}/photo?modo=url`,
);
const porPatente = endpoint<C>(
  'get',
  '/car/patent/{patent}',
  '/car/patent/AB123CD',
);
const porUsuario = endpoint<C>(
  'get',
  '/car/user/{userId}',
  (c) => `/car/user/${c.choferA.userId}`,
);

const cuerpoValido = (c: C) => ({
  user_id: c.choferA.userId,
  car_patent: 'AB123CD',
  type_car: 'Camioneta',
  car_capacity: 900,
});

const casos: Array<Caso<C>> = [
  lista('lista de su distribuidora', ADMIN, 200, {
    verificar: (b, c) => expect(JSON.stringify(b)).toContain(c.autoA),
  }),
  lista('no muestra otra distribuidora', ADMIN, 200, {
    verificar: (b, c) => expect(JSON.stringify(b)).not.toContain(c.autoB),
  }),
  lista('sin token', undefined, 401),
  lista('rol sin permiso', 'clienteA', 403),

  auto('lee un vehículo propio', ADMIN, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ car_id: c.autoA }),
  }),
  auto('id mal formado', ADMIN, 400, { ruta: '/car/no-es-uuid' }),
  auto('inexistente', ADMIN, 404, { ruta: (c) => `/car/${c.inexistente}` }),
  auto('de otra distribuidora', ADMIN, 404, { ruta: (c) => `/car/${c.autoB}` }),
  auto('sin token', undefined, 401),
  auto('rol sin permiso', 'clienteA', 403),

  porUsuario('encuentra por usuario', ADMIN, 200),
  porUsuario('id mal formado', ADMIN, 400, { ruta: '/car/user/no' }),
  // Por diseño es un filtro: un usuario sin vehículos (o inexistente) da lista vacía.
  porUsuario('usuario sin vehículos da lista vacía', ADMIN, 200, {
    ruta: (c) => `/car/user/${c.inexistente}`,
    verificar: (b) => expect(b).toEqual([]),
  }),
  porUsuario('no muestra vehículos de otra distribuidora', ADMIN, 200, {
    ruta: (c) => `/car/user/${c.choferB.userId}`,
    verificar: (b) => expect(b).toEqual([]),
  }),
  porUsuario('sin token', undefined, 401),
  porUsuario('rol sin permiso', 'clienteA', 403),

  porPatente('no devuelve una patente inexistente', ADMIN, 200, {
    ruta: '/car/patent/ZZ999ZZ',
    // Swagger: «sin cuerpo si no hay un vehículo con esa patente».
    verificar: (b) => expect(b).toEqual({}),
  }),
  porPatente('no encuentra la patente de otra distribuidora', ADMIN, 200, {
    ruta: '/car/patent/TB777TB',
    antes: async (c) => {
      await c.app
        .get(DataSource)
        .getRepository(Car)
        .update({ carId: c.autoB }, { carPatent: 'TB777TB' });
    },
    verificar: (b) => expect(b).toEqual({}),
  }),
  porPatente('patente demasiado larga', ADMIN, 400, {
    ruta: `/car/patent/${'A'.repeat(21)}`,
  }),
  porPatente('sin token', undefined, 401),
  porPatente('rol sin permiso', 'clienteA', 403),

  verFoto('informa que el vehículo no tiene foto', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ url: null }),
  }),
  verFoto('id mal formado', ADMIN, 400, {
    ruta: '/car/no-es-uuid/photo?modo=url',
  }),
  verFoto('vehículo de otro tenant', ADMIN, 404, {
    ruta: (c) => `/car/${c.autoB}/photo?modo=url`,
  }),
  verFoto('modo inválido', ADMIN, 400, {
    ruta: (c) => `/car/${c.autoA}/photo?modo=no`,
  }),
  verFoto('sin token', undefined, 401),
  verFoto('rol sin permiso', 'clienteA', 403),
  subirFoto('falta el archivo', ADMIN, 400),
  subirFoto('tipo no permitido', ADMIN, 415, {
    adjunto: {
      campo: 'file',
      contenido: Buffer.from('no soy una foto'),
      nombre: 'texto.txt',
      tipo: 'text/plain',
    },
  }),
  subirFoto('archivo demasiado grande', ADMIN, 413, {
    adjunto: {
      campo: 'file',
      contenido: Buffer.alloc(5 * 1024 * 1024 + 1),
      nombre: 'grande.jpg',
      tipo: 'image/jpeg',
    },
  }),
  subirFoto('id mal formado', ADMIN, 400, { ruta: '/car/no-es-uuid/photo' }),
  subirFoto('vehículo de otro tenant', ADMIN, 404, {
    ruta: (c) => `/car/${c.autoB}/photo`,
  }),
  subirFoto('sin token', undefined, 401),
  subirFoto('rol sin permiso', 'clienteA', 403),
  quitarFoto(
    'quita una foto inexistente sin dar de baja el vehículo',
    ADMIN,
    200,
  ),
  quitarFoto('id mal formado', ADMIN, 400, { ruta: '/car/no-es-uuid/photo' }),
  quitarFoto('vehículo de otro tenant', ADMIN, 404, {
    ruta: (c) => `/car/${c.autoB}/photo`,
  }),
  quitarFoto('sin token', undefined, 401),
  quitarFoto('rol sin permiso', 'clienteA', 403),

  crear('da de alta un vehículo', ADMIN, 201, { body: cuerpoValido }),
  crear('usuario falta', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), user_id: undefined }),
  }),
  crear('usuario no es UUID', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), user_id: 'no' }),
  }),
  crear('patente inválida', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), car_patent: 'mala' }),
  }),
  crear('capacidad decimal', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), car_capacity: 1.5 }),
  }),
  crear('tipo demasiado corto', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), type_car: 'x' }),
  }),
  crear('campo extra', ADMIN, 400, {
    body: (c) => ({ ...cuerpoValido(c), ajeno: true }),
  }),
  crear('patente duplicada', ADMIN, 409, {
    body: (c) => ({ ...cuerpoValido(c), car_patent: 'CD456EF' }),
    antes: async (c) => {
      await c.app
        .get(DataSource)
        .getRepository(Car)
        .save({
          distributorId: c.distA.id,
          userId: c.choferA.userId,
          carPatent: 'CD456EF',
        } as Partial<Car>);
    },
  }),
  crear('sin token', undefined, 401, { body: cuerpoValido }),
  crear('rol sin permiso', 'clienteA', 403, { body: cuerpoValido }),

  editar('modifica datos permitidos', ADMIN, 200, {
    body: { car_color: 'Blanco' },
  }),
  editar('id mal formado', ADMIN, 400, {
    ruta: '/car/no-es-uuid',
    body: { car_color: 'Blanco' },
  }),
  editar('campo extra', ADMIN, 400, { body: { ajeno: true } }),
  editar('inexistente', ADMIN, 404, {
    ruta: (c) => `/car/${c.inexistente}`,
    body: { car_color: 'Blanco' },
  }),
  editar('de otra distribuidora', ADMIN, 404, {
    ruta: (c) => `/car/${c.autoB}`,
    body: { car_color: 'Blanco' },
  }),
  editar('sin token', undefined, 401, { body: { car_color: 'Blanco' } }),
  editar('rol sin permiso', 'clienteA', 403, { body: { car_color: 'Blanco' } }),

  baja('da de baja un vehículo propio', ADMIN, 200),
  baja('id mal formado', ADMIN, 400, { ruta: '/car/no-es-uuid' }),
  baja('inexistente', ADMIN, 404, { ruta: (c) => `/car/${c.inexistente}` }),
  baja('de otra distribuidora', ADMIN, 404, { ruta: (c) => `/car/${c.autoB}` }),
  baja('sin token', undefined, 401),
  baja('rol sin permiso', 'clienteA', 403),
];

describe('Matriz HTTP T7 · vehículos', () => {
  let env: TestEnv;
  let ctx: C;
  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT7(env);
  });
  afterAll(async () => env?.cleanup());
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    () => ctx,
    casosEnModoSoporte(lista, crear),
  );
  correrMatriz('Cars', () => ctx, casos);
});
