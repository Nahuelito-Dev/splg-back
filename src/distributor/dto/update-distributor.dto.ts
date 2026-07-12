import { PartialType } from '@nestjs/mapped-types';
import { OmitType } from '@nestjs/mapped-types';
import { CreateDistributorDto } from './create-distributor.dto';

/**
 * El `slug` es el identificador estable del tenant: no se cambia por update
 * (rompería resolución por header/subdominio y referencias). Todo lo demás
 * es editable.
 */
export class UpdateDistributorDto extends PartialType(
  OmitType(CreateDistributorDto, ['slug'] as const),
) {}
