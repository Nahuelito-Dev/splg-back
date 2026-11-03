import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InjectionToken,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enteroPositivoDeEnv } from '../common/config/entero-positivo';
import { RoleType } from '../common/constants/role-type.enum';
import { ubicacionVigente } from '../common/utils/ubicacion-vigente';
import { errorMessage } from '../common/errors/error-message';
import { OrderService } from '../order/order.service';
import { RedisService } from '../redis/redis.service';
import { DrivingRouteDto } from './dto/driving-route.dto';
import { urlDeOsrm } from './osrm-url';
import { PuntoDeRuta, decodificarPolilinea } from './polyline';

/** `fetch` inyectable: los tests simulan al proveedor sin red. */
export const ROUTES_FETCH: InjectionToken = 'ROUTES_FETCH';
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Pedidos de ruta por usuario y por minuto. */
export const LIMITE_POR_MINUTO = 30;
/** Consultas a un proveedor por usuario y por día (24 h desde la primera). */
export const LIMITE_DIARIO_POR_USUARIO = 100;
/** Consultas a un proveedor por distribuidora y por día. */
export const LIMITE_DIARIO_POR_DISTRIBUIDORA = 3000;
/** Distancia máxima entre `from` y la última posición conocida del chofer. */
export const DISTANCIA_MAXIMA_DE_FROM_M = 300;
/** Redondeo de las coordenadas para la caché (4 decimales ≈ 11 m). */
const DECIMALES_DE_CACHE = 4;
const TTL_DE_CACHE_SEG = 60;
const TTL_DIARIO_SEG = 24 * 60 * 60;
const TIMEOUT_PROVEEDOR_MS = 5000;
const RADIO_TIERRA_M = 6_371_000;

/** Distancia entre dos puntos sobre la esfera (haversine), en metros. */
export function distanciaEnMetros(a: PuntoDeRuta, b: PuntoDeRuta): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h));
}

interface GoogleDirections {
  status: string;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      distance?: { value?: number };
      duration?: { value?: number };
    }>;
  }>;
}
interface OsrmRoute {
  code: string;
  routes?: Array<{ distance?: number; duration?: number; geometry?: string }>;
}

/**
 * Ruta por calles de UN pedido: del chofer a la dirección de entrega.
 *
 * No es un proxy de mapas: el destino sale del pedido (que tiene que ser del
 * que pregunta y estar activo) y el origen es la última posición conocida del
 * chofer; `from` sólo se acepta si está a menos de
 * `ROUTES_FROM_MAX_DISTANCE_M` de ella. Cada consulta que llega al proveedor
 * cuenta contra un tope diario por usuario y otro por distribuidora (429), para
 * acotar el gasto de Google. Google Directions con una clave DEL SERVIDOR
 * (`GOOGLE_DIRECTIONS_API_KEY`); sin clave el OSRM público sólo se usa en
 * desarrollo (en producción hace falta `OSRM_BASE_URL` propio). Con Redis caído
 * se degrada: los cupos pasan a contarse en memoria y no hay caché.
 */
@Injectable()
export class RoutesService {
  private readonly logger = new Logger(RoutesService.name);
  /** Contadores de respaldo si Redis no responde (por proceso). */
  private readonly enMemoria = new Map<
    string,
    { cuenta: number; vence: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly orders: OrderService,
    @Inject(ROUTES_FETCH) private readonly http: FetchFn,
  ) {}

