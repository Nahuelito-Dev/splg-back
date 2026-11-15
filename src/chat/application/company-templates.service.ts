import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { assertVariablesConocidas } from '../domain/bandeja';
import { Channel, MessageTemplateScope } from '../domain/chat.enums';
import { MessageTemplate } from '../entities/message-template.entity';
import type {
  CreateCompanyTemplateDto,
  QueryCompanyTemplatesDto,
  UpdateCompanyTemplateDto,
} from '../presentation/dto/bandeja-input.dto';

const UNICO_VIOLADO = '23505';

export class PlantillaNoEncontradaError extends NotFoundException {
  constructor() {
    super('No existe esa respuesta guardada');
  }
}

/**
 * Respuestas rápidas de la bandeja de cada empresa (§6.8, `staff_reply`): ABM
 * con baja lógica, clave única entre las vigentes de la empresa y variables de
 * una lista cerrada. Una de otra empresa no existe (404).
 */
@Injectable()
export class CompanyTemplatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(MessageTemplate);
  }

  /** Con `channel`, las de ese canal y las de los dos. */
  listar(
    distributorId: string,
    query: QueryCompanyTemplatesDto,
  ): Promise<MessageTemplate[]> {
    const qb = this.repo
      .createQueryBuilder('t')
      .where('t.distributorId = :distributorId', { distributorId })
      .andWhere('t.scope = :scope', {
        scope: MessageTemplateScope.STAFF_REPLY,
      });
    if (query.channel) {
      qb.andWhere('(t.channel = :canal OR t.channel IS NULL)', {
        canal: query.channel,
      });
    }
    if (query.active !== undefined) {
      qb.andWhere('t.active = :activa', { activa: query.active });
    }
    return qb
      .orderBy('t.title', 'ASC')
      .addOrderBy('t.templateId', 'ASC')
      .getMany();
  }

  async crear(
    distributorId: string,
    dto: CreateCompanyTemplateDto,
  ): Promise<MessageTemplate> {
    assertVariablesConocidas(dto.body);
    try {
      return await this.repo.save(
        this.repo.create({
          distributorId,
          scope: MessageTemplateScope.STAFF_REPLY,
          channel: dto.channel ?? null,
          key: dto.key,
          title: dto.title,
          body: dto.body,
          active: dto.active,
        }),
      );
    } catch (error) {
      throw claveRepetida(error);
    }
  }

  async actualizar(
    distributorId: string,
    id: string,
    dto: UpdateCompanyTemplateDto,
  ): Promise<MessageTemplate> {
    if (dto.body !== undefined) assertVariablesConocidas(dto.body);
    const plantilla = await this.buscar(distributorId, id);
    Object.assign(plantilla, dto);
    try {
      return await this.repo.save(plantilla);
    } catch (error) {
      throw claveRepetida(error);
    }
  }

  async darDeBaja(distributorId: string, id: string): Promise<void> {
    await this.repo.softRemove(await this.buscar(distributorId, id));
  }

  /** Una vigente y activa de la empresa, que se pueda usar en ese canal. */
  async paraEnviar(
    manager: EntityManager,
    distributorId: string,
    id: string,
    canal: Channel,
  ): Promise<MessageTemplate> {
    const plantilla = await manager.getRepository(MessageTemplate).findOne({
      where: {
        templateId: id,
        distributorId,
        scope: MessageTemplateScope.STAFF_REPLY,
        active: true,
      },
    });
    if (
      !plantilla ||
      (plantilla.channel !== null && plantilla.channel !== canal)
    ) {
      throw new PlantillaNoEncontradaError();
    }
    return plantilla;
  }

  private async buscar(
    distributorId: string,
    id: string,
  ): Promise<MessageTemplate> {
    const plantilla = await this.repo.findOne({
      where: {
        templateId: id,
        distributorId,
        scope: MessageTemplateScope.STAFF_REPLY,
      },
    });
    if (!plantilla) throw new PlantillaNoEncontradaError();
    return plantilla;
  }
}

function claveRepetida(error: unknown): unknown {
  if (codigoSqlDelError(error) === UNICO_VIOLADO) {
    return conCodigo(
      ConflictException,
      409,
      'Ya hay una respuesta guardada con esa clave',
      CODIGOS_DE_ERROR.MESSAGE_TEMPLATE_KEY_TAKEN,
    );
  }
  return error;
}
