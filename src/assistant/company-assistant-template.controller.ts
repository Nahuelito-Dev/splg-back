import { Controller, Get } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';
import { AssistantFaqTemplateService } from './assistant-faq-template.service';
import { AssistantFaqMapper } from './assistant-faq.mapper';
import { AssistantFaqTemplateListResponseDto } from './dto/assistant-faq.dto';

/**
 * Las preguntas de ejemplo que ofrece OrixTech (DISENO-CH-BOT D-B7), para
 * que la distribuidora vea qué carga `from-templates` antes de copiarlas.
 * Sólo lectura; marca las que su base ya tiene. Nunca muestra la base del
 * soporte de OrixTech (D-B6).
 */
@ApiTags('Configuración · Asistente del chat')
@RequiereModulo('assistant')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'company/assistant/templates', version: '2' })
export class CompanyAssistantTemplateController {
  constructor(private readonly ejemplos: AssistantFaqTemplateService) {}

  @Get()
  @Permiso('asistente.ver')
  @ApiOperation({
    summary: 'Preguntas de ejemplo de OrixTech',
    description:
      'Las vigentes del catálogo, en el orden en que se copian, con `alreadyInBase` si la base de la distribuidora ya tiene esa clave o esa misma pregunta (esas no se copian).',
  })
  @ApiOkResponse({ type: AssistantFaqTemplateListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora: super admin sin sesión de soporte ni empresa propia (`MISSING_DISTRIBUTOR`)',
  })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AssistantFaqTemplateListResponseDto> {
    return AssistantFaqMapper.toTemplateListDto(
      await this.ejemplos.listarParaEmpresa(distributorId),
    );
  }
}
