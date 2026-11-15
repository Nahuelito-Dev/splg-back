import type { DataSource, EntityManager } from 'typeorm';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
  textoDeDerivacion,
} from './company-chat-settings.service';

const D = 'dist-a';

function armar(empresa: Array<{ name: string | null }> = []) {
  const guardados: ChatCompanySettings[] = [];
  const repo = {
    findOneOrFail: jest.fn(() =>
      Promise.resolve(ajustesDeLaBandejaPorDefecto(D)),
    ),
    save: jest.fn((a: ChatCompanySettings) => {
      guardados.push(a);
      return Promise.resolve(a);
    }),
  };
  const manager = {
    query: jest.fn((sql: string, params: unknown[] = []) =>
      Promise.resolve(
        sql.includes('"distributor"') && params.length === 1 ? empresa : [],
      ),
    ),
    getRepository: jest.fn(() => repo),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
  };
  return {
    servicio: new CompanyChatSettingsService(
      dataSource as unknown as DataSource,
    ),
    dataSource,
    manager,
    guardados,
  };
}

describe('CompanyChatSettingsService: el asistente de la empresa (B1, D-B8)', () => {
  it('guarda el nombre y el mensaje de derivación, con quién lo cambió', async () => {
    const { servicio, guardados } = armar();
    const a = await servicio.actualizar(D, 'adm-1', {
      assistantName: 'Gasito de {{empresa.nombre}}',
      handoffMessage: 'Ya te atiende una persona, {{cliente.nombre}}.',
    });
    expect(guardados).toHaveLength(1);
    expect(a).toEqual(
      expect.objectContaining({
        assistantName: 'Gasito de {{empresa.nombre}}',
        handoffMessage: 'Ya te atiende una persona, {{cliente.nombre}}.',
        updatedByUserId: 'adm-1',
      }),
    );
    expect(textoDeDerivacion(a)).toBe(
      'Ya te atiende una persona, {{cliente.nombre}}.',
    );
  });

  it('`null` vuelve a los textos de omisión', async () => {
    const { servicio } = armar();
    const a = await servicio.actualizar(D, 'adm-1', {
      assistantName: null,
      handoffMessage: null,
    });
    expect([a.assistantName, a.handoffMessage]).toEqual([null, null]);
    expect(textoDeDerivacion(a)).toBe(
      'Te paso con alguien del equipo de {{empresa.nombre}}. Te va a responder a la brevedad.',
    );
  });

  it('una variable desconocida en la derivación es 400 y no se guarda nada', async () => {
    const { servicio, dataSource } = armar();
    await expect(
      servicio.actualizar(D, 'adm-1', { handoffMessage: 'Hola {{x}}' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_VARIABLE_UNKNOWN' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('el nombre del asistente con una variable de la conversación es 400 y no se guarda nada', async () => {
    const { servicio, dataSource } = armar();
    await expect(
      servicio.actualizar(D, 'adm-1', {
        assistantName: 'Hola {{cliente.nombre}}',
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_VARIABLE_UNKNOWN' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('el nombre para firmar es el de marca (o el legal), vacío si no está', async () => {
    const conMarca = armar([{ name: 'Florchi Gas' }]);
    expect(await conMarca.servicio.nombreDeLaEmpresa(D)).toBe('Florchi Gas');
    const [sql, params] = conMarca.manager.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain(nombreVisibleDeLaEmpresa('d'));
    expect(params).toEqual([D]);
    expect(await armar([]).servicio.nombreDeLaEmpresa(D)).toBe('');
  });

  it('un nombre de asistente fuera de largo o con corte de línea es 400 ASSISTANT_NAME_INVALID y no se guarda nada', async () => {
    for (const assistantName of [
      'G',
      `${'x'.repeat(59)}❤️`,
      'Gas\u2028ito',
      'Gas\u2029ito',
      'Gas\nito',
    ]) {
      const { servicio, dataSource } = armar();
      await expect(
        servicio.actualizar(D, 'adm-1', { assistantName }),
      ).rejects.toMatchObject({ code: 'ASSISTANT_NAME_INVALID' });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    }
  });
});
