import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { Admin } from './entities/admin.entity';
import { StaffRole } from './entities/staff-role.entity';
import { UsersModule } from '../users/users.module';
import { RoleModule } from '../role/role.module';
import { StaffRoleService } from './staff-role.service';
import { StaffPermissionsService } from './staff-permissions.service';
import {
  AdminStaffRoleController,
  StaffRoleController,
} from './staff-role.controller';
import {
  MyPermissionsController,
  PermissionsController,
} from './permissions.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Admin, StaffRole]),
    UsersModule,
    RoleModule,
  ],
  controllers: [
    AdminController,
    StaffRoleController,
    AdminStaffRoleController,
    PermissionsController,
    MyPermissionsController,
  ],
  providers: [AdminService, StaffRoleService, StaffPermissionsService],
  // StaffPermissionsService lo usa el `PermissionGuard` global (app.module).
  exports: [AdminService, StaffPermissionsService],
})
export class AdminModule {}
