import type { DataSource, EntityManager } from 'typeorm';
import type { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { UpdateChatSettingsDto } from '../presentation/dto/bandeja-input.dto';
import { nombreVisibleDeLaEmpresa } from '../infrastructure/nombre-visible-de-la-empresa';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
  textoDeDerivacion,
} from './company-chat-settings.service';

const D = 'dist-a';

function armar(
  empresa: Array<{ name: string | null }> = [],
  asistenteHabilitado = false,
  guardado: Partial<ChatCompanySettings> = {},
) {
  const guardados: ChatCompanySettings[] = [];
  const repo = {
    findOneOrFail: jest.fn(() =>
      Promise.resolve(Object.assign(ajustesDeLaBandejaPorDefecto(D), guardado)),
    ),
    findOne: jest.fn(() =>
      Promise.resolve(Object.assign(ajustesDeLaBandejaPorDefecto(D), guardado)),
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
  const acceso = {
    habilitado: jest.fn(() => Promise.resolve(asistenteHabilitado)),
  };
  return {
    servicio: new CompanyChatSettingsService(
      dataSource as unknown as DataSource,
      acceso as unknown as AccesoDeLaEmpresa,
    ),
    acceso,
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

describe('CompanyChatSettingsService: el asistente con IA (B3)', () => {
  it('apagado por omisión', () => {
    expect(ajustesDeLaBandejaPorDefecto(D).assistantAiEnabled).toBe(false);
  });

  it('con la función habilitada, lo prende y queda quién lo cambió', async () => {
    const { servicio, guardados, acceso } = armar([], true);
    const a = await servicio.actualizar(D, 'adm-1', {
      assistantAiEnabled: true,
    });
    expect(acceso.habilitado).toHaveBeenCalledWith(D, 'assistant');
    expect(guardados).toHaveLength(1);
    expect(a).toEqual(
      expect.objectContaining({
        assistantAiEnabled: true,
        updatedByUserId: 'adm-1',
      }),
    );
  });

  it('prenderlo sin la función habilitada es 403 MODULE_DISABLED, sin hablar de módulos, y no guarda nada', async () => {
    const { servicio, dataSource } = armar([], false);
    await expect(
      servicio.actualizar(D, 'adm-1', { assistantAiEnabled: true }),
    ).rejects.toMatchObject({
      status: 403,
      response: {
        code: 'MODULE_DISABLED',
        message: 'Esta función no está disponible para la distribuidora',
      },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('apagarlo siempre se puede, aunque la función ya no esté habilitada', async () => {
    const { servicio, guardados, acceso } = armar([], false);
    const a = await servicio.actualizar(D, 'adm-1', {
      assistantAiEnabled: false,
    });
    expect(acceso.habilitado).not.toHaveBeenCalled();
    expect(guardados).toHaveLength(1);
    expect(a.assistantAiEnabled).toBe(false);
  });

  it('dice si la función está disponible para la empresa', async () => {
    expect(await armar([], true).servicio.asistenteConIaDisponible(D)).toBe(
      true,
    );
    expect(await armar([], false).servicio.asistenteConIaDisponible(D)).toBe(
      false,
    );
  });
});

describe('CompanyChatSettingsService: un cambio parcial no pisa lo demás', () => {
  it('lo que no vino (en `undefined`, como lo deja el ValidationPipe) queda como estaba', async () => {
    const { servicio, guardados } = armar();
    const dto = Object.assign(new UpdateChatSettingsDto(), {
      ackEnabled: true,
    });
    expect(Object.keys(dto)).toContain('customerChatEnabled');
    const a = await servicio.actualizar(D, 'adm-1', dto);
    expect(guardados).toHaveLength(1);
    expect(a).toEqual(
      expect.objectContaining({
        ackEnabled: true,
        customerChatEnabled: true,
        outOfHoursEnabled: true,
        assistantAiEnabled: false,
        firstResponseTargetMinutes: 30,
        businessHours: [],
      }),
    );
  });
});

describe('CompanyChatSettingsService: prendido sin la función (B3)', () => {
  it('si ya estaba prendido y llega `true` sin la función, ignora ese campo y guarda el resto', async () => {
    const { servicio, guardados } = armar([], false, {
      assistantAiEnabled: true,
    });
    const a = await servicio.actualizar(D, 'adm-1', {
      assistantAiEnabled: true,
      ackEnabled: true,
    });
    expect(guardados).toHaveLength(1);
    expect(a).toEqual(
      expect.objectContaining({ ackEnabled: true, assistantAiEnabled: true }),
    );
  });

  it('si estaba apagado, prenderlo sin la función sigue siendo 403 y no guarda nada', async () => {
    const { servicio, dataSource } = armar([], false, {
      assistantAiEnabled: false,
    });
    await expect(
      servicio.actualizar(D, 'adm-1', {
        assistantAiEnabled: true,
        ackEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

describe('CompanyChatSettingsService: cierre por inactividad (7c)', () => {
  it('guarda cierre y aviso juntos, validados contra lo guardado', async () => {
    const { servicio } = armar();
    const a = await servicio.actualizar(D, 'adm-1', {
      inactivityCloseMinutes: 120,
      inactivityWarningMinutes: 15,
      expectedReplyEnabled: false,
    });
    expect([
      a.inactivityCloseMinutes,
      a.inactivityWarningMinutes,
      a.expectedReplyEnabled,
    ]).toEqual([120, 15, false]);
  });

  it('el aviso solo se valida contra el cierre ya guardado', async () => {
    const conCierre = armar([], false, { inactivityCloseMinutes: 60 });
    await expect(
      conCierre.servicio.actualizar(D, 'adm-1', {
        inactivityWarningMinutes: 60,
      }),
    ).rejects.toThrow('El aviso tiene que salir antes del cierre');
    const a = await conCierre.servicio.actualizar(D, 'adm-1', {
      inactivityWarningMinutes: 10,
    });
    expect([a.inactivityCloseMinutes, a.inactivityWarningMinutes]).toEqual([
      60, 10,
    ]);
  });

  it('aviso sin cierre: 400', async () => {
    const { servicio, guardados } = armar();
    await expect(
      servicio.actualizar(D, 'adm-1', { inactivityWarningMinutes: 10 }),
    ).rejects.toThrow('primero elegí en cuántos minutos se cierra');
    expect(guardados).toHaveLength(0);
  });

  it('apagar el cierre apaga también el aviso', async () => {
    const { servicio } = armar([], false, {
      inactivityCloseMinutes: 60,
      inactivityWarningMinutes: 10,
    });
    const a = await servicio.actualizar(D, 'adm-1', {
      inactivityCloseMinutes: null,
    });
    expect([a.inactivityCloseMinutes, a.inactivityWarningMinutes]).toEqual([
      null,
      null,
    ]);
  });

  it('bajar el cierre por debajo del aviso guardado: 400', async () => {
    const { servicio } = armar([], false, {
      inactivityCloseMinutes: 120,
      inactivityWarningMinutes: 60,
    });
    await expect(
      servicio.actualizar(D, 'adm-1', { inactivityCloseMinutes: 45 }),
    ).rejects.toThrow('El aviso tiene que salir antes del cierre');
  });

  it('sin tocar la inactividad, no se valida ni cambia', async () => {
    const { servicio } = armar([], false, {
      inactivityCloseMinutes: 60,
      inactivityWarningMinutes: 10,
    });
    const a = await servicio.actualizar(D, 'adm-1', { ackEnabled: true });
    expect([a.inactivityCloseMinutes, a.inactivityWarningMinutes]).toEqual([
      60, 10,
    ]);
  });
});

describe('CompanyChatSettingsService: desde cuándo rigen los plazos de inactividad (7c)', () => {
  const ANTES = new Date('2026-11-10T12:00:00Z');
  const AHORA = new Date('2026-11-16T12:00:00Z');

  it('al prenderlo rigen desde ahora', async () => {
    const { servicio } = armar();
    const a = await servicio.actualizar(
      D,
      'adm-1',
      { inactivityCloseMinutes: 60 },
      AHORA,
    );
    expect(a.inactivityEnabledAt).toEqual(AHORA);
  });

  it('cambiar el cierre o el aviso los hace regir desde ahora (un aviso anterior deja de valer)', async () => {
    for (const cambio of [
      { inactivityCloseMinutes: 90 },
      { inactivityWarningMinutes: 20 },
      { inactivityWarningMinutes: null },
    ]) {
      const { servicio } = armar([], false, {
        inactivityCloseMinutes: 60,
        inactivityWarningMinutes: 10,
        inactivityEnabledAt: ANTES,
      });
      const a = await servicio.actualizar(D, 'adm-1', cambio, AHORA);
      expect(a.inactivityEnabledAt).toEqual(AHORA);
    }
  });

  it('mandar los mismos valores no los reinicia', async () => {
    const { servicio } = armar([], false, {
      inactivityCloseMinutes: 60,
      inactivityWarningMinutes: 10,
      inactivityEnabledAt: ANTES,
    });
    const a = await servicio.actualizar(
      D,
      'adm-1',
      { inactivityCloseMinutes: 60, inactivityWarningMinutes: 10 },
      AHORA,
    );
    expect(a.inactivityEnabledAt).toEqual(ANTES);
  });

  it('apagarlo la deja nula', async () => {
    const { servicio } = armar([], false, {
      inactivityCloseMinutes: 60,
      inactivityEnabledAt: ANTES,
    });
    const a = await servicio.actualizar(
      D,
      'adm-1',
      { inactivityCloseMinutes: null },
      AHORA,
    );
    expect(a.inactivityEnabledAt).toBeNull();
  });

  it('el módulo de mensajes, por la plataforma', async () => {
    const { servicio, acceso } = armar([], true);
    expect(await servicio.chatDisponible(D)).toBe(true);
    expect(acceso.habilitado).toHaveBeenCalledWith(D, 'chat');
  });
});
