import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorService } from './distributor.service';
import { DistributorController } from './distributor.controller';
import { Distributor } from './entities/distributor.entity';

/**
 * Global: `DistributorService` es transversal (lo consumen AuthGuard y el
 * scoping de casi todos los módulos), y la entidad Distributor es referenciada
 * por muchas otras. Evita re-importar el módulo en cada feature.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Distributor])],
  controllers: [DistributorController],
  providers: [DistributorService],
  exports: [DistributorService, TypeOrmModule],
})
export class DistributorModule {}
