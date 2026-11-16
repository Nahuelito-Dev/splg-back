import { registerDecorator, ValidationOptions } from 'class-validator';

/** El número es un múltiplo entero de `base` (y mayor que cero). */
export function esMultiploDe(valor: unknown, base: number): boolean {
  return typeof valor === 'number' && valor > 0 && valor % base === 0;
}

/** El valor tiene que ser un múltiplo entero de `base` (por ejemplo, del tic de una tarea). */
export function EsMultiploDe(base: number, options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'esMultiploDe',
      target: object.constructor,
      propertyName,
      constraints: [base],
      options: {
        message: `tiene que ser un múltiplo entero de ${base} segundos (el ciclo de base de la tarea)`,
        ...options,
      },
      validator: { validate: (valor: unknown) => esMultiploDe(valor, base) },
    });
  };
}
