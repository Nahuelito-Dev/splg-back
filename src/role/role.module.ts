// role.module.ts - CORREGIDO
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoleService } from './role.service';
import { RoleController } from './role.controller';
import { Role } from './entities/role.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Role])], // ✅ Agregar esto
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService], // ✅ Exportar para usar en otros módulos
})
export class RoleModule {}
