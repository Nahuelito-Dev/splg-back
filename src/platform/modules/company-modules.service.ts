import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { DistributorService } from '../../distributor/distributor.service';
import {
  Distributor,
  DistributorStatus,
} from '../../distributor/entities/distributor.entity';
import { ExpressSettingsService } from '../../distributor/express-settings.service';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  AccesoDeLaEmpresa,
  MOTIVO_NO_DISPONIBLE,
  type NivelDeAcceso,
} from '../access/acceso-de-la-empresa.service';
import { moduloDesconocido } from '../access/errores';
import {
  CATALOGO_DE_MODULOS,
  esModulo,
  MODULOS,
  MODULOS_POR_PLAN,
  type ModuloKey,
} from './catalogo-de-modulos';
import type {
  CompanyModuleDto,
  FeaturesDto,
  OwnModuleDto,
  PublicFeaturesDto,
  SetCompanyModuleDto,
} from './dto/modules.dto';
import {
  type ExcepcionDeModulo,
  ModulosDeLaEmpresaRepository,
} from './modulos-de-la-empresa.repository';

/** Qué cuenta `impact.pending` de cada módulo. */
const UNIDAD_PENDIENTE: Readonly<Record<ModuloKey, string>> = {
  document_reading: 'documento(s) esperando lectura',
  route_planning: 'hoja(s) de ruta sin terminar',
  route_batching: 'lote(s) en armado u ofrecido(s)',
  repurchase: 'invitación(es) de recompra vigente(s)',
  cylinder_recovery: 'oferta(s) de retiro vigente(s)',
  fleet_planner: 'caso(s) de taller abierto(s)',
  whatsapp: 'conversación(es) abierta(s)',
  chat: 'conversación(es) abierta(s) con clientes o choferes',
  mercadopago: 'pedido(s) con Mercado Pago sin pagar',
  express: 'compra(s) express en curso',
  assistant: 'conversación(es) con el asistente',
};

/** Una excepción que rige ahora (con valor y sin vencer). */
function vigente(
  e: ExcepcionDeModulo | undefined,
  ahora: Date,
): (ExcepcionDeModulo & { enabled: boolean }) | null {
  if (!e || e.enabled === null) return null;
  if (e.expiresAt && e.expiresAt.getTime() <= ahora.getTime()) return null;
  return { ...e, enabled: e.enabled };
}

interface EstadoDelModulo {
  key: ModuloKey;
  inPlan: boolean;
  excepcion: (ExcepcionDeModulo & { enabled: boolean }) | null;
  enabled: boolean;
  companySwitch: boolean | null;
  effective: boolean;
}

/**
 * Módulos por distribuidora (DISENO-PLATAFORMA-ORIXTECH §5.2–§5.3): lo que ve
 * y cambia la plataforma, lo que ve la empresa y lo que leen las apps.
 * Habilitado = excepción vigente ?? módulo en la foto del plan; en uso
 * (`effective`) = habilitado ∧ encendido por la empresa ∧ empresa activa.
 */
@Injectable()
export class CompanyModulesService {
  private readonly logger = new Logger(CompanyModulesService.name);

  constructor(
    private readonly repo: ModulosDeLaEmpresaRepository,
    private readonly distribuidoras: DistributorService,
    private readonly acceso: AccesoDeLaEmpresa,
    private readonly procesos: ProcessConfigService,
    private readonly express: ExpressSettingsService,
    private readonly eventos: EventEmitter2,
  ) {}

  /** `GET /v2/platform/companies/:id/modules`. */
  async deLaPlataforma(distributorId: string): Promise<CompanyModuleDto[]> {
    const empresa = await this.empresa(distributorId);
    const estados = await this.estados(empresa);
    return Promise.all(estados.map((e) => this.aDtoDePlataforma(empresa, e)));
  }

  /** `PUT /v2/platform/companies/:id/modules/:key`. */
  async cambiar(
    distributorId: string,
    clave: string,
    dto: SetCompanyModuleDto,
    actorUserId: string,
    ahora = new Date(),
  ): Promise<CompanyModuleDto> {
    if (!esModulo(clave)) throw moduloDesconocido();
    const empresa = await this.empresa(distributorId);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (dto.enabled === null && expiresAt) {
      throw new BadRequestException(
        'Una fecha de vencimiento sólo corresponde a una excepción: para volver a lo del plan no se manda',
      );
    }
    if (expiresAt && expiresAt.getTime() <= ahora.getTime()) {
      throw new BadRequestException(
        'La fecha de vencimiento de la excepción tiene que ser futura',
      );
    }
    const antes = await this.estadoDe(empresa, clave, ahora);
    await this.repo.guardarExcepcion({
      distributorId,
      moduleKey: clave,
      enabled: dto.enabled,
      reason: dto.reason,
      expiresAt,
      actorUserId,
    });
    await this.acceso.invalidar(distributorId);
    const despues = await this.estadoDe(empresa, clave, ahora);
    if (antes.enabled !== despues.enabled) {
      this.avisarALaEmpresa(empresa, despues, ahora);
    }
    return this.aDtoDePlataforma(empresa, despues);
  }

  /** `GET /v2/company/modules`: los de la propia empresa (sin motivos ni excepciones). */
  async deLaEmpresa(distributorId: string): Promise<OwnModuleDto[]> {
    const empresa = await this.empresa(distributorId);
    return (await this.estados(empresa)).map((e) => ({
      key: e.key,
      label: CATALOGO_DE_MODULOS[e.key].label,
      enabled: e.enabled,
      effective: e.effective,
    }));
  }

