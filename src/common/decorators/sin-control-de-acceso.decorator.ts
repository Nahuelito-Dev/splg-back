import { SetMetadata } from '@nestjs/common';

export const SIN_CONTROL_DE_ACCESO_KEY = 'sinControlDeAcceso';

/**
 * Núcleo que una empresa usa aunque esté restringida o suspendida (diseño de
 * plataforma §6, `AccesoDeLaEmpresa`): el chat con la plataforma y los
 * tickets, porque es justo cuando más se necesita (diseño de comunicación
 * §4.2.2). El guard que controla el estado de la empresa lee esta marca y deja
 * pasar.
 *
 * Mientras ese guard no exista (llega con los módulos por distribuidora), la
 * marca documenta la excepción y la fija un test: ningún endpoint de C1 la
 * pierde.
 */
export const SinControlDeAcceso = () =>
  SetMetadata(SIN_CONTROL_DE_ACCESO_KEY, true);
