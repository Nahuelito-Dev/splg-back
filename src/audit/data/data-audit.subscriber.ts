import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntitySubscriberInterface,
  InsertEvent,
  ObjectLiteral,
  RecoverEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
import { AuditActionTypeId } from '../entities/audit-action-type.entity';
import {
  CONTEXTO_DE_PEDIDO,
  ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST,
  PROPIEDADES_EXCLUIDAS,
  TABLAS_EXCLUIDAS,
} from './audit-exclusions';
import { CambioDeCampo, cambioDeCampo, textoDe } from './audit-value';
import { AuditoriaDeDatos } from './auditoria-de-datos';

function valorDe(columna: ColumnMetadata, entidad: ObjectLiteral): unknown {
  const valor: unknown = columna.getEntityValue(entidad);
  return valor;
}

function seAudita(metadata: EntityMetadata): boolean {
  return !TABLAS_EXCLUIDAS.has(metadata.tableName);
}

/** Columnas que cuentan como dato: sin fechas de sistema ni versión. */
function esDato(metadata: EntityMetadata, columna: ColumnMetadata): boolean {
  if (columna.isCreateDate || columna.isUpdateDate || columna.isVersion) {
    return false;
  }
  return !PROPIEDADES_EXCLUIDAS[metadata.name]?.includes(columna.propertyName);
}

function recordIdDe(metadata: EntityMetadata, entidad: ObjectLiteral): string {
  return metadata.primaryColumns
    .map((c) => textoDe(valorDe(c, entidad)) ?? '')
    .join(':');
}

const TIPOS_NUMERICOS = new Set([
  'numeric',
  'decimal',
  'int',
  'integer',
  'smallint',
  'bigint',
  'float',
  'real',
  'double precision',
]);

function esNumerica(columna: ColumnMetadata): boolean {
  const tipo: unknown = columna.type;
  return (
    tipo === Number || (typeof tipo === 'string' && TIPOS_NUMERICOS.has(tipo))
  );
}

/** El id que trae el evento: un valor suelto o un mapa `{ propiedad: valor }`. */
function idDelEvento(
  metadata: EntityMetadata,
  entityId: unknown,
): string | null {
  if (typeof entityId === 'object' && entityId !== null) {
    return recordIdDe(metadata, entityId);
  }
  return textoDe(entityId);
}

/**
 * La distribuidora del propio registro. Sin columna propia: la del request si
 * la entidad es de una distribuidora (renglón de pedido, promoción...); si es
 * de la persona o global (User, Customer, UserAddress, Role), ninguna, para
 * no mostrarle a una distribuidora lo que otra edita de un cliente compartido.
 * `undefined` = la del request.
 */
function distribuidoraDe(
  metadata: EntityMetadata,
  entidad: ObjectLiteral,
): string | null | undefined {
  if (metadata.tableName === 'distributor')
    return recordIdDe(metadata, entidad);
  const columna = metadata.columns.find(
    (c) => c.propertyName === 'distributorId',
  );
  if (columna) {
    const valor = valorDe(columna, entidad);
    return typeof valor === 'string' ? valor : null;
  }
  return ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST.has(metadata.name)
    ? undefined
    : null;
}

/**
 * Captura la auditoría de datos en la capa de datos: toda alta, modificación,
 * baja lógica y reactivación que pasa por `save`, `softRemove` o `recover`
 * deja su Auditoria y sus DetalleAuditoria con el mismo `manager`, o sea
 * dentro de la transacción del cambio. Las escrituras que TypeORM no anuncia
 * (`update()`, `softDelete()`, query builders) se auditan a mano con
 * `AuditoriaDeDatos.registrar`.
 */
@Injectable()
export class DataAuditSubscriber implements EntitySubscriberInterface {
  private readonly logger = new Logger(DataAuditSubscriber.name);

