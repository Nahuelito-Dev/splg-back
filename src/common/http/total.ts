import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

/** Cabecera con el total de un listado paginado que devuelve un array. */
export const CABECERA_TOTAL = 'X-Total-Count';

/**
 * Pone el total en la respuesta. Va en una cabecera y no en el cuerpo para no
 * cambiar el contrato de los listados que ya consumen las apps (un array).
 */
export function informarTotal(res: Response, total: number): void {
  res.setHeader(CABECERA_TOTAL, String(total));
}

/** Documenta la cabecera en Swagger. */
export const ApiTotal = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      headers: {
        [CABECERA_TOTAL]: {
          description: 'Total de registros sin paginar',
          schema: { type: 'integer' },
        },
      },
    }),
  );