  /** `GET /v2/me/features`. */
  async features(distributorId: string): Promise<FeaturesDto> {
    const empresa = await this.empresa(distributorId);
    return {
      modules: await this.enUso(empresa),
      access: this.nivel(empresa),
    };
  }

  /** `GET /v2/public/distributors/:slug/features`: 404 si no existe o está dada de baja. */
  async featuresPublicas(slug: string): Promise<PublicFeaturesDto> {
    const empresa = await this.distribuidoras.findBySlug(slug);
    const acepta = empresa.status === DistributorStatus.ACTIVE;
    return {
      modules: acepta ? await this.enUso(empresa) : [],
      acceptingOrders: acepta,
      message: acepta ? null : MOTIVO_NO_DISPONIBLE,
    };
  }

  private async enUso(empresa: Distributor): Promise<ModuloKey[]> {
    return (await this.estados(empresa))
      .filter((e) => e.effective)
      .map((e) => e.key);
  }

  private nivel(empresa: Distributor): NivelDeAcceso {
    return empresa.status === DistributorStatus.ACTIVE ? 'full' : 'blocked';
  }

  private async empresa(distributorId: string): Promise<Distributor> {
    try {
      return await this.distribuidoras.findOne(distributorId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      throw conCodigo(
        NotFoundException,
        404,
        'La empresa no existe o está dada de baja',
        CODIGOS_DE_ERROR.COMPANY_NOT_FOUND,
      );
    }
  }

  private async estados(
    empresa: Distributor,
    ahora = new Date(),
  ): Promise<EstadoDelModulo[]> {
    const [foto, excepciones] = await Promise.all([
      this.repo.fotoDelPlan(empresa.distributorId),
      this.repo.excepciones(empresa.distributorId),
    ]);
    const enElPlan = new Set<string>(foto?.modules ?? MODULOS_POR_PLAN.full);
    const porClave = new Map(excepciones.map((e) => [e.moduleKey, e]));
    return Promise.all(
      MODULOS.map((key) =>
        this.armar(empresa, key, enElPlan, porClave.get(key), ahora),
      ),
    );
  }

  private async estadoDe(
    empresa: Distributor,
    key: ModuloKey,
    ahora: Date,
  ): Promise<EstadoDelModulo> {
    const [foto, excepciones] = await Promise.all([
      this.repo.fotoDelPlan(empresa.distributorId),
      this.repo.excepciones(empresa.distributorId),
    ]);
    return this.armar(
      empresa,
      key,
      new Set<string>(foto?.modules ?? MODULOS_POR_PLAN.full),
      excepciones.find((e) => e.moduleKey === key),
      ahora,
    );
  }

  private async armar(
    empresa: Distributor,
    key: ModuloKey,
    enElPlan: ReadonlySet<string>,
    excepcion: ExcepcionDeModulo | undefined,
    ahora: Date,
  ): Promise<EstadoDelModulo> {
    const inPlan = enElPlan.has(key);
    const rige = vigente(excepcion, ahora);
    const enabled = rige ? rige.enabled : inPlan;
    const companySwitch = await this.llaveDeLaEmpresa(
      empresa.distributorId,
      key,
    );
    return {
      key,
      inPlan,
      excepcion: rige,
      enabled,
      companySwitch,
      effective:
        enabled &&
        companySwitch !== false &&
        empresa.status === DistributorStatus.ACTIVE,
    };
  }

  /** El interruptor de la empresa (§2), o `null` si el módulo no tiene. */
  private async llaveDeLaEmpresa(
    distributorId: string,
    key: ModuloKey,
  ): Promise<boolean | null> {
    const llave = CATALOGO_DE_MODULOS[key].llaveDeEmpresa;
    if (!llave) return null;
    if (llave.tipo === 'express') {
      return (await this.express.obtener(distributorId)).enabled;
    }
    const valores = await this.procesos.obtener(distributorId, llave.proceso);
    return valores.enabled === 1;
  }

  private async aDtoDePlataforma(
    empresa: Distributor,
    e: EstadoDelModulo,
  ): Promise<CompanyModuleDto> {
    const pending = await this.repo.pendientes(empresa.distributorId, e.key);
    return {
      key: e.key,
      label: CATALOGO_DE_MODULOS[e.key].label,
      inPlan: e.inPlan,
      override: e.excepcion
        ? {
            enabled: e.excepcion.enabled,
            reason: e.excepcion.reason,
            expiresAt: e.excepcion.expiresAt?.toISOString() ?? null,
          }
        : null,
      enabled: e.enabled,
      companySwitch: e.companySwitch,
      effective: e.effective,
      impact: {
        pending,
        description: `${pending} ${UNIDAD_PENDIENTE[e.key]}. ${CATALOGO_DE_MODULOS[e.key].alApagar}`,
      },
    };
  }

  /** Aviso a la bandeja de la empresa: la plataforma cambió uno de sus módulos. */
  private avisarALaEmpresa(
    empresa: Distributor,
    e: EstadoDelModulo,
    ahora: Date,
  ): void {
    const { label } = CATALOGO_DE_MODULOS[e.key];
    pedirAvisoAlAdmin(this.eventos, this.logger, {
      distributorId: empresa.distributorId,
      kind: 'platform_module_changed',
      title: e.enabled
        ? `La plataforma habilitó «${label}»`
        : `La plataforma deshabilitó «${label}»`,
      body: e.enabled
        ? `Ya pueden usar «${label}». Si tiene interruptor propio, se enciende desde la configuración de la empresa.`
        : `«${label}» ya no está disponible para la empresa. ${CATALOGO_DE_MODULOS[e.key].alApagar}`,
      link: null,
      dedupeKey: `platform-module:${e.key}:${e.enabled ? 'on' : 'off'}:${ahora.getTime()}`,
    });
  }
}
