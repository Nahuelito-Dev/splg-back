import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeLeave } from './entities/employee-leave.entity';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { EmployeeModule } from '../employee/employee.module';
import { EmployeeRulesRegistry } from '../employee/employee-rules.registry';

/**
 * Licencias y ausencias del personal (CU-191 a CU-193, CU-316 a CU-319).
 * Depende de `employee` (el legajo es el dueño); quien necesita saber si un
 * chofer está de licencia (el despacho, el tablero) le pregunta a
 * `LeaveService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmployeeLeave]), EmployeeModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule implements OnModuleInit {
  constructor(
    private readonly rules: EmployeeRulesRegistry,
    private readonly leaves: LeaveService,
  ) {}

  /** Un legajo con licencias cargadas no es un alta errónea: corresponde el egreso. */
  onModuleInit(): void {
    this.rules.alDarDeBaja(async (manager, empleado) =>
      (await this.leaves.tieneLicencias(manager, empleado.employeeId))
        ? ['tiene licencias cargadas']
        : [],
    );
  }
}
