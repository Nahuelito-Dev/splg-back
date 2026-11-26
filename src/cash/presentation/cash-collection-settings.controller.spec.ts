import { RequestMethod } from '@nestjs/common';
import {
  PATH_METADATA,
  METHOD_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  SettlePendingDto,
  UpdateCashCollectionSettingsDto,
} from '../dto/cash-collection-settings.dto';
import { CashCollectionSettingsController } from './cash-collection-settings.controller';

describe('CashCollectionSettingsController', () => {
  let servicio: {
    obtener: jest.Mock;
    actualizar: jest.Mock;
    pendientes: jest.Mock;
    asentarPendientes: jest.Mock;
    delPedido: jest.Mock;
  };
  let controller: CashCollectionSettingsController;

  beforeEach(() => {
    servicio = {
      obtener: jest.fn().mockResolvedValue({
        config: {
          mercadoPagoCashBoxId: 'wallet-1',
          updatedAt: new Date('2026-10-30T12:00:00Z'),
        },
        nombres: new Map([['wallet-1', 'Mercado Pago']]),
      }),
      actualizar: jest.fn().mockResolvedValue(undefined),
      pendientes: jest.fn().mockResolvedValue({ count: 2 }),
      asentarPendientes: jest.fn().mockResolvedValue({ settled: 2 }),
      delPedido: jest.fn().mockResolvedValue({ entries: [] }),
    };
    controller = new CashCollectionSettingsController(servicio as never);
  });

  it('las rutas son de la API v2', () => {
    expect(
      Reflect.getMetadata(VERSION_METADATA, CashCollectionSettingsController),
    ).toBe('2');
    const ruta = (metodo: keyof CashCollectionSettingsController) => {
      const handler = CashCollectionSettingsController.prototype[
        metodo
      ] as object;
      return [
        Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        Reflect.getMetadata(PATH_METADATA, handler) as string,
      ];
    };
    expect(ruta('ver')).toEqual([RequestMethod.GET, 'cash-settings']);
    expect(ruta('actualizar')).toEqual([RequestMethod.PATCH, 'cash-settings']);
    expect(ruta('pendientes')).toEqual([
      RequestMethod.GET,
      'cash-settings/pending',
    ]);
    expect(ruta('asentarPendientes')).toEqual([
      RequestMethod.POST,
      'cash-settings/settle-pending',
    ]);
    expect(ruta('delPedido')).toEqual([
      RequestMethod.GET,
      'orders/:orderId/cash-settlement',
    ]);
  });

  it('GET devuelve las cajas con su nombre, de la distribuidora en contexto', async () => {
    const r = await controller.ver('dist-1');

    expect(servicio.obtener).toHaveBeenCalledWith('dist-1');
    expect(r).toEqual({
      mercadoPagoCashBoxId: 'wallet-1',
      mercadoPagoCashBoxName: 'Mercado Pago',
      updatedAt: new Date('2026-10-30T12:00:00Z'),
    });
  });

  it('GET sin configuración devuelve todo en null', async () => {
    servicio.obtener.mockResolvedValue({ config: null, nombres: new Map() });
    expect(await controller.ver('dist-1')).toEqual({
      mercadoPagoCashBoxId: null,
      mercadoPagoCashBoxName: null,
      updatedAt: null,
    });
  });

  it('PATCH guarda con la distribuidora y el usuario del token y devuelve lo vigente', async () => {
    await controller.actualizar(
      { mercadoPagoCashBoxId: 'wallet-1' },
      'dist-1',
      'adm-1',
    );

    expect(servicio.actualizar).toHaveBeenCalledWith(
      { mercadoPagoCashBoxId: 'wallet-1' },
      'dist-1',
      'adm-1',
    );
    expect(servicio.obtener).toHaveBeenCalledWith('dist-1');
  });

  it('settle-pending asienta desde la fecha pedida con el usuario del token', async () => {
    await controller.asentarPendientes(
      { from: '2026-10-01' },
      'dist-1',
      'adm-1',
    );
    expect(servicio.asentarPendientes).toHaveBeenCalledWith(
      'dist-1',
      '2026-10-01',
      'adm-1',
    );
  });

  it('el cobro de un pedido se consulta dentro de la distribuidora', async () => {
    await controller.delPedido('ord-1', 'dist-1');
    expect(servicio.delPedido).toHaveBeenCalledWith('ord-1', 'dist-1');
  });

  describe('validación de los cuerpos', () => {
    const errores = async <T extends object>(
      clase: new () => T,
      datos: object,
    ) => (await validate(plainToInstance(clase, datos))).map((e) => e.property);

    it('PATCH acepta uuid, null y vacío; rechaza lo que no es uuid', async () => {
      expect(await errores(UpdateCashCollectionSettingsDto, {})).toEqual([]);
      expect(
        await errores(UpdateCashCollectionSettingsDto, {
          mercadoPagoCashBoxId: null,
        }),
      ).toEqual([]);
      expect(
        await errores(UpdateCashCollectionSettingsDto, {
          mercadoPagoCashBoxId: 'billetera',
        }),
      ).toEqual(['mercadoPagoCashBoxId']);
    });

    it('settle-pending exige la fecha desde la que se asienta', async () => {
      expect(await errores(SettlePendingDto, {})).toEqual(['from']);
      expect(await errores(SettlePendingDto, { from: 'ayer' })).toEqual([
        'from',
      ]);
      expect(await errores(SettlePendingDto, { from: '2026-10-01' })).toEqual(
        [],
      );
    });
  });
});
