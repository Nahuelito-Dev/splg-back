import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Valida que la propiedad sea una fecha posterior a otra propiedad del mismo
 * objeto (p. ej. `validUntil` > `validFrom`). Si alguna de las dos falta, no
 * hay nada que comparar y se considera válido (lo cubre `@IsOptional` /
 * `@IsISO8601` de cada campo por separado).
 */
export function EsPosteriorA(
  propiedadInicio: string,
  opciones?: ValidationOptions,
) {
  return function (objeto: object, propiedad: string) {
    registerDecorator({
      name: 'esPosteriorA',
      target: objeto.constructor,
      propertyName: propiedad,
      constraints: [propiedadInicio],
      options: opciones,
      validator: {
        validate: (valor: unknown, args: ValidationArguments) => {
          const inicio = (args.object as Record<string, unknown>)[
            propiedadInicio
          ];
          if (valor === undefined || valor === null) return true;
          if (inicio === undefined || inicio === null) return true;
          const fin = new Date(valor as string).getTime();
          const desde = new Date(inicio as string).getTime();
          return Number.isFinite(fin) && Number.isFinite(desde) && fin > desde;
        },
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} tiene que ser posterior a ${propiedadInicio}`,
      },
    });
  };
}
