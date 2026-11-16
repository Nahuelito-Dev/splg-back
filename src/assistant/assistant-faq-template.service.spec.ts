import type { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  AssistantFaqTemplateService,
  CERROJO_DEL_CATALOGO,
} from './assistant-faq-template.service';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import { AssistantFaq } from './entities/assistant-faq.entity';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/**
 * El catálogo en memoria: entiende el cerrojo, el repositorio y la baja por
 * SQL. Cada llamada queda anotada para verificar el orden (cerrojo antes de
 * leer o escribir).
 */
function catalogoEnMemoria() {
  const filas: AssistantFaqTemplate[] = [];
  /** Preguntas de las bases de las distribuidoras (para `alreadyInBase`). */
  const faqs: Array<Pick<AssistantFaq, 'distributorId' | 'key' | 'question'>> =
    [];
  const llamadas: string[] = [];
  let reloj = Date.parse('2026-11-15T12:00:00Z');
  let secuencia = 0;
  let fallaAlGuardar: Error | null = null;

  const vigentes = () =>
    filas
      .filter((f) => f.deletedAt === null)
      .sort((x, y) => x.position - y.position);

  const repoDeEjemplos = {
    find: jest.fn(() => {
      llamadas.push('find');
      return Promise.resolve(vigentes().map((f) => ({ ...f })));
    }),
    findOne: jest.fn((opciones: { where: { templateId: string } }) => {
      llamadas.push('findOne');
      const fila = vigentes().find(
        (f) => f.templateId === opciones.where.templateId,
      );
      return Promise.resolve(fila ? { ...fila } : null);
    }),
    create: jest.fn((datos: Partial<AssistantFaqTemplate>) =>
      Object.assign(new AssistantFaqTemplate(), datos),
    ),
    save: jest.fn((fila: AssistantFaqTemplate) => {
      llamadas.push('save');
      if (fallaAlGuardar) return Promise.reject(fallaAlGuardar);
      reloj += 1000;
      if (!fila.templateId) {
        secuencia += 1;
        Object.assign(fila, {
          templateId: `ejemplo-${secuencia}`,
          createdAt: new Date(reloj),
          deletedAt: null,
        });
        fila.updatedAt = new Date(reloj);
        filas.push(fila);
        return Promise.resolve(fila);
      }
      const guardada = filas.find((f) => f.templateId === fila.templateId)!;
      Object.assign(guardada, fila, { updatedAt: new Date(reloj) });
      return Promise.resolve(guardada);
    }),
  };

  const repoDePreguntas = {
    find: jest.fn((opciones: { where: { distributorId: string } }) => {
      llamadas.push('preguntasDeLaEmpresa');
      return Promise.resolve(
        faqs.filter((f) => f.distributorId === opciones.where.distributorId),
      );
    }),
  };

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      llamadas.push(`cerrojo:${String(params[0])}`);
      return Promise.resolve([]);
    }
    if (sql.includes('UPDATE "assistant_faq_template"')) {
      llamadas.push('baja');
      const fila = filas.find(
        (f) => f.templateId === params[0] && f.deletedAt === null,
      );
      if (fila) {
        fila.deletedAt = new Date(reloj);
        fila.updatedBy = params[1] as string | null;
      }
      return Promise.resolve([[], fila ? 1 : 0]);
    }
    return Promise.reject(new Error(`SQL inesperado: ${sql}`));
  });

  const getRepository = (entidad: unknown) =>
    entidad === AssistantFaqTemplate ? repoDeEjemplos : repoDePreguntas;
  const manager = { query, getRepository };
  type Trabajo = (m: typeof manager) => Promise<unknown>;
  const transaction = jest.fn((nivel: string | Trabajo, trabajo?: Trabajo) =>
    typeof nivel === 'function' ? nivel(manager) : trabajo!(manager),
  );
  const dataSource = { getRepository, transaction };

  return {
    filas,
    faqs,
    llamadas,
    query,
    transaction,
    repoDeEjemplos,
    service: new AssistantFaqTemplateService(
      dataSource as unknown as DataSource,
    ),
    fallarAlGuardar: (error: Error | null) => {
      fallaAlGuardar = error;
    },
  };
}

async function cuerpoDelError(
  promesa: Promise<unknown>,
): Promise<Record<string, unknown> & { status: number; message?: unknown }> {
  try {
    await promesa;
  } catch (e) {
    return {
      status: (e as HttpException).getStatus(),
      ...((e as HttpException).getResponse() as Record<string, unknown>),
    };
  }
  throw new Error('no lanzó');
}

const ejemplo = (n: number, key = `ejemplo_${n}`) => ({
  key,
  question: `¿Pregunta de ejemplo ${n}?`,
  answer: `Respuesta ${n}`,
});

