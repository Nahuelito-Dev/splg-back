import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { RoutePlanningCalendarService } from '../application/route-planning-calendar.service';
import {
  CreateRoutePlanningHolidayDto,
  ListRoutePlanningHolidaysQueryDto,
  RoutePlanningHolidayDto,
} from './dto/route-planning-holiday.dto';

const FALTA_DISTRIBUIDORA =
  'Falta la distribuidora (super admin sin X-Distributor) o un dato no es válido (fecha AAAA-MM-DD, descripción de 2 a 120 caracteres)';

/**
 * Feriados de la hoja de ruta (F34): los días que la distribuidora no reparte
 * aunque caigan en un día hábil (`workingDays`). La propuesta automática no
 * arma un plan para un feriado y la reprogramación de un pedido lo saltea.
 */
@ApiTags('Route plans (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-planning/holidays', version: '2' })
export class RoutePlanningHolidaysController {
  constructor(private readonly calendario: RoutePlanningCalendarService) {}

  @Permiso('despacho.gestionar')
  @Get()
  @ApiOperation({
    summary: 'Feriados de la hoja de ruta',
    description:
      'Los feriados vigentes de la distribuidora, por fecha: desde `from` (por omisión, hoy) hasta `to` (sin tope si no viene).',
  })
  @ApiOkResponse({ type: RoutePlanningHolidayDto, isArray: true })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async listar(
    @Query() q: ListRoutePlanningHolidaysQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RoutePlanningHolidayDto[]> {
    const filas = await this.calendario.listar(distributorId, q);
    return filas.map((f) => RoutePlanningHolidayDto.de(f));
  }

  @Permiso('despacho.gestionar')
  @Post()
  @ApiOperation({
    summary: 'Cargar un feriado',
    description:
      'Ese día no se reparte: la propuesta automática no arma un plan y la reprogramación lo saltea. No toca un plan ya abierto ni hojas ya armadas para ese día.',
  })
  @ApiCreatedResponse({ type: RoutePlanningHolidayDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description:
      'El día ya pasó (ROUTE_HOLIDAY_DATE_PAST) o ya está cargado como feriado (ROUTE_HOLIDAY_ALREADY_EXISTS)',
  })
  async crear(
    @Body() dto: CreateRoutePlanningHolidayDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RoutePlanningHolidayDto> {
    return RoutePlanningHolidayDto.de(
      await this.calendario.crear(distributorId, dto),
    );
  }

  @Permiso('despacho.gestionar')
  @Delete(':id')
  @HttpCode(204)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Dar de baja un feriado',
    description:
      'Baja lógica: el día vuelve a ser hábil (si lo es por `workingDays`) y se puede volver a cargar.',
  })
  @ApiNoContentResponse({ description: 'Feriado dado de baja' })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o falta la distribuidora',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, ya se dio de baja o es de otra distribuidora (ROUTE_HOLIDAY_NOT_FOUND)',
  })
  async borrar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<void> {
    await this.calendario.borrar(distributorId, id);
  }
}
