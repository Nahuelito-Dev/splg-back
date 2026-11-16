import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { DistributorService } from '../distributor.service';
import { DistributorLogoService } from '../distributor-logo.service';
import { DistributorTheme } from '../entities/distributor-theme.entity';
import type {
  CompanyThemeDto,
  CompanyThemeResponseDto,
} from '../dto/company-theme.dto';
import {
  generarTema,
  PRINCIPAL_POR_OMISION,
  type FallaDeContraste,
  type TemaGenerado,
} from './generador-de-tema';

/** Lo que piden el `PUT` y la vista previa, ya normalizado por el DTO. */
export type EleccionDeTema = Pick<
  CompanyThemeDto,
  'primaryColor' | 'accentColor' | 'displayName'
>;

const QUE_ES: Record<string, string> = {
  'onPrimary/primary': 'con el texto de los botones',
  'primary/surface': 'con el blanco',
  'primary/canvas': 'con el fondo del panel',
  'accent/surface': 'con el blanco',
  'accent/canvas': 'con el fondo del panel',
};

const formatoRelacion = (n: number) =>
  `${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}:1`;

/** El 400 con la primera falla: el par, la relación medida y la sugerencia. */
export function contrasteInsuficiente(
  falla: FallaDeContraste,
): BadRequestException {
  const color =
    falla.field === 'primaryColor'
      ? 'El color principal'
      : 'El color de acento';
  const error = conCodigo(
    BadRequestException,
    400,
    `${color} no contrasta lo suficiente ${QUE_ES[falla.pair] ?? `(${falla.pair})`} (${formatoRelacion(falla.ratio)}; hace falta ${formatoRelacion(falla.required)}). Probá con ${falla.suggestion}`,
    CODIGOS_DE_ERROR.THEME_CONTRAST_INSUFFICIENT,
  );
  return new BadRequestException({
    ...(error.getResponse() as object),
    ...falla,
  });
}

/**
 * Tema por distribuidora (diseño de la plataforma, §4.8 y §10.3–§10.4). Todo
 * se resuelve por el `distributorId` del contexto (el del perfil del admin, el
 * de la sesión de soporte o el de la empresa propia): nunca por un parámetro
 * del cuerpo, así que el tema de A sólo se ve y se cambia desde A.
 */
@Injectable()
export class DistributorThemeService {
  constructor(
    @InjectRepository(DistributorTheme)
    private readonly temas: Repository<DistributorTheme>,
    private readonly distribuidoras: DistributorService,
    private readonly logo: DistributorLogoService,
  ) {}

  /** El tema vigente: el guardado o, si no hay, el por omisión con el nombre real. */
  async vigente(distributorId: string): Promise<CompanyThemeResponseDto> {
    const distribuidora = await this.distribuidoras.findOne(distributorId);
    await this.logo.firmar(distribuidora);
    const fila = await this.temas.findOne({
      where: { distributorId, deletedAt: IsNull() },
    });
    const base = {
      companyName: distribuidora.name,
      logoUrl: distribuidora.photoSignedUrl ?? null,
    };
    if (!fila) {
      const borrada = await this.temas.findOne({
        where: { distributorId },
        withDeleted: true,
      });
      return {
        ...this.porOmision(),
        ...base,
        version: borrada?.version ?? 0,
        updatedAt: borrada?.updatedAt.toISOString() ?? null,
      };
    }
    // Los tokens se recalculan con la versión actual del generador (es puro y
    // determinista): un tema guardado antes de que se sumaran roles los recibe
    // igual, sin migrar la tabla. Lo guardado queda como registro de lo que se
    // validó al guardar.
    const tema = generarTema(fila.primaryColor, fila.accentColor);
    return {
      primaryColor: fila.primaryColor,
      accentColor: fila.accentColor,
      displayName: fila.displayName,
      ...base,
      tokens: tema.tokens,
      contrast: tema.contrast,
      version: fila.version,
      isDefault: false,
      updatedAt: fila.updatedAt.toISOString(),
    };
  }

