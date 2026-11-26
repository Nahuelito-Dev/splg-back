import { readFileSync } from 'fs';
import { imprimirEsquema, RUTA_DEL_ESQUEMA } from './esquema';

describe('esquema.graphql', () => {
  it('coincide con los resolvers (si falla: npm run graphql:esquema y actualizar el panel)', async () => {
    expect(await imprimirEsquema()).toBe(
      readFileSync(RUTA_DEL_ESQUEMA, 'utf8'),
    );
  });

  it('es de sólo lectura: sin mutaciones ni suscripciones', async () => {
    const sdl = await imprimirEsquema();
    expect(sdl).toContain('type Query {');
    expect(sdl).not.toMatch(/type (Mutation|Subscription) \{/);
  });
});
