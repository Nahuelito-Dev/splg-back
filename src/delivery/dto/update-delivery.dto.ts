import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Lo que un administrador edita del perfil de un chofer. Antes heredaba todo
 * el alta (correo, contraseña, nombre, distribuidora) y lo que no era columna
 * se descartaba en silencio: el panel creía cambiar datos que no cambiaban.
 * Los datos de la persona van por `PATCH /users/:id`; la ubicación, el saldo y
 * la disponibilidad tienen su propio endpoint.
 *
 * La habilitación (antes `isActive`) NO se edita acá: vive exclusivamente en
 * `PATCH /delivery/:id/status`, que además saca al chofer del radar al
 * deshabilitarlo. Tenerla también acá (como antes) era una segunda puerta que
 * cambiaba el mismo estado sin ese efecto: un admin podía deshabilitar a un
 * chofer por este endpoint y dejarlo, sin querer, recibiendo ofertas.
 */
export class UpdateDeliveryDto {
  @ApiPropertyOptional({ description: 'Chofer aprobado por la distribuidora' })
  @IsOptional()
  @IsBoolean({ message: 'validated tiene que ser true o false' })
  validated?: boolean;
}
