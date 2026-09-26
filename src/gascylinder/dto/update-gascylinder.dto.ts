import { PartialType } from '@nestjs/swagger';
import { CreateGasCylinderDto } from './create-gascylinder.dto';

export class UpdateGasCylinderDto extends PartialType(CreateGasCylinderDto) {}
