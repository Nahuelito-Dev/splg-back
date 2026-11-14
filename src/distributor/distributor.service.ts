import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Distributor, DistributorStatus } from './entities/distributor.entity';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from './events/distribuidora-creada.event';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../common/events/notificar-admin.event';

/**
 * El cuerpo de la API lleva `legal_name` y `tax_id`; la entidad,
 * camelCase. Se mapea campo por campo: `Object.assign(entidad, dto)` no da
 * error de tipos y pierde esos datos en silencio.
 */
function columnasDeLaDistribuidora(
  dto: UpdateDistributorDto,
): Partial<Distributor> {
  return sinIndefinidos({
    name: dto.name,
    legalName: dto.legal_name,
    taxId: dto.tax_id,
    email: dto.email,
    phone: dto.phone,
    status: dto.status,
    plan: dto.plan,
  });
}

/** Un uuid canónico: el `X-Distributor` puede ser el id o el slug. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DistributorService {
  constructor(
    @InjectRepository(Distributor)
    private readonly repo: Repository<Distributor>,
    private readonly config: ConfigService,
    private readonly eventos: EventEmitter2,
  ) {}

  async create(dto: CreateDistributorDto): Promise<Distributor> {
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException(
        `Ya existe una distribuidora con slug '${dto.slug}'`,
      );
    }
    const distributor = this.repo.create({
      ...columnasDeLaDistribuidora(dto),
      slug: dto.slug,
    });
    const guardada = await this.repo.save(distributor);

    // Confirmada el alta, se avisa para que quien tenga datos base por
    // distribuidora los siembre (hoy: los planes de mantenimiento de fleet).
    this.eventos.emit(
      EVENTO_DISTRIBUIDORA_CREADA,
      new DistribuidoraCreadaEvent(guardada.distributorId),
    );

    return guardada;
  }

  findAll(): Promise<Distributor[]> {
    return this.repo.find({ order: { createdAt: 'ASC' } });
  }

  async findOne(id: string): Promise<Distributor> {
    const distributor = await this.repo.findOne({
      where: { distributorId: id },
    });
    if (!distributor) {
      throw new NotFoundException('Distribuidora no encontrada');
    }
    return distributor;
  }

  async findBySlug(slug: string): Promise<Distributor> {
    const distributor = await this.repo.findOne({ where: { slug } });
    if (!distributor) {
      throw new NotFoundException(`Distribuidora '${slug}' no encontrada`);
    }
    return distributor;
  }

  /**
   * Distribuidora por defecto (compatibilidad hacia atrás). Los flujos de
   * cliente que aún NO mandan `X-Distributor` (apps previas al multi-tenant)
   * caen acá para seguir funcionando como single-tenant. Resolución:
   *   1. la de slug `DEFAULT_DISTRIBUTOR_SLUG` (env; default 'demo'),
   *   2. si no existe, la distribuidora activa más antigua,
   *   3. null si no hay ninguna.
   */
  async getDefault(): Promise<Distributor | null> {
    const slug = this.config.get<string>('DEFAULT_DISTRIBUTOR_SLUG', 'demo');
    const bySlug = await this.repo.findOne({ where: { slug } });
    if (bySlug) return bySlug;
    return this.repo.findOne({
      where: { status: DistributorStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Devuelve la distribuidora sólo si está activa (para flujos de cliente:
   * no se puede pedir a una distribuidora suspendida). Lanza si no existe o
   * está suspendida.
   */
  async assertActive(id: string): Promise<Distributor> {
    const distributor = await this.findOne(id);
    if (distributor.status !== DistributorStatus.ACTIVE) {
      throw new NotFoundException(
        `La distribuidora '${distributor.name}' no está disponible`,
      );
    }
    return distributor;
  }

  /**
   * La empresa propia de la plataforma que nombra el `X-Distributor` del super
   * admin (slug o uuid), o `null` si no lo es. Sólo cuenta una distribuidora
   * vigente (activa y no dada de baja) con la marca `ownedByPlatform`: una que
   * no existe, que no es propia o que está suspendida da `null` igual, así el
   * header de una empresa ajena no abre nada. Se consulta en cada request:
   * desmarcarla corta el acceso en la request siguiente.
   */
  async empresaPropiaVigente(referencia: string): Promise<string | null> {
    const ref = referencia.trim();
    if (!ref) return null;
    const porId = UUID_RE.test(ref);
    const fila = await this.repo.findOne({
      select: { distributorId: true },
      where: {
        ...(porId ? { distributorId: ref } : { slug: ref }),
        ownedByPlatform: true,
        createdByPlatform: true,
        status: DistributorStatus.ACTIVE,
      },
    });
    if (!fila) return null;
    // La condición de «sólo datos de la plataforma» se revisa en cada request,
    // no sólo al marcarla: si entró un admin, un cliente o un pedido de una
    // cuenta real, el acceso directo se corta y vuelve a hacer falta el modo
    // soporte (con el consentimiento de la empresa).
    return (await this.soloDatosDePlataforma(fila.distributorId, false))
      ? fila.distributorId
      : null;
  }

  /**
   * Las empresas de la plataforma (vigentes, sin las dadas de baja), para el
   * panel del super admin: primero las propias, después por nombre.
   */
  async listarEmpresas(filtro: {
    ownedByPlatform?: boolean;
    status?: DistributorStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: Distributor[]; total: number }> {
    const [items, total] = await this.repo.findAndCount({
      where: sinIndefinidos({
        ownedByPlatform: filtro.ownedByPlatform,
        status: filtro.status,
      }),
      order: { ownedByPlatform: 'DESC', name: 'ASC', distributorId: 'ASC' },
      take: filtro.limit,
      skip: filtro.offset,
    });
    return { items, total };
  }

  /**
   * Marca o desmarca una empresa como propia de la plataforma. Idempotente: si
   * ya tiene ese valor no escribe. El cambio lo asienta el trigger de
   * auditoría con el super admin como actor.
   */
  async marcarPropia(id: string, propia: boolean): Promise<Distributor> {
    const d = await this.repo.findOne({ where: { distributorId: id } });
    if (!d) {
      throw conCodigo(
        NotFoundException,
        404,
        'La empresa no existe o está dada de baja',
        CODIGOS_DE_ERROR.COMPANY_NOT_FOUND,
      );
    }
    if (d.ownedByPlatform === propia) return d;
    if (propia && !(await this.puedeSerEmpresaPropia(d.distributorId))) {
      throw conCodigo(
        ConflictException,
        409,
        'Sólo se puede marcar como propia una empresa de prueba creada por la plataforma',
        CODIGOS_DE_ERROR.COMPANY_NOT_PLATFORM_OWNED,
      );
    }
    d.ownedByPlatform = propia;
    const guardada = await this.repo.save(d);
    this.eventos.emit(
      EVENTO_NOTIFICAR_ADMIN,
      new NotificarAdminEvent(
        guardada.distributorId,
        'platform_company_ownership_changed',
        propia
          ? 'La plataforma marcó esta empresa como propia'
          : 'La plataforma desmarcó esta empresa como propia',
        propia
          ? 'El administrador general puede operarla sin sesión de soporte.'
          : 'El administrador general vuelve a requerir una sesión de soporte para operarla.',
        null,
        false,
        `platform-company-ownership:${guardada.distributorId}:${propia}`,
      ),
    );
    return guardada;
  }

  /**
   * Una empresa propia sólo puede ser un entorno de prueba íntegramente
   * creado por la plataforma. La marca de origen impide convertir una empresa
   * real; los tres EXISTS cierran el caso de datos reales agregados después.
   */
  private async puedeSerEmpresaPropia(id: string): Promise<boolean> {
    if (
      !(await this.repo.findOne({
        where: { distributorId: id, createdByPlatform: true },
      }))
    ) {
      return false;
    }
    return this.soloDatosDePlataforma(id, true);
  }

  /**
   * Sin admins ni clientes vigentes que no sean cuentas de la siembra, y sin
   * pedidos (`sinPedidos`, al marcar) o sin pedidos de clientes que no sean de
   * la siembra (en cada request: los de prueba de la plataforma sí valen).
   */
  private async soloDatosDePlataforma(
    id: string,
    sinPedidos: boolean,
  ): Promise<boolean> {
    const [fila] = await this.repo.query<
      Array<{
        sin_admins_ajenos: boolean;
        sin_clientes_ajenos: boolean;
        sin_pedidos: boolean;
      }>
    >(
      `SELECT
         NOT EXISTS (
           SELECT 1 FROM admin a
           JOIN "user" u ON u.user_id = a.user_id
           WHERE a.distributor_id = $1
             AND u."deletedAt" IS NULL
             AND u.created_by_platform IS NOT TRUE
         ) AS sin_admins_ajenos,
         NOT EXISTS (
           SELECT 1 FROM customer_distributor cd
           JOIN "user" u ON u.user_id = cd.user_id
           WHERE cd.distributor_id = $1
             AND cd.removed_at IS NULL
             AND u.created_by_platform IS NOT TRUE
         ) AS sin_clientes_ajenos,
         NOT EXISTS (
           SELECT 1 FROM "order" o
           LEFT JOIN "user" u ON u.user_id = o.customer_id
           WHERE o.distributor_id = $1
             AND ($2::boolean OR u.created_by_platform IS NOT TRUE)
         ) AS sin_pedidos`,
      [id, sinPedidos],
    );
    return Boolean(
      fila?.sin_admins_ajenos && fila.sin_clientes_ajenos && fila.sin_pedidos,
    );
  }

  /** La política de soporte de la empresa (modo soporte, D1). */
  async politicaDeSoporte(
    id: string,
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    const d = await this.findOne(id);
    return {
      emergencyAllowed: d.supportEmergencyAllowed,
      autoApprove: d.supportAutoApprove,
    };
  }

  /** Cambia la política de soporte; lo que no viene queda como estaba. */
  async actualizarPoliticaDeSoporte(
    id: string,
    cambios: { emergencyAllowed?: boolean; autoApprove?: boolean },
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    const d = await this.findOne(id);
    if (cambios.emergencyAllowed !== undefined) {
      d.supportEmergencyAllowed = cambios.emergencyAllowed;
    }
    if (cambios.autoApprove !== undefined) {
      d.supportAutoApprove = cambios.autoApprove;
    }
    const guardada = await this.repo.save(d);
    return {
      emergencyAllowed: guardada.supportEmergencyAllowed,
      autoApprove: guardada.supportAutoApprove,
    };
  }

  async update(id: string, dto: UpdateDistributorDto): Promise<Distributor> {
    const distributor = await this.findOne(id);
    Object.assign(distributor, columnasDeLaDistribuidora(dto));
    return this.repo.save(distributor);
  }

  async remove(id: string): Promise<void> {
    const distributor = await this.findOne(id);
    await this.repo.softRemove(distributor);
  }
}
