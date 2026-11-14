import { NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import type { DistributorService } from '../../distributor/distributor.service';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import type { ExpressSettingsService } from '../../distributor/express-settings.service';
import type { ProcessConfigService } from '../../distributor/process-config.service';
import type { AccesoDeLaEmpresa } from '../access/acceso-de-la-empresa.service';
import { MODULOS } from './catalogo-de-modulos';
import { CompanyModulesService } from './company-modules.service';
import type {
  ExcepcionDeModulo,
  ModulosDeLaEmpresaRepository,
} from './modulos-de-la-empresa.repository';

const AHORA = new Date('2026-11-14T12:00:00Z');

describe('CompanyModulesService (§5.2–§5.3)', () => {
  let empresas: Record<string, { distributorId: string; status: string }>;
  let fotos: Record<string, string[] | null>;
  let excepciones: Record<string, ExcepcionDeModulo[]>;
  let pendientes: jest.Mock;
  let guardar: jest.Mock;
  let invalidar: jest.Mock;
  let llaves: Record<string, Record<string, number>>;
  let express: Record<string, boolean>;
  let emit: jest.Mock;
  let service: CompanyModulesService;

  beforeEach(() => {
    empresas = {
      A: { distributorId: 'A', status: DistributorStatus.ACTIVE },
      B: { distributorId: 'B', status: DistributorStatus.ACTIVE },
    };
    fotos = { A: [...MODULOS], B: [...MODULOS] };
    excepciones = { A: [], B: [] };
    llaves = {};
    express = {};
    pendientes = jest.fn().mockResolvedValue(0);
    guardar = jest.fn((c: { distributorId: string } & ExcepcionDeModulo) => {
      excepciones[c.distributorId] = [
        ...excepciones[c.distributorId].filter(
          (e) => e.moduleKey !== c.moduleKey,
        ),
        {
          moduleKey: c.moduleKey,
          enabled: c.enabled,
          reason: c.reason,
          expiresAt: c.expiresAt,
        },
      ];
      return Promise.resolve();
    });
    invalidar = jest.fn().mockResolvedValue(undefined);
    emit = jest.fn();
    const repo = {
      fotoDelPlan: (id: string) =>
        Promise.resolve(
          fotos[id] ? { planCode: 'full', modules: fotos[id] } : null,
        ),
      excepciones: (id: string) => Promise.resolve(excepciones[id] ?? []),
      guardarExcepcion: guardar,
      pendientes,
    };
    const distribuidoras = {
      findOne: (id: string) =>
        empresas[id]
          ? Promise.resolve(empresas[id])
          : Promise.reject(
              new NotFoundException('Distribuidora no encontrada'),
            ),
      findBySlug: (slug: string) =>
        empresas[slug]
          ? Promise.resolve(empresas[slug])
          : Promise.reject(new NotFoundException('no está')),
    };
    service = new CompanyModulesService(
      repo as unknown as ModulosDeLaEmpresaRepository,
      distribuidoras as unknown as DistributorService,
      { invalidar } as unknown as AccesoDeLaEmpresa,
      {
        obtener: (id: string, proceso: string) =>
          Promise.resolve({ enabled: llaves[id]?.[proceso] ?? 0 }),
      } as unknown as ProcessConfigService,
      {
        obtener: (id: string) =>
          Promise.resolve({ enabled: express[id] ?? false }),
      } as unknown as ExpressSettingsService,
      { emit } as unknown as EventEmitter2,
    );
  });

  const de = <T extends { key: string }>(lista: T[], key: string): T =>
    lista.find((m) => m.key === key)!;

  describe('lo que ve la plataforma', () => {
    it('todos los módulos del catálogo con plan, llave de la empresa, uso e impacto', async () => {
      llaves.A = { repurchase: 1 };
      express.A = true;
      pendientes.mockImplementation((_id: string, m: string) =>
        Promise.resolve(m === 'repurchase' ? 4 : 0),
      );
      const lista = await service.deLaPlataforma('A');
      expect(lista.map((m) => m.key)).toEqual([...MODULOS]);
      expect(de(lista, 'repurchase')).toEqual({
        key: 'repurchase',
        label: 'Recompra anticipada',
        inPlan: true,
        override: null,
        enabled: true,
        companySwitch: true,
        effective: true,
        impact: {
          pending: 4,
          description: expect.stringMatching(
            /^4 invitación\(es\) de recompra vigente\(s\)\. /,
          ) as string,
        },
      });
      // Encendido por la empresa = 0: habilitado pero no en uso.
      expect(de(lista, 'document_reading')).toMatchObject({
        enabled: true,
        companySwitch: false,
        effective: false,
      });
      // Sin interruptor de la empresa: en uso si está habilitado.
      expect(de(lista, 'mercadopago')).toMatchObject({
        companySwitch: null,
        effective: true,
      });
      expect(de(lista, 'express')).toMatchObject({
        companySwitch: true,
        effective: true,
      });
    });

    it('sin suscripción rige el plan completo', async () => {
      fotos.A = null;
      const lista = await service.deLaPlataforma('A');
      expect(lista.every((m) => m.inPlan)).toBe(true);
    });

    it('una excepción vencida no rige y una nula vuelve a lo del plan', async () => {
      fotos.A = ['mercadopago'];
      excepciones.A = [
        {
          moduleKey: 'repurchase',
          enabled: true,
          reason: 'Prueba de quince días',
          expiresAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          moduleKey: 'mercadopago',
          enabled: null,
          reason: 'Vuelve a lo que diga el plan',
          expiresAt: null,
        },
      ];
      const lista = await service.deLaPlataforma('A');
      expect(de(lista, 'repurchase')).toMatchObject({
        inPlan: false,
        override: null,
        enabled: false,
      });
      expect(de(lista, 'mercadopago')).toMatchObject({
        inPlan: true,
        override: null,
        enabled: true,
      });
    });

    it('una empresa suspendida tiene sus módulos habilitados pero ninguno en uso', async () => {
      empresas.A.status = DistributorStatus.SUSPENDED;
      const lista = await service.deLaPlataforma('A');
      expect(lista.every((m) => !m.effective)).toBe(true);
      expect(de(lista, 'mercadopago').enabled).toBe(true);
    });

    it('empresa inexistente o dada de baja: 404 COMPANY_NOT_FOUND', async () => {
      await expect(service.deLaPlataforma('X')).rejects.toMatchObject({
        status: 404,
        response: { code: 'COMPANY_NOT_FOUND' },
      });
    });

    it('un error que no es 404 se propaga tal cual', async () => {
      const boom = new Error('base caída');
      (
        service as unknown as {
          distribuidoras: { findOne: () => Promise<never> };
        }
      ).distribuidoras.findOne = () => Promise.reject(boom);
      await expect(service.deLaPlataforma('A')).rejects.toBe(boom);
    });
  });

  describe('cambiar un módulo', () => {
    const motivo = 'La empresa pidió dejar de usar el lector';

    it('deshabilita aunque el plan lo traiga, invalida la caché y avisa a la empresa', async () => {
      const r = await service.cambiar(
        'A',
        'document_reading',
        { enabled: false, reason: motivo },
        'super-1',
        AHORA,
      );
      expect(guardar).toHaveBeenCalledWith({
        distributorId: 'A',
        moduleKey: 'document_reading',
        enabled: false,
        reason: motivo,
        expiresAt: null,
        actorUserId: 'super-1',
      });
      expect(invalidar).toHaveBeenCalledWith('A');
      expect(r).toMatchObject({
        key: 'document_reading',
        inPlan: true,
        override: { enabled: false, reason: motivo, expiresAt: null },
        enabled: false,
        effective: false,
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const [evento, aviso] = emit.mock.calls[0] as [
        string,
        { distributorId: string; kind: string; title: string },
      ];
      expect(evento).toBe(EVENTO_NOTIFICAR_ADMIN);
      expect(aviso).toMatchObject({
        distributorId: 'A',
        kind: 'platform_module_changed',
        title: 'La plataforma deshabilitó «Lector de documentos»',
      });
    });

    it('habilita con vencimiento lo que el plan no trae', async () => {
      fotos.A = ['mercadopago'];
      const r = await service.cambiar(
        'A',
        'repurchase',
        {
          enabled: true,
          reason: 'Prueba de quince días del módulo',
          expiresAt: '2026-11-29T12:00:00Z',
        },
        'super-1',
        AHORA,
      );
      expect(r).toMatchObject({
        inPlan: false,
        enabled: true,
        override: { enabled: true, expiresAt: '2026-11-29T12:00:00.000Z' },
      });
      const [[, aviso]] = emit.mock.calls as Array<[string, { title: string }]>;
      expect(aviso.title).toBe('La plataforma habilitó «Recompra anticipada»');
    });

    it('idempotente: repetir el mismo cambio no vuelve a avisar', async () => {
      await service.cambiar(
        'A',
        'express',
        { enabled: false, reason: motivo },
        'super-1',
        AHORA,
      );
      await service.cambiar(
        'A',
        'express',
        { enabled: false, reason: motivo },
        'super-1',
        AHORA,
      );
      expect(guardar).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('cambiar un módulo de A no cambia nada de B', async () => {
      const antes = await service.deLaEmpresa('B');
      await service.cambiar(
        'A',
        'mercadopago',
        { enabled: false, reason: motivo },
        'super-1',
        AHORA,
      );
      expect(await service.deLaEmpresa('B')).toEqual(antes);
      expect(invalidar).not.toHaveBeenCalledWith('B');
    });

    it('módulo que no existe: 400 MODULE_UNKNOWN sin escribir', async () => {
      await expect(
        service.cambiar(
          'A',
          'teletransporte',
          {
            enabled: true,
            reason: motivo,
          },
          'super-1',
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'MODULE_UNKNOWN' },
      });
      expect(guardar).not.toHaveBeenCalled();
    });

    it('empresa inexistente: 404 sin escribir', async () => {
      await expect(
        service.cambiar('X', 'express', { enabled: true, reason: motivo }, 's'),
      ).rejects.toMatchObject({ status: 404 });
      expect(guardar).not.toHaveBeenCalled();
    });

    it('vencimiento con `enabled: null` o en el pasado: 400 sin escribir', async () => {
      await expect(
        service.cambiar(
          'A',
          'express',
          { enabled: null, reason: motivo, expiresAt: '2026-12-01T00:00:00Z' },
          's',
          AHORA,
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.cambiar(
          'A',
          'express',
          { enabled: true, reason: motivo, expiresAt: '2026-11-01T00:00:00Z' },
          's',
          AHORA,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(guardar).not.toHaveBeenCalled();
    });

    it('`enabled: null` vuelve a lo del plan (sin borrar la fila)', async () => {
      excepciones.A = [
        {
          moduleKey: 'express',
          enabled: false,
          reason: motivo,
          expiresAt: null,
        },
      ];
      const r = await service.cambiar(
        'A',
        'express',
        { enabled: null, reason: 'Vuelve a lo que trae el plan' },
        's',
        AHORA,
      );
      expect(guardar).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: null, expiresAt: null }),
      );
      expect(r).toMatchObject({ override: null, enabled: true });
      expect(emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('lo que ve la empresa y las apps', () => {
    it('la empresa ve habilitado y en uso, sin motivos ni excepciones', async () => {
      llaves.A = { route_planning: 1 };
      const lista = await service.deLaEmpresa('A');
      expect(de(lista, 'route_planning')).toEqual({
        key: 'route_planning',
        label: 'Hoja de ruta',
        enabled: true,
        effective: true,
      });
    });

    it('features: los módulos en uso y el nivel de acceso', async () => {
      excepciones.A = [
        {
          moduleKey: 'mercadopago',
          enabled: false,
          reason: 'x'.repeat(10),
          expiresAt: null,
        },
      ];
      express.A = true;
      expect(await service.features('A')).toEqual({
        modules: ['fleet_planner', 'whatsapp', 'express'],
        access: 'full',
      });
      expect(await service.features('B')).toEqual({
        modules: ['fleet_planner', 'whatsapp', 'mercadopago'],
        access: 'full',
      });
      empresas.A.status = DistributorStatus.SUSPENDED;
      expect(await service.features('A')).toEqual({
        modules: [],
        access: 'blocked',
      });
    });

    it('features públicas: por slug; una suspendida no toma pedidos y no lista módulos', async () => {
      expect(await service.featuresPublicas('A')).toEqual({
        modules: ['fleet_planner', 'whatsapp', 'mercadopago'],
        acceptingOrders: true,
        message: null,
      });
      empresas.A.status = DistributorStatus.SUSPENDED;
      expect(await service.featuresPublicas('A')).toEqual({
        modules: [],
        acceptingOrders: false,
        message: 'La distribuidora no está tomando pedidos en este momento',
      });
      await expect(service.featuresPublicas('nada')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