  async driving(
    orderId: string,
    from: string | undefined,
    user: { userId: string; role: RoleType },
  ): Promise<DrivingRouteDto> {
    const pedido = await this.orders.datosParaLaRuta(
      orderId,
      user.userId,
      user.role,
    );
    await this.contar(
      `routes:cupo:${user.userId}`,
      60,
      LIMITE_POR_MINUTO,
      'Demasiados pedidos de ruta: esperá un minuto',
    );

    const origen = await this.resolverOrigen(orderId, from, user, pedido);
    const destino = pedido.destino;

    const clave = `routes:driving:${this.redondear(origen)}:${this.redondear(destino)}`;
    const guardada = await this.seguro(() => this.redis.get(clave), null);
    if (guardada) {
      try {
        return JSON.parse(guardada) as DrivingRouteDto;
      } catch {
        await this.seguro(() => this.redis.del(clave), undefined);
      }
    }

    // Sólo lo que llega al proveedor cuesta plata: la caché no cuenta.
    await this.contar(
      `routes:dia:usuario:${user.userId}`,
      TTL_DIARIO_SEG,
      enteroPositivoDeEnv(
        'ROUTES_DAILY_LIMIT_PER_USER',
        this.config.get<string>('ROUTES_DAILY_LIMIT_PER_USER'),
        LIMITE_DIARIO_POR_USUARIO,
      ),
      'Llegaste al máximo de rutas por día: probá mañana',
    );
    await this.contar(
      `routes:dia:distribuidora:${pedido.distributorId}`,
      TTL_DIARIO_SEG,
      enteroPositivoDeEnv(
        'ROUTES_DAILY_LIMIT_PER_DISTRIBUTOR',
        this.config.get<string>('ROUTES_DAILY_LIMIT_PER_DISTRIBUTOR'),
        LIMITE_DIARIO_POR_DISTRIBUIDORA,
      ),
      'La distribuidora llegó al máximo de rutas por día',
    );

    const ruta = await this.calcular(origen, destino);
    await this.seguro(
      () => this.redis.setex(clave, TTL_DE_CACHE_SEG, JSON.stringify(ruta)),
      undefined,
    );
    return ruta;
  }

  /**
   * El origen es la última posición vigente del chofer. `from` se acepta si
   * está cerca de ella; si el radar no responde, el chofer (y sólo él) puede
   * dar su propio origen.
   */
  private async resolverOrigen(
    orderId: string,
    desde: string | undefined,
    user: { userId: string; role: RoleType },
    pedido: { choferUserId: string | null },
  ): Promise<PuntoDeRuta> {
    const origenDado = desde ? this.parsear(desde) : null;
    let conocida: PuntoDeRuta | null = null;
    let radarCaido = false;
    if (pedido.choferUserId) {
      try {
        // El cliente sólo ve la posición si éste es el pedido que el chofer lleva.
        const activo =
          user.role === RoleType.CUSTOMER
            ? await this.redis.getDriverActiveOrder(pedido.choferUserId)
            : null;
        if (user.role !== RoleType.CUSTOMER || activo?.orderId === orderId) {
          conocida = ubicacionVigente(
            await this.redis.getDriverLastLocation(pedido.choferUserId),
          );
        }
      } catch (error) {
        radarCaido = true;
        this.logger.warn(`Sin radar para la ruta: ${errorMessage(error)}`);
      }
    }
    if (conocida) {
      if (
        origenDado &&
        distanciaEnMetros(origenDado, conocida) >
          enteroPositivoDeEnv(
            'ROUTES_FROM_MAX_DISTANCE_M',
            this.config.get<string>('ROUTES_FROM_MAX_DISTANCE_M'),
            DISTANCIA_MAXIMA_DE_FROM_M,
          )
      ) {
        throw new BadRequestException(
          'El origen está lejos de la última posición del chofer',
        );
      }
      return origenDado ?? conocida;
    }
    // Sin radar no hay contra qué validar el origen: aceptar el `from` del chofer
    // dejaría trazar rutas desde cualquier punto con la clave del servidor.
    if (radarCaido) {
      throw new ServiceUnavailableException(
        'La posición del chofer no está disponible en este momento: reintentá en unos segundos',
      );
    }
    throw new ConflictException(
      'Todavía no hay una posición reciente del chofer para trazar la ruta',
    );
  }

