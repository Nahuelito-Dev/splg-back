import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { VehicleAssignmentService } from './vehicle-assignment.service';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import { Car, FleetStatus } from './entities/car.entity';
import { DeliveryService } from '../delivery/delivery.service';

/**
 * Qué vehículo usa cada chofer (decisión de nahue, 30/09). Cubre las
 * invariantes centrales: una sola asignación abierta por chofer y por
 * vehículo (cerradas dentro de la misma transacción), y que no se pueda dar
 * de baja un vehículo en uso.
 */
describe('VehicleAssignmentService', () => {
  let service: VehicleAssignmentService;
  let assignments: {
    find: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    save: jest.Mock;
  };
  let cars: { findOne: jest.Mock };
  let carsTx: { getOne: jest.Mock; andWhere: jest.Mock };
  let deliveries: { findOne: jest.Mock };
  let qb: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let txRepo: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let manager: { getRepository: jest.Mock; query: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  /** Las consultas que el service hace con el manager de la transacción. */
  /** El lock de choferes devuelve los ids pedidos, vigentes. */
  const choferesVigentes = (params: unknown[] | undefined) =>
    ((params?.[0] as string[] | undefined) ?? []).map((id) => ({
      delivery_id: id,
      deleted: false,
    }));

  function sqlsDelManager(): string[] {
    return manager.query.mock.calls.map((c) => (c as [string])[0]);
  }

  beforeEach(() => {
    assignments = {
      find: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn((a: VehicleAssignment) => Promise.resolve(a)),
    };
    cars = { findOne: jest.fn() };
    carsTx = { getOne: jest.fn(), andWhere: jest.fn().mockReturnThis() };
    deliveries = { findOne: jest.fn() };
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
    };
    txRepo = {
      createQueryBuilder: jest.fn(() => qb),
      create: jest.fn((a: Partial<VehicleAssignment>) => a),
      save: jest.fn((a: VehicleAssignment) => Promise.resolve(a)),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const carQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: carsTx.andWhere,
      getOne: carsTx.getOne,
    };
    manager = {
      getRepository: jest.fn((entidad: unknown) =>
        entidad === Car ? { createQueryBuilder: () => carQb } : txRepo,
      ),
      // Por defecto, ningún chofer tiene un pedido en curso
      // (`assertSinViajeEnCurso`): cada test que necesite lo contrario lo
      // sobreescribe. El lock de los choferes no devuelve nada que se use.
      query: jest.fn((sql: string, params?: unknown[]) =>
        Promise.resolve(
          sql.includes('INSERT INTO "audit"')
            ? []
            : sql.includes('"truck_load"')
              ? []
              : sql.includes('EXISTS')
                ? [{ existe: false }]
                : choferesVigentes(params),
        ),
      ),
    };
    dataSource = {
      transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    };

    service = new VehicleAssignmentService(
      assignments as unknown as Repository<VehicleAssignment>,
      cars as unknown as Repository<Car>,
      dataSource as unknown as DataSource,
      deliveries as unknown as DeliveryService,
    );
  });

  const choferDelTenant = () =>
    deliveries.findOne.mockResolvedValue({
      deliveryId: 'dl1',
      distributorId: 'd1',
    });
  const autoDelTenant = () =>
    carsTx.getOne.mockResolvedValue({ carId: 'c1', distributorId: 'd1' });
  /** Orden de las lecturas del service: la abierta del chofer, luego la del auto. */
  const abiertas = (
    delChofer: Partial<VehicleAssignment> | null,
    delAuto: Partial<VehicleAssignment> | null,
  ) =>
    txRepo.findOne
      .mockResolvedValueOnce(delChofer)
      .mockResolvedValueOnce(delAuto);

  describe('ponerEnUso', () => {
    it('un vehículo fuera de servicio no se asigna: se reactiva primero (409)', async () => {
      choferDelTenant();
      carsTx.getOne.mockResolvedValue({
        carId: 'c1',
        distributorId: 'd1',
        fleetStatus: FleetStatus.GROUNDED,
      });

      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toThrow('fuera de servicio');
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('cierra la abierta anterior del chofer y la del vehículo, y abre la nueva', async () => {
      choferDelTenant();
      autoDelTenant();

      const resultado = await service.ponerEnUso(
        'dl1',
        'c1',
        'nota',
        'd1',
        'admin-1',
      );

      // Una sola sentencia (no dos `update` separados: ver el comentario del
      // deadlock en el service) que cierra por `deliveryId` O `carId`.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ releasedByUserId: 'admin-1' }),
      );
      expect(qb.where).toHaveBeenCalledWith('released_at IS NULL');
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      // El query builder no pasa por el subscriber: pide los ids cerrados
      // para auditarlos a mano.
      expect(qb.returning).toHaveBeenCalledWith([
        'assignmentId',
        'distributorId',
      ]);
      expect(resultado).toMatchObject({
        carId: 'c1',
        deliveryId: 'dl1',
        distributorId: 'd1',
        note: 'nota',
        releasedAt: null,
      });
      // Se adjunta el `car` ya validado: el caller no necesita otra consulta.
      expect(resultado.car).toEqual({ carId: 'c1', distributorId: 'd1' });
      // El vehículo se lee con lock Y acotado a la distribuidora.
      expect(carsTx.andWhere).toHaveBeenCalledWith(
        'car.distributorId = :distributorId',
        { distributorId: 'd1' },
      );
    });

    it('audita a mano cada asignación que cierra, con la misma transacción', async () => {
      choferDelTenant();
      autoDelTenant();
      abiertas(null, null);
      qb.execute.mockResolvedValue({
        affected: 1,
        raw: [{ assignment_id: 'a1', distributor_id: 'd1' }],
      });

      await service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1');

      const auditoria = manager.query.mock.calls.find((c) =>
        (c as [string])[0].includes('INSERT INTO "audit"'),
      ) as [string, unknown[]] | undefined;
      expect(auditoria).toBeDefined();
      expect(auditoria?.[1]).toEqual(
        expect.arrayContaining(['VehicleAssignment', 'a1', 'd1']),
      );
      expect(JSON.parse(String(auditoria?.[1][7]))).toEqual([
        expect.objectContaining({ field: 'releasedAt', old_value: null }),
        {
          field: 'releasedByUserId',
          old_value: null,
          new_value: 'admin-1',
        },
      ]);
    });

    it('un chofer de otra distribuidora es 404', async () => {
      deliveries.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        distributorId: 'd2',
      });
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un vehículo de otra distribuidora es 404', async () => {
      choferDelTenant();
      carsTx.getOne.mockResolvedValue(null);
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('es idempotente: si el chofer ya tiene ese vehículo en uso, no cierra ni abre nada', async () => {
      choferDelTenant();
      autoDelTenant();
      const abierta = { assignmentId: 'a1', deliveryId: 'dl1', carId: 'c1' };
      abiertas(abierta, abierta);

      const resultado = await service.ponerEnUso(
        'dl1',
        'c1',
        'otra nota',
        'd1',
        'admin-1',
      );

      expect(resultado).toBe(abierta);
      expect(resultado.car).toEqual({ carId: 'c1', distributorId: 'd1' });
      expect(qb.execute).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
      // Ni siquiera mira si hay un viaje en curso: no cambia nada.
      expect(sqlsDelManager()).toEqual([]);
    });

    it('409 si el chofer que RECIBE el vehículo tiene un pedido en curso (no se le puede cambiar en medio de una entrega)', async () => {
      choferDelTenant();
      autoDelTenant();
      manager.query.mockImplementation((sql: string, params?: unknown[]) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? []
            : sql.includes('EXISTS')
              ? [{ existe: true }]
              : choferesVigentes(params),
        ),
      );
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('409 si se le "roba" el vehículo a OTRO chofer que tiene un pedido en curso', async () => {
      choferDelTenant();
      autoDelTenant();
      abiertas(null, { assignmentId: 'a-otro', deliveryId: 'dl-otro' });
      manager.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (!sql.includes('EXISTS'))
          return Promise.resolve(choferesVigentes(params));
        // dl1 (quien recibe): en condiciones; dl-otro: en viaje.
        return Promise.resolve([{ existe: params?.[0] === 'dl-otro' }]);
      });

      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('el chequeo de viaje en curso corre DENTRO de la transacción y DESPUÉS de bloquear a los choferes (en orden de id)', async () => {
      choferDelTenant();
      autoDelTenant();
      abiertas(null, { assignmentId: 'a-otro', deliveryId: 'dl-0' });

      await service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1');

      const sqls = sqlsDelManager();
      expect(sqls[0]).toContain('FOR NO KEY UPDATE');
      expect(manager.query.mock.calls[0]).toEqual([
        expect.any(String),
        [['dl-0', 'dl1']],
      ]);
      expect(sqls.slice(1, 3).every((q) => q.includes('EXISTS'))).toBe(true);
      expect(sqls[3]).toContain('"truck_load"'); // y después la carga abierta
      expect(sqls).toHaveLength(4); // lock + un EXISTS por chofer + la carga
    });

    it('409 si el chofer o el camión tienen una carga de camión abierta: el vehículo no se cambia en la jornada', async () => {
      choferDelTenant();
      autoDelTenant();
      manager.query.mockImplementation((sql: string, params?: unknown[]) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? [{ number: 7 }]
            : sql.includes('EXISTS')
              ? [{ existe: false }]
              : choferesVigentes(params),
        ),
      );
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toThrow(/carga de camión abierta \(carga N° 7\)/);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('si el chofer fue dado de baja mientras esperaba el lock es 404 y no inserta', async () => {
      choferDelTenant();
      autoDelTenant();
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? []
            : sql.includes('EXISTS')
              ? [{ existe: false }]
              : [{ delivery_id: 'dl1', deleted: true }],
        ),
      );
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('si el chofer al que se le "roba" el vehículo fue dado de baja, sólo se lo bloquea: no falla', async () => {
      choferDelTenant();
      autoDelTenant();
      abiertas(null, { assignmentId: 'a-otro', deliveryId: 'dl-0' });
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? []
            : sql.includes('EXISTS')
              ? [{ existe: false }]
              : [
                  { delivery_id: 'dl-0', deleted: true },
                  { delivery_id: 'dl1', deleted: false },
                ],
        ),
      );
      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).resolves.toBeDefined();
    });

    it('409 claro (no 500) si el INSERT choca por concurrencia (23505)', async () => {
      choferDelTenant();
      autoDelTenant();
      txRepo.save.mockRejectedValue({
        code: '23505',
        message: 'duplicate key',
      });

      await expect(
        service.ponerEnUso('dl1', 'c1', null, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('liberar', () => {
    it('libera la asignación abierta, con el chofer bloqueado y dentro de la transacción', async () => {
      choferDelTenant();
      const abierta = {
        assignmentId: 'a1',
        releasedAt: null,
      } as VehicleAssignment;
      txRepo.findOne.mockResolvedValue(abierta);

      await service.liberar('dl1', 'd1', 'admin-1');

      const cualquierFecha: unknown = expect.any(Date);
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          releasedAt: cualquierFecha,
          releasedByUserId: 'admin-1',
        }),
      );
      expect(sqlsDelManager()[0]).toContain('FOR NO KEY UPDATE');
    });

    it('409 si el chofer tiene una carga de camión abierta: no se libera el vehículo', async () => {
      choferDelTenant();
      txRepo.findOne.mockResolvedValue({ assignmentId: 'a1' });
      manager.query.mockImplementation((sql: string, params?: unknown[]) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? [{ number: 2 }]
            : sql.includes('EXISTS')
              ? [{ existe: false }]
              : choferesVigentes(params),
        ),
      );
      await expect(service.liberar('dl1', 'd1', 'admin-1')).rejects.toThrow(
        /carga N° 2/,
      );
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('404 si el chofer no tiene un vehículo en uso', async () => {
      choferDelTenant();
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.liberar('dl1', 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 si el chofer tiene un pedido en curso: no se le puede liberar el vehículo en medio de una entrega', async () => {
      choferDelTenant();
      manager.query.mockImplementation((sql: string, params?: unknown[]) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? []
            : sql.includes('EXISTS')
              ? [{ existe: true }]
              : choferesVigentes(params),
        ),
      );
      await expect(
        service.liberar('dl1', 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.findOne).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('liberarSiTieneUno (baja de chofer)', () => {
    const enLaTransaccion = () => manager as unknown as EntityManager;

    it('libera si tenía uno y deja la nota, por la transacción de la baja', async () => {
      txRepo.findOne.mockResolvedValue({
        assignmentId: 'a1',
        carId: 'c1',
        releasedAt: null,
        note: null,
      });

      await service.liberarSiTieneUno('dl1', enLaTransaccion());

      const cualquierFecha: unknown = expect.any(Date);
      const notaConTexto: unknown = expect.stringContaining('dado de baja');
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          releasedAt: cualquierFecha,
          note: notaConTexto,
        }),
      );
      // Nunca por el repositorio suelto: quedaría fuera de la transacción.
      expect(assignments.save).not.toHaveBeenCalled();
    });

    it('409 si el chofer tiene una carga de camión abierta: la baja se rechaza y el vehículo sigue en uso', async () => {
      txRepo.findOne.mockResolvedValue({
        assignmentId: 'a1',
        carId: 'c1',
        releasedAt: null,
        note: null,
      });
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('"truck_load"') ? [{ number: 5 }] : []),
      );

      await expect(
        service.liberarSiTieneUno('dl1', enLaTransaccion()),
      ).rejects.toThrow(
        /No se puede dar de baja al chofer mientras haya una carga de camión abierta \(carga N° 5\)/,
      );
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('no hace nada (ni tira) si no tenía vehículo en uso', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.liberarSiTieneUno('dl1', enLaTransaccion()),
      ).resolves.toBeUndefined();
      expect(txRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('assertVehiculoLibre', () => {
    const enLaTransaccion = () => manager as unknown as EntityManager;

    it('no tira si el vehículo no está en uso', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.assertVehiculoLibre('c1', enLaTransaccion()),
      ).resolves.toBeUndefined();
    });

    it('409 si el vehículo está en uso, consultando por la transacción de la baja', async () => {
      txRepo.findOne.mockResolvedValue({ assignmentId: 'a1' });
      await expect(
        service.assertVehiculoLibre('c1', enLaTransaccion()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(assignments.findOne).not.toHaveBeenCalled();
    });
  });

  describe('historialDelChofer', () => {
    it('incluye el vehículo aunque esté dado de baja, y el nombre del chofer', async () => {
      choferDelTenant();
      assignments.findAndCount.mockResolvedValue([[], 0]);
      await service.historialDelChofer('dl1', 'd1', {});
      expect(assignments.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          withDeleted: true,
          relations: ['car', 'delivery', 'delivery.user'],
        }),
      );
    });
  });

  describe('historialDelVehiculo', () => {
    it('carga la relación `car` del vehículo (no sólo la del chofer)', async () => {
      cars.findOne.mockResolvedValue({ carId: 'c1' });
      assignments.findAndCount.mockResolvedValue([[], 0]);
      await service.historialDelVehiculo('c1', 'd1', {});
      const [opciones] = assignments.findAndCount.mock.calls[0] as [
        { relations: string[] },
      ];
      expect(opciones.relations).toContain('car');
    });

    it('incluye al chofer y al vehículo aunque estén dados de baja', async () => {
      cars.findOne.mockResolvedValue({ carId: 'c1' });
      assignments.findAndCount.mockResolvedValue([[], 0]);
      await service.historialDelVehiculo('c1', 'd1', {});
      expect(assignments.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ withDeleted: true }),
      );
    });

    it('404 si el vehículo no es de esta distribuidora', async () => {
      cars.findOne.mockResolvedValue(null);
      await expect(
        service.historialDelVehiculo('c1', 'd1', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cars.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { carId: 'c1', distributorId: 'd1' },
        }),
      );
    });
  });

  describe('findVehiculosEnUsoPorDeliveryIds', () => {
    it('sin deliveryIds, no consulta', async () => {
      const resultado = await service.findVehiculosEnUsoPorDeliveryIds(
        [],
        'd1',
      );
      expect(resultado).toEqual([]);
      expect(assignments.find).not.toHaveBeenCalled();
    });

    it('devuelve deliveryId + carId + marca/modelo/patente de las asignaciones abiertas', async () => {
      assignments.find.mockResolvedValue([
        {
          deliveryId: 'dl1',
          carId: 'c1',
          car: { carPatent: 'AB123CD', carBrand: 'Honda', carModel: 'Wave' },
        },
      ]);
      const resultado = await service.findVehiculosEnUsoPorDeliveryIds(
        ['dl1', 'dl2'],
        'd1',
      );
      expect(resultado).toEqual([
        {
          deliveryId: 'dl1',
          carId: 'c1',
          patent: 'AB123CD',
          brand: 'Honda',
          model: 'Wave',
        },
      ]);
    });
  });

  describe('liberarDelVehiculo (siniestro que lo deja inutilizable)', () => {
    it('cierra la asignación abierta y devuelve el chofer', async () => {
      const abierta = {
        assignmentId: 'a1',
        deliveryId: 'dl1',
        releasedAt: null,
        note: null,
      } as VehicleAssignment;
      txRepo.findOne.mockResolvedValue(abierta);

      const chofer = await service.liberarDelVehiculo(
        'c1',
        manager as unknown as EntityManager,
        { motivo: 'Fuera de servicio', actorUserId: 'admin-1' },
      );

      expect(chofer).toBe('dl1');
      expect(txRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          releasedAt: expect.any(Date) as Date,
          releasedByUserId: 'admin-1',
          note: 'Fuera de servicio',
        }),
      );
    });

    it('con un pedido en curso es 409 y no cierra nada', async () => {
      txRepo.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        releasedAt: null,
      } as VehicleAssignment);
      manager.query.mockResolvedValueOnce([{ existe: true }]);
      await expect(
        service.liberarDelVehiculo('c1', manager as unknown as EntityManager, {
          motivo: 'x',
        }),
      ).rejects.toThrow(/fuera de servicio.*pedido en curso/);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('con una carga de camión abierta es 409 y no cierra nada', async () => {
      txRepo.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        releasedAt: null,
      } as VehicleAssignment);
      manager.query
        .mockResolvedValueOnce([{ existe: false }])
        .mockResolvedValueOnce([{ number: 7 }]);
      await expect(
        service.liberarDelVehiculo('c1', manager as unknown as EntityManager, {
          motivo: 'x',
        }),
      ).rejects.toThrow(/carga de camión abierta/);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('si nadie lo tenía en uso no hace nada', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(
        service.liberarDelVehiculo('c1', manager as unknown as EntityManager, {
          motivo: 'x',
        }),
      ).resolves.toBeNull();
      expect(txRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('choferDelVehiculoEn', () => {
    it('busca la asignación que cubre el instante, en la distribuidora', async () => {
      const where = jest.fn().mockReturnThis();
      const andWhere = jest.fn().mockReturnThis();
      assignments.find = jest.fn();
      (
        assignments as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn(() => ({
        where,
        andWhere,
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ deliveryId: 'dl1' }),
      }));
      const en = new Date('2026-10-10T12:00:00.000Z');

      await expect(service.choferDelVehiculoEn('c1', 'd1', en)).resolves.toBe(
        'dl1',
      );
      expect(andWhere).toHaveBeenCalledWith(
        'a.distributor_id = :distributorId',
        {
          distributorId: 'd1',
        },
      );
      expect(andWhere).toHaveBeenCalledWith(
        '(a.released_at IS NULL OR a.released_at > :en)',
        { en },
      );
    });

    it('si nadie lo tenía, null', async () => {
      (
        assignments as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }));
      await expect(
        service.choferDelVehiculoEn('c1', 'd1', new Date()),
      ).resolves.toBeNull();
    });
  });
});
