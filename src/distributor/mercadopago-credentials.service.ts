import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { codigoSqlDelError } from '../common/errors/db-exceptions';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import {
  MercadoPagoAccountType,
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
/** Cuánto se recuerda de qué tipo es una cuenta: el panel consulta el estado seguido. */
const VIGENCIA_TIPO_DE_CUENTA_MS = 10 * 60 * 1000;

/**
 * Qué tipo de cuenta es la dueña de un token, según lo que devuelve `GET /users/me`: los
 * usuarios de prueba traen la etiqueta `test_user` y un nickname `TESTUSER…`. El
 * prefijo del token ya no sirve (los de prueba también son `APP_USR-`).
 */
export function tipoDeCuentaDe(cuenta: {
  nickname?: unknown;
  tags?: unknown;
}): MercadoPagoAccountType {
  const etiquetas = Array.isArray(cuenta.tags) ? cuenta.tags : [];
  const nickname =
    typeof cuenta.nickname === 'string' ? cuenta.nickname.toUpperCase() : '';
  return etiquetas.includes('test_user') || nickname.startsWith('TESTUSER')
    ? 'test'
    : 'real';
}

function etiquetaDelTipo(tipo: MercadoPagoAccountType): string {
  return tipo === 'test'
    ? 'cuenta de prueba'
    : tipo === 'real'
      ? 'cuenta real'
      : 'no se pudo determinar';
}

@Injectable()
export class MercadoPagoCredentialsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MercadoPagoCredentialsService.name);
  private readonly tiposDeCuenta = new Map<
    string,
    { tipo: MercadoPagoAccountType; hasta: number }
  >();
  private readonly advertidas = new Set<string>();

  constructor(
    @InjectRepository(MercadoPagoCredentials)
    private readonly repo: Repository<MercadoPagoCredentials>,
    private readonly crypto: CredentialsEncryptionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Al arrancar se mira de qué tipo es la cuenta del entorno y se deja en el log
   * (con advertencia si no corresponde al entorno). No frena el arranque.
   */
  onApplicationBootstrap(): void {
    const token = this.config.get<string>('MP_ACCESS_TOKEN');
    if (!token) return;
    void this.tipoDeCuenta(token, 'la del entorno (MP_ACCESS_TOKEN)').then(
      (tipo) =>
        this.logger.log(
          `Cuenta de Mercado Pago del entorno: ${etiquetaDelTipo(tipo)}`,
        ),
    );
  }

  /**
   * Tipo de la cuenta dueña del token, consultando a Mercado Pago (se recuerda unos
   * minutos). Nunca lanza: si no responde, `unknown`. Si la cuenta no corresponde al
   * entorno (real fuera de producción, o de prueba en producción) lo advierte en el
   * log, una vez por token. Nunca registra el token.
   */
  async tipoDeCuenta(
    accessToken: string,
    origen: string,
  ): Promise<MercadoPagoAccountType> {
    if (!accessToken) return 'unknown';
    const huella = createHash('sha256').update(accessToken).digest('hex');
    const guardado = this.tiposDeCuenta.get(huella);
    if (guardado && guardado.hasta > Date.now()) return guardado.tipo;
    let tipo: MercadoPagoAccountType = 'unknown';
    try {
      const respuesta = await fetch(URL_CUENTA, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_VERIFICACION_MS),
      });
      if (respuesta.ok) {
        tipo = tipoDeCuentaDe((await respuesta.json()) as object);
      }
    } catch {
      tipo = 'unknown';
    }
    if (tipo !== 'unknown') {
      this.tiposDeCuenta.set(huella, {
        tipo,
        hasta: Date.now() + VIGENCIA_TIPO_DE_CUENTA_MS,
      });
      this.advertirSiNoCorresponde(tipo, origen, huella);
    }
    return tipo;
  }

  private advertirSiNoCorresponde(
    tipo: MercadoPagoAccountType,
    origen: string,
    huella: string,
  ): void {
    const entorno = this.config.get<string>('NODE_ENV') || 'development';
    const mensaje =
      tipo === 'real' && entorno !== 'production'
        ? `ADVERTENCIA: la cuenta de Mercado Pago ${origen} es REAL y el servidor corre en '${entorno}': los cobros de este entorno son con dinero real`
        : tipo === 'test' && entorno === 'production'
          ? `ADVERTENCIA: la cuenta de Mercado Pago ${origen} es de PRUEBA y el servidor corre en producción: no se puede cobrar de verdad`
          : null;
    const clave = `${huella}:${tipo}:${entorno}`;
    if (!mensaje || this.advertidas.has(clave)) return;
    this.advertidas.add(clave);
    this.logger.warn(mensaje);
  }

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
        accountType: await this.tipoDeCuenta(
          this.config.get<string>('MP_ACCESS_TOKEN') || '',
          'la del entorno (MP_ACCESS_TOKEN)',
        ),
        source: 'system',
        active: false,
        encryptionConfigured,
        accessTokenMasked: null,
        publicKeyMasked: null,
        webhookSecretMasked: null,
        verifiedAt: null,
      };
    }
    const accessToken = this.crypto.decrypt(item.accessTokenEncrypted);
    return {
      accountType: await this.tipoDeCuenta(
        accessToken,
        `de la distribuidora ${distributorId}`,
      ),
      source: 'own',
      active: true,
      encryptionConfigured,
      accessTokenMasked: enmascarar(accessToken),
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
