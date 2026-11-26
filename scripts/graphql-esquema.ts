/**
 * Reescribe el esquema de la API GraphQL (`src/graphql/esquema.graphql`) a
 * partir de los resolvers. No toca la base.
 *
 *   npm run graphql:esquema
 *
 * El panel copia ese archivo y genera sus tipos (`npm run graphql:types`). El
 * test `esquema.spec.ts` falla si el archivo quedó viejo.
 */
import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { imprimirEsquema, RUTA_DEL_ESQUEMA } from '../src/graphql/esquema';

async function main(): Promise<void> {
  writeFileSync(RUTA_DEL_ESQUEMA, await imprimirEsquema());
  console.log(`Esquema escrito en ${RUTA_DEL_ESQUEMA}`);
}

void main();
