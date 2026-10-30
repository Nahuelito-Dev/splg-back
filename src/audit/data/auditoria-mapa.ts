import { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
import {
  ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST,
  CONTEXTO_DE_PEDIDO,
  esSecreto,
  PROPIEDADES_EXCLUIDAS,
  TABLAS_EXCLUIDAS,
} from './audit-exclusions';

/** Cómo el trigger convierte el valor de la columna a texto. */
export type TipoDeValor = 'text' | 'timestamp' | 'json' | 'geo';

/** De dónde sale la distribuidora de un asiento. */
export type ModoDeDistribuidora =
  | 'self'
  | 'column'
  | 'parent'
  | 'request'
  | 'none';

/** Una fila de `audit_entity_map`: una tabla auditada y su entidad. */
export interface FilaDeEntidad {
  table: string;
  entity: string;
  pk: string[];
  deleteColumn: string | null;
  distributorMode: ModoDeDistribuidora;
  distributorColumn: string | null;
  /** Modo `parent`: la distribuidora se toma del padre por su FK. */
  parentTable: string | null;
  parentFkColumn: string | null;
  parentPkColumn: string | null;
  parentDistributorColumn: string | null;
  orderProperty: string | null;
  orderColumn: string | null;
}

/** Una fila de `audit_field_map`: una columna que se audita y su propiedad. */
export interface FilaDeCampo {
  table: string;
  column: string;
  property: string;
  secret: boolean;
  kind: TipoDeValor;
  /** Orden de la columna en la entidad: el de los detalles del asiento. */
  position: number;
}

export interface MapaDeAuditoria {
  entities: FilaDeEntidad[];
  fields: FilaDeCampo[];
}

const TIPOS_JSON = new Set(['json', 'jsonb', 'simple-json']);

function tipoDeValor(columna: EntityMetadata['columns'][number]): TipoDeValor {
  const tipo: unknown = columna.type;
  if (typeof tipo !== 'string') return 'text';
  if (tipo.startsWith('timestamp')) return 'timestamp';
  if (tipo === 'geometry' || tipo === 'geography') return 'geo';
  if (TIPOS_JSON.has(tipo) || (columna.isArray && tipo !== 'simple-array')) {
    return 'json';
  }
  return 'text';
}

interface Distribuidora {
  mode: ModoDeDistribuidora;
  column: string | null;
  parent: {
    table: string;
    fk: string;
    pk: string;
    distributor: string;
  } | null;
}

/** El padre (ManyToOne obligatorio) con distribuidora propia del que cuelga un renglón. */
function padreConDistribuidora(
  metadata: EntityMetadata,
): Distribuidora['parent'] {
  for (const r of metadata.relations) {
    if (!r.isManyToOne || r.isNullable || r.joinColumns.length !== 1) continue;
    const padre = r.inverseEntityMetadata;
    const columna = padre.columns.find(
      (c) => c.propertyName === 'distributorId',
    );
    const pk = padre.primaryColumns;
    if (!columna || pk.length !== 1 || pk[0].type !== 'uuid') continue;
    return {
      table: padre.tableName,
      fk: r.joinColumns[0].databaseName,
      pk: pk[0].databaseName,
      distributor: columna.databaseName,
    };
  }
  return null;
}

function distribuidoraDe(metadata: EntityMetadata): Distribuidora {
  if (metadata.tableName === 'distributor') {
    return { mode: 'self', column: null, parent: null };
  }
  const columna = metadata.columns.find(
    (c) => c.propertyName === 'distributorId',
  );
  if (columna) {
    return { mode: 'column', column: columna.databaseName, parent: null };
  }
  if (ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST.has(metadata.name)) {
    return { mode: 'request', column: null, parent: null };
  }
  const parent = padreConDistribuidora(metadata);
  return { mode: parent ? 'parent' : 'none', column: null, parent };
}

/**
 * El mapa tabla→entidad y columna→propiedad que usa el trigger de auditoría,
 * sacado de la metadata de TypeORM con las mismas reglas que tenía el
 * subscriber: sin las tablas excluidas, sin fechas de sistema ni versión, sin
 * las propiedades excluidas, con el nombre de la clase y de la propiedad.
 */
export function construirMapa(metadatas: EntityMetadata[]): MapaDeAuditoria {
  const entities: FilaDeEntidad[] = [];
  const fields: FilaDeCampo[] = [];
  const auditadas = metadatas
    .filter((m) => m.tableType !== 'view' && m.tableType !== 'junction')
    .filter((m) => !TABLAS_EXCLUIDAS.has(m.tableName))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));
  for (const m of auditadas) {
    const { mode, column, parent } = distribuidoraDe(m);
    const propiedadDelPedido = CONTEXTO_DE_PEDIDO[m.name];
    const columnaDelPedido = propiedadDelPedido
      ? m.columns.find((c) => c.propertyName === propiedadDelPedido)
      : undefined;
    entities.push({
      table: m.tableName,
      entity: m.name,
      pk: m.primaryColumns.map((c) => c.databaseName),
      deleteColumn: m.deleteDateColumn?.databaseName ?? null,
      distributorMode: mode,
      distributorColumn: column,
      parentTable: parent?.table ?? null,
      parentFkColumn: parent?.fk ?? null,
      parentPkColumn: parent?.pk ?? null,
      parentDistributorColumn: parent?.distributor ?? null,
      orderProperty: columnaDelPedido ? columnaDelPedido.propertyName : null,
      orderColumn: columnaDelPedido ? columnaDelPedido.databaseName : null,
    });
    const excluidas = PROPIEDADES_EXCLUIDAS[m.name] ?? [];
    let position = 0;
    for (const c of m.columns) {
      if (c.isCreateDate || c.isUpdateDate || c.isVersion) continue;
      if (excluidas.includes(c.propertyName)) continue;
      fields.push({
        table: m.tableName,
        column: c.databaseName,
        property: c.propertyName.slice(0, 80),
        secret: esSecreto(c.propertyName),
        kind: tipoDeValor(c),
        position: position++,
      });
    }
  }
  return { entities, fields };
}
