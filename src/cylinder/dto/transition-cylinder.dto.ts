import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { CylinderState } from '../entities/cylinder.entity';

export class TransitionCylinderDto {
  @IsEnum(CylinderState)
  toState: CylinderState;

  /** Pedido en cuyo contexto ocurre la transición (ej. dispatch/entrega). */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
