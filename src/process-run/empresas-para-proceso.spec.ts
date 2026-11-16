import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import type {
  AccesoDeLaEmpresa,
  AccesoVigente,
  NivelDeAcceso,
} from '../platform/access/acceso-de-la-empresa.service';
import type { ModuloKey } from '../platform/modules/catalogo-de-modulos';
import type { RedisService } from '../redis/redis.service';
import { CATALOGO, ProcessName } from './domain/process-catalog';
import { EmpresasParaProceso } from './empresas-para-proceso';
import { dentroDeCorrida, nuevaCorrida } from './process-run.context';
import { RedisEnMemoria } from './testing/empresas-de-prueba';

const esperar = (ms: number) =>
  new Promise<void>((listo) => setTimeout(listo, ms));

describe('EmpresasParaProceso (DISENO-PLATAFORMA-ORIXTECH §6.3 y §9)', () => {
  let distribuidoras: { findAll: jest.Mock };
  let niveles: Map<string, NivelDeAcceso>;
  let sinModulo: Map<string, ModuloKey>;
  let redis: RedisEnMemoria;
  let eventos: { emit: jest.Mock };
  let empresas: EmpresasParaProceso;
  /** Cuánto tarda en leerse el acceso de cada empresa (ms). */
  let demoraDelAcceso: Map<string, number>;
  /** Lecturas del acceso: `cache` (vigente) o `fresca` (calcular). */
  let lecturas: Array<[string, 'cache' | 'fresca']>;

  const opciones = {
    proceso: ProcessName.DOCUMENT_READING,
    modulo: 'document_reading' as const,
  };

  beforeEach(() => {
    distribuidoras = {
      findAll: jest.fn().mockResolvedValue([
        { distributorId: 'A', name: 'Empresa A' },
        { distributorId: 'B', name: 'Empresa B' },
      ]),
    };
    niveles = new Map();
    sinModulo = new Map();
    demoraDelAcceso = new Map();
    lecturas = [];
    const leer = async (id: string): Promise<AccesoVigente> => {
      await esperar(demoraDelAcceso.get(id) ?? 0);
      return {
        distributorId: id,
        nivel: niveles.get(id) ?? 'full',
        aceptaPedidos: true,
        modulos: new Set<ModuloKey>(
          sinModulo.has(id)
            ? ['repurchase']
            : ['document_reading', 'repurchase'],
        ),
        limites: {
          maxDrivers: null,
          maxAdmins: null,
          maxOrdersMonth: null,
          documentReadingUsdMonth: null,
        },
        motivo: null,
        planCode: 'full',
      };
    };
    const acceso = {
      vigente: (id: string) => {
        lecturas.push([id, 'cache']);
        return leer(id);
      },
      calcular: (id: string) => {
        lecturas.push([id, 'fresca']);
        return leer(id);
      },
    };
    redis = new RedisEnMemoria();
    eventos = { emit: jest.fn() };
    empresas = new EmpresasParaProceso(
      distribuidoras as unknown as DistributorService,
      acceso as unknown as AccesoDeLaEmpresa,
      redis as unknown as RedisService,
      eventos as unknown as EventEmitter2,
    );
  });

  it('corre todas las empresas vigentes y devuelve lo de cada una', async () => {
    const r = await empresas.recorrer(opciones, (id) =>
      Promise.resolve(`hecho ${id}`),
    );
    expect(r.salteadas).toBe(0);
    expect(r.empresas).toEqual(
      expect.arrayContaining([
        { distributorId: 'A', estado: 'ok', valor: 'hecho A' },
        { distributorId: 'B', estado: 'ok', valor: 'hecho B' },
      ]),
    );
  });

  it('sólo las que tienen el módulo habilitado; sin módulo (núcleo) corren todas', async () => {
    sinModulo.set('A', 'document_reading');
    const fn = jest.fn().mockResolvedValue(1);
    const r = await empresas.recorrer(opciones, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('B', expect.anything());
    expect(r.salteadas).toBe(1);

    fn.mockClear();
    await empresas.recorrer({ ...opciones, modulo: null }, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('saltea las bloqueadas y, si el proceso crea cosas, las restringidas', async () => {
    niveles.set('A', 'blocked');
    niveles.set('B', 'restricted');
    const fn = jest.fn().mockResolvedValue(1);
    await empresas.recorrer({ ...opciones, modulo: null }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('B', expect.anything());

    fn.mockClear();
    const r = await empresas.recorrer(
      { ...opciones, modulo: null, crea: true },
      fn,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(r.salteadas).toBe(2);
  });

  it('con `entre` recorre sólo esas candidatas, sin repetir', async () => {
    const fn = jest.fn().mockResolvedValue(1);
    await empresas.recorrer({ ...opciones, entre: ['B', 'B', 'C'] }, fn);
    expect(fn.mock.calls.map(([id]) => id as string).sort()).toEqual([
      'B',
      'C',
    ]);
  });

  describe('no interferencia (proceso falso)', () => {
    it('A lanza error → B corre y termina ok; la corrida cuenta la falla de A', async () => {
      const corrida = nuevaCorrida();
      const r = await dentroDeCorrida(corrida, () =>
        empresas.recorrer(opciones, (id) =>
          id === 'A'
            ? Promise.reject(new Error('la base de A no responde'))
            : Promise.resolve('ok B'),
        ),
      );
      const porEmpresa = Object.fromEntries(
        r.empresas.map((e) => [e.distributorId, e.estado]),
      );
      expect(porEmpresa).toEqual({ A: 'failed', B: 'ok' });
      expect(corrida.errors).toBe(1);
      expect(corrida.fatal).toBeNull();
      expect(corrida.lastError).toMatch(/la base de A/);
      // Monitor O1: el resumen por empresa queda en la corrida (`process_run.companies`).
      expect(corrida.companies).toEqual({
        ok: 1,
        failed: 1,
        timeout: 0,
        locked: 0,
        circuit_open: 0,
        paused: 0,
        skipped: 0,
      });
    });

    it('una empresa sin el módulo suma en skipped, no como corrida', async () => {
      sinModulo.set('A', 'repurchase');
      const corrida = nuevaCorrida();
      await dentroDeCorrida(corrida, () =>
        empresas.recorrer(opciones, () => Promise.resolve(1)),
      );
      expect(corrida.companies).toMatchObject({ ok: 1, skipped: 1 });
    });

    it('A tarda 10 veces su presupuesto → B termina dentro del tic y A queda cortada', async () => {
      const presupuestoMs = 40;
      const inicio = Date.now();
      let terminoB = 0;
      const corrida = nuevaCorrida();
      const r = await dentroDeCorrida(corrida, () =>
        empresas.recorrer({ ...opciones, presupuestoMs }, async (id) => {
          if (id === 'A') {
            await esperar(presupuestoMs * 10);
            return 'tarde';
          }
          await esperar(5);
          terminoB = Date.now() - inicio;
          return 'ok B';
        }),
      );
      const total = Date.now() - inicio;
      const porEmpresa = Object.fromEntries(
        r.empresas.map((e) => [e.distributorId, e.estado]),
      );
      expect(porEmpresa).toEqual({ A: 'timeout', B: 'ok' });
      expect(terminoB).toBeLessThan(presupuestoMs);
      // El recorrido no esperó a A: terminó con el presupuesto, no con los 400 ms.
      expect(total).toBeLessThan(presupuestoMs * 5);
      expect(corrida.errors).toBe(1);
      // A sigue con su cerrojo tomado hasta terminar: el próximo tic no la pisa.
      expect(redis.cerrojos.has(`${opciones.proceso}:A`)).toBe(true);
      await esperar(presupuestoMs * 10);
      expect(redis.cerrojos.has(`${opciones.proceso}:A`)).toBe(false);
    });

    it('A tarda 10 veces su presupuesto LEYENDO SU ACCESO → B corre igual dentro del tic', async () => {
      const presupuestoMs = 40;
      demoraDelAcceso.set('A', presupuestoMs * 10);
      const inicio = Date.now();
      const fn = jest.fn().mockResolvedValue('ok');
      const r = await empresas.recorrer({ ...opciones, presupuestoMs }, fn);
      const porEmpresa = Object.fromEntries(
        r.empresas.map((e) => [e.distributorId, e.estado]),
      );
      expect(porEmpresa).toEqual({ A: 'timeout', B: 'ok' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('B', expect.anything());
      expect(Date.now() - inicio).toBeLessThan(presupuestoMs * 5);
      await esperar(presupuestoMs * 10);
    });

    it('con concurrencia 1 una empresa lenta igual no frena a la siguiente más allá de su presupuesto', async () => {
      const r = await empresas.recorrer(
        { ...opciones, presupuestoMs: 30, concurrencia: 1 },
        async (id) => {
          if (id === 'A') await esperar(300);
          return id;
        },
      );
      expect(r.empresas.map((e) => [e.distributorId, e.estado])).toEqual([
        ['A', 'timeout'],
        ['B', 'ok'],
      ]);
    });

    it('lo que falla después del presupuesto sólo queda en el log', async () => {
      const r = await empresas.recorrer(
        { ...opciones, presupuestoMs: 10 },
        async (id) => {
          if (id === 'A') {
            await esperar(40);
            throw new Error('tarde y mal');
          }
          return id;
        },
      );
      expect(r.empresas.find((e) => e.distributorId === 'A')?.estado).toBe(
        'timeout',
      );
      await esperar(60);
    });
  });

  it('sigueHabilitada consulta el acceso sin caché: si el módulo se apagó después de elegir la empresa, no se crea nada', async () => {
    const creadas: string[] = [];
    await empresas.recorrer(opciones, async (id, empresa) => {
      // La plataforma apaga el lector de A mientras el proceso ya la eligió.
      if (id === 'A') sinModulo.set('A', 'document_reading');
      if (await empresa.sigueHabilitada()) creadas.push(id);
    });
    expect(creadas).toEqual(['B']);
    expect(lecturas).toEqual(
      expect.arrayContaining([
        ['A', 'cache'],
        ['A', 'fresca'],
        ['B', 'fresca'],
      ]),
    );
  });

  it('sigueHabilitada también corta una empresa bloqueada en medio del tic (proceso del núcleo)', async () => {
    const r = await empresas.recorrer(
      { ...opciones, modulo: null },
      async (id, empresa) => {
        niveles.set(id, 'blocked');
        return empresa.sigueHabilitada();
      },
    );
    expect(r.empresas.map((e) => e.valor)).toEqual([false, false]);
  });

  it('cerrojo por empresa: si otra instancia procesa A, B corre igual', async () => {
    redis.cerrojos.add(`${opciones.proceso}:A`);
    const fn = jest.fn().mockResolvedValue(1);
    const r = await empresas.recorrer(opciones, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('B', expect.anything());
    expect(r.empresas.find((e) => e.distributorId === 'A')?.estado).toBe(
      'locked',
    );
  });

  describe('cortacircuito por empresa', () => {
    const fallaA = (id: string) =>
      id === 'A' ? Promise.reject(new Error('caída')) : Promise.resolve(id);

    it('tras tres fallas seguidas saltea a A con espera creciente y avisa una vez a la plataforma', async () => {
      let ahora = 1_000_000;
      const reloj = () => ahora;
      for (let i = 0; i < 3; i++) {
        await empresas.recorrer(opciones, fallaA, reloj);
      }
      expect(eventos.emit).toHaveBeenCalledTimes(1);
      const [nombre, aviso] = eventos.emit.mock.calls[0] as [
        string,
        { distributorId: string | null; kind: string; title: string },
      ];
      expect(nombre).toBe(EVENTO_NOTIFICAR_ADMIN);
      expect(aviso).toMatchObject({
        distributorId: null,
        kind: 'process_circuit_open',
      });
      expect(aviso.title).toMatch(/Empresa A/);

      const fn = jest.fn(fallaA);
      let r = await empresas.recorrer(opciones, fn, reloj);
      expect(fn).not.toHaveBeenCalledWith('A', expect.anything());
      expect(fn).toHaveBeenCalledWith('B', expect.anything());
      expect(r.empresas.find((e) => e.distributorId === 'A')?.estado).toBe(
        'circuit_open',
      );

      // Pasado el minuto de espera vuelve a probar; si falla, espera el doble.
      ahora += EmpresasParaProceso.ESPERA_BASE_MS + 1;
      r = await empresas.recorrer(opciones, fallaA, reloj);
      expect(r.empresas.find((e) => e.distributorId === 'A')?.estado).toBe(
        'failed',
      );
      const circuito = JSON.parse(
        (await redis.get(`circuito:${opciones.proceso}:A`)) ?? '{}',
      ) as { fallas: number; hasta: number };
      expect(circuito).toEqual({
        fallas: 4,
        hasta: ahora + 2 * EmpresasParaProceso.ESPERA_BASE_MS,
      });
      // No repite el aviso.
      expect(eventos.emit).toHaveBeenCalledTimes(1);
    });

    it('una corrida buena cierra el circuito', async () => {
      await empresas.recorrer(opciones, fallaA);
      expect(await redis.get(`circuito:${opciones.proceso}:A`)).not.toBeNull();
      await empresas.recorrer(opciones, (id) => Promise.resolve(id));
      expect(await redis.get(`circuito:${opciones.proceso}:A`)).toBeNull();
    });

    it('la espera tiene tope de una hora', async () => {
      await redis.setex(
        `circuito:${opciones.proceso}:A`,
        60,
        JSON.stringify({ fallas: 20, hasta: 0 }),
      );
      const ahora = 5_000;
      await empresas.recorrer(opciones, fallaA, () => ahora);
      const circuito = JSON.parse(
        (await redis.get(`circuito:${opciones.proceso}:A`)) ?? '{}',
      ) as { hasta: number };
      expect(circuito.hasta).toBe(ahora + EmpresasParaProceso.ESPERA_TOPE_MS);
    });

    it('si Redis no responde, el cortacircuito no frena el proceso', async () => {
      jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis caído'));
      jest.spyOn(redis, 'setex').mockRejectedValue(new Error('redis caído'));
      jest.spyOn(redis, 'del').mockRejectedValue(new Error('redis caído'));
      const r = await empresas.recorrer(opciones, fallaA);
      expect(r.empresas.map((e) => e.estado).sort()).toEqual(['failed', 'ok']);
    });

    it('si Redis no responde al cerrar el circuito, la corrida buena igual cuenta', async () => {
      await empresas.recorrer(opciones, fallaA);
      jest.spyOn(redis, 'del').mockRejectedValue(new Error('redis caído'));
      const r = await empresas.recorrer(opciones, (id) => Promise.resolve(id));
      expect(r.empresas.every((e) => e.estado === 'ok')).toBe(true);
    });
  });

  it('el aviso de una empresa sin nombre conocido no la nombra', async () => {
    const fn = (id: string) =>
      id === 'Z' ? Promise.reject(new Error('x')) : Promise.resolve(id);
    for (let i = 0; i < EmpresasParaProceso.UMBRAL; i++) {
      await empresas.recorrer({ ...opciones, entre: ['Z'] }, fn);
    }
    const [[, aviso]] = eventos.emit.mock.calls as Array<
      [string, { title: string }]
    >;
    expect(aviso.title).toBe(
      `Proceso automático en pausa: ${CATALOGO[opciones.proceso].title}`,
    );
  });

  it('una empresa suspendida en la lista de la base no corre', async () => {
    distribuidoras.findAll.mockResolvedValue([
      { distributorId: 'A', status: DistributorStatus.SUSPENDED },
    ]);
    niveles.set('A', 'blocked');
    const fn = jest.fn();
    await empresas.recorrer(opciones, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
