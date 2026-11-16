import { SetMetadata } from '@nestjs/common';

export const SOLO_LECTURA_KEY = 'auditoria:solo-lectura';

/**
 * Marca un POST que sólo lee (p. ej. una consulta por lote con ids en el
 * cuerpo): el interceptor de auditoría no lo registra como escritura.
 */
export const SoloLectura = () => SetMetadata(SOLO_LECTURA_KEY, true);
