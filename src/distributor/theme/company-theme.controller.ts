import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SoloLectura } from '../../audit/solo-lectura.decorator';
import {
  CompanyThemeDto,
  CompanyThemeResponseDto,
  ThemeContrastErrorDto,
} from '../dto/company-theme.dto';
import { DistributorThemeService } from './distributor-theme.service';

const FALTA_DISTRIBUIDORA =
  'Falta la distribuidora: super admin sin sesión de soporte ni empresa propia (`MISSING_DISTRIBUTOR`)';

const ERRORES_DEL_CUERPO = {
  description: `Formato inválido (p. ej. «Color principal: tiene que ser un color #RRGGBB», «Nombre para mostrar: tiene que tener entre 2 y 60 caracteres»), un color que no cumple el contraste WCAG AA (\`THEME_CONTRAST_INSUFFICIENT\`, con el campo, el par que falla, la relación medida, el mínimo y una sugerencia del mismo tono que sí cumple) o ${FALTA_DISTRIBUIDORA}`,
  schema: { $ref: getSchemaPath(ThemeContrastErrorDto) },
};

/**
 * Apariencia de la distribuidora (diseño de la plataforma, §10.3): color
 * principal, acento, nombre para mostrar y los tokens que usan el panel y las
 * apps. Siempre la del contexto: el admin, la suya; el super admin, la de su
 * sesión de soporte (sólo lectura) o su empresa propia (como un admin). No
 * acepta ningún id de distribuidora: el tema de otra no se ve ni se toca.
 */
@ApiTags('Configuración · Apariencia')
@ApiExtraModels(ThemeContrastErrorDto)
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'company/theme', version: '2' })
export class CompanyThemeController {
  constructor(private readonly temas: DistributorThemeService) {}

  /** Sin `@Permiso`: el encabezado del panel lo pide en todas las pantallas. */
  @Get()
  @ApiOperation({
    summary: 'El tema de la distribuidora',
    description:
      'Colores elegidos, nombre para mostrar, nombre y logo (URL firmada) de la distribuidora, tokens derivados en claro y oscuro, el contraste medido de cada par y la versión. Sin tema propio devuelve el por omisión (`isDefault: true`) con el nombre real. Lo puede leer cualquier administrador de la empresa: el encabezado del panel lo usa en todas las pantallas.',
  })
  @ApiOkResponse({ type: CompanyThemeResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({ description: 'La distribuidora está dada de baja' })
  obtener(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CompanyThemeResponseDto> {
    return this.temas.vigente(distributorId);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @SoloLectura()
  @Permiso('configuracion.ver')
  @ApiOperation({
    summary: 'Vista previa del tema, sin guardar',
    description:
      'Mismo cuerpo que el `PUT`: devuelve los tokens y el contraste que quedarían, o el mismo 400 de contraste. No escribe nada (se permite en modo soporte).',
  })
  @ApiOkResponse({ type: CompanyThemeResponseDto })
  @ApiBadRequestResponse(ERRORES_DEL_CUERPO)
  @ApiNotFoundResponse({ description: 'La distribuidora está dada de baja' })
  vistaPrevia(
    @Body() dto: CompanyThemeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CompanyThemeResponseDto> {
    return this.temas.vistaPrevia(distributorId, dto);
  }

  @Put()
  @Permiso('configuracion.gestionar')
  @ApiOperation({
    summary: 'Cambiar el tema de la distribuidora',
    description:
      'Reemplaza el tema: lo que no viene queda sin valor (acento derivado del principal, nombre de la distribuidora). Valida el contraste WCAG AA y, si un color no cumple, no lo ajusta: responde 400 `THEME_CONTRAST_INSUFFICIENT` con una sugerencia. Sube la versión. Queda en la auditoría. En modo soporte, 403 `SUPPORT_READ_ONLY`.',
  })
  @ApiOkResponse({ type: CompanyThemeResponseDto })
  @ApiBadRequestResponse(ERRORES_DEL_CUERPO)
  @ApiNotFoundResponse({ description: 'La distribuidora está dada de baja' })
  guardar(
    @Body() dto: CompanyThemeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<CompanyThemeResponseDto> {
    return this.temas.guardar(distributorId, dto, actorUserId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('configuracion.gestionar')
  @ApiOperation({
    summary: 'Restablecer el tema por omisión',
    description:
      'Baja lógica del tema propio: la empresa vuelve al tema por omisión con su nombre real (el logo no se toca). Sube la versión. Idempotente. En modo soporte, 403 `SUPPORT_READ_ONLY`.',
  })
  @ApiNoContentResponse({ description: 'Restablecido' })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({ description: 'La distribuidora está dada de baja' })
  async restablecer(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.temas.restablecer(distributorId, actorUserId);
  }
}
