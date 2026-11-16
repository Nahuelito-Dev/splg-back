import { Module } from '@nestjs/common';
import { DriversGateway } from './drivers.gateway';
import { CustomersGateway } from './customers.gateway';
import { AdminGateway } from './admin.gateway';
import { SocketIdentityService } from './socket-identity.service';
import { SocketSesionesService } from './socket-sesiones.service';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminModule } from '../admin/admin.module';
import { PermisosDePlataformaService } from '../common/permisos/catalogo-de-plataforma';
import { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';

@Module({
  imports: [RedisModule, AuthModule, UsersModule, AdminModule],
  providers: [
    SocketIdentityService,
    PermisosDePlataformaService,
    ParticipacionEnConversaciones,
    DriversGateway,
    CustomersGateway,
    AdminGateway,
    SocketSesionesService,
  ],
  exports: [DriversGateway, CustomersGateway, AdminGateway],
})
export class GatewaysModule {}
