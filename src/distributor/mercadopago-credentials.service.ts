import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { codigoSqlDelError } from '../common/errors/db-exceptions';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import {
  MercadoPagoCredentialsResponseDto,
  SaveMercadoPagoCredentialsDto,
} from './dto/mercadopago-credentials.dto';
import { MercadoPagoCredentials } from './entities/mercadopago-credentials.entity';

/** Cuenta con la que se cobra: la propia de la distribuidora o la del entorno. */
export interface ResolvedMercadoPagoCredentials {
  accessToken: string;
  webhookSecret: string;
  source: 'own' | 'system';
  /** Id de la credencial propia usada; `null` si es la del sistema. */
  credentialId: string | null;
  /** Distribuidora dueña de la cuenta; `null` si es la del sistema. */
  distributorId: string | null;
}

/** Consulta de la cuenta dueña de un token: sirve para saber si Mercado Pago lo acepta. */
const URL_CUENTA = 'https://api.mercadopago.com/users/me';
const TIMEOUT_VERIFICACION_MS = 5000;

@Injectable()
export class MercadoPagoCredentialsService {
  private readonly logger = new Logger(MercadoPagoCredentialsService.name);

  constructor(
    @InjectRepository(MercadoPagoCredentials)
    private readonly repo: Repository<MercadoPagoCredentials>,
    private readonly crypto: CredentialsEncryptionService,
  ) {}

  /** Qué cuenta usa la distribuidora, con los valores enmascarados. */
  async status(
    distributorId: string,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    const encryptionConfigured = this.crypto.isConfigured();
    const item = await this.repo.findOne({
      where: { distributorId, active: true },
    });
    if (!item || !encryptionConfigured) {
      return {
        source: 'system',
        active: false,
        encryptionConfigured,
        accessTokenMasked: null,
        publicKeyMasked: null,
        webhookSecretMasked: null,
        verifiedAt: null,
      };
    }
    return {
      source: 'own',
      active: true,
      encryptionConfigured,
      accessTokenMasked: enmascarar(
        this.crypto.decrypt(item.accessTokenEncrypted),
      ),
      publicKeyMasked: enmascarar(this.crypto.decrypt(item.publicKeyEncrypted)),
      webhookSecretMasked: enmascarar(
        this.crypto.decrypt(item.webhookSecretEncrypted),
      ),
      verifiedAt: item.verifiedAt,
    };
  }

  /**
   * Carga o reemplaza la cuenta. El token se verifica contra Mercado Pago antes
   * de guardar nada: si lo rechaza o no responde, la distribuidora sigue como estaba.
   */
  async save(
    distributorId: string,
    actorUserId: string,
    dto: SaveMercadoPagoCredentialsDto,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    if (!this.crypto.isConfigured()) {
      throw new ServiceUnavailableException(
        'Las credenciales propias no están habilitadas: falta CREDENTIALS_ENCRYPTION_KEY en el servidor',
      );
    }
    await this.verificarToken(dto.accessToken);

    // La cuenta anterior queda desactivada (no se pisa): los pagos ya cobrados
    // con ella siguen usándola. Todo en una transacción para no dejar dos activas.
    try {
      await this.repo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(MercadoPagoCredentials);
        await repo.update({ distributorId, active: true }, { active: false });
        await repo.save(
          repo.create({
            distributorId,
            accessTokenEncrypted: this.crypto.encrypt(dto.accessToken),
            publicKeyEncrypted: this.crypto.encrypt(dto.publicKey),
            webhookSecretEncrypted: this.crypto.encrypt(dto.webhookSecret),
            active: true,
            loadedByUserId: actorUserId,
            verifiedAt: new Date(),
          }),
        );
      });
    } catch (error) {
      if (codigoSqlDelError(error) === '23505') {
        throw new ConflictException(
          'Otra carga de la cuenta de Mercado Pago se estaba guardando al mismo tiempo: probá de nuevo',
        );
      }
      throw error;
    }
    return this.status(distributorId);
  }

  /** Vuelve a la cuenta del sistema. La fila queda (baja lógica), sin borrarse. */
  async deactivate(
    distributorId: string,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    const item = await this.repo.findOne({
      where: { distributorId, active: true },
    });
    if (!item) {
      throw new NotFoundException(
        'La distribuidora no tiene una cuenta propia de Mercado Pago activa',
      );
    }
    item.active = false;
    await this.repo.save(item);
    return this.status(distributorId);
  }

  /**
   * La cuenta con la que cobra hoy la distribuidora. Sin credenciales propias
   * activas (o sin clave de cifrado en el servidor) devuelve las del entorno.
   */
  async resolve(
    distributorId: string | null | undefined,
    system: { accessToken: string; webhookSecret: string },
  ): Promise<ResolvedMercadoPagoCredentials> {
    if (distributorId && this.crypto.isConfigured()) {
      const item = await this.repo.findOne({
        where: { distributorId, active: true },
      });
      if (item) return this.descifrar(item);
    }
    return this.delSistema(system);
  }

  /**
   * La cuenta con la que se cobró un pago: la credencial indicada aunque
   * después se la haya desactivado o reemplazado, o la del entorno si es `null`.
   * Una credencial que no existe es un error (nunca cae a otra cuenta).
   */
  async resolveById(
    credentialId: string | null | undefined,
    system: { accessToken: string; webhookSecret: string },
  ): Promise<ResolvedMercadoPagoCredentials> {
    if (!credentialId) return this.delSistema(system);
    const item = await this.repo.findOne({ where: { credentialId } });
    if (!item) {
      throw new NotFoundException(
        'La cuenta de Mercado Pago de este pago no existe',
      );
    }
    return this.descifrar(item);
  }

  private delSistema(system: {
    accessToken: string;
    webhookSecret: string;
  }): ResolvedMercadoPagoCredentials {
    return {
      ...system,
      source: 'system',
      credentialId: null,
      distributorId: null,
    };
  }

  private descifrar(
    item: MercadoPagoCredentials,
  ): ResolvedMercadoPagoCredentials {
    return {
      accessToken: this.crypto.decrypt(item.accessTokenEncrypted),
      webhookSecret: this.crypto.decrypt(item.webhookSecretEncrypted),
      source: 'own',
      credentialId: item.credentialId,
      distributorId: item.distributorId,
    };
  }

  private async verificarToken(accessToken: string): Promise<void> {
    let respuesta: Response;
    try {
      respuesta = await fetch(URL_CUENTA, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_VERIFICACION_MS),
      });
    } catch {
      throw new BadGatewayException(
        'Mercado Pago no respondió al verificar el access token: no se guardó nada',
      );
    }
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw new UnprocessableEntityException(
        'Mercado Pago rechazó el access token: no se guardó nada',
      );
    }
    if (!respuesta.ok) {
      this.logger.warn(
        `Mercado Pago respondió ${respuesta.status} al verificar un access token`,
      );
      throw new BadGatewayException(
        'Mercado Pago no pudo verificar el access token: no se guardó nada',
      );
    }
  }
}

/** Deja ver sólo el prefijo conocido (`APP_USR-`, `TEST-`) y los últimos 4 caracteres. */
export function enmascarar(valor: string): string {
  if (valor.length < 12) return '••••';
  const prefijo = /^(APP_USR|TEST)-/.exec(valor)?.[0] ?? '';
  return `${prefijo}${prefijo ? '…' : '••••'}${valor.slice(-4)}`;
}
