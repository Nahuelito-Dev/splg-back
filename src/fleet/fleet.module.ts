import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { MaintenanceWindowProposal } from './entities/maintenance-window-proposal.entity';
import { VehicleUsageLog } from './entities/vehicle-usage-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MaintenancePlan,
      MaintenanceTask,
      MaintenanceWindowProposal,
      VehicleUsageLog,
    ]),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class FleetModule {}
