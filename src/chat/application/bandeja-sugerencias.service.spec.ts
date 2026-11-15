import type { DataSource } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  Party,
  SubjectType,
} from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import type { ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import {
  PALABRAS_DE_CORTESIA,
  PARECIDO_MINIMO,
  TOPE_DE_SUGERENCIAS,
} from '../domain/sugerencias';
import { BandejaSugerenciasService } from './bandeja-sugerencias.service';

/** El SQL en una línea, para comparar cláusulas enteras. */
const plano = (sql = '') => sql.replace(/\s+/g, ' ');
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';

const D = 'dist-a';
const ahora = new Date('2026-11-16T15:00:00Z'); // lunes 12:00 en Buenos Aires

const personal: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'adm-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes'],
};

function conversacion(cambios: Partial<Conversation> = {}): Conversation {
  return Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: D,
    channel: Channel.STAFF_CUSTOMER,
    subjectType: SubjectType.ORDER,
    status: ConversationStatus.OPEN,
    orderId: '7c1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b',
    customerUserId: 'cli-1',
    driverUserId: null,
    ...cambios,
  });
}

const plantilla = (n: number, body: string) => ({
  template_id: `t-${n}`,
  key: `clave_${n}`,
  title: `Título ${n}`,
  body,
});

function armar(opciones: {
  conversacion?: Conversation | Error;
  ultimo?: Array<{ seq: string; body: string }>;
  parecidas?: Array<ReturnType<typeof plantilla>>;
}) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes('"sender_party" IN')) {
        return Promise.resolve(opciones.ultimo ?? []);
      }
      if (sql.includes('"message_template"')) {
        return Promise.resolve(opciones.parecidas ?? []);
      }
      if (sql.includes('"full_name"')) {
        return Promise.resolve([
          { persona: 'Ana Pérez', empresa: 'Gas Norte' },
        ]);
      }
      return Promise.resolve([]);
    }),
  };
  const acceso = {
    buscar: jest.fn(() => {
      const c = opciones.conversacion ?? conversacion();
      return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
    }),
  };
  const ajustes = {
    leer: jest.fn(() => Promise.resolve(ajustesDeLaBandejaPorDefecto(D))),
  };
  const servicio = new BandejaSugerenciasService(
    { manager } as unknown as DataSource,
    acceso as unknown as BandejaAcceso,
    ajustes as unknown as CompanyChatSettingsService,
  );
  return { servicio, consultas, acceso, ajustes };
}