  /** Calcula sin guardar; 400 si un color elegido no cumple. */
  async vistaPrevia(
    distributorId: string,
    eleccion: EleccionDeTema,
  ): Promise<CompanyThemeResponseDto> {
    const distribuidora = await this.distribuidoras.findOne(distributorId);
    await this.logo.firmar(distribuidora);
    const tema = this.validado(eleccion);
    return {
      primaryColor: eleccion.primaryColor,
      accentColor: eleccion.accentColor ?? null,
      displayName: eleccion.displayName ?? null,
      companyName: distribuidora.name,
      logoUrl: distribuidora.photoSignedUrl ?? null,
      tokens: tema.tokens,
      contrast: tema.contrast,
      version: 0,
      isDefault: false,
      updatedAt: null,
    };
  }

  /**
   * Guarda el tema (crea la fila la primera vez o la revive si se había
   * restablecido) y sube la versión. Un `PUT` reemplaza todo: lo que no viene
   * queda sin valor (acento derivado, nombre de la distribuidora).
   */
  async guardar(
    distributorId: string,
    eleccion: EleccionDeTema,
    actorUserId: string | null,
  ): Promise<CompanyThemeResponseDto> {
    await this.distribuidoras.findOne(distributorId);
    const tema = this.validado(eleccion);
    await this.temas.query(
      `INSERT INTO "distributor_theme"
         ("distributor_id", "primary_color", "accent_color", "display_name", "tokens", "contrast", "version", "updated_by")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1, $7)
       ON CONFLICT ("distributor_id") DO UPDATE SET
         "primary_color" = EXCLUDED."primary_color",
         "accent_color" = EXCLUDED."accent_color",
         "display_name" = EXCLUDED."display_name",
         "tokens" = EXCLUDED."tokens",
         "contrast" = EXCLUDED."contrast",
         "version" = "distributor_theme"."version" + 1,
         "updated_by" = EXCLUDED."updated_by",
         "updated_at" = now(),
         "deleted_at" = NULL`,
      [
        distributorId,
        eleccion.primaryColor,
        eleccion.accentColor ?? null,
        eleccion.displayName ?? null,
        JSON.stringify(tema.tokens),
        JSON.stringify(tema.contrast),
        actorUserId,
      ],
    );
    return this.vigente(distributorId);
  }

  /**
   * «Restablecer»: baja lógica de la fila (sube la versión). Idempotente: si ya
   * usa el tema por omisión no cambia nada.
   */
  async restablecer(
    distributorId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.distribuidoras.findOne(distributorId);
    await this.temas.query(
      `UPDATE "distributor_theme"
          SET "deleted_at" = now(), "updated_at" = now(),
              "version" = "version" + 1, "updated_by" = $2
        WHERE "distributor_id" = $1 AND "deleted_at" IS NULL`,
      [distributorId, actorUserId],
    );
  }

  private validado(eleccion: EleccionDeTema): TemaGenerado {
    const tema = generarTema(
      eleccion.primaryColor,
      eleccion.accentColor ?? null,
    );
    if (tema.failures.length > 0) throw contrasteInsuficiente(tema.failures[0]);
    return tema;
  }

  private porOmision(): Pick<
    CompanyThemeResponseDto,
    | 'primaryColor'
    | 'accentColor'
    | 'displayName'
    | 'tokens'
    | 'contrast'
    | 'isDefault'
  > {
    // Con los oscuros de Brasa: sin tema propio el panel pinta sus variables,
    // y lo que devuelve la API tiene que ser lo que se ve.
    const tema = generarTema(PRINCIPAL_POR_OMISION, null, {
      oscurosDeBrasa: true,
    });
    return {
      primaryColor: PRINCIPAL_POR_OMISION,
      accentColor: null,
      displayName: null,
      tokens: tema.tokens,
      contrast: tema.contrast,
      isDefault: true,
    };
  }
}
