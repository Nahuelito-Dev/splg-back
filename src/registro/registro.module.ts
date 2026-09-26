import { Module } from '@nestjs/common';
import { RegistroController } from './registro.controller';
import { RegistroService } from './registro.service';
import { UsersModule } from '../users/users.module';
import { RoleModule } from '../role/role.module';
import { CustomersModule } from '../customer/customer.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { AdminModule } from '../admin/admin.module';
import { DistributorModule } from '../distributor/distributor.module';

/**
 * El alta de usuarios. Depende de los dueños de cada tabla (usuario y los
 * tres perfiles) y nadie depende de él: por eso no arma ciclos.
 */
@Module({
  imports: [
    UsersModule,
    RoleModule,
    CustomersModule,
    DeliveryModule,
    AdminModule,
    DistributorModule,
  ],
  controllers: [RegistroController],
  providers: [RegistroService],
  exports: [RegistroService],
})
export class RegistroModule {}
