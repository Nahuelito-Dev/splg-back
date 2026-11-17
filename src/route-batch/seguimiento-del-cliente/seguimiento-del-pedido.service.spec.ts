import type { DataSource } from 'typeorm';
import type { ProcessConfigService } from '../../distributor/process-config.service';
import {
  diaParaElCliente,
  SeguimientoDelPedido,
  textoDeLaVentana,
} from './seguimiento-del-pedido.service';

const EMPRESA = 'dist-a';
const OTRA_EMPRESA = 'dist-b';
const CLIENTE = 'cli-1';
const OTRO_CLIENTE = 'cli-2';
// Martes 17/11/2026, 15:00 en Argentina.
const AHORA = new Date('2026-11-17T18:00:00Z');
const at = (hhmm: string, dia = '2026-11-17') =>
  new Date(`${dia}T${hhmm}:00-03:00`);

interface FilaFalsa {
  distributorId: string;
  customerId: string;
  orderId: string;
  status: string;
  orderDate: string | null;
  sheetId: string | null;
  sheetStatus: string | null;
  planDate: string | null;
  etaAt: Date | null;
  ws: Date | null;
  we: Date | null;
  failedAttempts: number | null;
  slotStart: string | null;
  slotEnd: string | null;
  dayStart: string | null;
  dayEnd: string | null;
  before: number | string | null;
}

const fila = (orderId: string, extra: Partial<FilaFalsa> = {}): FilaFalsa => ({
  distributorId: EMPRESA,
  customerId: CLIENTE,
  orderId,
  status: 'accepted',
  orderDate: '2026-11-17',
  sheetId: null,
  sheetStatus: null,
  planDate: null,
  etaAt: null,
  ws: null,
  we: null,
  failedAttempts: null,
  slotStart: null,
  slotEnd: null,
  dayStart: '08:00:00',
  dayEnd: '20:00:00',
  before: null,
  ...extra,
});

interface SalidaFalsa {
  distributorId: string;
  customerId: string;
  orderId: string;
  reason: string | null;
  planDate: string | null;
}

const enHoja = (extra: Partial<FilaFalsa> = {}): Partial<FilaFalsa> => ({
  sheetId: 'hoja-1',
  sheetStatus: 'confirmed',
  planDate: '2026-11-17',
  etaAt: at('15:22'),
  failedAttempts: 0,
  slotStart: '14:00:00',
  slotEnd: '18:00:00',
  before: 3,
  ...extra,
});

/**
 * Una base de mentira: devuelve sólo las filas que cumplen los parámetros
 * (empresa, cliente, pedidos), como la consulta real. Si el servicio no
 * mandara la empresa o el cliente, se colarían las ajenas.
 */
function armar(filas: FilaFalsa[], salidas: SalidaFalsa[] = []) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[]) => {
    consultas.push({ sql, params });
    const [empresa, cliente, ids] = params as [string, string, string[]];
    const filtrar = <
      T extends { distributorId: string; customerId: string; orderId: string },
    >(
      xs: T[],
    ) =>
      xs
        .filter(
          (x) =>
            x.distributorId === empresa &&
            x.customerId === cliente &&
            ids.includes(x.orderId),
        )
        .map((x) => {
          const copia: Record<string, unknown> = { ...x };
          delete copia.distributorId;
          delete copia.customerId;
          return copia;
        });
    return Promise.resolve(
      sql.includes('DISTINCT ON') ? filtrar(salidas) : filtrar(filas),
    );
  });
  const obtener = jest.fn(() => Promise.resolve({ etaWindowMinutes: 15 }));
  const servicio = new SeguimientoDelPedido(
    { query } as unknown as DataSource,
    { obtener } as unknown as ProcessConfigService,
  );
  return { servicio, consultas, obtener };
}

