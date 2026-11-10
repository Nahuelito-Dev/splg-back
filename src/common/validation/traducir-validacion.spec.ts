import {
  ArgumentMetadata,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  NotFoundException,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsDateString,
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsPhoneNumber,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { STATUS_CODES } from 'http';
import { DeclareEmptiesDto } from '../../order/dto/declare-empties.dto';
import { traducirErrores } from './traducir-validacion';
import { traducirExcepcion } from './traducir-excepcion';
import { crearValidationPipe } from './validation-pipe';

enum Estado {
  A = 'up_to_date',
  B = 'due_soon',
  C = 'expired',
  D = 'missing',
}

class Hijo {
  @IsInt() quantity!: number;
  @IsString({ message: 'name: tiene que ser un texto propio' }) name!: string;
}

class Dto {
  @IsString() name!: string;
  @IsInt() capacity!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) price!: number;
  @IsBoolean() enabled!: boolean;
  @IsUUID() user_id!: string;
  @IsEnum(Estado) documentStatus!: Estado;
  @IsIn(['csv', 'xlsx']) format!: string;
  @IsNotEmpty() title!: string;
  @IsDefined() description!: string;
  @IsArray() serials!: string[];
  @IsObject() details!: object;
  @IsEmail() email!: string;
  @IsDateString() dueDate!: string;
  @IsDate() paidAt!: Date;
  @IsPositive() amount!: number;
  @Min(3) days!: number;
  @Max(20) maxBatchSize!: number;
  @MinLength(4) code!: string;
  @MaxLength(5) alias!: string;
  @Length(2, 4) brand!: string;
  @ArrayMinSize(3) employeeIds!: string[];
  @ArrayMaxSize(1) deliveryIds!: string[];
  @ArrayNotEmpty() userIds!: string[];
  @ArrayUnique() thresholds!: string[];
  @Matches(/^\d+$/) cuit!: string;
  @IsLatitude() latitude!: string;
  @IsLongitude() longitude!: string;
  @IsPhoneNumber() phone!: string;
  @IsString({ each: true }) notes!: string[];
  @ValidateNested({ each: true })
  @Type(() => Hijo)
  items!: Hijo[];
  @ValidateNested() @Type(() => Hijo) payment!: Hijo;
  @ValidateNested({ each: true })
  @Type(() => Hijo)
  promotions!: Hijo[];
  @ValidateNested() @Type(() => Hijo) receiver!: Hijo;
}

const pipe = crearValidationPipe();
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

async function mensajes(
  dto: new () => object,
  body: object,
): Promise<string[]> {
  try {
    await pipe.transform(body, meta(dto));
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const r = (e as BadRequestException).getResponse() as {
      statusCode: number;
      error: string;
      message: string[];
    };
    expect(r.statusCode).toBe(400);
    expect(r.error).toBe('Bad Request');
    return r.message;
  }
  return [];
}