describe('AssistantFaqTemplateService (catálogo de preguntas de ejemplo, D-B7)', () => {
  describe('alta y lectura', () => {
    it('crea al final del catálogo, con quién la cargó, bajo el cerrojo del catálogo', async () => {
      const m = catalogoEnMemoria();
      await m.service.crear(ejemplo(1), 's1');
      const fila = await m.service.crear(ejemplo(2), 's2');
      expect(fila).toMatchObject({
        key: 'ejemplo_2',
        question: '¿Pregunta de ejemplo 2?',
        position: 2,
        updatedBy: 's2',
      });
      expect(m.llamadas.slice(0, 3)).toEqual([
        `cerrojo:${CERROJO_DEL_CATALOGO}`,
        'find',
        'save',
      ]);
      expect((await m.service.listar()).map((f) => f.key)).toEqual([
        'ejemplo_1',
        'ejemplo_2',
      ]);
    });

    it('la lista sale por posición, no por fecha de alta', async () => {
      const m = catalogoEnMemoria();
      await m.service.crear(ejemplo(1), 's');
      await m.service.crear(ejemplo(2), 's');
      m.filas[0].position = 5;
      expect((await m.service.listar()).map((f) => f.key)).toEqual([
        'ejemplo_2',
        'ejemplo_1',
      ]);
      expect(m.repoDeEjemplos.find).toHaveBeenLastCalledWith({
        order: { position: 'ASC', createdAt: 'ASC' },
      });
    });

    it('la posición nueva es la siguiente a la más alta vigente (una baja no la reutiliza en el medio)', async () => {
      const m = catalogoEnMemoria();
      await m.service.crear(ejemplo(1), 's');
      const segunda = await m.service.crear(ejemplo(2), 's');
      await m.service.crear(ejemplo(3), 's');
      await m.service.darDeBaja(segunda.templateId, 's');
      await expect(m.service.crear(ejemplo(4), 's')).resolves.toMatchObject({
        position: 4,
      });
    });
  });

  describe('para la empresa', () => {
    it('marca las que su base ya tiene (por clave o por la misma pregunta); lo de otra empresa no cuenta', async () => {
      const m = catalogoEnMemoria();
      await m.service.crear(ejemplo(1, 'horarios'), 's');
      await m.service.crear(ejemplo(2, 'pagos'), 's');
      await m.service.crear(ejemplo(3, 'zonas'), 's');
      m.faqs.push(
        { distributorId: A, key: 'horarios', question: '¿Otra redacción?' },
        { distributorId: A, key: null, question: '  ¿PREGUNTA DE EJEMPLO 2?' },
        { distributorId: B, key: 'zonas', question: '¿Zonas?' },
      );
      const lista = await m.service.listarParaEmpresa(A);
      expect(lista.map((e) => [e.ejemplo.key, e.yaEnLaBase])).toEqual([
        ['horarios', true],
        ['pagos', true],
        ['zonas', false],
      ]);
      expect(m.transaction).toHaveBeenLastCalledWith(
        'REPEATABLE READ',
        expect.any(Function),
      );
      expect(m.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.anything(),
      );
    });
  });

  describe('400: la segunda capa (sin pasar por el DTO)', () => {
    it.each([
      ['clave con mayúsculas', { ...ejemplo(1), key: 'Horario' }, /clave/i],
      ['clave de una letra', { ...ejemplo(1), key: 'h' }, /clave/i],
      ['clave larga', { ...ejemplo(1), key: 'a'.repeat(61) }, /clave/i],
      [
        'pregunta con HTML',
        { ...ejemplo(1), question: '¿<b>Abren</b>?' },
        /HTML/,
      ],
      ['respuesta vacía', { ...ejemplo(1), answer: '  ' }, /respuesta/i],
    ])('%s', async (_caso, datos, mensaje) => {
      const m = catalogoEnMemoria();
      const error = await cuerpoDelError(m.service.crear(datos, 's'));
      expect(error).toMatchObject({ status: 400 });
      expect(String(error.message)).toMatch(mensaje);
      expect(m.query).not.toHaveBeenCalled();
    });

    it('la edición controla igual', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1), 's');
      expect(
        await cuerpoDelError(
          m.service.actualizar(fila.templateId, { answer: 'Sí &amp no' }, 's'),
        ),
      ).toMatchObject({ status: 400 });
    });
  });

  describe('409', () => {
    it('la misma pregunta (sin mayúsculas ni espacios de los bordes) es ASSISTANT_TEMPLATE_DUPLICATE', async () => {
      const m = catalogoEnMemoria();
      await m.service.crear(ejemplo(1), 's');
      expect(
        await cuerpoDelError(
          m.service.crear(
            { ...ejemplo(2), question: '  ¿PREGUNTA DE EJEMPLO 1?  ' },
            's',
          ),
        ),
      ).toMatchObject({
        status: 409,
        code: 'ASSISTANT_TEMPLATE_DUPLICATE',
        message: 'Ya hay una pregunta de ejemplo igual en el catálogo',
      });
    });

    it('la clave repetida es ASSISTANT_TEMPLATE_KEY_TAKEN; dada de baja queda libre', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1, 'pagos'), 's');
      expect(
        await cuerpoDelError(m.service.crear(ejemplo(2, 'pagos'), 's')),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_TEMPLATE_KEY_TAKEN' });
      await m.service.darDeBaja(fila.templateId, 's');
      await expect(
        m.service.crear(ejemplo(2, 'pagos'), 's'),
      ).resolves.toBeDefined();
    });

    it(`con ${TOPE_DE_PREGUNTAS} vigentes la siguiente es ASSISTANT_TEMPLATE_LIMIT_REACHED y no se guarda`, async () => {
      const m = catalogoEnMemoria();
      for (let i = 0; i < TOPE_DE_PREGUNTAS; i += 1) {
        await m.service.crear(ejemplo(i), 's');
      }
      const error = await cuerpoDelError(m.service.crear(ejemplo(999), 's'));
      expect(error).toMatchObject({
        status: 409,
        code: 'ASSISTANT_TEMPLATE_LIMIT_REACHED',
      });
      expect(error.message).toMatch(/máximo/);
      expect(m.filas).toHaveLength(TOPE_DE_PREGUNTAS);
    });

    it('si un único de la base salta igual, sale 409 con su code; otro error pasa tal cual', async () => {
      const m = catalogoEnMemoria();
      m.fallarAlGuardar(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          driverError: {
            constraint: 'UQ_assistant_faq_template_pregunta_vigente',
          },
        }),
      );
      expect(
        await cuerpoDelError(m.service.crear(ejemplo(1), 's')),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_TEMPLATE_DUPLICATE' });
      m.fallarAlGuardar(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_assistant_faq_template_clave_vigente',
        }),
      );
      expect(
        await cuerpoDelError(m.service.crear(ejemplo(1), 's')),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_TEMPLATE_KEY_TAKEN' });
      const otro = new Error('se cayó la conexión');
      m.fallarAlGuardar(otro);
      await expect(m.service.crear(ejemplo(1), 's')).rejects.toBe(otro);
    });
  });

  describe('edición', () => {
    it('cambia lo que viene, deja lo demás y anota quién', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1), 's1');
      await expect(
        m.service.actualizar(fila.templateId, { answer: 'Nueva' }, 's2'),
      ).resolves.toMatchObject({
        key: 'ejemplo_1',
        question: '¿Pregunta de ejemplo 1?',
        answer: 'Nueva',
        position: 1,
        updatedBy: 's2',
      });
    });

    it('sin cambios no escribe', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1), 's');
      m.repoDeEjemplos.save.mockClear();
      await m.service.actualizar(fila.templateId, { answer: fila.answer }, 's');
      await m.service.actualizar(fila.templateId, {}, 's');
      expect(m.repoDeEjemplos.save).not.toHaveBeenCalled();
    });

    it('cambiar sólo mayúsculas de la propia pregunta no choca; llevarla a la de otra sí (409)', async () => {
      const m = catalogoEnMemoria();
      const una = await m.service.crear(ejemplo(1), 's');
      await m.service.crear(ejemplo(2), 's');
      await expect(
        m.service.actualizar(
          una.templateId,
          { question: '¿PREGUNTA DE EJEMPLO 1?' },
          's',
        ),
      ).resolves.toMatchObject({ question: '¿PREGUNTA DE EJEMPLO 1?' });
      expect(
        await cuerpoDelError(
          m.service.actualizar(
            una.templateId,
            { question: '¿Pregunta de ejemplo 2?' },
            's',
          ),
        ),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_TEMPLATE_DUPLICATE' });
      await expect(
        m.service.actualizar(
          una.templateId,
          { question: '¿Pregunta de ejemplo 3?' },
          's',
        ),
      ).resolves.toMatchObject({ question: '¿Pregunta de ejemplo 3?' });
    });

    it('edita bajo el cerrojo del catálogo', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1), 's');
      m.llamadas.length = 0;
      await m.service.actualizar(fila.templateId, { answer: 'Otra' }, 's');
      expect(m.llamadas[0]).toBe(`cerrojo:${CERROJO_DEL_CATALOGO}`);
    });
  });

  describe('404 y baja lógica', () => {
    it('marca la baja (no borra) y anota quién; la segunda baja y la edición de una dada de baja son 404', async () => {
      const m = catalogoEnMemoria();
      const fila = await m.service.crear(ejemplo(1), 's1');
      await m.service.darDeBaja(fila.templateId, 's2');
      expect(m.filas).toHaveLength(1);
      expect(m.filas[0].deletedAt).toBeInstanceOf(Date);
      expect(m.filas[0].updatedBy).toBe('s2');
      expect(await m.service.listar()).toEqual([]);
      for (const intento of [
        m.service.darDeBaja(fila.templateId, 's'),
        m.service.actualizar(fila.templateId, { answer: 'x' }, 's'),
      ]) {
        expect(await cuerpoDelError(intento)).toMatchObject({
          status: 404,
          code: 'ASSISTANT_TEMPLATE_NOT_FOUND',
          message: 'No existe esa pregunta de ejemplo',
        });
      }
    });

    it('un id que no existe es 404', async () => {
      const m = catalogoEnMemoria();
      expect(
        await cuerpoDelError(m.service.darDeBaja('no-existe', 's')),
      ).toMatchObject({ status: 404, code: 'ASSISTANT_TEMPLATE_NOT_FOUND' });
    });
  });
});
