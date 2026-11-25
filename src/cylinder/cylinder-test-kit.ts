import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { CustomerContainerService } from '../customer-container/customer-container.service';
import { DeliveryService } from '../delivery/delivery.service';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { AssignCylindersToOrderUseCase } from './application/assign-cylinders-to-order.use-case';
import { CreateCylinderUseCase } from './application/create-cylinder.use-case';
import { CylinderQueryService } from './application/cylinder-query.service';
import { DeliverOrderCylindersUseCase } from './application/deliver-order-cylinders.use-case';
import { RegisterInspectionUseCase } from './application/register-inspection.use-case';
import { RetireCylinderUseCase } from './application/retire-cylinder.use-case';
import { TransitionCylinderUseCase } from './application/transition-cylinder.use-case';
import { UpdateCylinderUseCase } from './application/update-cylinder.use-case';
import { CylinderVigenciaService } from './cylinder-vigencia.service';
import { CylinderService } from './cylinder.service';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { Cylinder } from './entities/cylinder.entity';
import { ContainerAccountAdapter } from './infrastructure/container-account.adapter';
import { CylinderEventsAdapter } from './infrastructure/cylinder-events.adapter';
import { CylinderInspectionTypeormRepository } from './infrastructure/cylinder-inspection.typeorm.repository';
import { CylinderMovementTypeormRepository } from './infrastructure/cylinder-movement.typeorm.repository';
import { CylinderQueryTypeormAdapter } from './infrastructure/cylinder-query.typeorm.adapter';
import { CylinderTypeormRepository } from './infrastructure/cylinder.typeorm.repository';
import { DriverAdapter } from './infrastructure/driver.adapter';
import { OrderDispatchAdapter } from './infrastructure/order-dispatch.adapter';
import { ProductCatalogAdapter } from './infrastructure/product-catalog.adapter';
import { SystemClockAdapter } from './infrastructure/system-clock.adapter';
import { TypeormUnitOfWorkAdapter } from './infrastructure/typeorm-unit-of-work.adapter';

/** Lo que el módulo de envases recibe de afuera: sus repositorios y los servicios vecinos. */
export interface PiezasDeEnvases {
  cylinders: Repository<Cylinder>;
  movements: Repository<CylinderMovement>;
  inspections: Repository<CylinderInspection>;
  orders: OrderLookupService;
  gasCylinders: GasCylinderService;
  eventos: EventEmitter2;
  deliveries: DeliveryService;
  cuentaDeEnvases: CustomerContainerService;
}

/**
 * Arma a mano, para tests, lo mismo que enchufa `CylinderModule`: los casos de
 * uso con sus adaptadores reales (TypeORM, eventos, módulos vecinos) sobre los
 * repositorios y servicios que se le pasen (dobles o reales).
 */
export function armarEnvases(piezas: PiezasDeEnvases): {
  service: CylinderService;
  vigencia: CylinderVigenciaService;
} {
  const envases = new CylinderTypeormRepository(piezas.cylinders);
  const movimientos = new CylinderMovementTypeormRepository(piezas.movements);
  const revisiones = new CylinderInspectionTypeormRepository();
  const consultasPort = new CylinderQueryTypeormAdapter(
    piezas.cylinders,
    piezas.movements,
    piezas.inspections,
  );
  const uow = new TypeormUnitOfWorkAdapter(piezas.cylinders);
  const reloj = new SystemClockAdapter();
  const eventos = new CylinderEventsAdapter(piezas.eventos);
  const pedidos = new OrderDispatchAdapter(piezas.orders);
  const choferes = new DriverAdapter(piezas.deliveries);
  const catalogo = new ProductCatalogAdapter(piezas.gasCylinders);
  const cuenta = new ContainerAccountAdapter(piezas.cuentaDeEnvases);

  const consultas = new CylinderQueryService(consultasPort, reloj);
  const service = new CylinderService(
    new CreateCylinderUseCase(envases, movimientos, catalogo),
    new UpdateCylinderUseCase(envases, catalogo, uow, reloj),
    new TransitionCylinderUseCase(
      envases,
      movimientos,
      pedidos,
      choferes,
      cuenta,
      eventos,
      uow,
      reloj,
    ),
    new RetireCylinderUseCase(envases, movimientos, uow, reloj),
    new AssignCylindersToOrderUseCase(
      envases,
      movimientos,
      pedidos,
      choferes,
      eventos,
      uow,
      reloj,
    ),
    new DeliverOrderCylindersUseCase(envases, movimientos, pedidos, uow, reloj),
    consultas,
  );
  const vigencia = new CylinderVigenciaService(
    new RegisterInspectionUseCase(envases, revisiones, movimientos, uow, reloj),
    consultas,
  );
  return { service, vigencia };
}
