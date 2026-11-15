import { ConflictException, NotFoundException } from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import type { DataSource } from 'typeorm';
import {
  AssistantFaqService,
  normalizarPregunta,
} from './assistant-faq.service';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import { AssistantFaq } from './entities/assistant-faq.entity';
import { AssistantKnowledgeBase } from './entities/assistant-knowledge-base.entity';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Base {
  id: string;
  distributorId: string | null;
  version: number;
}

/**
 * Una base en memoria que entiende lo que el servicio le pide: la cabecera
 * (alta, bloqueo, versión) por SQL y las preguntas por repositorio. Cada
 * llamada queda anotada para verificar el orden (bloquear antes de leer).
 */
function baseEnMemoria() {
  const bases: Base[] = [];
  const faqs: AssistantFaq[] = [];
  /** El catálogo de preguntas de ejemplo (D-B7), cargado a mano por cada test. */
  const ejemplos: AssistantFaqTemplate[] = [];
  const llamadas: string[] = [];
  let reloj = Date.parse('2026-11-15T12:00:00Z');
  let secuencia = 0;
  let fallaAlGuardar: Error | null = null;

  const coincide = (
    fila: AssistantFaq,
    where: Record<string, unknown>,
  ): boolean =>
    Object.entries(where).every(([campo, valor]) => {
      const actual = (fila as unknown as Record<string, unknown>)[campo];
      if (valor instanceof FindOperator) {
        return valor.type === 'isNull' ? actual === null : false;
      }
      return actual === valor;
    });

  /** Respeta el `order` que pide el servicio (sin `order`, el de inserción). */
  const vigentes = (
    where: Record<string, unknown>,
    order: Record<string, 'ASC' | 'DESC'> = {},
  ) =>
    faqs
      .filter((f) => f.deletedAt === null && coincide(f, where))
      .sort((x, y) => {
        for (const campo of Object.keys(order)) {
          const a = (x as unknown as Record<string, number | Date>)[campo];
          const b = (y as unknown as Record<string, number | Date>)[campo];
          const dif = Number(a) - Number(b);
          if (dif !== 0) return dif;
        }
        return 0;
      });

  /** Como `now()` de Postgres: todo lo que se guarda en una misma llamada lleva la misma fecha. */
  const guardar = (fila: AssistantFaq): AssistantFaq => {
    if (!fila.faqId) {
      secuencia += 1;
      Object.assign(fila, {
        faqId: `faq-${secuencia}`,
        createdAt: new Date(reloj),
        deletedAt: null,
      });
      faqs.push(fila);
    }
    fila.updatedAt = new Date(reloj);
    return fila;
  };

  const repoDePreguntas = {
    find: jest.fn(
      (opciones: {
        where: Record<string, unknown>;
        order?: Record<string, 'ASC' | 'DESC'>;
      }): Promise<AssistantFaq[]> => {
        llamadas.push('find');
        return Promise.resolve(
          vigentes(opciones.where, opciones.order).map((f) => ({ ...f })),
        );
      },
    ),
    findOne: jest.fn(
      (opciones: {
        where: Record<string, unknown>;
      }): Promise<AssistantFaq | null> => {
        llamadas.push('findOne');
        const fila = vigentes(opciones.where)[0];
        return Promise.resolve(fila ?? null);
      },
    ),
    create: jest.fn((datos: Partial<AssistantFaq>) =>
      Object.assign(new AssistantFaq(), datos),
    ),
    save: jest.fn((filas: AssistantFaq | AssistantFaq[]): Promise<unknown> => {
      llamadas.push('save');
      if (fallaAlGuardar) return Promise.reject(fallaAlGuardar);
      reloj += 1000;
      return Promise.resolve(
        Array.isArray(filas) ? filas.map(guardar) : guardar(filas),
      );
    }),
  };

  const repoDeBases = {
    findOne: jest.fn(
      (opciones: {
        where: { distributorId: unknown };
      }): Promise<Base | null> => {
        const id = opciones.where.distributorId;
        const buscado = id instanceof FindOperator ? null : id;
        return Promise.resolve(
          bases.find((b) => b.distributorId === buscado) ?? null,
        );
      },
    ),
  };

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO "assistant_knowledge_base"')) {
      llamadas.push('crearBase');
      const duenio = params[0] as string | null;
      if (!bases.some((b) => b.distributorId === duenio)) {
        bases.push({
          id: `base-${duenio ?? 'plataforma'}`,
          distributorId: duenio,
          version: 0,
        });
      }
      return Promise.resolve([]);
    }
    if (sql.includes('FOR UPDATE')) {
      llamadas.push('bloquear');
      const duenio = sql.includes('IS NULL') ? null : (params[0] as string);
      const base = bases.find((b) => b.distributorId === duenio);
      return Promise.resolve(
        base ? [{ id: base.id, version: base.version }] : [],
      );
    }
    if (sql.includes('UPDATE "assistant_knowledge_base"')) {
      llamadas.push('subirVersion');
      const base = bases.find((b) => b.id === params[0]);
      if (base) base.version += 1;
      return Promise.resolve([[], 1]);
    }
    if (sql.includes('UPDATE "assistant_faq"')) {
      llamadas.push('baja');
      const fila = faqs.find(
        (f) => f.faqId === params[0] && f.deletedAt === null,
      );
      if (fila) {
        fila.deletedAt = new Date(reloj);
        fila.updatedBy = params[1] as string | null;
      }
      return Promise.resolve([[], fila ? 1 : 0]);
    }
    return Promise.reject(new Error(`SQL inesperado: ${sql}`));
  });

  const repoDeEjemplos = {
    find: jest.fn(
      (opciones: {
        order?: Record<string, 'ASC' | 'DESC'>;
      }): Promise<AssistantFaqTemplate[]> => {
        llamadas.push('ejemplos');
        const campos = Object.keys(opciones.order ?? {});
        return Promise.resolve(
          ejemplos
            .filter((e) => e.deletedAt === null)
            .sort((x, y) => {
              for (const campo of campos) {
                const a = (x as unknown as Record<string, number | Date>)[
                  campo
                ];
                const b = (y as unknown as Record<string, number | Date>)[
                  campo
                ];
                const dif = Number(a) - Number(b);
                if (dif !== 0) return dif;
              }
              return 0;
            })
            .map((e) => ({ ...e })),
        );
      },
    ),
  };

  const getRepository = (entidad: unknown) =>
    entidad === AssistantKnowledgeBase
      ? repoDeBases
      : entidad === AssistantFaqTemplate
        ? repoDeEjemplos
        : repoDePreguntas;
  const manager = { query, getRepository };
  type Trabajo = (m: typeof manager) => Promise<unknown>;
  const dataSource = {
    // Todo pasa por una transacción: leer afuera rompería la foto común.
    getRepository: () => {
      throw new Error('lectura fuera de una transacción');
    },
    transaction: jest.fn((nivel: string | Trabajo, trabajo?: Trabajo) =>
      typeof nivel === 'function' ? nivel(manager) : trabajo!(manager),
    ),
  };

  /** Carga una pregunta de ejemplo en el catálogo (vigente, al final). */
  const ejemplo = (
    key: string,
    question: string,
    answer = 'Respuesta de ejemplo',
    position = ejemplos.length + 1,
  ): AssistantFaqTemplate => {
    const fila = Object.assign(new AssistantFaqTemplate(), {
      templateId: `ejemplo-${key}`,
      key,
      question,
      answer,
      position,
      updatedBy: 's',
      createdAt: new Date(reloj),
      updatedAt: new Date(reloj),
      deletedAt: null,
    });
    ejemplos.push(fila);
    return fila;
  };

  return {
    bases,
    faqs,
    ejemplos,
    ejemplo,
    repoDeEjemplos,
    llamadas,
    query,
    repoDePreguntas,
    transaction: dataSource.transaction,
    service: new AssistantFaqService(dataSource as unknown as DataSource),
    fallarAlGuardar: (error: Error) => {
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

const pregunta = (n: number) => ({
  question: `¿Pregunta número ${n}?`,
  answer: `Respuesta ${n}`,
});

describe('AssistantFaqService', () => {
  describe('alta y lectura', () => {
    it('una empresa carga su pregunta: sin clave, sin plantilla, con quién la cargó, y la base sube a la versión 1', async () => {
      const m = baseEnMemoria();
      const fila = await m.service.crear(A, pregunta(1), 'admin-a');
      expect(fila).toMatchObject({
        distributorId: A,
        knowledgeBaseId: `base-${A}`,
        key: null,
        createdBy: 'admin-a',
        updatedBy: 'admin-a',
      });
      const base = await m.service.listar(A);
      expect(base.version).toBe(1);
      expect(base.items.map((f) => f.question)).toEqual([
        '¿Pregunta número 1?',
      ]);
    });

    it('bloquea la cabecera de la base antes de leer o escribir (las altas de una base van en fila)', async () => {
      const m = baseEnMemoria();
      await m.service.crear(A, pregunta(1), 'admin-a');
      expect(m.llamadas).toEqual([
        'crearBase',
        'bloquear',
        'find',
        'save',
        'subirVersion',
      ]);
    });

    it('sin nada cargado la base está vacía y en versión 0 (leer no crea nada)', async () => {
      const m = baseEnMemoria();
      await expect(m.service.listar(A)).resolves.toEqual({
        items: [],
        version: 0,
      });
      expect(m.bases).toHaveLength(0);
    });

    it('aislamiento: cada empresa y la plataforma ven sólo lo suyo', async () => {
      const m = baseEnMemoria();
      await m.service.crear(A, pregunta(1), 'admin-a');
      await m.service.crear(B, pregunta(2), 'admin-b');
      await m.service.crear(null, { ...pregunta(3), key: 'tres' }, 'super');
      expect(
        (await m.service.listar(A)).items.map((f) => f.distributorId),
      ).toEqual([A]);
      expect(
        (await m.service.listar(B)).items.map((f) => f.distributorId),
      ).toEqual([B]);
      expect((await m.service.listar(null)).items.map((f) => f.key)).toEqual([
        'tres',
      ]);
    });
  });

  describe('409', () => {
    it('la misma pregunta (sin distinguir mayúsculas ni espacios de los bordes) es ASSISTANT_FAQ_DUPLICATE; en otra empresa no choca', async () => {
      const m = baseEnMemoria();
      await m.service.crear(
        A,
        { question: '¿Hasta qué hora abren?', answer: 'x' },
        'a',
      );
      expect(
        await cuerpoDelError(
          m.service.crear(
            A,
            { question: '  ¿HASTA QUÉ HORA ABREN?  ', answer: 'y' },
            'a',
          ),
        ),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_FAQ_DUPLICATE' });
      await expect(
        m.service.crear(
          B,
          { question: '¿Hasta qué hora abren?', answer: 'z' },
          'b',
        ),
      ).resolves.toMatchObject({ distributorId: B });
      expect(normalizarPregunta('  ¿Abren?  ')).toBe('¿abren?');
    });

    it('la clave repetida en la plataforma es ASSISTANT_FAQ_KEY_TAKEN', async () => {
      const m = baseEnMemoria();
      await m.service.crear(
        null,
        { ...pregunta(1), key: 'medios_de_pago' },
        's',
      );
      expect(
        await cuerpoDelError(
          m.service.crear(null, { ...pregunta(2), key: 'medios_de_pago' }, 's'),
        ),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_FAQ_KEY_TAKEN' });
    });

    it(`con ${TOPE_DE_PREGUNTAS} vigentes la siguiente es ASSISTANT_FAQ_LIMIT_REACHED y no se guarda; una baja libera el lugar`, async () => {
      const m = baseEnMemoria();
      for (let i = 0; i < TOPE_DE_PREGUNTAS; i += 1) {
        await m.service.crear(A, pregunta(i), 'a');
      }
      const error = await cuerpoDelError(
        m.service.crear(A, pregunta(999), 'a'),
      );
      expect(error).toMatchObject({
        status: 409,
        code: 'ASSISTANT_FAQ_LIMIT_REACHED',
      });
      expect(error.message).toMatch(/máximo/);
      expect(m.faqs).toHaveLength(TOPE_DE_PREGUNTAS);
      await m.service.darDeBaja(A, m.faqs[0].faqId, 'a');
      await expect(
        m.service.crear(A, pregunta(999), 'a'),
      ).resolves.toBeDefined();
    });

    it('si el único de la base salta igual (algo se escapó del bloqueo), sale 409 con su code; otro error pasa tal cual', async () => {
      const m = baseEnMemoria();
      // Como lo envuelve TypeORM (`QueryFailedError` con el error del driver).
      m.fallarAlGuardar(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          driverError: { constraint: 'UQ_assistant_faq_pregunta_vigente' },
        }),
      );
      expect(
        await cuerpoDelError(m.service.crear(A, pregunta(1), 'a')),
      ).toMatchObject({
        status: 409,
        code: 'ASSISTANT_FAQ_DUPLICATE',
      });
      // Como lo da el driver directo.
      m.fallarAlGuardar(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_assistant_faq_clave_vigente',
        }),
      );
      expect(
        await cuerpoDelError(
          m.service.crear(null, { ...pregunta(1), key: 'k' }, 's'),
        ),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_FAQ_KEY_TAKEN' });
      const otro = new Error('se cayó la conexión');
      m.fallarAlGuardar(otro);
      await expect(m.service.crear(A, pregunta(2), 'a')).rejects.toBe(otro);
      const deOtroUnico = Object.assign(new Error('duplicate key'), {
        code: '23505',
        driverError: { constraint: 'UQ_otra_cosa' },
      });
      m.fallarAlGuardar(deOtroUnico);
      await expect(m.service.crear(A, pregunta(3), 'a')).rejects.toBe(
        deOtroUnico,
      );
    });
  });

  describe('edición', () => {
    it('cambia lo que viene, deja lo demás, anota quién y sube la versión', async () => {
      const m = baseEnMemoria();
      const fila = await m.service.crear(A, pregunta(1), 'a1');
      const editada = await m.service.actualizar(
        A,
        fila.faqId,
        { answer: 'Nueva' },
        'a2',
      );
      expect(editada).toMatchObject({
        question: '¿Pregunta número 1?',
        answer: 'Nueva',
        updatedBy: 'a2',
      });
      expect((await m.service.listar(A)).version).toBe(2);
    });

    it('sin cambios no escribe ni sube la versión', async () => {
      const m = baseEnMemoria();
      const fila = await m.service.crear(A, pregunta(1), 'a');
      m.repoDePreguntas.save.mockClear();
      await m.service.actualizar(A, fila.faqId, { answer: fila.answer }, 'a');
      await m.service.actualizar(A, fila.faqId, {}, 'a');
      expect(m.repoDePreguntas.save).not.toHaveBeenCalled();
      expect((await m.service.listar(A)).version).toBe(1);
    });

    it('cambiar sólo mayúsculas de la propia pregunta no choca consigo misma; llevarla a la de otra sí (409)', async () => {
      const m = baseEnMemoria();
      const una = await m.service.crear(A, pregunta(1), 'a');
      await m.service.crear(A, pregunta(2), 'a');
      await expect(
        m.service.actualizar(
          A,
          una.faqId,
          { question: '¿PREGUNTA NÚMERO 1?' },
          'a',
        ),
      ).resolves.toMatchObject({ question: '¿PREGUNTA NÚMERO 1?' });
      expect(
        await cuerpoDelError(
          m.service.actualizar(
            A,
            una.faqId,
            { question: '¿Pregunta número 2?' },
            'a',
          ),
        ),
      ).toMatchObject({ status: 409, code: 'ASSISTANT_FAQ_DUPLICATE' });
      await expect(
        m.service.actualizar(
          A,
          una.faqId,
          { question: '¿Pregunta número 3?' },
          'a',
        ),
      ).resolves.toMatchObject({ question: '¿Pregunta número 3?' });
    });
  });

  describe('404: lo de otra base no existe', () => {
    it.each([
      ['otra empresa', B],
      ['la plataforma', null],
    ])(
      'la pregunta de A no la edita ni la da de baja %s',
      async (_quien, duenio) => {
        const m = baseEnMemoria();
        const deA = await m.service.crear(A, pregunta(1), 'a');
        for (const intento of [
          m.service.actualizar(duenio, deA.faqId, { answer: 'x' }, 'otro'),
          m.service.darDeBaja(duenio, deA.faqId, 'otro'),
        ]) {
          expect(await cuerpoDelError(intento)).toMatchObject({
            status: 404,
            code: 'ASSISTANT_FAQ_NOT_FOUND',
            message: 'No existe esa pregunta frecuente',
          });
        }
        expect(m.faqs[0]).toMatchObject({
          answer: 'Respuesta 1',
          deletedAt: null,
        });
      },
    );

    it('una empresa no toca las de la plataforma', async () => {
      const m = baseEnMemoria();
      const deOrixTech = await m.service.crear(
        null,
        { ...pregunta(1), key: 'uno' },
        's',
      );
      await expect(
        m.service.actualizar(A, deOrixTech.faqId, { answer: 'x' }, 'a'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('baja lógica', () => {
    it('marca la baja (no borra), anota quién, sube la versión y deja la pregunta libre; la segunda baja es 404', async () => {
      const m = baseEnMemoria();
      const fila = await m.service.crear(A, pregunta(1), 'a1');
      await m.service.darDeBaja(A, fila.faqId, 'a2');
      expect(m.faqs).toHaveLength(1);
      expect(m.faqs[0].deletedAt).toBeInstanceOf(Date);
      expect(m.faqs[0].updatedBy).toBe('a2');
      const base = await m.service.listar(A);
      expect(base).toEqual({ items: [], version: 2 });
      await expect(
        m.service.darDeBaja(A, fila.faqId, 'a2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        m.service.crear(A, pregunta(1), 'a1'),
      ).resolves.toBeDefined();
    });
  });

  describe('copia de preguntas de ejemplo (D-B7)', () => {
    /**
     * El catálogo con dos ejemplos y uno dado de baja, y la base de OrixTech
     * con preguntas propias (una con la misma clave que un ejemplo).
     */
    async function conEjemplos() {
      const m = baseEnMemoria();
      m.ejemplo('como_pedir', '¿Cómo pido?', 'Desde la app');
      m.ejemplo('medios_de_pago', '¿Cómo pago?', 'Como diga la app');
      m.ejemplo('vieja', '¿Vieja?', 'x').deletedAt = new Date();
      await m.service.crear(
        null,
        {
          question: '¿Cómo uso el panel?',
          answer: 'Sólo para el soporte',
          key: 'panel',
        },
        's',
      );
      await m.service.crear(
        null,
        {
          question: '¿Cómo pido soporte a OrixTech?',
          answer: 'Interno de OrixTech',
          key: 'como_pedir',
        },
        's',
      );
      return m;
    }

    it('copia las preguntas de ejemplo vigentes del catálogo, con su clave, como preguntas de la empresa', async () => {
      const m = await conEjemplos();
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toEqual({
        copied: 2,
        skipped: 0,
        version: 1,
      });
      const base = await m.service.listar(A);
      expect(
        base.items.map((f) => [
          f.key,
          f.question,
          f.answer,
          f.distributorId,
          f.createdBy,
        ]),
      ).toEqual([
        ['como_pedir', '¿Cómo pido?', 'Desde la app', A, 'a'],
        ['medios_de_pago', '¿Cómo pago?', 'Como diga la app', A, 'a'],
      ]);
      expect(m.repoDeEjemplos.find).toHaveBeenCalledTimes(1);
    });

    it('con la misma clave en OrixTech y en el catálogo, la copia trae el texto del catálogo y nunca el de OrixTech', async () => {
      const m = await conEjemplos();
      expect(
        (await m.service.listar(null)).items.find(
          (f) => f.key === 'como_pedir',
        ),
      ).toMatchObject({ answer: 'Interno de OrixTech' });
      await m.service.copiarPlantillas(A, 'a');
      const copia = (await m.service.listar(A)).items.find(
        (f) => f.key === 'como_pedir',
      );
      expect(copia).toMatchObject({
        question: '¿Cómo pido?',
        answer: 'Desde la app',
        distributorId: A,
      });
      const textos = m.faqs
        .filter((f) => f.distributorId === A)
        .flatMap((f) => [f.question, f.answer]);
      expect(textos).not.toContain('¿Cómo pido soporte a OrixTech?');
      expect(textos).not.toContain('Interno de OrixTech');
    });

    it('una pregunta de la base de OrixTech nunca llega a una distribuidora (D-B6)', async () => {
      const m = baseEnMemoria();
      await m.service.crear(
        null,
        { question: '¿Cómo pido?', answer: 'Interno', key: 'como_pedir' },
        's',
      );
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toEqual({
        copied: 0,
        skipped: 0,
        version: 0,
      });
      expect(m.faqs.filter((f) => f.distributorId === A)).toEqual([]);
      // Y con catálogo, sólo llega lo del catálogo.
      const conCatalogo = await conEjemplos();
      await conCatalogo.service.copiarPlantillas(A, 'a');
      const copiadas = conCatalogo.faqs.filter((f) => f.distributorId === A);
      expect(copiadas.map((f) => f.answer)).not.toContain(
        'Interno de OrixTech',
      );
      expect(copiadas.map((f) => f.answer)).not.toContain(
        'Sólo para el soporte',
      );
    });

    it('la copia es de la empresa: editarla o darla de baja no toca el catálogo', async () => {
      const m = await conEjemplos();
      await m.service.copiarPlantillas(A, 'a');
      const [copia, otra] = (await m.service.listar(A)).items;
      await m.service.actualizar(A, copia.faqId, { answer: 'Llamanos' }, 'a');
      await m.service.darDeBaja(A, otra.faqId, 'a');
      expect(m.ejemplos.map((e) => [e.answer, e.deletedAt === null])).toEqual([
        ['Desde la app', true],
        ['Como diga la app', true],
        ['x', false],
      ]);
    });

    it('es idempotente: la segunda vez no copia nada ni sube la versión, aunque la empresa haya editado la copia', async () => {
      const m = await conEjemplos();
      await m.service.copiarPlantillas(A, 'a');
      const copia = (await m.service.listar(A)).items[0];
      await m.service.actualizar(
        A,
        copia.faqId,
        { question: '¿Cómo hago el pedido?' },
        'a',
      );
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toEqual({
        copied: 0,
        skipped: 2,
        version: 2,
      });
      expect((await m.service.listar(A)).items).toHaveLength(2);
    });

    it('no duplica una pregunta que la empresa ya escribió (misma pregunta, sin clave)', async () => {
      const m = await conEjemplos();
      await m.service.crear(
        A,
        { question: '¿cómo PAGO?', answer: 'Efectivo' },
        'a',
      );
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toEqual({
        copied: 1,
        skipped: 1,
        version: 2,
      });
    });

    it('una copia dada de baja vuelve a copiarse si se piden los ejemplos de nuevo', async () => {
      const m = await conEjemplos();
      await m.service.copiarPlantillas(A, 'a');
      const copia = (await m.service.listar(A)).items[0];
      await m.service.darDeBaja(A, copia.faqId, 'a');
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toMatchObject({
        copied: 1,
        skipped: 1,
      });
    });

    it('todo o nada: si no entran bajo el tope no copia ninguna (409 con cuántas sobran)', async () => {
      const m = await conEjemplos();
      for (let i = 0; i < TOPE_DE_PREGUNTAS - 1; i += 1) {
        await m.service.crear(A, pregunta(i), 'a');
      }
      const error = await cuerpoDelError(m.service.copiarPlantillas(A, 'a'));
      expect(error).toMatchObject({
        status: 409,
        code: 'ASSISTANT_FAQ_LIMIT_REACHED',
      });
      expect(error.message).toMatch(/preguntas de ejemplo.*al menos 1/);
      expect((await m.service.listar(A)).items).toHaveLength(
        TOPE_DE_PREGUNTAS - 1,
      );
    });

    it('sin preguntas de ejemplo no copia nada y la versión no cambia', async () => {
      const m = baseEnMemoria();
      await expect(m.service.copiarPlantillas(A, 'a')).resolves.toEqual({
        copied: 0,
        skipped: 0,
        version: 0,
      });
    });

    it('cada empresa copia a su base: lo de A no cuenta para B', async () => {
      const m = await conEjemplos();
      await m.service.copiarPlantillas(A, 'a');
      await expect(m.service.copiarPlantillas(B, 'b')).resolves.toMatchObject({
        copied: 2,
      });
      expect(m.faqs.filter((f) => f.distributorId === B)).toHaveLength(2);
    });

    it('bloquea la base de la empresa antes de leer el catálogo', async () => {
      const m = await conEjemplos();
      m.llamadas.length = 0;
      await m.service.copiarPlantillas(A, 'a');
      expect(m.llamadas.slice(0, 4)).toEqual([
        'crearBase',
        'bloquear',
        'find',
        'ejemplos',
      ]);
    });
  });

  it('los errores son excepciones de Nest con mensaje en castellano', async () => {
    const m = baseEnMemoria();
    const error = await m.service
      .actualizar(A, 'no-existe', { answer: 'x' }, 'a')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    await m.service.crear(A, pregunta(1), 'a');
    await expect(m.service.crear(A, pregunta(1), 'a')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('AssistantFaqService · corrección 1', () => {
  it('un PATCH de la plataforma sin cambios no escribe ni sube la versión', async () => {
    const m = baseEnMemoria();
    const fila = await m.service.crear(
      null,
      { ...pregunta(1), key: 'uno' },
      's',
    );
    m.repoDePreguntas.save.mockClear();
    await m.service.actualizar(null, fila.faqId, { answer: fila.answer }, 's');
    await m.service.actualizar(null, fila.faqId, {}, 's');
    expect(m.repoDePreguntas.save).not.toHaveBeenCalled();
    expect((await m.service.listar(null)).version).toBe(1);
  });

  it('la base de la plataforma ya no guarda la marca de plantilla', async () => {
    const m = baseEnMemoria();
    const fila = await m.service.crear(
      null,
      { ...pregunta(1), key: 'uno' },
      's',
    );
    expect(fila).not.toHaveProperty('useAsTemplate');
  });

  it('listar lee preguntas y versión en una misma transacción REPEATABLE READ', async () => {
    const m = baseEnMemoria();
    await m.service.crear(A, pregunta(1), 'a');
    m.transaction.mockClear();
    await expect(m.service.listar(A)).resolves.toMatchObject({ version: 1 });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.transaction).toHaveBeenCalledWith(
      'REPEATABLE READ',
      expect.any(Function),
    );
  });

  describe('largo como lo cuenta la base (puntos de código)', () => {
    // «✔️» son dos puntos de código (U+2714 y el selector U+FE0F).
    const conEmoji = (largo: number) => `${'a'.repeat(largo - 2)}✔️`;

    it.each([
      ['pregunta de 201', { question: conEmoji(201), answer: 'x' }, /pregunta/],
      [
        'respuesta de 1501',
        { question: '¿Abren hoy?', answer: conEmoji(1501) },
        /respuesta/,
      ],
      ['pregunta de 4', { question: '¿✔️?', answer: 'x' }, /pregunta/],
    ])('%s: 400 antes de llegar a la base', async (_caso, datos, campo) => {
      const m = baseEnMemoria();
      const error = await cuerpoDelError(m.service.crear(A, datos, 'a'));
      expect(error).toMatchObject({ status: 400 });
      expect(String(error.message).toLowerCase()).toMatch(campo);
      expect(m.query).not.toHaveBeenCalled();
    });

    it('en el límite exacto con emojis pasa (200 y 1500)', async () => {
      const m = baseEnMemoria();
      await expect(
        m.service.crear(
          A,
          { question: conEmoji(200), answer: conEmoji(1500) },
          'a',
        ),
      ).resolves.toBeDefined();
    });

    it('la edición controla igual', async () => {
      const m = baseEnMemoria();
      const fila = await m.service.crear(A, pregunta(1), 'a');
      expect(
        await cuerpoDelError(
          m.service.actualizar(A, fila.faqId, { question: conEmoji(201) }, 'a'),
        ),
      ).toMatchObject({ status: 400 });
    });
  });

  it.each(['Sí &amp no', 'Uno &lt dos', 'Signo &#60', '<b>hola</b>'])(
    'el servicio rechaza HTML aunque no pase por el DTO: %s',
    async (answer) => {
      const m = baseEnMemoria();
      const error = await cuerpoDelError(
        m.service.crear(A, { question: '¿Abren hoy?', answer }, 'a'),
      );
      expect(error).toMatchObject({ status: 400 });
      expect(String(error.message)).toMatch(/no puede llevar HTML/);
    },
  );

  it('un & o un < sueltos son texto', async () => {
    const m = baseEnMemoria();
    await expect(
      m.service.crear(
        A,
        { question: '¿Tienen de < 5 kg?', answer: 'De 3 & de 4 kg' },
        'a',
      ),
    ).resolves.toBeDefined();
  });

  describe('orden explícito (position)', () => {
    it('cada pregunta nueva va al final de su base', async () => {
      const m = baseEnMemoria();
      await m.service.crear(A, pregunta(1), 'a');
      await m.service.crear(B, pregunta(2), 'b');
      await m.service.crear(A, pregunta(3), 'a');
      expect((await m.service.listar(A)).items.map((f) => f.position)).toEqual([
        1, 2,
      ]);
      expect((await m.service.listar(B)).items.map((f) => f.position)).toEqual([
        1,
      ]);
    });

    it('la lista sale por posición, no por fecha de alta', async () => {
      const m = baseEnMemoria();
      await m.service.crear(A, pregunta(1), 'a');
      await m.service.crear(A, pregunta(2), 'a');
      m.faqs[0].position = 5;
      expect((await m.service.listar(A)).items.map((f) => f.question)).toEqual([
        '¿Pregunta número 2?',
        '¿Pregunta número 1?',
      ]);
    });

    it('las preguntas de ejemplo copiadas (todas con la misma fecha) conservan el orden del catálogo y van después de lo propio', async () => {
      const m = baseEnMemoria();
      // El catálogo ordenado c, a, b (la posición manda, no el alta).
      m.ejemplo('a', '¿Ejemplo a?', 'x', 2);
      m.ejemplo('b', '¿Ejemplo b?', 'x', 3);
      m.ejemplo('c', '¿Ejemplo c?', 'x', 1);
      await m.service.crear(A, pregunta(1), 'a');
      await m.service.crear(A, pregunta(2), 'a');
      await m.service.copiarPlantillas(A, 'a');
      const copias = m.faqs.filter((f) => f.distributorId === A && f.key);
      expect(new Set(copias.map((f) => f.createdAt.getTime())).size).toBe(1);
      expect(
        (await m.service.listar(A)).items.map((f) => [f.key, f.position]),
      ).toEqual([
        [null, 1],
        [null, 2],
        ['c', 3],
        ['a', 4],
        ['b', 5],
      ]);
    });
  });
});
