import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './entities/employee.entity';
import { JobPosition } from './entities/job-position.entity';
import { EmployeeController } from './employee.controller';
import { JobPositionController } from './job-position.controller';
import { EmployeeService } from './employee.service';
import { JobPositionService } from './job-position.service';
import { EmployeeUserRemovedListener } from './employee-user-removed.listener';
import { JobPositionSeedListener } from './job-position-seed.listener';
import { EmployeeRulesRegistry } from './employee-rules.registry';
import { EmployeeAttachmentOwnerResolver } from './employee-attachment-owner.resolver';
import { TerminateEmployeeUseCase } from './application/terminate-employee.use-case';
import { EmployeePhotoService } from './employee-photo.service';
import { S3Module } from '../s3/s3.module';
import { UsersModule } from '../users/users.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CarModule } from '../car/car.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { AttachmentModule } from '../attachment/attachment.module';

/**
 * Personal: puestos de trabajo y legajos (CU-176 a CU-182). No depende de
 * `registro`: es `registro` quien lo importa para crear o vincular el legajo
 * en el alta de un chofer, y quien aloja `POST /employees/:id/account`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, JobPosition]),
    UsersModule, // bloquear la cuenta al egresar
    DeliveryModule, // deshabilitar al chofer y su id de reparto
    CarModule, // liberar el vehículo en uso (VehicleAssignmentService)
    OrderLookupModule, // pedidos en curso del chofer
    DocumentSequenceModule, // número de legajo
    AttachmentModule, // dueño `employee` de los adjuntos
    S3Module, // foto del legajo
  ],
  controllers: [JobPositionController, EmployeeController],
  providers: [
    EmployeeService,
    EmployeePhotoService,
    JobPositionService,
    JobPositionSeedListener,
    EmployeeUserRemovedListener,
    EmployeeRulesRegistry,
    EmployeeAttachmentOwnerResolver,
    TerminateEmployeeUseCase,
  ],
  exports: [EmployeeService, EmployeePhotoService, EmployeeRulesRegistry],
})
export class EmployeeModule {}