describe('BandejaSugerenciasService: sugerencias de respuesta (CH-BOT §3)', () => {
  it('busca con el último mensaje de la persona, en las de la empresa y el canal, y completa las variables', async () => {
    const { servicio, consultas } = armar({
      ultimo: [{ seq: '7', body: '¿Cómo puedo pagar?' }],
      parecidas: [
        plantilla(
          1,
          'Hola {{cliente.nombre}}, en {{empresa.nombre}} aceptamos efectivo.',
        ),
        plantilla(2, 'Tu pedido {{pedido.numero}} se paga al recibirlo.'),
      ],
    });
    const r = await servicio.sugerir(personal, 'conv-1', ahora);
    expect(r).toEqual({
      basadoEnSeq: 7,
      items: [
        {
          templateId: 't-1',
          key: 'clave_1',
          title: 'Título 1',
          body: 'Hola Ana, en Gas Norte aceptamos efectivo.',
        },
        {
          templateId: 't-2',
          key: 'clave_2',
          title: 'Título 2',
          body: 'Tu pedido 4F5A6B se paga al recibirlo.',
        },
      ],
    });
    const busqueda = consultas.find((c) => c.sql.includes('message_template'));
    // Orden de los parámetros: $1 texto, $2 empresa, $3 canal, $4 tope, $5 parecido mínimo, $6 cortesía.
    expect(busqueda?.params).toEqual([
      'puedo pagar',
      D,
      Channel.STAFF_CUSTOMER,
      TOPE_DE_SUGERENCIAS,
      PARECIDO_MINIMO,
      PALABRAS_DE_CORTESIA,
    ]);
    const sql = plano(busqueda?.sql);
    // Aislamiento: sólo las de la empresa de la conversación y de su canal (o de los dos).
    expect(sql).toContain(
      `FROM "message_template" t WHERE t."distributor_id" = $2 AND t."scope" = 'staff_reply' AND t."active" AND t."deleted_at" IS NULL AND (t."channel" IS NULL OR t."channel" = $3) )`,
    );
    expect(sql).toContain(`unnest(to_tsvector('spanish', unaccent($1)))`);
    expect(sql).toContain(`unnest(to_tsvector('spanish', unaccent($6)))`);
    // Los saludos de las respuestas guardadas («Hola…», «Saludo») tampoco cuentan.
    expect(sql).toContain(
      `cortesia AS ( SELECT array_agg(l.lexeme) AS lexemas FROM unnest(to_tsvector('spanish', unaccent($6))) AS l )`,
    );
    expect(sql).toContain('(SELECT lexemas FROM cortesia)) AS v');
    expect(sql).toContain(
      'WHERE c.v @@ consulta.q AND ts_rank(c.v, consulta.q) >= $5 ORDER BY ts_rank(c.v, consulta.q) DESC',
    );
    expect(sql).toMatch(/LIMIT \$4\s*$/);
    // Ningún otro parámetro numerado.
    expect(sql.match(/\$\d+/g)?.every((p) => /^\$[1-6]$/.test(p))).toBe(true);
    const ultimo = consultas.find((c) => c.sql.includes('"sender_party" IN'));
    expect(ultimo?.params).toEqual(['conv-1']);
  });

  it('un mensaje que sólo saluda o agradece no busca nada', async () => {
    for (const body of [
      'hola',
      'Buenas tardes!!',
      'ok, gracias',
      'Graciass 👍',
    ]) {
      const { servicio, consultas, ajustes } = armar({
        ultimo: [{ seq: '5', body }],
        parecidas: [plantilla(1, 'Hola {{cliente.nombre}}')],
      });
      expect(await servicio.sugerir(personal, 'conv-1', ahora)).toEqual({
        basadoEnSeq: 5,
        items: [],
      });
      expect(consultas.some((c) => c.sql.includes('message_template'))).toBe(
        false,
      );
      expect(ajustes.leer).not.toHaveBeenCalled();
    }
  });

  it('en C2 busca con las del canal de choferes', async () => {
    const { servicio, consultas } = armar({
      conversacion: conversacion({
        channel: Channel.STAFF_DRIVER,
        customerUserId: null,
        driverUserId: 'cho-1',
      }),
      ultimo: [{ seq: '2', body: 'Se me pinchó una rueda' }],
    });
    await servicio.sugerir(personal, 'conv-1', ahora);
    const busqueda = consultas.find((c) => c.sql.includes('message_template'));
    expect(busqueda?.params.slice(0, 3)).toEqual([
      'Se me pinchó una rueda',
      D,
      Channel.STAFF_DRIVER,
    ]);
  });

  it('si la persona no escribió nada, lista vacía sin buscar', async () => {
    const { servicio, consultas } = armar({ ultimo: [] });
    expect(await servicio.sugerir(personal, 'conv-1', ahora)).toEqual({
      basadoEnSeq: null,
      items: [],
    });
    expect(consultas.some((c) => c.sql.includes('message_template'))).toBe(
      false,
    );
  });

  it('si nada se parece, lista vacía (200) sin leer los ajustes', async () => {
    const { servicio, ajustes } = armar({
      ultimo: [{ seq: '3', body: 'se me pinchó una rueda' }],
      parecidas: [],
    });
    expect(await servicio.sugerir(personal, 'conv-1', ahora)).toEqual({
      basadoEnSeq: 3,
      items: [],
    });
    expect(ajustes.leer).not.toHaveBeenCalled();
  });

  it('una que queda vacía en esta conversación no se sugiere', async () => {
    const { servicio } = armar({
      ultimo: [{ seq: '3', body: 'mi pedido?' }],
      parecidas: [plantilla(1, '{{pedido.numero}}'), plantilla(2, 'Ya sale')],
    });
    const r = await servicio.sugerir(personal, 'conv-1', ahora);
    expect(r.items.map((i) => i.templateId)).toEqual(['t-1', 't-2']);
    const general = armar({
      conversacion: conversacion({
        orderId: null,
        subjectType: SubjectType.GENERAL,
      }),
      ultimo: [{ seq: '3', body: 'mi pedido?' }],
      parecidas: [plantilla(1, '{{pedido.numero}}'), plantilla(2, 'Ya sale')],
    });
    expect(
      (await general.servicio.sugerir(personal, 'conv-1', ahora)).items.map(
        (i) => i.templateId,
      ),
    ).toEqual(['t-2']);
  });

  it('de otra empresa o de un canal que no atiende: 404 sin buscar nada', async () => {
    const { servicio, consultas } = armar({
      conversacion: new ConversacionNoEncontradaError(),
    });
    await expect(
      servicio.sugerir(personal, 'conv-x', ahora),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(consultas).toHaveLength(0);
  });
});
