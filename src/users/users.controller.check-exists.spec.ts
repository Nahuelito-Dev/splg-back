import { UsersController } from './users.controller';

/** Metadatos que `@nestjs/throttler` lee del handler (`@Throttle`). */
const LIMITE = 'THROTTLER:LIMITdefault';
const TTL = 'THROTTLER:TTLdefault';

describe('POST /users/check-exists', () => {
  const handler = Reflect.get(
    UsersController.prototype,
    'checkUserExists',
  ) as object;

  it('tiene un cupo bajo por IP: es público y sirve para enumerar cuentas', () => {
    expect(Reflect.getMetadata(LIMITE, handler)).toBeLessThanOrEqual(10);
    expect(Reflect.getMetadata(TTL, handler)).toBe(60_000);
  });
});