  private parsear(texto: string): PuntoDeRuta {
    const [lat, lng] = texto.split(',').map(Number);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new HttpException(
        'Coordenadas fuera de rango',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { lat, lng };
  }

  private redondear(p: PuntoDeRuta): string {
    return `${p.lat.toFixed(DECIMALES_DE_CACHE)},${p.lng.toFixed(DECIMALES_DE_CACHE)}`;
  }

  /** Cuenta una consulta en la ventana y corta con 429 al pasar el tope. */
  private async contar(
    clave: string,
    ventanaSeg: number,
    tope: number,
    mensaje: string,
  ): Promise<void> {
    const usados = await this.seguro(
      () => this.redis.incrWithExpire(clave, ventanaSeg),
      () => this.contarEnMemoria(clave, ventanaSeg),
    );
    if (usados > tope) {
      throw new HttpException(mensaje, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private contarEnMemoria(clave: string, ventanaSeg: number): number {
    const ahora = Date.now();
    const actual = this.enMemoria.get(clave);
    if (!actual || actual.vence <= ahora) {
      this.enMemoria.set(clave, {
        cuenta: 1,
        vence: ahora + ventanaSeg * 1000,
      });
      return 1;
    }
    actual.cuenta += 1;
    return actual.cuenta;
  }

  /** Ejecuta contra Redis; si falla, usa el respaldo en vez de tirar un 500. */
  private async seguro<T>(
    operacion: () => Promise<T>,
    respaldo: T | (() => T),
  ): Promise<T> {
    try {
      return await operacion();
    } catch (error) {
      this.logger.warn(`Redis no respondió: ${errorMessage(error)}`);
      return typeof respaldo === 'function'
        ? (respaldo as () => T)()
        : respaldo;
    }
  }

  private async calcular(
    origen: PuntoDeRuta,
    destino: PuntoDeRuta,
  ): Promise<DrivingRouteDto> {
    const claveGoogle = this.config.get<string>('GOOGLE_DIRECTIONS_API_KEY');
    if (claveGoogle) {
      try {
        return await this.conGoogle(origen, destino, claveGoogle);
      } catch (error) {
        this.logger.warn(
          `Google Directions falló, se usa OSRM: ${errorMessage(error)}`,
        );
      }
    }
    const osrm = urlDeOsrm(this.config);
    if (!osrm) {
      this.logger.error(
        'Sin proveedor de rutas: falta GOOGLE_DIRECTIONS_API_KEY y OSRM_BASE_URL (el OSRM público sólo se usa en desarrollo)',
      );
      throw new ServiceUnavailableException(
        'El servicio de rutas no está disponible',
      );
    }
    try {
      return await this.conOsrm(origen, destino, osrm);
    } catch (error) {
      this.logger.error(`OSRM falló: ${errorMessage(error)}`);
      throw new BadGatewayException(
        'No se pudo calcular la ruta: el servicio de mapas no responde',
      );
    }
  }

  private async pedir<T>(url: string): Promise<T> {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), TIMEOUT_PROVEEDOR_MS);
    try {
      const res = await this.http(url, { signal: control.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async conGoogle(
    o: PuntoDeRuta,
    d: PuntoDeRuta,
    clave: string,
  ): Promise<DrivingRouteDto> {
    const url =
      'https://maps.googleapis.com/maps/api/directions/json' +
      `?origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}` +
      `&mode=driving&key=${encodeURIComponent(clave)}`;
    const data = await this.pedir<GoogleDirections>(url);
    const ruta = data.routes?.[0];
    const codificada = ruta?.overview_polyline?.points;
    if (data.status !== 'OK' || !ruta || !codificada) {
      throw new Error(`status ${data.status}`);
    }
    const tramos = ruta.legs ?? [];
    return this.armar(
      'google',
      codificada,
      tramos.reduce((t, l) => t + (l.distance?.value ?? 0), 0),
      tramos.reduce((t, l) => t + (l.duration?.value ?? 0), 0),
    );
  }

  private async conOsrm(
    o: PuntoDeRuta,
    d: PuntoDeRuta,
    base: string,
  ): Promise<DrivingRouteDto> {
    const url =
      `${base}/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}` +
      '?overview=full&geometries=polyline';
    const data = await this.pedir<OsrmRoute>(url);
    const ruta = data.routes?.[0];
    if (data.code !== 'Ok' || !ruta?.geometry) {
      throw new Error(`code ${data.code}`);
    }
    return this.armar(
      'osrm',
      ruta.geometry,
      ruta.distance ?? 0,
      ruta.duration ?? 0,
    );
  }

  private armar(
    proveedor: 'google' | 'osrm',
    codificada: string,
    metros: number,
    segundos: number,
  ): DrivingRouteDto {
    const dto = new DrivingRouteDto();
    dto.provider = proveedor;
    dto.distanceMeters = Math.round(metros);
    dto.durationSeconds = Math.round(segundos);
    dto.encodedPolyline = codificada;
    dto.points = decodificarPolilinea(codificada);
    return dto;
  }
}
