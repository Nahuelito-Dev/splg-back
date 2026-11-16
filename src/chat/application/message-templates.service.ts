import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { MessageTemplate } from '../entities/message-template.entity';
import type {
  CreateMessageTemplateDto,
  QueryMessageTemplatesDto,
  UpdateMessageTemplateDto,
} from '../presentation/dto/support-settings.dto';

const UNICO_VIOLADO = '23505';

/** Respuestas guardadas de la plataforma (ABM; la baja es lógica). */
@Injectable()
export class MessageTemplatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(MessageTemplate);
  }

  listar(query: QueryMessageTemplatesDto): Promise<MessageTemplate[]> {
    return this.repo.find({
      where: {
        distributorId: IsNull(),
        ...(query.scope ? { scope: query.scope } : {}),
      },
      order: { scope: 'ASC', title: 'ASC' },
    });
  }

  async crear(dto: CreateMessageTemplateDto): Promise<MessageTemplate> {
    try {
      return await this.repo.save(
        this.repo.create({
          distributorId: null,
          scope: dto.scope,
          key: dto.key,
          title: dto.title,
          body: dto.body,
          active: dto.active,
        }),
      );
    } catch (error) {
      if (codigoSqlDelError(error) === UNICO_VIOLADO) {
        throw conCodigo(
          ConflictException,
          409,
          'Ya hay una respuesta guardada con esa clave',
          CODIGOS_DE_ERROR.MESSAGE_TEMPLATE_KEY_TAKEN,
        );
      }
      throw error;
    }
  }

  async actualizar(
    id: string,
    dto: UpdateMessageTemplateDto,
  ): Promise<MessageTemplate> {
    const plantilla = await this.buscar(id);
    Object.assign(plantilla, dto);
    return this.repo.save(plantilla);
  }

  async darDeBaja(id: string): Promise<void> {
    await this.repo.softRemove(await this.buscar(id));
  }

  private async buscar(id: string): Promise<MessageTemplate> {
    const plantilla = await this.repo.findOne({
      where: { templateId: id, distributorId: IsNull() },
    });
    if (!plantilla) {
      throw new NotFoundException('No existe esa respuesta guardada');
    }
    return plantilla;
  }
}
