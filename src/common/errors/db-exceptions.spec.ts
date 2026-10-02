import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { traducirErrorDeBase } from './db-exceptions';

/**
 * Códigos de Postgres que traduce el helper compartido. 23505 y 40P01 son
 * los que importan para la revisión de vehículo en uso (`ponerEnUso`): un
 * choque de unicidad o un deadlock tienen que dar un 409 claro, no un 500.
 */
describe('traducirErrorDeBase', () => {
  const warn = jest.fn();
  const error = jest.fn();
  // Referencias directas a los `jest.fn()`, no a `logger.warn`/`logger.error`:
  // leer esos dos como propiedades de algo tipado `Logger` dispara
  // `@typescript-eslint/unbound-method` (el método "pierde" su `this`).
  const logger = { warn, error } as unknown as Logger;

  beforeEach(() => jest.clearAllMocks());

  it('23505 (unicidad violada) es 409', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '23505', detail: 'Key already exists', message: 'duplicate' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('40P01 (deadlock) es 409, no 500', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '40P01', message: 'deadlock detected' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('40001 (falla de serialización) es 409, no 500', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '40001', message: 'could not serialize access' },
        logger,
        'asignación de vehículo',
      ),
    ).toThrow(ConflictException);
  });

  it('un código no contemplado sigue siendo 500, pero deja rastro en el log', () => {
    expect(() =>
      traducirErrorDeBase({ code: '99999', message: 'misterio' }, logger),
    ).toThrow(InternalServerErrorException);
    expect(error).toHaveBeenCalled();
  });

  it('22P02 (sintaxis inválida) es 400', () => {
    expect(() =>
      traducirErrorDeBase(
        { code: '22P02', message: 'invalid input syntax' },
        logger,
      ),
    ).toThrow(BadRequestException);
  });

  it('una excepción HTTP ya decidida no se pisa', () => {
    const original = new ConflictException('ya decidido');
    expect(() => traducirErrorDeBase(original, logger)).toThrow(original);
  });
});
