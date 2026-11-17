import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { Channel, Party } from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { ConversationLabel } from '../entities/conversation-label.entity';
import { ConversationLabelLink } from '../entities/conversation-label-link.entity';
import type { ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import type { ChatEvents, Efectos } from './chat.events';
import { ChatLabelsService } from './chat-labels.service';

const A = 'empresa-a';
const B = 'empresa-b';
const CONV = 'conv-1';

const actor = (distributorId = A): ActorDeLaBandeja => ({
  party: Party.COMPANY,
  userId: 'adm-1',
  distributorId,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes'],
});

const etiqueta = (
  labelId: string,
  distributorId = A,
  deletedAt: Date | null = null,
): ConversationLabel =>
  Object.assign(new ConversationLabel(), {
    labelId,
    distributorId,
    name: `Etiqueta ${labelId}`,
    color: 'blue',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt,
  });

/** Una base en memoria: etiquetas y vínculos de dos empresas, filtrando como el `WHERE` real. */
function armar(opciones: {
  etiquetas?: ConversationLabel[];
  vinculos?: Array<Partial<ConversationLabelLink>>;
  nombreTomado?: boolean;
  errorAlGuardar?: Error;
}) {
  const etiquetas = opciones.etiquetas ?? [];
  const vinculos = (opciones.vinculos ?? []).map((v, i) =>
    Object.assign(new ConversationLabelLink(), {
      linkId: `link-${i}`,
      conversationId: CONV,
      distributorId: A,
      deletedAt: null,
      ...v,
    }),
  );
  const conversacion = Object.assign(new Conversation(), {
    conversationId: CONV,
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
  });
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const vigentes = (l: ConversationLabel) => l.deletedAt === null;
  const repoEtiquetas = {
    count: jest.fn(
      ({
        where,
      }: {
        where: { distributorId: string; labelId?: { _value: string[] } };
      }) =>
        Promise.resolve(
          etiquetas.filter(
            (l) =>
              vigentes(l) &&
              l.distributorId === where.distributorId &&
              (!where.labelId || where.labelId._value.includes(l.labelId)),
          ).length,
        ),
    ),
    findOne: jest.fn(
      ({ where }: { where: { labelId: string; distributorId: string } }) =>
        Promise.resolve(
          etiquetas.find(
            (l) =>
              vigentes(l) &&
              l.labelId === where.labelId &&
              l.distributorId === where.distributorId,
          ) ?? null,
        ),
    ),
    create: jest.fn((d: Partial<ConversationLabel>) =>
      Object.assign(new ConversationLabel(), d),
    ),
    save: jest.fn((l: ConversationLabel) =>
      opciones.errorAlGuardar
        ? Promise.reject(opciones.errorAlGuardar)
        : Promise.resolve(Object.assign(l, { labelId: l.labelId ?? 'nueva' })),
    ),
    softRemove: jest.fn((l: ConversationLabel) => {
      l.deletedAt = new Date();
      return Promise.resolve(l);
    }),
  };
  const repoVinculos = {
    find: jest.fn(
      ({
        where,
      }: {
        where: {
          conversationId?: string;
          labelId?: string;
          distributorId: string;
        };
      }) =>
        Promise.resolve(
          vinculos.filter(
            (v) =>
              v.deletedAt === null &&
              v.distributorId === where.distributorId &&
              (!where.conversationId ||
                v.conversationId === where.conversationId) &&
              (!where.labelId || v.labelId === where.labelId),
          ),
        ),
    ),
    softDelete: jest.fn(() => Promise.resolve({ affected: 1 })),
    insert: jest.fn(() => Promise.resolve({})),
  };
  const repoConversaciones = {
    find: jest.fn(() => Promise.resolve([conversacion])),
    findOneByOrFail: jest.fn(() => Promise.resolve(conversacion)),
  };
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      if (sql.includes('chat_label_key')) {
        return Promise.resolve(
          opciones.nombreTomado ? [{ '?column?': 1 }] : [],
        );
      }
      return Promise.resolve([]);
    }),
    getRepository: jest.fn((e: unknown) =>
      e === ConversationLabel
        ? repoEtiquetas
        : e === ConversationLabelLink
          ? repoVinculos
          : repoConversaciones,
    ),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => ({})),
  };
  const acceso = {
    buscar: jest.fn((a: ActorDeLaBandeja) =>
      a.distributorId === A
        ? Promise.resolve(conversacion)
        : Promise.reject(new ConversacionNoEncontradaError()),
    ),
  };
  const publicados: Efectos[] = [];
  const eventos = {
    publicar: jest.fn((e: Efectos) => publicados.push(e)),
  };
  const servicio = new ChatLabelsService(
    dataSource as unknown as DataSource,
    acceso as unknown as BandejaAcceso,
    eventos as unknown as ChatEvents,
  );
  return {
    servicio,
    consultas,
    repoEtiquetas,
    repoVinculos,
    acceso,
    publicados,
  };
}

