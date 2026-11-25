import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerContainerModule } from '../customer-container/customer-container.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { S3Module } from '../s3/s3.module';
import { AssignCylindersToOrderUseCase } from './application/assign-cylinders-to-order.use-case';
import { CreateCylinderUseCase } from './application/create-cylinder.use-case';
import { CylinderQueryService } from './application/cylinder-query.service';
import { DeliverOrderCylindersUseCase } from './application/deliver-order-cylinders.use-case';
import { RegisterInspectionUseCase } from './application/register-inspection.use-case';
import { RetireCylinderUseCase } from './application/retire-cylinder.use-case';
import { TransitionCylinderUseCase } from './application/transition-cylinder.use-case';
import { UpdateCylinderUseCase } from './application/update-cylinder.use-case';
import { CylinderPhotoController } from './cylinder-photo.controller';
import { CylinderPhotoService } from './cylinder-photo.service';
import { CylinderVigenciaService } from './cylinder-vigencia.service';
import { CylinderController } from './cylinder.controller';
import { CylinderService } from './cylinder.service';
import { ClockPort } from './domain/ports/clock.port';
import { ContainerAccountPort } from './domain/ports/container-account.port';
import { CylinderEventsPort } from './domain/ports/cylinder-events.port';
import { CylinderInspectionRepositoryPort } from './domain/ports/cylinder-inspection.repository.port';
import { CylinderMovementRepositoryPort } from './domain/ports/cylinder-movement.repository.port';
import { CylinderQueryPort } from './domain/ports/cylinder-query.port';
import { CylinderRepositoryPort } from './domain/ports/cylinder.repository.port';
import { DriverPort } from './domain/ports/driver.port';
import { OrderDispatchPort } from './domain/ports/order-dispatch.port';
import { ProductCatalogPort } from './domain/ports/product-catalog.port';
import { UnitOfWorkPort } from './domain/ports/unit-of-work.port';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { CylinderRecoveryCase } from './entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from './entities/cylinder-recovery-notice.entity';
import { Cylinder } from './entities/cylinder.entity';
import { ContainerAccountAdapter } from './infrastructure/container-account.adapter';
import { CylinderEventsAdapter } from './infrastructure/cylinder-events.adapter';
import { CylinderInspectionTypeormRepository } from './infrastructure/cylinder-inspection.typeorm.repository';
import { CylinderMovementTypeormRepository } from './infrastructure/cylinder-movement.typeorm.repository';
import { CylinderQueryTypeormAdapter } from './infrastructure/cylinder-query.typeorm.adapter';
import { CylinderTypeormRepository } from './infrastructure/cylinder.typeorm.repository';
import { DespachoBloqueadoListener } from './infrastructure/despacho-bloqueado.listener';
import { DriverAdapter } from './infrastructure/driver.adapter';
import { OrderDispatchAdapter } from './infrastructure/order-dispatch.adapter';
import { ProductCatalogAdapter } from './infrastructure/product-catalog.adapter';
import { SystemClockAdapter } from './infrastructure/system-clock.adapter';
import { TypeormUnitOfWorkAdapter } from './infrastructure/typeorm-unit-of-work.adapter';

/**
 * Envases físicos, con arquitectura hexagonal: el dominio (`domain/`) y los
 * casos de uso (`application/`) dependen de puertos (`domain/ports/`); acá se
 * enchufa cada puerto con su adaptador (`infrastructure/`).
 */
@Module({
  // El envase toma el cliente del pedido. Se lee por OrderLookupModule y no
  // por OrderModule, que importa a cylinder para avanzar los envases al entregar.
  imports: [
    TypeOrmModule.forFeature([
      Cylinder,
      CylinderMovement,
      CylinderInspection,
      CylinderRecoveryCase,
      CylinderRecoveryNotice,
    ]),
    OrderLookupModule,
    DeliveryModule, // el chofer sólo carga envases a sus pedidos
    GatewaysModule, // el aviso al panel cuando se bloquea un despacho
    GasCylinderModule, // el producto del envase tiene que existir y ser del tenant
    S3Module, // foto del envase
    CustomerContainerModule, // F35 E5: la devolución de un envase propio baja la cuenta
  ],
  controllers: [CylinderController, CylinderPhotoController],
  providers: [
    // Aplicación: casos de uso y fachadas.
    CreateCylinderUseCase,
    UpdateCylinderUseCase,
    TransitionCylinderUseCase,
    RetireCylinderUseCase,
    AssignCylindersToOrderUseCase,
    DeliverOrderCylindersUseCase,
    RegisterInspectionUseCase,
    CylinderQueryService,
    CylinderService,
    CylinderVigenciaService,
    CylinderPhotoService,
    // Puertos de persistencia.
    { provide: CylinderRepositoryPort, useClass: CylinderTypeormRepository },
    {
      provide: CylinderMovementRepositoryPort,
      useClass: CylinderMovementTypeormRepository,
    },
    {
      provide: CylinderInspectionRepositoryPort,
      useClass: CylinderInspectionTypeormRepository,
    },
    { provide: CylinderQueryPort, useClass: CylinderQueryTypeormAdapter },
    { provide: UnitOfWorkPort, useClass: TypeormUnitOfWorkAdapter },
    // Puertos hacia otros módulos y hacia afuera.
    { provide: ClockPort, useClass: SystemClockAdapter },
    { provide: CylinderEventsPort, useClass: CylinderEventsAdapter },
    { provide: OrderDispatchPort, useClass: OrderDispatchAdapter },
    { provide: DriverPort, useClass: DriverAdapter },
    { provide: ProductCatalogPort, useClass: ProductCatalogAdapter },
    { provide: ContainerAccountPort, useClass: ContainerAccountAdapter },
    // Quien escucha los eventos de dominio para avisar al panel.
    DespachoBloqueadoListener,
  ],
  exports: [CylinderService, DeliverOrderCylindersUseCase],
})
export class CylinderModule {}
