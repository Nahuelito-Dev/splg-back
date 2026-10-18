import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeAttendance } from './entities/employee-attendance.entity';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceOpenAlertCron } from './attendance-open-alert.cron';
import { EmployeeModule } from '../employee/employee.module';
import { EmployeeRulesRegistry } from '../employee/employee-rules.registry';
import { AdminModule } from '../admin/admin.module';
import { EmailModule } from '../email/email.module';

/**
 * Asistencia del personal (CU-189, CU-190, CU-313, CU-314, CU-315): jornadas
 * con ingreso y egreso. Depende de `employee`; el chofer marca desde su app
 * con `/attendance/mine/*`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EmployeeAttendance]),
    EmployeeModule,
    AdminModule, // a quién avisar (AttendanceOpenAlertCron)
    EmailModule, // cómo avisar
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceOpenAlertCron],
  exports: [AttendanceService],
})
export class AttendanceModule implements OnModuleInit {
  constructor(
    private readonly rules: EmployeeRulesRegistry,
    private readonly attendance: AttendanceService,
  ) {}

  /** Un legajo con jornadas cargadas no es un alta errónea: corresponde el egreso. */
  onModuleInit(): void {
    this.rules.alDarDeBaja(async (manager, empleado) =>
      (await this.attendance.tieneJornadas(manager, empleado.employeeId))
        ? ['tiene jornadas cargadas']
        : [],
    );
  }
}
