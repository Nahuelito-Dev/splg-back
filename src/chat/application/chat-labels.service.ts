import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import {
  type ColorDeEtiqueta,
  nombreDeEtiqueta,
  TOPE_DE_ETIQUETAS,
} from '../domain/etiquetas';
import { Conversation } from '../entities/conversation.entity';
import { ConversationLabel } from '../entities/conversation-label.entity';
import { ConversationLabelLink } from '../entities/conversation-label-link.entity';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { ChatEvents, Efectos } from './chat.events';

const UNICO_VIOLADO = '23505';
const CHECK_VIOLADO = '23514';

export const etiquetaNoEncontrada = () =>
  conCodigo(
    NotFoundException,
    404,
    'No existe esa etiqueta',
    CODIGOS_DE_ERROR.CHAT_LABEL_NOT_FOUND,
  );

export const nombreDeEtiquetaRepetido = () =>
  conCodigo(
    ConflictException,
    409,
    'Ya hay una etiqueta con ese nombre',
    CODIGOS_DE_ERROR.CHAT_LABEL_NAME_TAKEN,
  );

export const topeDeEtiquetas = () =>
  conCodigo(
    ConflictException,
    409,
    `Ya hay ${TOPE_DE_ETIQUETAS} etiquetas: da de baja alguna para crear otra`,
    CODIGOS_DE_ERROR.CHAT_LABEL_LIMIT_REACHED,
  );

export interface DatosDeEtiqueta {
  name?: string;
  color?: ColorDeEtiqueta;
}

/** Restricción de la base de un error de Postgres (vía TypeORM), si la trae. */
function restriccionDelError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { constraint?: unknown; driverError?: unknown };
  if (typeof e.constraint === 'string') return e.constraint;
  const d = e.driverError as { constraint?: unknown } | undefined;
  return typeof d?.constraint === 'string' ? d.constraint : undefined;
}

/** Lo que la base rechaza aunque el servicio ya lo haya mirado (dos pedidos a la vez). */
function traducir(error: unknown): unknown {
  const codigo = codigoSqlDelError(error);
  const restriccion = restriccionDelError(error);
  if (
    codigo === UNICO_VIOLADO &&
    restriccion === 'UQ_conversation_label_nombre'
  ) {
    return nombreDeEtiquetaRepetido();
  }
  if (
    codigo === CHECK_VIOLADO &&
    restriccion === 'CHK_conversation_label_tope'
  ) {
    return topeDeEtiquetas();
  }
  return error;
}

/**
 * Etiquetas de la bandeja de cada empresa (tanda 7c): el ABM (baja lógica,
 * hasta 50 vigentes, nombre único sin distinguir mayúsculas ni tildes) y
 * ponerlas o sacarlas de una conversación (hasta 5). Una etiqueta de otra
 * empresa no existe (404). Los cambios quedan en la auditoría por los
 * triggers de las tablas; poner o sacar re-emite la conversación al panel.
 */
