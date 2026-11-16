import { PartialType } from '@nestjs/swagger';
import { CreateFleetPlanDto } from './create-plan.dto';

export class UpdateFleetPlanDto extends PartialType(CreateFleetPlanDto) {}