describe('traducción de los mensajes de validación', () => {
  let m: string[];

  beforeAll(async () => {
    m = await mensajes(Dto, {
      name: 1,
      capacity: 1.5,
      price: 0.001,
      enabled: 'si',
      user_id: 'abc',
      documentStatus: 'vencida',
      format: 'pdf',
      title: '',
      serials: 'x',
      details: 'x',
      email: 'x',
      dueDate: 'x',
      paidAt: 'x',
      amount: -1,
      days: 1,
      maxBatchSize: 9999,
      code: 'a',
      alias: 'abcdefgh',
      brand: 'a',
      employeeIds: ['a'],
      deliveryIds: ['a', 'b'],
      userIds: [],
      thresholds: ['a', 'a'],
      cuit: 'x',
      latitude: 'x',
      longitude: 'x',
      phone: 'x',
      notes: ['a', 1],
      items: [{ quantity: 'x', name: 3 }],
      payment: { quantity: 'x' },
      promotions: 1,
      receiver: 7,
      sobrante: 1,
      campoRaro: 1,
    });
  });

  it.each([
    'Nombre: tiene que ser un texto',
    'Capacidad: tiene que ser un número entero',
    'Precio: tiene que ser un número válido (revisá la cantidad de decimales)',
    'Habilitado: tiene que ser verdadero o falso',
    'Usuario: no es válido',
    'Estado de la documentación: elegí una opción válida (al día, por vencer, vencida o falta cargar)',
    'Formato: elegí una opción válida (CSV o planilla de Excel)',
    'Título: no puede estar vacío',
    'Descripción: es obligatorio',
    'Seriales: tiene que ser una lista',
    'Detalle: tiene que ser un objeto',
    'Correo electrónico: tiene que ser un correo electrónico válido',
    'Fecha de vencimiento: tiene que ser una fecha válida (formato ISO 8601)',
    'Fecha de pago: tiene que ser una fecha válida',
    'Importe: tiene que ser un número positivo',
    'Días: tiene que ser como mínimo 3',
    'Máximo de pedidos por lote: tiene que ser como máximo 20',
    'Código: tiene que tener al menos 4 caracteres',
    'Alias: tiene que tener como máximo 5 caracteres',
    'Marca: tiene que tener al menos 2 caracteres',
    'Empleados: tiene que tener al menos 3 elementos',
    'Choferes: no puede tener más de 1 elemento',
    'Usuarios: no puede estar vacío',
    'Umbrales: no puede tener elementos repetidos',
    'CUIT: no tiene un formato válido',
    'Latitud: tiene que ser una latitud válida',
    'Longitud: tiene que ser una longitud válida',
    'Teléfono: tiene que ser un teléfono válido',
    'Notas: cada elemento tiene que ser un texto',
    'Ítem 1 · Cantidad: tiene que ser un número entero',
    'Pago · Cantidad: tiene que ser un número entero',
    'Se envió un dato que no corresponde',
  ])('%s', (esperado) => {
    expect(m).toContain(esperado);
  });

  it('un campo no permitido con etiqueta la nombra; sin etiqueta no muestra el nombre interno', () => {
    expect(m.filter((x) => x.startsWith('Se envió un dato'))).toEqual([
      'Se envió un dato que no corresponde',
      'Se envió un dato que no corresponde',
    ]);
    expect(
      traducirErrores([
        {
          property: 'email',
          constraints: {
            whitelistValidation: 'property email should not exist',
          },
        },
      ]),
    ).toEqual(['Se envió un dato que no corresponde: Correo electrónico']);
  });

  it('con 1 dice «elemento» y «carácter»; las vacías del pedido se llaman Vacías', () => {
    expect(
      traducirErrores([
        {
          property: 'items',
          target: new DeclareEmptiesDto(),
          constraints: {
            arrayMinSize: 'items must contain at least 1 elements',
          },
        },
        {
          property: 'code',
          constraints: {
            minLength: 'code must be longer than or equal to 1 characters',
          },
        },
      ]),
    ).toEqual([
      'Vacías: tiene que tener al menos 1 elemento',
      'Código: tiene que tener al menos 1 carácter',
    ]);
  });

  it('un mensaje propio del DTO pasa con la ruta del padre', () => {
    expect(m).toContain('Ítem 1 · Nombre: tiene que ser un texto propio');
  });

  it('un objeto que no es objeto (con y sin each) sale en castellano', () => {
    expect(m).toContain(
      'Recibo: tiene que ser un objeto'.replace('Recibo', 'Receptor'),
    );
    expect(m).toContain('Promociones: tiene que ser una lista válida');
  });

  it('ningún mensaje queda en inglés ni con nombres internos', () => {
    expect(
      m.filter((x) => /\b(must|should|property|nested)\b/.test(x)),
    ).toEqual([]);
    expect(m.filter((x) => /[a-z][A-Z]|_/.test(x))).toEqual([]);
  });

  it('@IsISO8601 y @IsEnum/@IsIn con each salen naturales', () => {
    expect(
      traducirErrores([
        {
          property: 'startDate',
          constraints: {
            isIso8601: 'startDate must be a valid ISO 8601 date string',
          },
        },
        {
          property: 'appliesToCategories',
          constraints: {
            isEnum:
              'each value in appliesToCategories must be one of the following values: driver, helper, management',
          },
        },
      ]),
    ).toEqual([
      'Fecha de inicio: tiene que ser una fecha válida',
      'Categorías a las que aplica: cada opción tiene que ser una de: chofer, ayudante o gerencia',
    ]);
  });

  it('una restricción desconocida cae en un genérico en castellano', () => {
    expect(
      traducirErrores([
        {
          property: 'name',
          constraints: { isMagnetURI: 'name must be magnet uri format' },
        },
      ]),
    ).toEqual(['Nombre: tiene un valor inválido']);
  });

  it('un error con hijos descarta sus propias restricciones (como Nest)', () => {
    expect(
      traducirErrores([
        {
          property: 'items',
          constraints: { isArray: 'items must be an array' },
          children: [
            {
              property: '0',
              children: [
                {
                  property: 'quantity',
                  constraints: { isInt: 'quantity must be an integer number' },
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual(['Ítem 1 · Cantidad: tiene que ser un número entero']);
  });
});

describe('mensajes de Nest en castellano', () => {
  const texto = (e: unknown): unknown =>
    (traducirExcepcion(e) as BadRequestException).getResponse();

  it('ParseUUIDPipe', async () => {
    const e = await new ParseUUIDPipe()
      .transform('abc', { type: 'param' })
      .catch((x: unknown) => x);
    expect(texto(e)).toMatchObject({
      statusCode: 400,
      error: 'Solicitud inválida',
      message: 'El identificador no es válido',
    });
  });

  it('ParseIntPipe y ParseEnumPipe', async () => {
    const i = await new ParseIntPipe()
      .transform('x', { type: 'query' })
      .catch((x: unknown) => x);
    expect(texto(i)).toMatchObject({
      message: 'El valor tiene que ser un número',
    });
    const en = await new ParseEnumPipe(Estado)
      .transform('x' as unknown as typeof Estado, { type: 'query' })
      .catch((x: unknown) => x);
    expect(texto(en)).toMatchObject({
      message: 'El valor no es uno de los permitidos',
    });
  });

  it('ruta inexistente: 404 en castellano con el mismo shape', () => {
    const e = new NotFoundException('Cannot GET /api/v1/exports/legajos');
    expect(texto(e)).toEqual({
      statusCode: 404,
      error: 'No encontrado',
      message: 'No existe la ruta GET /api/v1/exports/legajos',
    });
    expect((traducirExcepcion(e) as NotFoundException).getStatus()).toBe(404);
  });

  it('un mensaje de dominio queda como está', () => {
    const e = new BadRequestException('No hay stock');
    expect(texto(e)).toMatchObject({
      statusCode: 400,
      message: 'No hay stock',
      error: 'Solicitud inválida',
    });
  });

  it.each([
    [new BadRequestException('x'), 'Solicitud inválida'],
    [new UnauthorizedException('x'), 'No autenticado'],
    [new ForbiddenException('x'), 'Acceso denegado'],
    [new NotFoundException('x'), 'No encontrado'],
    [new ConflictException('x'), 'Conflicto'],
    [new UnprocessableEntityException('x'), 'No se puede procesar'],
    [new InternalServerErrorException('x'), 'Error interno del servidor'],
    [new ServiceUnavailableException('x'), 'Servicio no disponible'],
    [new PayloadTooLargeException('x'), 'Archivo demasiado grande'],
    [new UnsupportedMediaTypeException('x'), 'Tipo de contenido no admitido'],
  ])('el campo error sale en castellano (%#)', (e, error) => {
    expect(texto(e)).toMatchObject({ error, message: 'x' });
  });

  it('sin mensaje propio, el nombre del status en inglés sale en castellano', () => {
    expect(texto(new UnauthorizedException())).toMatchObject({
      message: 'No autenticado',
      error: undefined,
    });
    expect(texto(new ForbiddenException())).toMatchObject({
      message: 'Acceso denegado',
    });
  });

  it('throttler (respuesta de texto plano) y multer', () => {
    const t = traducirExcepcion(
      new HttpException('ThrottlerException: Too Many Requests', 429),
    );
    expect(t.getStatus()).toBe(429);
    expect(t.getResponse()).toEqual({
      statusCode: 429,
      message: 'Demasiadas solicitudes: probá de nuevo en unos instantes',
      error: 'Demasiadas solicitudes',
    });
    expect(texto(new PayloadTooLargeException('File too large'))).toMatchObject(
      {
        message: 'El archivo es demasiado grande',
        error: 'Archivo demasiado grande',
      },
    );
    expect(
      texto(new BadRequestException('Unexpected field - foto')),
    ).toMatchObject({ message: 'Campo de archivo inesperado: foto' });
  });

  it('un error que no es de Nest sale como 500 genérico en castellano', () => {
    const e = traducirExcepcion(new Error('boom'));
    expect(e.getStatus()).toBe(500);
    expect(e.getResponse()).toEqual({
      statusCode: 500,
      message: 'Error interno del servidor',
      error: 'Error interno del servidor',
    });
  });

  it.each([
    [
      'entity.parse.failed',
      400,
      'El cuerpo de la solicitud no es un JSON válido',
    ],
    ['entity.too.large', 413, 'El cuerpo de la solicitud es demasiado grande'],
    [
      'charset.unsupported',
      415,
      'La codificación de caracteres de la solicitud no se admite',
    ],
    ['encoding.unsupported', 415, 'La compresión de la solicitud no se admite'],
    ['request.aborted', 400, 'La solicitud se interrumpió antes de terminar'],
    [
      'request.size.invalid',
      400,
      'El tamaño de la solicitud no coincide con lo enviado',
    ],
    ['parameters.too.many', 413, 'La solicitud trae demasiados parámetros'],
  ])(
    'un error de body-parser %s conserva su status %i',
    (type, status, message) => {
      const e = traducirExcepcion(
        Object.assign(new Error('english'), { type, statusCode: status }),
      );
      expect(e.getStatus()).toBe(status);
      expect(e.getResponse()).toMatchObject({ statusCode: status, message });
    },
  );

  it('un objeto cualquiera con `status` (el error de un SDK) es un 500, no un 4xx del cliente', () => {
    for (const sdk of [
      { status: 401, message: 'invalid access token' },
      Object.assign(new Error('MP'), { status: 400, statusCode: 400 }),
    ]) {
      const e = traducirExcepcion(sdk);
      expect(e.getStatus()).toBe(500);
      expect(e.getResponse()).toMatchObject({
        message: 'Error interno del servidor',
      });
    }
  });

  it('un error de http-errors con `expose` conserva su status; sin status es 500', () => {
    const e = traducirExcepcion(
      Object.assign(new Error('x'), { status: 408, expose: true }),
    );
    expect(e.getStatus()).toBe(408);
    expect(e.getResponse()).toMatchObject({
      message: 'Tiempo de espera agotado',
    });
    expect(
      traducirExcepcion({ statusCode: 'nope', expose: true }).getStatus(),
    ).toBe(500);
  });

  it.each([
    "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    'Unexpected token } in JSON at position 7',
    'Unexpected end of JSON input',
  ])('el 400 por un JSON roto sale en castellano: %s', (original) => {
    expect(texto(new BadRequestException(original))).toMatchObject({
      statusCode: 400,
      message: 'El cuerpo de la solicitud no es un JSON válido',
    });
  });

  it('un 400 de dominio con un texto parecido al de JSON no se toca', () => {
    const e = new HttpException(
      { statusCode: 400, message: 'Unexpected token', error: 'Otro' },
      400,
    );
    expect(texto(e)).toMatchObject({ message: 'Unexpected token' });
    expect(
      texto(new BadRequestException(['Unexpected end of JSON input'])),
    ).toMatchObject({ message: ['Unexpected end of JSON input'] });
  });

  it('un `error` propio no se pisa; el nombre en inglés del status sí', () => {
    const propio = new HttpException(
      { statusCode: 409, message: 'x', error: 'Envase vencido' },
      409,
    );
    expect(texto(propio)).toMatchObject({ error: 'Envase vencido' });
    expect(
      texto(
        new HttpException(
          { statusCode: 409, message: 'x', error: 'Conflict' },
          409,
        ),
      ),
    ).toMatchObject({ error: 'Conflicto' });
  });

  it('todos los status 4xx y 5xx de http tienen su `error` en castellano', () => {
    for (const codigo of Object.keys(STATUS_CODES).map(Number)) {
      if (codigo < 400) continue;
      const ingles = STATUS_CODES[codigo] as string;
      const e = traducirExcepcion(
        new HttpException(
          { statusCode: codigo, message: 'x', error: ingles },
          codigo,
        ),
      ).getResponse() as { error: string };
      expect(e.error).not.toBe(ingles);
    }
  });

  it('el identificador mal formado trae el código estable INVALID_ID', async () => {
    const e = await new ParseUUIDPipe()
      .transform('abc', { type: 'param' })
      .catch((x: unknown) => x);
    expect(texto(e)).toMatchObject({
      statusCode: 400,
      code: 'INVALID_ID',
      message: 'El identificador no es válido',
    });
  });

  it('un mensaje de servicio o de dominio pasa tal cual: lo escribió una persona', () => {
    for (const texto_ of [
      'El estado on_the_way no admite esa operación',
      'confirmalo enviando confirmOutOfRange: true',
      'hasOwnProperty',
    ]) {
      expect(texto(new BadRequestException(texto_))).toMatchObject({
        message: texto_,
      });
    }
  });
});
