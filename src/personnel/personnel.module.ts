import { Module } from '@nestjs/common';
import { PersonnelController } from './personnel.controller';
import { PersonnelDashboardService } from './personnel-dashboard.service';
import { EmployeeModule } from '../employee/employee.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveModule } from '../leave/leave.module';
import { FleetModule } from '../fleet/fleet.module';

/** Tablero de personal (CU-194): lectura sobre los servicios de los módulos de personal. */
@Module({
  imports: [EmployeeModule, AttendanceModule, LeaveModule, FleetModule],
  controllers: [PersonnelController],
  providers: [PersonnelDashboardService],
})
export class PersonnelModule {}
