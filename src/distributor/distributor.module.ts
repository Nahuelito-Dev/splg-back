import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorService } from './distributor.service';
import { DistributorController } from './distributor.controller';
import { Distributor } from './entities/distributor.entity';
import { ModuleConfig } from './entities/module-config.entity';

/**
 * Global: `DistributorService` es transversal (lo consumen AuthGuard y el
 * scoping de casi todos los módulos), y la entidad Distributor es referenciada
 * por muchas otras. Evita re-importar el módulo en cada feature. Exporta el
 * servicio y no el repositorio: los demás módulos leen distribuidoras por acá.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Distributor, ModuleConfig])],
  controllers: [DistributorController],
  providers: [DistributorService],
  exports: [DistributorService],
})
export class DistributorModule {}
