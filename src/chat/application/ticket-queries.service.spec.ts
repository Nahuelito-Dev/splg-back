import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, SelectQueryBuilder } from 'typeorm';
import { Brackets } from 'typeorm';
import { Party, TicketStatus } from '../domain/chat.enums';
import type { SupportTicket } from '../entities/support-ticket.entity';
import {
  QueryCompanyTicketsDto,
  QueryPlatformChatsDto,
  QueryPlatformTicketsDto,
} from '../presentation/dto/chat-input.dto';
import {
  TicketQueriesService,
  filtrarEstadoYTexto,
  ordenar,
} from './ticket-queries.service';

/** Query builder que anota lo que se le pide. */
function qbFalso() {
  const llamadas: Array<[string, ...unknown[]]> = [];
  const qb = {} as Record<string, jest.Mock>;
  for (const m of [
    'where',
    'andWhere',
    'orWhere',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
  ]) {
    qb[m] = jest.fn((...args: unknown[]) => {
      if (args[0] instanceof Brackets) {
        // Resuelve los paréntesis sobre el mismo falso para ver qué condiciones arman.
        (
          args[0] as unknown as {
            whereFactory: (w: unknown) => void;
          }
        ).whereFactory(qb);
        llamadas.push([m, 'brackets']);
      } else {
        llamadas.push([m, ...args]);
      }
      return qb;
    });
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return {
    qb: qb as unknown as SelectQueryBuilder<SupportTicket>,
    llamadas,
  };
}

const consulta = (q: object) => plainToInstance(QueryCompanyTicketsDto, q);

describe('listados de tickets: filtros y orden', () => {
  it('varios estados: un IN con la lista', () => {
    const { qb, llamadas } = qbFalso();
    filtrarEstadoYTexto(qb, consulta({ status: 'new,open , waiting_company' }));
    expect(llamadas).toEqual([
      [
        'andWhere',
        't.status IN (:...estados)',
        { estados: ['new', 'open', 'waiting_company'] },
      ],
    ]);
  });

  it('`q` con número busca por número o asunto; con texto, sólo asunto (con comodines escapados)', () => {
    const conNumero = qbFalso();
    filtrarEstadoYTexto(conNumero.qb, consulta({ q: 'T-000012' }));
    expect(conNumero.llamadas).toEqual(
      expect.arrayContaining([
        ['where', 't.subject ILIKE :texto', { texto: '%T-000012%' }],
        ['orWhere', 't.number = :numero', { numero: 12 }],
      ]),
    );
    const conTexto = qbFalso();
    filtrarEstadoYTexto(conTexto.qb, consulta({ q: '50%_off' }));
    expect(conTexto.llamadas).toEqual([
      ['where', 't.subject ILIKE :texto', { texto: '%50\\%\\_off%' }],
      ['andWhere', 'brackets'],
    ]);
  });

  it('sin filtros no agrega condiciones', () => {
    const { qb, llamadas } = qbFalso();
    filtrarEstadoYTexto(qb, consulta({}));
    expect(llamadas).toEqual([]);
  });

  it('orden por defecto: último movimiento, más recientes primero, desempate por número', () => {
    const { qb, llamadas } = qbFalso();
    ordenar(qb, consulta({}), Party.COMPANY);
    expect(llamadas).toEqual([
      ['orderBy', 't.updatedAt', 'DESC', 'NULLS LAST'],
      ['addOrderBy', 't.number', 'DESC'],
    ]);
  });

  it('`lastMessageAt` para la empresa no cuenta las notas internas; para la plataforma sí', () => {
    const empresa = qbFalso();
    ordenar(
      empresa.qb,
      consulta({ sort: 'lastMessageAt', order: 'asc' }),
      Party.COMPANY,
    );
    const [, sqlEmpresa] = empresa.llamadas[0] as [string, string];
    expect(sqlEmpresa).toContain(`m."visibility" = 'all'`);
    expect(empresa.llamadas.slice(1)).toEqual([
      ['orderBy', 'ultimo_mensaje', 'ASC', 'NULLS LAST'],
      ['addOrderBy', 't.number', 'ASC'],
    ]);
    const plataforma = qbFalso();
    ordenar(plataforma.qb, consulta({ sort: 'lastMessageAt' }), Party.PLATFORM);
    const [, sqlPlataforma] = plataforma.llamadas[0] as [string, string];
    expect(sqlPlataforma).not.toContain('visibility');
  });

  it('`createdAt`: por fecha de alta', () => {
    const { qb, llamadas } = qbFalso();
    ordenar(qb, consulta({ sort: 'createdAt', order: 'asc' }), Party.PLATFORM);
    expect(llamadas[0]).toEqual([
      'orderBy',
      't.createdAt',
      'ASC',
      'NULLS LAST',
    ]);
  });

  it('la empresa siempre filtra por su distribuidora y pagina', async () => {
    const { qb, llamadas } = qbFalso();
    const ds = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
    } as unknown as DataSource;
    await new TicketQueriesService(ds).deLaEmpresa(
      'dist-a',
      consulta({ status: 'resolved', limit: '5', offset: '10' }),
    );
    expect(llamadas).toEqual(
      expect.arrayContaining([
        ['where', 't.distributorId = :dist', { dist: 'dist-a' }],
        ['andWhere', 't.status IN (:...estados)', { estados: ['resolved'] }],
        ['limit', 5],
        ['offset', 10],
      ]),
    );
  });
});

