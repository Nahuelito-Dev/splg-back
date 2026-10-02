import { Body, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CreateTimeSlotDto } from './create-time-slot.dto';

/** Lo único que necesitamos leer del schema generado; el tipo completo
 * (`SchemaObject`) no forma parte del barrel público de `@nestjs/swagger`. */
interface EsquemaConRequired {
  required?: string[];
}

/** Controlador descartable: lo único que importa es que declare el DTO como
 * body, para que `SwaggerModule` lo registre en el documento generado. */
@Controller('time-slot')
class ControladorDePrueba {
  @Post()
  crear(@Body() dto: CreateTimeSlotDto): CreateTimeSlotDto {
    return dto;
  }
}

/**
 * `capacity` tiene `@IsOptional()` y la columna tiene `default: 50` en la
 * base: no tendría que salir como obligatorio en el OpenAPI. Antes de la
 * corrección, usar `@ApiProperty()` (en vez de `@ApiPropertyOptional()`, o
 * `required: false`) lo marcaba `required` igual, contradiciendo el propio
 * `@IsOptional()` del DTO.
 */
describe('CreateTimeSlotDto — Swagger no exige lo que el DTO marca opcional', () => {
  it('`capacity` no figura en el `required` del schema generado', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ControladorDePrueba],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').setVersion('1').build(),
    );
    const schema = document.components?.schemas?.[
      'CreateTimeSlotDto'
    ] as EsquemaConRequired;

    expect(schema).toBeDefined();
    expect(schema.required ?? []).not.toContain('capacity');

    await app.close();
  });
});
