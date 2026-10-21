import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { enMinusculas } from './en-minusculas';
import { SerialesDeEnvase } from './serial-de-envase';

/**
 * Asigna envases físicos (por serial) a un pedido y los despacha. Se envía
 * cuando el chofer/admin carga en el camión los envases que salen para ese
 * pedido.
 */
export class AssignCylindersDto {
  /** Pedido al que se asignan los envases. */
  @ApiProperty({ format: 'uuid' })
  @Transform(enMinusculas)
  @IsUUID()
  orderId!: string;

  /** Seriales de los envases a despachar (deben estar FILLED). */
  @ApiProperty({ type: String, isArray: true, example: ['SN-000123'] })
  @IsArray()
  @ArrayNotEmpty()
  @SerialesDeEnvase()
  serials!: string[];
}