describe('validación de la consulta de tickets', () => {
  const errores = async (q: object, clase = QueryCompanyTicketsDto) =>
    (await validate(plainToInstance(clase, q))).map((e) => e.property);

  it('acepta varios estados por coma o repetidos', async () => {
    expect(await errores({ status: 'new,open' })).toEqual([]);
    expect(await errores({ status: ['new', 'open'] })).toEqual([]);
    const dto = plainToInstance(QueryCompanyTicketsDto, {
      status: ['new', 'new,open'],
    });
    expect(dto.status).toEqual([TicketStatus.NEW, TicketStatus.OPEN]);
  });

  it('rechaza un estado desconocido entre varios, una lista vacía, y `sort`/`order` desconocidos', async () => {
    expect(await errores({ status: 'new,todo' })).toEqual(['status']);
    expect(await errores({ status: ',' })).toEqual(['status']);
    expect(await errores({ sort: 'subject' })).toEqual(['sort']);
    expect(await errores({ order: 'arriba' })).toEqual(['order']);
  });

  it('`q` de hasta 120 caracteres, también del lado de la plataforma', async () => {
    expect(await errores({ q: 'x'.repeat(121) })).toEqual(['q']);
    expect(
      await errores({ q: 'x'.repeat(121) }, QueryPlatformTicketsDto),
    ).toEqual(['q']);
    expect(
      await errores({ q: 'factura', sort: 'createdAt', order: 'asc' }),
    ).toEqual([]);
  });

  it('por defecto: último movimiento, descendente', () => {
    expect(plainToInstance(QueryCompanyTicketsDto, {})).toMatchObject({
      sort: 'updatedAt',
      order: 'desc',
    });
  });
});

describe('chats de la plataforma: la cola de los que esperan a una persona (B3)', () => {
  const armarQb = () => {
    const llamadas: unknown[][] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
      'skip',
    ]) {
      qb[m] = jest.fn((...args: unknown[]) => {
        llamadas.push([m, ...args]);
        return qb;
      });
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([[], 0]));
    const ds = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
      query: () => Promise.resolve([{ waiting: '1', mine: '0' }]),
    } as unknown as DataSource;
    return { servicio: new TicketQueriesService(ds), llamadas };
  };
  const consultaDeChats = (extra: object) =>
    plainToInstance(QueryPlatformChatsDto, { ...extra });

  it('«sin atender»: primero los que esperan (el más viejo primero) y `awaiting=true` filtra', async () => {
    const { servicio, llamadas } = armarQb();
    await servicio.chats(
      'p1',
      consultaDeChats({ assigned: 'none', awaiting: 'true' }),
    );
    expect(llamadas).toContainEqual([
      'andWhere',
      'c.awaitingHumanSince IS NOT NULL',
    ]);
    expect(llamadas.filter(([m]) => String(m).endsWith('rderBy'))).toEqual([
      ['orderBy', 'c.awaitingHumanSince', 'ASC', 'NULLS LAST'],
      ['addOrderBy', 'c.lastMessageAt', 'DESC', 'NULLS LAST'],
      ['addOrderBy', 'c.conversationId'],
    ]);
  });

  it('sin filtros, el orden de hoy', async () => {
    const { servicio, llamadas } = armarQb();
    await servicio.chats('p1', consultaDeChats({}));
    expect(llamadas.filter(([m]) => String(m).endsWith('rderBy'))).toEqual([
      ['addOrderBy', 'c.lastMessageAt', 'DESC', 'NULLS LAST'],
      ['addOrderBy', 'c.conversationId'],
    ]);
  });

  it('`awaiting` sólo acepta true/false', async () => {
    const errores = async (q: object) =>
      (await validate(plainToInstance(QueryPlatformChatsDto, q))).map(
        (e) => e.property,
      );
    expect(await errores({ awaiting: 'true' })).toEqual([]);
    expect(await errores({ awaiting: 'false' })).toEqual([]);
    expect(await errores({ awaiting: 'sí' })).toEqual(['awaiting']);
    expect(await errores({ awaiting: '1' })).toEqual(['awaiting']);
  });
});
