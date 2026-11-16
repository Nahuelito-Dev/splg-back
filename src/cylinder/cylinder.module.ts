import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CylinderService } from './cylinder.service';
import { CylinderVigenciaService } from './cylinder-vigencia.service';
import { DespachoBloqueadoListener } from './events/despacho-bloqueado.listener';
import { GatewaysModule } from '../gateways/gateways.module';
import { CylinderController } from './cylinder.controller';
import { CylinderPhotoController } from './cylinder-photo.controller';
import { CylinderPhotoService } from './cylinder-photo.service';
import { S3Module } from '../s3/s3.module';
import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { DeliveryModule } from '../delivery/delivery.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { CustomerContainerModule } from '../customer-container/customer-container.module';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import { CylinderRecoveryCase } from './entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from './entities/cylinder-recovery-notice.entity';

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
    CylinderService,
    CylinderPhotoService,
    CylinderVigenciaService,
    DespachoBloqueadoListener,
  ],
  exports: [CylinderService],
})
export class CylinderModule {}
