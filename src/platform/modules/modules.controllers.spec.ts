import { MODULE_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlatformAccessModule } from '../access/platform-access.module';
import { AccesoDeLaEmpresa } from '../access/acceso-de-la-empresa.service';
import {
  CATALOGO_DE_MODULOS,
  checkModuloConocido,
  esModulo,
  MODULOS,
  MODULOS_APAGADOS_POR_OMISION,
  MODULOS_POR_PLAN,
} from './catalogo-de-modulos';
import {
  CompanyModulesController,
  MeFeaturesController,
} from './company-modules.controller';
import type { CompanyModulesService } from './company-modules.service';
import { SetCompanyModuleDto } from './dto/modules.dto';
import { PlatformModulesController } from './platform-modules.controller';
import { PublicFeaturesController } from './public-features.controller';

describe('controllers de módulos (finos: delegan en el servicio)', () => {
  const servicio = {
    deLaPlataforma: jest.fn().mockResolvedValue(['plataforma']),
    cambiar: jest.fn().mockResolvedValue('cambiado'),
    deLaEmpresa: jest.fn().mockResolvedValue(['empresa']),
    features: jest.fn().mockResolvedValue('features'),
    featuresPublicas: jest.fn().mockResolvedValue('publicas'),
  };
  const s = servicio as unknown as CompanyModulesService;

  it('plataforma: lista y cambia con el usuario que lo pide', async () => {
    const c = new PlatformModulesController(s);
    expect(await c.list('A')).toEqual(['plataforma']);
    const dto = { enabled: false, reason: 'Motivo de prueba largo' };
    expect(await c.set('A', 'express', dto, 'super-1')).toBe('cambiado');
    expect(servicio.cambiar).toHaveBeenCalledWith(
      'A',
      'express',
      dto,
      'super-1',
    );
  });

  it('empresa, features y públicas', async () => {
    expect(await new CompanyModulesController(s).list('A')).toEqual([
      'empresa',
    ]);
    expect(await new MeFeaturesController(s).features('A')).toBe('features');
    expect(await new PublicFeaturesController(s).features('demo')).toBe(
      'publicas',
    );
    expect(servicio.featuresPublicas).toHaveBeenCalledWith('demo');
  });
});

describe('SetCompanyModuleDto', () => {
  const errores = async (cuerpo: object) =>
    (await validate(plainToInstance(SetCompanyModuleDto, cuerpo))).map(
      (e) => e.property,
    );

  it('acepta true, false y null con motivo de 10 a 300', async () => {
    for (const enabled of [true, false, null]) {
      expect(
        await errores({ enabled, reason: 'Pedido de la empresa' }),
      ).toEqual([]);
    }
  });

  it('exige `enabled` (null también se manda) y lo quiere booleano', async () => {
    expect(await errores({ reason: 'Pedido de la empresa' })).toEqual([
      'enabled',
    ]);
    expect(
      await errores({ enabled: 'si', reason: 'Pedido de la empresa' }),
    ).toEqual(['enabled']);
  });

  it('motivo recortado de 10 a 300 caracteres', async () => {
    expect(await errores({ enabled: true, reason: '   corto   ' })).toEqual([
      'reason',
    ]);
    expect(await errores({ enabled: true, reason: 'x'.repeat(301) })).toEqual([
      'reason',
    ]);
    expect(await errores({ enabled: true, reason: 7 })).toEqual(['reason']);
  });

  it('vencimiento opcional en ISO 8601', async () => {
    expect(
      await errores({
        enabled: true,
        reason: 'Pedido de la empresa',
        expiresAt: '2026-12-01T00:00:00Z',
      }),
    ).toEqual([]);
    expect(
      await errores({
        enabled: true,
        reason: 'Pedido de la empresa',
        expiresAt: 'mañana',
      }),
    ).toEqual(['expiresAt']);
  });
});

describe('catálogo de módulos', () => {
  it('cada módulo tiene su ficha con la misma clave y etiqueta en castellano', () => {
    for (const m of MODULOS) {
      expect(CATALOGO_DE_MODULOS[m].key).toBe(m);
      expect(CATALOGO_DE_MODULOS[m].label).not.toMatch(/_/);
    }
    expect(esModulo('express')).toBe(true);
    expect(esModulo('dispatch')).toBe(false);
  });

  it('los planes sembrados: Completo y Prueba traen todo menos lo apagado por omisión; Básico, Mercado Pago y express (D-P1)', () => {
    const enLosPlanes = MODULOS.filter((m) => m !== 'assistant');
    expect(MODULOS_POR_PLAN.full).toEqual(enLosPlanes);
    expect(MODULOS_POR_PLAN.trial).toEqual(enLosPlanes);
    expect(MODULOS_POR_PLAN.basic).toEqual(['mercadopago', 'express']);
  });

  it('el asistente del chat (M8) no viene en ningún plan: se habilita empresa por empresa (D-B3)', () => {
    expect(MODULOS_APAGADOS_POR_OMISION).toEqual(['assistant']);
    for (const plan of Object.values(MODULOS_POR_PLAN)) {
      expect(plan).not.toContain('assistant');
    }
    expect(CATALOGO_DE_MODULOS.assistant.label).toBe('Asistente del chat');
  });

  it('el CHECK de la base es la lista del catálogo', () => {
    expect(checkModuloConocido('module_key')).toBe(
      `"module_key" IN (${MODULOS.map((m) => `'${m}'`).join(', ')})`,
    );
  });

  it('el módulo de acceso es global y exporta AccesoDeLaEmpresa', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, PlatformAccessModule),
    ).toEqual([AccesoDeLaEmpresa]);
  });
});