@Injectable()
export class ChatLabelsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly eventos: ChatEvents,
  ) {}

  /** Las vigentes de la empresa, por nombre. */
  listar(distributorId: string): Promise<ConversationLabel[]> {
    return this.dataSource
      .getRepository(ConversationLabel)
      .createQueryBuilder('l')
      .where('l.distributorId = :distributorId', { distributorId })
      .orderBy('lower(l.name)', 'ASC')
      .addOrderBy('l.labelId', 'ASC')
      .getMany();
  }

  async crear(
    distributorId: string,
    dto: Required<DatosDeEtiqueta>,
  ): Promise<ConversationLabel> {
    const nombre = nombreDeEtiqueta(dto.name);
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.bloquearLasDeLaEmpresa(manager, distributorId);
        const vigentes = await manager
          .getRepository(ConversationLabel)
          .count({ where: { distributorId } });
        if (vigentes >= TOPE_DE_ETIQUETAS) throw topeDeEtiquetas();
        await this.assertNombreLibre(manager, distributorId, nombre, null);
        const repo = manager.getRepository(ConversationLabel);
        return repo.save(
          repo.create({ distributorId, name: nombre, color: dto.color }),
        );
      });
    } catch (error) {
      throw traducir(error);
    }
  }

  /**
   * Nombre o color. Si cambia algo, las conversaciones que la tienen se
   * re-emiten al panel (la bandeja la muestra cambiada sin recargar).
   */
  async actualizar(
    distributorId: string,
    id: string,
    dto: DatosDeEtiqueta,
  ): Promise<ConversationLabel> {
    const efectos = new Efectos();
    let guardada: ConversationLabel;
    try {
      guardada = await this.dataSource.transaction(async (manager) => {
        await this.bloquearLasDeLaEmpresa(manager, distributorId);
        const etiqueta = await this.buscar(manager, distributorId, id);
        const antes = { name: etiqueta.name, color: etiqueta.color };
        if (dto.name !== undefined) {
          const nombre = nombreDeEtiqueta(dto.name);
          await this.assertNombreLibre(manager, distributorId, nombre, id);
          etiqueta.name = nombre;
        }
        if (dto.color !== undefined) etiqueta.color = dto.color;
        if (etiqueta.name === antes.name && etiqueta.color === antes.color) {
          return etiqueta;
        }
        const r = await manager.getRepository(ConversationLabel).save(etiqueta);
        await this.reemitirLasQueLaTienen(
          manager,
          distributorId,
          etiqueta.labelId,
          efectos,
        );
        return r;
      });
    } catch (error) {
      throw traducir(error);
    }
    this.eventos.publicar(efectos);
    return guardada;
  }

  /**
   * Baja lógica de la etiqueta y de sus vínculos vigentes: sale de todas las
   * conversaciones (que dejan de contarla en su tope de 5). Las
   * conversaciones afectadas se re-emiten al panel.
   */
  async darDeBaja(distributorId: string, id: string): Promise<void> {
    const efectos = new Efectos();
    await this.dataSource.transaction(async (manager) => {
      await this.bloquearLasDeLaEmpresa(manager, distributorId);
      const etiqueta = await this.buscar(manager, distributorId, id);
      // Antes de sacarla: después de la baja de los vínculos no se encuentran.
      const afectadas = await this.reemitirLasQueLaTienen(
        manager,
        distributorId,
        etiqueta.labelId,
        efectos,
      );
      if (afectadas > 0) {
        await manager.getRepository(ConversationLabelLink).softDelete({
          labelId: etiqueta.labelId,
          distributorId,
          deletedAt: IsNull(),
        });
      }
      await manager.getRepository(ConversationLabel).softRemove(etiqueta);
    });
    this.eventos.publicar(efectos);
  }

  /**
   * Deja en la conversación exactamente esas etiquetas (hasta 5, las valida
   * el DTO): saca las que no vienen y pone las nuevas. Con los permisos del
   * canal (otra empresa o un canal que no atiende → 404). Una etiqueta que no
   * es de la empresa o está dada de baja → 404. Mandar las mismas no cambia
   * nada ni avisa.
   */
  async ponerEnConversacion(
    actor: ActorDeLaBandeja,
    conversationId: string,
    labelIds: readonly string[],
  ): Promise<Conversation> {
    const efectos = new Efectos();
    const c = await this.dataSource.transaction(async (manager) => {
      // Una baja simultánea de una de las etiquetas pedidas espera (o se
      // espera): no queda puesta una etiqueta dada de baja.
      await this.bloquearLasDeLaEmpresa(manager, actor.distributorId);
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      const pedidas = [...new Set(labelIds)];
      if (pedidas.length > 0) {
        const vigentes = await manager.getRepository(ConversationLabel).count({
          where: {
            labelId: In(pedidas),
            distributorId: actor.distributorId,
            deletedAt: IsNull(),
          },
        });
        if (vigentes !== pedidas.length) throw etiquetaNoEncontrada();
      }
      const links = manager.getRepository(ConversationLabelLink);
      const actuales = await links.find({
        where: {
          conversationId: c.conversationId,
          distributorId: actor.distributorId,
        },
      });
      const sacar = actuales.filter((l) => !pedidas.includes(l.labelId));
      const ya = new Set(actuales.map((l) => l.labelId));
      const poner = pedidas.filter((id) => !ya.has(id));
      if (sacar.length === 0 && poner.length === 0) return c;
      if (sacar.length > 0) {
        await links.softDelete({ linkId: In(sacar.map((l) => l.linkId)) });
      }
      if (poner.length > 0) {
        await links.insert(
          poner.map((labelId) => ({
            conversationId: c.conversationId,
            labelId,
            distributorId: actor.distributorId,
          })),
        );
      }
      // Que la bandeja la vea cambiada en la reconexión (`updatedSince`).
      await manager.query(
        `UPDATE "conversation" SET "updated_at" = now() WHERE "conversation_id" = $1 AND "distributor_id" = $2`,
        [c.conversationId, actor.distributorId],
      );
      const actual = await manager
        .getRepository(Conversation)
        .findOneByOrFail({ conversationId: c.conversationId });
      efectos.conversacion(actual, 'labels');
      return actual;
    });
    this.eventos.publicar(efectos);
    return c;
  }

  /**
   * Anota para re-emitir al panel las conversaciones que tienen puesta la
   * etiqueta (vínculos vigentes). Devuelve cuántas.
   */
  private async reemitirLasQueLaTienen(
    manager: EntityManager,
    distributorId: string,
    labelId: string,
    efectos: Efectos,
  ): Promise<number> {
    const vinculos = await manager
      .getRepository(ConversationLabelLink)
      .find({ where: { labelId, distributorId } });
    if (vinculos.length === 0) return 0;
    const conversaciones = await manager.getRepository(Conversation).find({
      where: {
        conversationId: In(vinculos.map((v) => v.conversationId)),
        distributorId,
      },
    });
    for (const c of conversaciones) efectos.conversacion(c, 'labels');
    return vinculos.length;
  }

  /**
   * Dos altas, cambios o bajas simultáneos de la misma empresa se ordenan
   * (tope y nombre), y poner etiquetas espera a una baja en curso: siempre
   * antes que el cerrojo de la conversación, en el mismo orden.
   */
  private async bloquearLasDeLaEmpresa(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `chat_label:${distributorId}`,
    ]);
  }

  private async assertNombreLibre(
    manager: EntityManager,
    distributorId: string,
    nombre: string,
    excepto: string | null,
  ): Promise<void> {
    const filas: unknown[] = await manager.query(
      `SELECT 1 FROM "conversation_label"
        WHERE "distributor_id" = $1 AND "deleted_at" IS NULL
          AND chat_label_key("name") = chat_label_key($2)
          AND ($3::uuid IS NULL OR "label_id" <> $3::uuid)
        LIMIT 1`,
      [distributorId, nombre, excepto],
    );
    if (filas.length > 0) throw nombreDeEtiquetaRepetido();
  }

  private async buscar(
    manager: EntityManager,
    distributorId: string,
    id: string,
  ): Promise<ConversationLabel> {
    const etiqueta = await manager
      .getRepository(ConversationLabel)
      .findOne({ where: { labelId: id, distributorId } });
    if (!etiqueta) throw etiquetaNoEncontrada();
    return etiqueta;
  }
}
