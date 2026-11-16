import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/**
 * Documento de quien recibe: DNI, CUIT/CUIL o pasaporte. Se normaliza antes de
 * validar (sin puntos, guiones ni espacios, en mayúsculas) y tiene que traer
 * algún dígito.
 */
export const FORMATO_DE_DOCUMENTO = /^(?=.*\d)[A-Z0-9]{6,15}$/;

/** Cuerpo de `PATCH /orders/:id/receiver` (CU-128). */
export class SetOrderReceiverDto {
  @ApiProperty({ maxLength: 120, example: 'María Gómez' })
  @TextoNoVacio()
  @MaxLength(120)
  receiverName!: string;

  @ApiProperty({
    maxLength: 20,
    example: '30123456',
    description:
      'DNI, CUIT/CUIL o pasaporte (6 a 15 letras o dígitos, con al menos un dígito). Puede venir con puntos o guiones: se guarda sin ellos. Dato personal de un tercero: no se guarda en el registro de auditoría.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[\s.-]/g, '').toUpperCase()
      : value,
  )
  @Matches(FORMATO_DE_DOCUMENTO, {
    message:
      'receiverDocument: formato inválido (DNI, CUIT/CUIL o pasaporte, de 6 a 15 letras o dígitos)',
  })
  receiverDocument!: string;

  @ApiProperty({
    maxLength: 40,
    example: 'vecina',
    description: 'Relación con el cliente: familiar, encargado, vecino...',
  })
  @TextoNoVacio()
  @MaxLength(40)
  receiverRelationship!: string;
}
