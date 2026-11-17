import { Global, Module } from '@nestjs/common';
import { AdminModule } from './admin.module';
import { StaffRoleService } from './staff-role.service';
import { AutoridadSobreCuentas } from '../common/permisos/autoridad-sobre-cuentas';

/**
 * Enlaza el puerto `AutoridadSobreCuentas` con `StaffRoleService`. Global
 * porque quien lo consume (`UsersController`) vive en `users`, del que
 * `admin` ya depende: importarlo desde `users` sería un ciclo (CONVENCIONES
 * §4, inversión de la dependencia con un puerto).
 */
@Global()
@Module({
  imports: [AdminModule],
  providers: [
    { provide: AutoridadSobreCuentas, useExisting: StaffRoleService },
  ],
  exports: [AutoridadSobreCuentas],
})
export class AutoridadSobreCuentasModule {}
