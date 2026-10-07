import { PartialType, PickType } from '@nestjs/swagger';
import { CreateClaimDto } from './create-claim.dto';

/** Lo único editable de un reclamo pendiente: motivo y descripción. */
export class UpdateClaimDto extends PartialType(
  PickType(CreateClaimDto, ['reason', 'description'] as const),
) {}
