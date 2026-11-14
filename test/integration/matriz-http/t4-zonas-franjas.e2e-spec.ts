import { randomUUID } from 'crypto';
import { createTestApp, TestEnv } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import {
  EscenarioT4,
  franjaValida,
  sembrarBaseT4,
  zonaValida,
} from './t4-base';
import { casosEnModoSoporte } from './soporte';

describe('Matriz HTTP T4: zonas y franjas (e2e)', () => {
  let env: TestEnv;
  let ctx: EscenarioT4;
  const ver = () => ctx;
  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = {
      ...(await sembrarBaseT4(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 240000);
  afterAll(async () => env.cleanup());
  const zones = endpoint<EscenarioT4>(
    'get',
    '/coverage-zones',
    '/coverage-zones',
  );
  const check = endpoint<EscenarioT4>(
    'get',
    '/coverage-zones/check',
    '/coverage-zones/check?lat=-34.615&lng=-58.415',
  );
  const zone = endpoint<EscenarioT4>(
    'get',
    '/coverage-zones/{id}',
    (c) => `/coverage-zones/${c.zonaA}`,
  );
  const createZone = endpoint<EscenarioT4>(
    'post',
    '/coverage-zones',
    '/coverage-zones',
  );
  const patchZone = endpoint<EscenarioT4>(
    'patch',
    '/coverage-zones/{id}',
    (c) => `/coverage-zones/${c.zonaA}`,
  );
  const deleteZone = endpoint<EscenarioT4>(
    'delete',
    '/coverage-zones/{id}',
    (c) => `/coverage-zones/${c.zonaA}`,
  );
  let zonaQueChoca = '';
  const zoneCases: Array<Caso<EscenarioT4>> = [
    zones('administrador aislado', 'adminA', 200, {
      verificar: (b, c) => {
        expect(JSON.stringify(b)).toContain(c.zonaA);
        expect(JSON.stringify(b)).not.toContain(c.zonaB);
      },
    }),
    zones('sin token', undefined, 401),
    zones('cliente', 'clienteA', 403),
    check('cliente cubierto', 'clienteA', 200),
    check('sin token', undefined, 401),
    check('chofer', 'chofer', 403),
    check('coordenada inválida', 'clienteA', 400, {
      ruta: '/coverage-zones/check?lat=hola&lng=-58.4',
    }),
    zone('propia', 'adminA', 200),
    zone('id inválido', 'adminA', 400, {
      ruta: '/coverage-zones/no',
      code: 'INVALID_ID',
    }),
    zone('sin token', undefined, 401),
    zone('cliente', 'clienteA', 403),
    zone('tenant ajeno', 'adminB', 404, {
      ruta: (c) => `/coverage-zones/${c.zonaA}`,
    }),
    zone('inexistente', 'adminA', 404, {
      ruta: (c) => `/coverage-zones/${c.inexistente}`,
    }),
    createZone('crea y relee', 'adminA', 201, {
      body: () => zonaValida(`Nueva ${randomUUID().slice(0, 6)}`),
      verificar: async (b, c) => {
        const id = (b as { coverage_zone_id: string }).coverage_zone_id;
        expect(
          (await llamar(c, 'get', `/coverage-zones/${id}`, 'adminA')).body,
        ).toMatchObject({ coverage_zone_id: id });
      },
    }),
    createZone('requerido', 'adminA', 400, { body: { name: 'x' } }),
    createZone('polígono inválido', 'adminA', 400, {
      body: {
        ...zonaValida('Mala'),
        polygon: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    }),
    createZone('campo extra', 'adminA', 400, {
      body: { ...zonaValida('Extra'), ajeno: 1 },
    }),
    createZone('sin token', undefined, 401),
    createZone('cliente', 'clienteA', 403),
    createZone('chofer', 'chofer', 403),
    createZone('nombre activo duplicado', 'adminA', 409, {
      body: () => zonaValida('Zona T4 A'),
    }),
    patchZone('edita y relee', 'adminA', 200, {
      body: { label: 'Actualizada' },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/coverage-zones/${c.zonaA}`, 'adminA')).body,
        ).toMatchObject({ label: 'Actualizada' }),
    }),
    patchZone('id inválido', 'adminA', 400, {
      ruta: '/coverage-zones/no',
      body: {},
      code: 'INVALID_ID',
    }),
    patchZone('vigencia inválida', 'adminA', 400, {
      body: { validFrom: '2030-01-02', validUntil: '2030-01-01' },
    }),
    patchZone('sin token', undefined, 401, { body: {} }),
    patchZone('cliente', 'clienteA', 403, { body: {} }),
    patchZone('chofer', 'chofer', 403, { body: {} }),
    // Otra zona del caso, no `zonaA`: editar `zonaA` con su propia prioridad no choca con nadie.
    patchZone('prioridad activa duplicada', 'adminA', 409, {
      antes: async (c) => {
        const r = await llamar(c, 'post', '/coverage-zones', 'adminA', {
          ...zonaValida(`Choque ${randomUUID().slice(0, 6)}`),
        });
        expect(r.status).toBe(201);
        zonaQueChoca = (r.body as { coverage_zone_id: string })
          .coverage_zone_id;
      },
      ruta: () => `/coverage-zones/${zonaQueChoca}`,
      body: { priority: 0 },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/coverage-zones/${zonaQueChoca}`,
          'adminA',
        );
        expect((r.body as { priority: number }).priority).not.toBe(0);
      },
    }),
    patchZone('tenant ajeno intacta', 'adminB', 404, {
      ruta: (c) => `/coverage-zones/${c.zonaA}`,
      body: { label: 'No cambia' },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/coverage-zones/${c.zonaA}`, 'adminA')).body,
        ).toMatchObject({ label: 'Actualizada' }),
    }),
    deleteZone('id inválido', 'adminA', 400, {
      ruta: '/coverage-zones/no',
      code: 'INVALID_ID',
    }),
    deleteZone('sin token', undefined, 401),
    deleteZone('cliente', 'clienteA', 403),
    deleteZone('chofer', 'chofer', 403),
    deleteZone('tenant ajeno intacta', 'adminB', 404, {
      ruta: (c) => `/coverage-zones/${c.zonaA}`,
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/coverage-zones/${c.zonaA}`, 'adminA'))
            .status,
        ).toBe(200),
    }),
    deleteZone('baja propia y desaparece', 'adminA', 200, {
      antes: async (c) => {
        const r = await llamar(
          c,
          'post',
          '/coverage-zones',
          'adminA',
          zonaValida(`Baja ${randomUUID().slice(0, 6)}`),
        );
        c.zonaA = (r.body as { coverage_zone_id: string }).coverage_zone_id;
      },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/coverage-zones/${c.zonaA}`, 'adminA'))
            .status,
        ).toBe(404),
    }),
  ];
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(zones, createZone),
  );
  correrMatriz('coverage zones', ver, zoneCases);

  const slots = endpoint<EscenarioT4>('get', '/time-slot', '/time-slot');
  const availability = endpoint<EscenarioT4>(
    'get',
    '/time-slot/availability',
    (c) =>
      `/time-slot/availability?date=2030-01-01&distributor=${c.distA.slug}`,
  );
  const slot = endpoint<EscenarioT4>(
    'get',
    '/time-slot/{id}',
    (c) => `/time-slot/${c.franjaA}`,
  );
  const createSlot = endpoint<EscenarioT4>('post', '/time-slot', '/time-slot');
  const patchSlot = endpoint<EscenarioT4>(
    'patch',
    '/time-slot/{id}',
    (c) => `/time-slot/${c.franjaA}`,
  );
  const deleteSlot = endpoint<EscenarioT4>(
    'delete',
    '/time-slot/{id}',
    (c) => `/time-slot/${c.franjaA}`,
  );
  let franjaQueChoca = '';
  let franjaDeBaja = '';
  const slotCases: Array<Caso<EscenarioT4>> = [
    slots('administrador aislado', 'adminA', 200, {
      verificar: (b, c) => {
        expect(JSON.stringify(b)).toContain(c.franjaA);
        expect(JSON.stringify(b)).not.toContain(c.franjaB);
      },
    }),
    slots('sin token', undefined, 401),
    slots('cliente', 'clienteA', 403),
    slots('query inválida', 'adminA', 400, {
      ruta: '/time-slot?includeInactive=talvez',
    }),
    availability('pública', undefined, 200),
    availability('fecha inválida', undefined, 400, {
      ruta: '/time-slot/availability?date=no',
    }),
    slot('propia', 'adminA', 200),
    slot('id inválido', 'adminA', 400, {
      ruta: '/time-slot/no',
      code: 'INVALID_ID',
    }),
    slot('sin token', undefined, 401),
    slot('tenant ajeno', 'adminB', 404),
    slot('inexistente', 'adminA', 404, {
      ruta: (c) => `/time-slot/${c.inexistente}`,
    }),
    createSlot('crea y relee', 'adminA', 201, {
      body: () => franjaValida(`Nueva ${randomUUID().slice(0, 6)}`),
      verificar: async (b, c) => {
        const id = (b as { time_slot_id: string }).time_slot_id;
        expect(
          (await llamar(c, 'get', `/time-slot/${id}`, 'adminA')).body,
        ).toMatchObject({ time_slot_id: id });
      },
    }),
    createSlot('requerido', 'adminA', 400, { body: { name: 'x' } }),
    createSlot('horario inválido', 'adminA', 400, {
      body: { ...franjaValida('Rango'), startTime: '16:00', endTime: '14:00' },
    }),
    createSlot('sin token', undefined, 401),
    createSlot('cliente', 'clienteA', 403),
    createSlot('chofer', 'chofer', 403),
    createSlot('conflicto de horario', 'adminA', 409, {
      body: { ...franjaValida('Choque'), startTime: '08:30', endTime: '09:30' },
    }),
    patchSlot('edita y relee', 'adminA', 200, {
      body: { capacity: 21 },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/time-slot/${c.franjaA}`, 'adminA')).body,
        ).toMatchObject({ capacity: 21 }),
    }),
    patchSlot('id inválido', 'adminA', 400, {
      ruta: '/time-slot/no',
      body: {},
      code: 'INVALID_ID',
    }),
    patchSlot('capacidad inválida', 'adminA', 400, { body: { capacity: 0 } }),
    patchSlot('sin token', undefined, 401, { body: {} }),
    patchSlot('cliente', 'clienteA', 403, { body: {} }),
    patchSlot('chofer', 'chofer', 403, { body: {} }),
    // Otra franja del caso, no `franjaA`: correr `franjaA` dentro de su propio horario no choca con nadie.
    patchSlot('se solapa con una activa', 'adminA', 409, {
      antes: async (c) => {
        const r = await llamar(c, 'post', '/time-slot', 'adminA', {
          ...franjaValida(`Choque ${randomUUID().slice(0, 6)}`),
          startTime: '18:00',
          endTime: '19:00',
        });
        expect(r.status).toBe(201);
        franjaQueChoca = (r.body as { time_slot_id: string }).time_slot_id;
      },
      ruta: () => `/time-slot/${franjaQueChoca}`,
      body: { startTime: '08:30', endTime: '09:30' },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/time-slot/${franjaQueChoca}`, 'adminA'))
            .body,
        ).toMatchObject({
          startTime: expect.stringMatching(/^18:00/) as string,
        }),
    }),
    patchSlot('tenant ajeno intacta', 'adminB', 404, {
      body: { capacity: 22 },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/time-slot/${c.franjaA}`, 'adminA')).body,
        ).toMatchObject({ capacity: 21 }),
    }),
    deleteSlot('id mal formado', 'adminA', 400, {
      ruta: '/time-slot/no',
      code: 'INVALID_ID',
    }),
    deleteSlot('sin token', undefined, 401),
    deleteSlot('cliente', 'clienteA', 403),
    deleteSlot('chofer', 'chofer', 403),
    deleteSlot('tenant ajeno intacta', 'adminB', 404, {
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/time-slot/${c.franjaA}`, 'adminA')).status,
        ).toBe(200),
    }),
    deleteSlot('baja propia y relee inactiva', 'adminA', 200, {
      antes: async (c) => {
        const r = await llamar(c, 'post', '/time-slot', 'adminA', {
          ...franjaValida(`Baja ${randomUUID().slice(0, 6)}`),
          startTime: '20:00',
          endTime: '21:00',
        });
        expect(r.status).toBe(201);
        franjaDeBaja = (r.body as { time_slot_id: string }).time_slot_id;
      },
      ruta: () => `/time-slot/${franjaDeBaja}`,
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/time-slot?includeInactive=true`, 'adminA'))
            .body,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              time_slot_id: franjaDeBaja,
              isActive: false,
            }),
          ]),
        ),
    }),
  ];
  correrMatriz('time slots', ver, slotCases);
});
