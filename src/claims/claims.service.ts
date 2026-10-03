import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, FindOptionsWhere } from 'typeorm';
import { Claim, ClaimStatus } from './entities/claim.entity';
import { CreateClaimDto } from './dto/create-claim.dto';
import { OrderService } from '../order/order.service';
import { assertClaimTransition } from './claim-status.machine';
import {
  SignedDownload,
  StorageObjectStream,
  StoragePort,
} from '../storage/ports/storage.port';
import { StorageCleanupService } from '../storage/storage-cleanup.service';
import { RoleType } from '../common/constants/role-type.enum';
import { errorMessage } from '../common/errors/error-message';
import {
  esImagenPermitida,
  extensionParaMimeType,
  firmaCoincideConMimeType,
  MAX_ATTACHMENT_SIZE_BYTES,
} from '../common/utils/attachment-rules';

/** Quién pide la foto: el cliente dueño del reclamo o un admin de la distribuidora. */
export interface ClaimActor {
  userId: string;
  role: RoleType;
}

/** La foto del reclamo lista para responder, sea cual sea el driver activo. */
export type ClaimPhotoFile =
  | { kind: 'redirect'; url: string }
  | ({
      kind: 'stream';
      fileName: string;
      mimeType: string;
    } & StorageObjectStream);

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    @InjectRepository(Claim) private readonly claimRepo: Repository<Claim>,
    private readonly orderService: OrderService,
    private readonly storage: StoragePort,
    private readonly cleanup: StorageCleanupService,
  ) {}

  async create(
    createClaimDto: CreateClaimDto,
    distributorId: string | null = null,
  ): Promise<Claim> {
    // Con distribuidora en contexto, el pedido de otra no existe.
    await this.orderService.assertDeLaDistribuidora(
      createClaimDto.orderId,
      distributorId,
    );
    const order = await this.orderService.findOne(createClaimDto.orderId);

    if (order.customerId !== createClaimDto.customerId) {
      throw new BadRequestException(
        'Esta orden no pertenece al cliente indicado',
      );
    }

    // El `distributor_id` del reclamo se denormaliza desde la orden asociada:
    // el cliente no elige distribuidora acá, hereda la del pedido reclamado.
    const claim = this.claimRepo.create({
      orderId: createClaimDto.orderId,
      customerId: createClaimDto.customerId,
      distributorId: order.distributorId,
      reason: createClaimDto.reason,
      description: createClaimDto.description,
      photoUrl: createClaimDto.photoUrl,
    });

    return await this.claimRepo.save(claim);
  }

  async findAll(distributorId?: string | null): Promise<Claim[]> {
    const where: FindOptionsWhere<Claim> = {};
    if (distributorId) where.distributorId = distributorId;

    return await this.claimRepo.find({
      where,
      order: { createdAt: 'DESC' },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['order', 'customer'],
    });
  }

  /**
   * `distributorId` opcional: si viene, el reclamo debe pertenecer a ese
   * tenant (evita que un admin lea/resuelva reclamos de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null): Promise<Claim> {
    const where: FindOptionsWhere<Claim> = { claimId: id };
    if (distributorId) where.distributorId = distributorId;

    const claim = await this.claimRepo.findOne({ where });
    if (!claim) throw new NotFoundException('Reclamo no encontrado');

    return claim;
  }

  /**
   * Lee el reclamo con lock pesimista (`FOR UPDATE`), aplica el cambio y lo
   * guarda, todo en una transacción: dos admins que resuelven, toman o
   * reabren el mismo reclamo a la vez se serializan, y el segundo valida la
   * transición contra el estado que dejó el primero (no contra una lectura
   * vieja) en lugar de pisarle la nota.
   */
  private modificar(
    id: string,
    distributorId: string | null | undefined,
    aplicar: (claim: Claim, manager: EntityManager) => void | Promise<void>,
  ): Promise<Claim> {
    return this.claimRepo.manager.transaction(async (manager) => {
      const consulta = manager
        .createQueryBuilder(Claim, 'claim')
        .setLock('pessimistic_write')
        .where('claim.claimId = :id', { id });
      if (distributorId) {
        consulta.andWhere('claim.distributorId = :distributorId', {
          distributorId,
        });
      }
      const claim = await consulta.getOne();
      if (!claim) throw new NotFoundException('Reclamo no encontrado');

      await aplicar(claim, manager);
      return manager.save(claim);
    });
  }

  async resolve(
    id: string,
    resolution: string,
    status: ClaimStatus,
    distributorId?: string | null,
  ): Promise<Claim> {
    // Máquina de estados: un reclamo RESOLVED/REJECTED no se "re-resuelve" de
    // taquito, hay que reabrirlo primero (`reopen`).
    return this.modificar(id, distributorId, (claim) => {
      assertClaimTransition(claim.status, status);
      claim.resolutionNote = resolution;
      claim.status = status;
    });
  }

  /**
   * El admin toma un reclamo pendiente para empezar a revisarlo. A diferencia
   * de `resolve`, no exige nota: es sólo marcar que alguien ya lo está mirando.
   */
  async take(id: string, distributorId?: string | null): Promise<Claim> {
    return this.modificar(id, distributorId, (claim) => {
      if (claim.status !== ClaimStatus.PENDING) {
        throw new BadRequestException(
          'Sólo se puede tomar un reclamo pendiente',
        );
      }
      assertClaimTransition(claim.status, ClaimStatus.IN_PROCESS);
      claim.status = ClaimStatus.IN_PROCESS;
    });
  }

  /**
   * Reabre un reclamo ya resuelto o rechazado (error del admin, el cliente
   * aportó datos nuevos, etc.). Vuelve a IN_PROCESS, nunca a PENDING: alguien
   * ya lo había tomado. Exige el motivo de la reapertura, que pisa la nota de
   * resolución anterior (el historial completo queda en la auditoría).
   */
  async reopen(
    id: string,
    reason: string,
    distributorId?: string | null,
  ): Promise<Claim> {
    return this.modificar(id, distributorId, (claim) => {
      if (
        claim.status !== ClaimStatus.RESOLVED &&
        claim.status !== ClaimStatus.REJECTED
      ) {
        throw new BadRequestException(
          'Sólo se puede reabrir un reclamo resuelto o rechazado',
        );
      }
      assertClaimTransition(claim.status, ClaimStatus.IN_PROCESS);
      claim.status = ClaimStatus.IN_PROCESS;
      claim.resolutionNote = reason;
    });
  }

  /**
   * CU-174: sube (o reemplaza) la foto del reclamo. Valida el tipo por la firma
   * del archivo, la guarda en el storage y recién ahí apunta el reclamo a la
   * key nueva; la foto anterior se borra en segundo plano.
   */
  async uploadPhoto(
    id: string,
    file: Express.Multer.File | undefined,
    distributorId: string | null,
    actor: ClaimActor,
  ): Promise<Claim> {
    const claim = await this.findForPhoto(id, distributorId, actor);
    this.assertAbierto(claim);

    if (!file) throw new BadRequestException('Falta la foto');
    if (file.size === 0) throw new BadRequestException('La foto está vacía');
    if (!esImagenPermitida(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Tipo de archivo no permitido (${file.mimetype}). Se acepta JPG, PNG o WEBP`,
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `La foto supera el máximo permitido (${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB)`,
      );
    }
    if (!firmaCoincideConMimeType(file.mimetype, file.buffer)) {
      throw new UnsupportedMediaTypeException(
        `El contenido del archivo no coincide con el tipo declarado (${file.mimetype})`,
      );
    }

    const key = `claims/${claim.distributorId}/${claim.claimId}/${randomUUID()}.${extensionParaMimeType(file.mimetype)}`;
    // Se anota la key antes de subir: si el proceso cae antes de que el reclamo
    // apunte a la foto, el cron borra el objeto abandonado.
    await this.cleanup.reserveUpload(key);
    await this.storage.put({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    let anterior: string | null = null;
    try {
      const updated = await this.modificar(
        id,
        claim.distributorId,
        async (c, manager) => {
          // Con el lock tomado: si lo cerraron mientras se subía, no se cambia.
          this.assertAbierto(c);
          anterior = c.photoKey;
          c.photoKey = key;
          c.photoUrl = null;
          if (anterior) await this.cleanup.scheduleRemoval(manager, anterior);
          await this.cleanup.confirmUpload(manager, key);
        },
      );
      if (anterior) this.cleanup.removeInBackground(anterior);
      return updated;
    } catch (error) {
      // El archivo ya se subió pero el reclamo no apunta a él: se borra.
      this.cleanup.removeInBackground(key);
      throw error;
    }
  }

  /** Un reclamo resuelto o rechazado ya no admite cambios de foto (se reabre antes). */
  private assertAbierto(claim: Claim): void {
    if (
      claim.status === ClaimStatus.RESOLVED ||
      claim.status === ClaimStatus.REJECTED
    ) {
      throw new ConflictException(
        'El reclamo está cerrado: no se puede cambiar su foto',
      );
    }
  }

  /** CU-175: URL firmada de la foto (`null` con el driver local). 404 si no tiene. */
  async getPhotoSignedDownload(
    id: string,
    distributorId: string | null,
    actor: ClaimActor,
  ): Promise<SignedDownload | null> {
    const key = await this.photoKeyOrThrow(id, distributorId, actor);
    return this.storage.getSignedDownload(key);
  }

  /** CU-175: la foto misma, para `?modo=archivo`. */
  async getPhotoFile(
    id: string,
    distributorId: string | null,
    actor: ClaimActor,
  ): Promise<ClaimPhotoFile> {
    const key = await this.photoKeyOrThrow(id, distributorId, actor);
    const signed = await this.storage.getSignedDownload(key);
    if (signed) return { kind: 'redirect', url: signed.url };

    const stream = await this.storage.getStream(key);
    return {
      kind: 'stream',
      fileName: `reclamo-${id}.${key.split('.').pop() ?? 'jpg'}`,
      mimeType: stream.contentType ?? 'application/octet-stream',
      ...stream,
    };
  }

  /**
   * URL firmada para el campo `photoUrl` del reclamo. Nunca rompe la respuesta:
   * si no hay foto, el driver no firma (local) o el cálculo falla, es `null` y
   * el mapper deja la URL externa que el reclamo traía de antes.
   */
  async photoUrlFor(claim: Claim): Promise<string | null> {
    if (!claim.photoKey) return null;
    try {
      return (
        (await this.storage.getSignedDownload(claim.photoKey))?.url ?? null
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo firmar la foto del reclamo ${claim.claimId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async photoKeyOrThrow(
    id: string,
    distributorId: string | null,
    actor: ClaimActor,
  ): Promise<string> {
    const claim = await this.findForPhoto(id, distributorId, actor);
    if (!claim.photoKey) {
      throw new NotFoundException('El reclamo no tiene foto');
    }
    return claim.photoKey;
  }

  /**
   * El cliente sólo accede a sus propios reclamos (los clientes se comparten
   * entre distribuidoras: no se acota por tenant); el admin, a los de su
   * distribuidora. Lo demás es 404: no se revela que el reclamo existe.
   */
  private async findForPhoto(
    id: string,
    distributorId: string | null,
    actor: ClaimActor,
  ): Promise<Claim> {
    if (actor.role === RoleType.CUSTOMER) {
      const claim = await this.claimRepo.findOne({
        where: { claimId: id, customerId: actor.userId },
      });
      if (!claim) throw new NotFoundException('Reclamo no encontrado');
      return claim;
    }
    return this.findOne(id, distributorId);
  }
}
