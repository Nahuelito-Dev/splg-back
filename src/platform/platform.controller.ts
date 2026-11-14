import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/isPublic.decorator';
import type { ConfiguracionDePlataforma } from '../common/config/plataforma.config';
import { PlatformResponseDto } from './dto/platform-response.dto';

/**
 * La plataforma dueña del sistema (API v2). El nombre sale de una sola
 * configuración (`PLATFORM_NAME`, D11): el panel y las apps lo leen de acá en
 * lugar de tenerlo fijo.
 */
@ApiTags('Platform')
@Controller({ path: 'platform', version: '2' })
export class PlatformController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Nombre y contacto de la plataforma',
    description:
      'Público: no requiere sesión. Devuelve el nombre comercial, la razón social y el correo del soporte configurados.',
  })
  @ApiOkResponse({ type: PlatformResponseDto })
  datos(): PlatformResponseDto {
    const p = this.config.getOrThrow<ConfiguracionDePlataforma>('plataforma');
    return {
      name: p.name,
      legalName: p.legalName,
      supportEmail: p.supportEmail,
    };
  }
}