describe('SeguimientoDelPedido (reparto que ve el cliente)', () => {
  it('textos: el día relativo y la franja «entre… y…, aprox.» en hora argentina', () => {
    expect(diaParaElCliente('2026-11-17', '2026-11-17')).toBe('hoy');
    expect(diaParaElCliente('2026-11-18', '2026-11-17')).toBe('mañana');
    expect(diaParaElCliente('2026-11-19', '2026-11-17')).toBe('jueves 19/11');
    expect(
      textoDeLaVentana({
        startMs: at('15:05').getTime(),
        endMs: at('15:40').getTime(),
      }),
    ).toBe('entre las 15:05 y las 15:40, aprox.');
  });

  it('sin pedidos no consulta la base', async () => {
    const { servicio, consultas } = armar([]);
    expect(
      (await servicio.deLosPedidos(EMPRESA, CLIENTE, [], AHORA)).size,
    ).toBe(0);
    expect(consultas).toHaveLength(0);
  });

  it('pedido sin hoja: sin hoja de ruta (ni hora, ni entregas antes)', async () => {
    const { servicio, obtener } = armar([fila('p1')]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.get('p1')).toEqual({
      situacion: 'sin_hoja_de_ruta',
      diaDelReparto: null,
      viajeIniciado: false,
      entregasAntes: null,
      llegadaEstimada: null,
      pasoAlFinalDelRecorrido: false,
      reprogramadoPara: null,
    });
    expect(obtener).not.toHaveBeenCalled();
  });

  it('en hoja sin arrancar: el día y la franja de su hora estimada (± la media, redondeada), sin entregas antes', async () => {
    const { servicio, obtener } = armar([fila('p1', enHoja())]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.get('p1')).toEqual({
      situacion: 'en_hoja_sin_salir',
      diaDelReparto: 'hoy',
      viajeIniciado: false,
      entregasAntes: null,
      // 15:22 ± 15 = 15:07–15:37 → 15:05–15:40.
      llegadaEstimada: 'entre las 15:05 y las 15:40, aprox.',
      pasoAlFinalDelRecorrido: false,
      reprogramadoPara: null,
    });
    expect(obtener).toHaveBeenCalledTimes(1);
  });

  it('sin franja comprada, la estimada se arma con la jornada de la empresa', async () => {
    const { servicio } = armar([
      fila(
        'p1',
        enHoja({ slotStart: null, slotEnd: null, etaAt: at('08:01') }),
      ),
    ]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    // 08:01 − 15 queda antes de que abra la jornada (08:00): se recorta ahí.
    expect(r.get('p1')?.llegadaEstimada).toBe(
      'entre las 08:00 y las 08:20, aprox.',
    );
  });

  it('en viaje con N antes: la franja avisada (la que vio en la app) y cuántas entregas faltan antes', async () => {
    const { servicio, obtener } = armar([
      fila(
        'p1',
        enHoja({
          sheetStatus: 'assigned',
          ws: at('16:10'),
          we: at('16:40'),
          before: '2',
        }),
      ),
    ]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.get('p1')).toEqual({
      situacion: 'en_viaje',
      diaDelReparto: 'hoy',
      viajeIniciado: true,
      entregasAntes: 2,
      llegadaEstimada: 'entre las 16:10 y las 16:40, aprox.',
      pasoAlFinalDelRecorrido: false,
      reprogramadoPara: null,
    });
    // Con la franja avisada no hacen falta los parámetros.
    expect(obtener).not.toHaveBeenCalled();
  });

  it('reencolado: pasó al final del recorrido', async () => {
    const { servicio } = armar([
      fila(
        'p1',
        enHoja({
          sheetStatus: 'assigned',
          failedAttempts: 1,
          ws: at('18:00'),
          we: at('18:30'),
        }),
      ),
    ]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.get('p1')).toEqual(
      expect.objectContaining({
        situacion: 'en_viaje',
        pasoAlFinalDelRecorrido: true,
        llegadaEstimada: 'entre las 18:00 y las 18:30, aprox.',
      }),
    );
  });

  it('reprogramado: para cuándo («mañana»)', async () => {
    const { servicio } = armar(
      [fila('p1', { status: 'pending', orderDate: '2026-11-18' })],
      [
        {
          distributorId: EMPRESA,
          customerId: CLIENTE,
          orderId: 'p1',
          reason: 'rescheduled',
          planDate: '2026-11-17',
        },
      ],
    );
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.get('p1')).toEqual(
      expect.objectContaining({
        situacion: 'reprogramado',
        reprogramadoPara: 'mañana',
        llegadaEstimada: null,
      }),
    );
  });

  it('entregado: sin reparto (el estado alcanza)', async () => {
    const { servicio } = armar([
      fila('p1', {
        status: 'delivered',
        ...enHoja({ sheetStatus: 'assigned' }),
      }),
    ]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    expect(r.has('p1')).toBe(true);
    expect(r.get('p1')).toBeNull();
  });

  it('aislamiento: los pedidos de otro cliente o de otra empresa no vuelven, aunque se pidan por id', async () => {
    const { servicio, consultas } = armar(
      [
        fila('p1', enHoja()),
        fila('ajeno', { customerId: OTRO_CLIENTE, ...enHoja() }),
        fila('otra', { distributorId: OTRA_EMPRESA, ...enHoja() }),
      ],
      [
        {
          distributorId: EMPRESA,
          customerId: OTRO_CLIENTE,
          orderId: 'ajeno',
          reason: 'rescheduled',
          planDate: '2026-11-16',
        },
      ],
    );
    const r = await servicio.deLosPedidos(
      EMPRESA,
      CLIENTE,
      ['p1', 'ajeno', 'otra'],
      AHORA,
    );
    expect([...r.keys()]).toEqual(['p1']);
    for (const c of consultas) {
      expect(c.params.slice(0, 2)).toEqual([EMPRESA, CLIENTE]);
      expect(c.sql).toContain('o."distributor_id" = $1');
      expect(c.sql).toContain('o."customer_id" = $2');
      expect(c.sql).toContain(`b."kind" = 'planned'`);
    }
  });

  it('de las otras paradas sólo sale un número: ni ids, ni nombres, ni direcciones, ni la hora puntual', async () => {
    const { servicio, consultas } = armar([
      fila('p1', enHoja({ sheetStatus: 'assigned', before: 5 })),
    ]);
    const r = await servicio.deLosPedidos(EMPRESA, CLIENTE, ['p1'], AHORA);
    const reparto = r.get('p1');
    expect(Object.keys(reparto ?? {}).sort()).toEqual([
      'diaDelReparto',
      'entregasAntes',
      'llegadaEstimada',
      'pasoAlFinalDelRecorrido',
      'reprogramadoPara',
      'situacion',
      'viajeIniciado',
    ]);
    expect(JSON.stringify(reparto)).not.toMatch(/hoja-1|15:22|T\d\d:/);
    // La consulta de la hoja no trae datos de otros clientes: sólo cuenta.
    const sql = consultas.map((c) => c.sql).join('\n');
    expect(sql).not.toMatch(
      /full_name|formattedAddress|phone|deliveryPoint|ST_/,
    );
    expect(sql).toContain('count(*)::int');
  });
});