  constructor(@InjectDataSource() dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  async afterInsert(event: InsertEvent<ObjectLiteral>): Promise<void> {
    const { metadata, entity, manager } = event;
    if (!entity || !seAudita(metadata)) return;
    const detalles: CambioDeCampo[] = [];
    for (const columna of metadata.columns) {
      if (!esDato(metadata, columna)) continue;
      const valor = valorDe(columna, entity);
      if (valor === null || valor === undefined) continue;
      const cambio = cambioDeCampo(columna.propertyName, null, valor);
      if (cambio) detalles.push(cambio);
    }
    await this.registrar(
      manager,
      metadata,
      entity,
      AuditActionTypeId.CREATE,
      detalles,
    );
  }

  async afterUpdate(event: UpdateEvent<ObjectLiteral>): Promise<void> {
    const { metadata, entity, databaseEntity, manager } = event;
    if (!entity || !databaseEntity || !seAudita(metadata)) return;
    const columnas = new Set<ColumnMetadata>(event.updatedColumns);
    for (const relacion of event.updatedRelations) {
      for (const c of relacion.joinColumns) columnas.add(c);
    }
    const detalles: CambioDeCampo[] = [];
    let accion = AuditActionTypeId.UPDATE;
    for (const columna of columnas) {
      if (!esDato(metadata, columna)) continue;
      const cambio = cambioDeCampo(
        columna.propertyName,
        valorDe(columna, databaseEntity),
        valorDe(columna, entity),
        esNumerica(columna),
      );
      if (!cambio) continue;
      detalles.push(cambio);
      if (columna.isDeleteDate) {
        accion =
          cambio.newValue === null
            ? AuditActionTypeId.RESTORE
            : AuditActionTypeId.SOFT_DELETE;
      }
    }
    if (detalles.length === 0) return;
    await this.registrar(manager, metadata, databaseEntity, accion, detalles);
  }

  async afterSoftRemove(event: SoftRemoveEvent<ObjectLiteral>): Promise<void> {
    const { metadata, manager } = event;
    // Una baja por orphanedRowAction llega sin entidad: sólo trae el id.
    const base = event.databaseEntity ?? event.entity ?? {};
    if (!seAudita(metadata)) return;
    const columna = metadata.deleteDateColumn;
    if (!columna) return;
    const nuevo: unknown = event.entity ? valorDe(columna, event.entity) : null;
    const cambio = cambioDeCampo(
      columna.propertyName,
      null,
      nuevo ?? new Date(),
    );
    if (!cambio) return;
    await this.registrar(
      manager,
      metadata,
      base,
      AuditActionTypeId.SOFT_DELETE,
      [cambio],
      idDelEvento(metadata, event.entityId),
    );
  }

  async afterRecover(event: RecoverEvent<ObjectLiteral>): Promise<void> {
    const { metadata, manager } = event;
    const base = event.databaseEntity ?? event.entity ?? {};
    if (!seAudita(metadata)) return;
    const columna = metadata.deleteDateColumn;
    if (!columna) return;
    const anterior: unknown = event.databaseEntity
      ? valorDe(columna, event.databaseEntity)
      : null;
    const cambio = cambioDeCampo(
      columna.propertyName,
      anterior ?? new Date(),
      null,
    );
    if (!cambio) return;
    await this.registrar(
      manager,
      metadata,
      base,
      AuditActionTypeId.RESTORE,
      [cambio],
      idDelEvento(metadata, event.entityId),
    );
  }

  /**
   * Borrado físico (`remove`/`delete` de una entidad cargada): no debería
   * haber, pero si ocurre deja una Baja física con los valores que tenía.
   */
  async afterRemove(event: RemoveEvent<ObjectLiteral>): Promise<void> {
    const { metadata, manager } = event;
    const base = event.databaseEntity ?? event.entity;
    if (!base || !seAudita(metadata)) return;
    const detalles: CambioDeCampo[] = [];
    for (const columna of metadata.columns) {
      if (!esDato(metadata, columna)) continue;
      const valor = valorDe(columna, base);
      if (valor === null || valor === undefined) continue;
      const cambio = cambioDeCampo(columna.propertyName, valor, null);
      if (cambio) detalles.push(cambio);
    }
    await this.registrar(
      manager,
      metadata,
      base,
      AuditActionTypeId.PHYSICAL_DELETE,
      detalles,
      idDelEvento(metadata, event.entityId),
    );
  }

  private async registrar(
    manager: EntityManager,
    metadata: EntityMetadata,
    entidad: ObjectLiteral,
    actionTypeId: AuditActionTypeId,
    details: CambioDeCampo[],
    recordIdAlternativo?: string | null,
  ): Promise<void> {
    const recordId = recordIdDe(metadata, entidad) || recordIdAlternativo || '';
    if (!recordId) {
      // Un insert/upsert por query builder puede llegar sin id: sin id no hay
      // a qué registro atribuirlo, no se escribe una auditoría vacía.
      this.logger.warn(
        `${metadata.name}: cambio sin id de registro, no se audita`,
      );
      return;
    }
    const campoDelPedido = CONTEXTO_DE_PEDIDO[metadata.name];
    if (campoDelPedido && !details.some((d) => d.field === campoDelPedido)) {
      const valor: unknown = entidad[campoDelPedido];
      const pedido = textoDe(valor);
      if (pedido) {
        details = [
          ...details,
          { field: campoDelPedido, oldValue: pedido, newValue: pedido },
        ];
      }
    }
    // La distribuidora del propio registro manda; si no tiene, la del request.
    await AuditoriaDeDatos.registrar(manager, {
      actionTypeId,
      entity: metadata.name,
      recordId,
      distributorId: distribuidoraDe(metadata, entidad),
      details,
    });
  }
}