const codigo = (e: unknown) =>
  ((e as ConflictException).getResponse() as { code?: string }).code;

describe('ChatLabelsService: ABM (7c)', () => {
  it('crea con el nombre recortado, ordenada por cerrojo de la empresa', async () => {
    const { servicio, repoEtiquetas, consultas } = armar({});
    const l = await servicio.crear(A, {
      name: '  Envíos   urgentes ',
      color: 'red',
    });
    expect(l).toEqual(
      expect.objectContaining({
        distributorId: A,
        name: 'Envíos urgentes',
        color: 'red',
      }),
    );
    expect(repoEtiquetas.save).toHaveBeenCalledTimes(1);
    expect(consultas[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      params: [`chat_label:${A}`],
    });
    // El nombre se compara sin mayúsculas ni tildes, en la base y sólo en la empresa.
    expect(consultas[1].params).toEqual([A, 'Envíos urgentes', null]);
  });

  it('409 `CHAT_LABEL_LIMIT_REACHED` con 50 vigentes (las dadas de baja no cuentan)', async () => {
    const llenas = Array.from({ length: 50 }, (_, i) => etiqueta(`e-${i}`));
    const { servicio, repoEtiquetas } = armar({ etiquetas: llenas });
    const error = await servicio
      .crear(A, { name: 'Otra', color: 'red' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(codigo(error)).toBe('CHAT_LABEL_LIMIT_REACHED');
    expect(repoEtiquetas.save).not.toHaveBeenCalled();

    const conBajas = [
      ...Array.from({ length: 49 }, (_, i) => etiqueta(`e-${i}`)),
      etiqueta('baja', A, new Date()),
      ...Array.from({ length: 5 }, (_, i) => etiqueta(`b-${i}`, B)),
    ];
    const otra = armar({ etiquetas: conBajas });
    await expect(
      otra.servicio.crear(A, { name: 'Otra', color: 'red' }),
    ).resolves.toBeDefined();
  });

  it('409 `CHAT_LABEL_NAME_TAKEN` si ya hay una vigente con ese nombre', async () => {
    const { servicio, repoEtiquetas } = armar({ nombreTomado: true });
    const error = await servicio
      .crear(A, { name: 'envios', color: 'red' })
      .catch((e: unknown) => e);
    expect(codigo(error)).toBe('CHAT_LABEL_NAME_TAKEN');
    expect(repoEtiquetas.save).not.toHaveBeenCalled();
  });

  it('la base como red: el único y el tope de la base se traducen a sus 409', async () => {
    const unico = armar({
      errorAlGuardar: Object.assign(new Error('único'), {
        code: '23505',
        constraint: 'UQ_conversation_label_nombre',
      }),
    });
    expect(
      codigo(
        await unico.servicio
          .crear(A, { name: 'X', color: 'red' })
          .catch((e: unknown) => e),
      ),
    ).toBe('CHAT_LABEL_NAME_TAKEN');
    const tope = armar({
      errorAlGuardar: Object.assign(new Error('tope'), {
        driverError: {
          code: '23514',
          constraint: 'CHK_conversation_label_tope',
        },
      }),
    });
    expect(
      codigo(
        await tope.servicio
          .crear(A, { name: 'X', color: 'red' })
          .catch((e: unknown) => e),
      ),
    ).toBe('CHAT_LABEL_LIMIT_REACHED');
    const otro = armar({ errorAlGuardar: new Error('se cayó la base') });
    await expect(
      otro.servicio.crear(A, { name: 'X', color: 'red' }),
    ).rejects.toThrow('se cayó la base');
  });

  it('cambiar: nombre (sin chocar consigo misma) y color; la de otra empresa no existe', async () => {
    const { servicio, consultas } = armar({ etiquetas: [etiqueta('e-1')] });
    const l = await servicio.actualizar(A, 'e-1', {
      name: ' Pagos ',
      color: 'green',
    });
    expect([l.name, l.color]).toEqual(['Pagos', 'green']);
    expect(consultas[1].params).toEqual([A, 'Pagos', 'e-1']);
    const deB = armar({ etiquetas: [etiqueta('e-1')] });
    const error = await deB.servicio
      .actualizar(B, 'e-1', { color: 'red' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(codigo(error)).toBe('CHAT_LABEL_NOT_FOUND');
  });

  it('renombrar o cambiar el color re-emite las conversaciones que la tienen; sin cambios, no', async () => {
    const t = armar({
      etiquetas: [etiqueta('e-1')],
      vinculos: [{ labelId: 'e-1' }],
    });
    await t.servicio.actualizar(A, 'e-1', { color: 'green' });
    expect(t.publicados[0].conversaciones.map((c) => c.change)).toEqual([
      'labels',
    ]);
    expect(t.repoEtiquetas.save).toHaveBeenCalledTimes(1);

    const igual = armar({
      etiquetas: [etiqueta('e-1')],
      vinculos: [{ labelId: 'e-1' }],
    });
    await igual.servicio.actualizar(A, 'e-1', { color: 'blue' });
    expect(igual.publicados[0].conversaciones).toEqual([]);
    expect(igual.repoEtiquetas.save).not.toHaveBeenCalled();

    const sinConversaciones = armar({ etiquetas: [etiqueta('e-1')] });
    await sinConversaciones.servicio.actualizar(A, 'e-1', { name: 'Otra' });
    expect(sinConversaciones.publicados[0].conversaciones).toEqual([]);
  });

  it('baja lógica: también sale de sus conversaciones (vínculos vigentes) y se re-emiten', async () => {
    const { servicio, repoEtiquetas, repoVinculos, publicados } = armar({
      etiquetas: [etiqueta('e-1')],
      vinculos: [{ labelId: 'e-1' }],
    });
    await servicio.darDeBaja(A, 'e-1');
    expect(repoVinculos.softDelete).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 'e-1', distributorId: A }),
    );
    expect(repoEtiquetas.softRemove).toHaveBeenCalledTimes(1);
    expect(publicados[0].conversaciones.map((c) => c.change)).toEqual([
      'labels',
    ]);
  });

  it('baja de una de otra empresa: 404 y no toca nada', async () => {
    const { servicio, repoEtiquetas, repoVinculos } = armar({
      etiquetas: [etiqueta('e-1')],
    });
    await expect(servicio.darDeBaja(B, 'e-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repoEtiquetas.softRemove).not.toHaveBeenCalled();
    expect(repoVinculos.softDelete).not.toHaveBeenCalled();
  });
});

describe('ChatLabelsService: etiquetas de una conversación (7c)', () => {
  it('reemplaza: saca las que no vienen, pone las nuevas y re-emite al panel', async () => {
    const { servicio, repoVinculos, publicados } = armar({
      etiquetas: [etiqueta('e-1'), etiqueta('e-2'), etiqueta('e-3')],
      vinculos: [{ labelId: 'e-1' }, { labelId: 'e-2' }],
    });
    await servicio.ponerEnConversacion(actor(), CONV, ['e-2', 'e-3']);
    expect(repoVinculos.softDelete).toHaveBeenCalledWith({
      linkId: expect.objectContaining({ _value: ['link-0'] }) as unknown,
    });
    expect(repoVinculos.insert).toHaveBeenCalledWith([
      { conversationId: CONV, labelId: 'e-3', distributorId: A },
    ]);
    expect(publicados[0].conversaciones.map((c) => c.change)).toEqual([
      'labels',
    ]);
  });

  it('las mismas: no cambia nada ni avisa', async () => {
    const { servicio, repoVinculos, publicados } = armar({
      etiquetas: [etiqueta('e-1')],
      vinculos: [{ labelId: 'e-1' }],
    });
    await servicio.ponerEnConversacion(actor(), CONV, ['e-1']);
    expect(repoVinculos.insert).not.toHaveBeenCalled();
    expect(repoVinculos.softDelete).not.toHaveBeenCalled();
    expect(publicados[0].conversaciones).toEqual([]);
  });

  it('vacía: las saca todas', async () => {
    const { servicio, repoVinculos } = armar({
      etiquetas: [etiqueta('e-1')],
      vinculos: [{ labelId: 'e-1' }],
    });
    await servicio.ponerEnConversacion(actor(), CONV, []);
    expect(repoVinculos.softDelete).toHaveBeenCalledTimes(1);
    expect(repoVinculos.insert).not.toHaveBeenCalled();
  });

  it('una etiqueta de otra empresa o dada de baja: 404 `CHAT_LABEL_NOT_FOUND` y no se pone ninguna', async () => {
    const { servicio, repoVinculos } = armar({
      etiquetas: [
        etiqueta('e-1'),
        etiqueta('de-b', B),
        etiqueta('baja', A, new Date()),
      ],
    });
    for (const ajena of ['de-b', 'baja']) {
      const error = await servicio
        .ponerEnConversacion(actor(), CONV, ['e-1', ajena])
        .catch((e: unknown) => e);
      expect(codigo(error)).toBe('CHAT_LABEL_NOT_FOUND');
    }
    expect(repoVinculos.insert).not.toHaveBeenCalled();
  });

  it('toma el cerrojo de la empresa (el mismo que la baja) antes que el de la conversación', async () => {
    const { servicio, consultas, acceso } = armar({
      etiquetas: [etiqueta('e-1')],
    });
    acceso.buscar.mockImplementationOnce((a: ActorDeLaBandeja) => {
      // Cuando busca la conversación, el cerrojo de la empresa ya está tomado.
      expect(consultas[0]).toEqual({
        sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
        params: [`chat_label:${a.distributorId}`],
      });
      return Promise.resolve(
        Object.assign(new Conversation(), {
          conversationId: CONV,
          distributorId: A,
        }),
      );
    });
    await servicio.ponerEnConversacion(actor(), CONV, ['e-1']);
    expect(acceso.buscar).toHaveBeenCalledTimes(1);
  });

  it('una conversación de otra empresa no existe (404) y se busca con el cerrojo', async () => {
    const { servicio, acceso, repoVinculos } = armar({
      etiquetas: [etiqueta('e-1')],
    });
    await expect(
      servicio.ponerEnConversacion(actor(B), CONV, ['e-1']),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(acceso.buscar).toHaveBeenCalledWith(
      expect.objectContaining({ distributorId: B }),
      CONV,
      expect.anything(),
      { bloquear: true },
    );
    expect(repoVinculos.insert).not.toHaveBeenCalled();
  });
});
