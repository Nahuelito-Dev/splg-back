import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { join } from 'path';
import { ReportsResolver } from '../reports/reports.resolver';

/**
 * Los resolvers de la API GraphQL. Al sumar uno, va acá también: con esta
 * lista se imprime el esquema que consume el panel (`esquema.graphql`).
 */
export const RESOLVERS_GRAPHQL = [ReportsResolver];

/** El esquema versionado junto al código, del que el panel genera sus tipos. */
export const RUTA_DEL_ESQUEMA = join(__dirname, 'esquema.graphql');

/**
 * El SDL de la API GraphQL, igual al que sirve la app (mismos resolvers,
 * ordenado), sin levantar la app ni la base.
 */
export async function imprimirEsquema(): Promise<string> {
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  try {
    await app.init();
    const fabrica = app.get(GraphQLSchemaFactory);
    const esquema = await fabrica.create(RESOLVERS_GRAPHQL);
    return printSchema(lexicographicSortSchema(esquema)) + '\n';
  } finally {
    await app.close();
  }
}
