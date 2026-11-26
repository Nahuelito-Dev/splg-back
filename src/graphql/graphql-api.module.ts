import type { ApolloDriverConfig } from '@nestjs/apollo';
import { ApolloDriver } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { opcionesDeGraphql } from './opciones-de-graphql';

/**
 * API GraphQL de sólo lectura (`/api/graphql`), conviviendo con la REST. Hoy
 * expone los informes de ventas (`ReportsResolver`); cada módulo registra sus
 * resolvers como providers y el esquema se arma solo.
 */
@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      useFactory: () => opcionesDeGraphql({ NODE_ENV: process.env.NODE_ENV }),
    }),
  ],
})
export class GraphqlApiModule {}
