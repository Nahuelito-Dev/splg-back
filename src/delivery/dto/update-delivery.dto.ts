import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Lo que un administrador edita del perfil de un chofer. Antes heredaba todo
 * el alta (correo, contraseña, nombre, distribuidora) y lo que no era columna
 * se descartaba en silencio: el panel creía cambiar datos que no cambiaban.
 * Los datos de la persona van por `PATCH /users/:id`; la ubicación, el saldo y
 * la disponibilidad tienen su propio endpoint.
 */
export class UpdateDeliveryDto {
  @ApiPropertyOptional({ description: 'Chofer aprobado por la distribuidora' })
  @IsOptional()
  @IsBoolean({ message: 'validated tiene que ser true o false' })
  validated?: boolean;

  @ApiPropertyOptional({ description: 'Disponible para recibir ofertas' })
  @IsOptional()
  @IsBoolean({ message: 'isActive tiene que ser true o false' })
  isActive?: boolean;
}
