import { IsString } from 'class-validator';

export class ResolveIncidentDto {
  @IsString()
  resolutionNote: string;
}
