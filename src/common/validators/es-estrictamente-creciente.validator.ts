import { registerDecorator, ValidationOptions } from 'class-validator';

/** Cada número es mayor que el anterior (sin repetidos ni desordenados). */
export function esEstrictamenteCreciente(valor: unknown): boolean {
  if (!Array.isArray(valor)) return false;
  for (let i = 1; i < valor.length; i++) {
    const anterior: unknown = valor[i - 1];
    const actual: unknown = valor[i];
    if (typeof anterior !== 'number' || typeof actual !== 'number') {
      return false;
    }
    if (actual <= anterior) return false;
  }
  return true;
}

/** La lista tiene que venir estrictamente creciente (por ejemplo, los pasos de radio). */
export function EsEstrictamenteCreciente(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'esEstrictamenteCreciente',
      target: object.constructor,
      propertyName,
      options: {
        message:
          'tiene que ser una lista estrictamente creciente (cada valor mayor que el anterior, sin repetidos)',
        ...options,
      },
      validator: { validate: esEstrictamenteCreciente },
    });
  };
}
