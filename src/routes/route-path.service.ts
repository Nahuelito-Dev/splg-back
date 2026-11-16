import { STATUS_CODES } from 'http';
import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enteroPositivoDeEnv } from '../common/config/entero-positivo';
import { conCodigo } from '../common/errors/con-codigo';
import { errorMessage } from '../common/errors/error-message';
import { RedisService } from '../redis/redis.service';
import { urlDeOsrm } from './osrm-url';
import {
  PuntoDeRuta,
  codificarPolilinea,
  decodificarPolilinea,
} from './polyline';
import {
  type FetchFn,
  GOOGLE_ROUTES_URL,
  ROUTES_FETCH,
  pedirAlProveedor,
  segundosDeDuracion,
} from './routes.service';

/** Paradas intermedias que acepta la Routes API de Google por pedido. */
export const MAX_INTERMEDIOS_GOOGLE = 25;
/** Consultas a Google por distribuidora y por día para trazar recorridos de hojas (OSRM no cuenta). */
export const LIMITE_DIARIO_DE_RECORRIDOS = 500;
/** Un recorrido guardado vale mientras la hoja no cambie (la clave lleva la firma). */
export const TTL_DE_RECORRIDO_SEG = 24 * 60 * 60;
/** El de OSRM (Google falló o no hay clave) dura poco: en cuanto Google vuelve, se retraza con él. */
export const TTL_DE_RECORRIDO_OSRM_SEG = 10 * 60;
const TTL_DIARIO_SEG = 24 * 60 * 60;

/** Campos de la Routes API que usa el recorrido: los totales, la polilínea y cada tramo. */
export const GOOGLE_PATH_FIELD_MASK =
  'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration';

export const ROUTE_PATH_CODES = {
  DAILY_LIMIT: 'ROUTE_PATH_DAILY_LIMIT',
  PROVIDER_UNAVAILABLE: 'ROUTE_PROVIDER_UNAVAILABLE',
  PROVIDER_FAILED: 'ROUTE_PROVIDER_FAILED',
} as const;

export const cupoDeRecorridosAgotado = () =>
  new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message:
        'La distribuidora llegó al máximo de recorridos por día: probá mañana',
      error: STATUS_CODES[HttpStatus.TOO_MANY_REQUESTS],
      code: ROUTE_PATH_CODES.DAILY_LIMIT,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );

export const sinProveedorDeRutas = () =>
  conCodigo(
    ServiceUnavailableException,
    HttpStatus.SERVICE_UNAVAILABLE,
    'El servicio de mapas no está disponible en este momento',
    ROUTE_PATH_CODES.PROVIDER_UNAVAILABLE,
  );

export const proveedorDeRutasCaido = () =>
  conCodigo(
    BadGatewayException,
    HttpStatus.BAD_GATEWAY,
    'No se pudo trazar el recorrido: el servicio de mapas no responde',
    ROUTE_PATH_CODES.PROVIDER_FAILED,
  );

export interface TramoCalculado {
  distanceMeters: number;
  durationSeconds: number;
}

/** Un recorrido por calles que pasa por todos los puntos, en orden. */
export interface RecorridoCalculado {
  provider: 'google' | 'osrm';
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  /** Uno por cada par de puntos consecutivos (`puntos.length - 1`). */
  legs: TramoCalculado[];
}

interface GoogleRutaConTramos {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: Array<{ distanceMeters?: number; duration?: string }>;
  }>;
}

interface OsrmRutaConTramos {
  code: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: string;
    legs?: Array<{ distance?: number; duration?: number }>;
  }>;
}

/**
 * Parte los puntos en pedidos de a lo sumo `MAX_INTERMEDIOS_GOOGLE` paradas
 * intermedias (origen + 25 + destino). Cada tramo empieza donde terminó el
 * anterior, así unidos no falta ningún segmento.
 */
export function partirEnTramos<T>(puntos: readonly T[]): T[][] {
  const porPedido = MAX_INTERMEDIOS_GOOGLE + 2;
  const tramos: T[][] = [];
  for (let i = 0; i < puntos.length - 1; i += porPedido - 1) {
    tramos.push(puntos.slice(i, Math.min(i + porPedido, puntos.length)));
  }
  return tramos;
}

/** Une los tramos en un solo recorrido: suma totales, concatena tramos y polilíneas. */
export function unirTramos(partes: RecorridoCalculado[]): RecorridoCalculado {
  const puntos: PuntoDeRuta[] = [];
  for (const parte of partes) {
    const propios = decodificarPolilinea(parte.encodedPolyline);
    const ultimo = puntos[puntos.length - 1];
    const primero = propios[0];
    // El punto de unión viene repetido: el final de un pedido es el inicio del siguiente.
    const desde =
      ultimo &&
      primero &&
      ultimo.lat === primero.lat &&
      ultimo.lng === primero.lng
        ? 1
        : 0;
    puntos.push(...propios.slice(desde));
  }
  return {
    provider: partes[0].provider,
    distanceMeters: partes.reduce((s, p) => s + p.distanceMeters, 0),
    durationSeconds: partes.reduce((s, p) => s + p.durationSeconds, 0),
    encodedPolyline:
      partes.length === 1
        ? partes[0].encodedPolyline
        : codificarPolilinea(puntos),
    legs: partes.flatMap((p) => p.legs),
  };
}

/** Lo leído de la caché, si tiene la forma de un recorrido con esa cantidad de tramos. */
export function recorridoGuardado(
  texto: string,
  tramos: number,
): RecorridoCalculado | null {
  try {
    const r = JSON.parse(texto) as Partial<RecorridoCalculado> | null;
    if (
      !r ||
      (r.provider !== 'google' && r.provider !== 'osrm') ||
      typeof r.encodedPolyline !== 'string' ||
      typeof r.distanceMeters !== 'number' ||
      typeof r.durationSeconds !== 'number' ||
      !Array.isArray(r.legs) ||
      r.legs.length !== tramos
    ) {
      return null;
    }
    return r as RecorridoCalculado;
  } catch {
    return null;
  }
}

/**
 * Recorrido por calles que pasa por varios puntos en orden (la hoja de ruta:
 * galpón → paradas → galpón). Google Routes API con paradas intermedias y la
 * clave DEL SERVIDOR (`GOOGLE_DIRECTIONS_API_KEY`); más de 25 intermedias se
 * piden por tramos y se unen. Si Google falla (o no hay clave), OSRM, como
 * `RoutesService`. Cada recorrido se guarda en Redis con la clave que da quien
 * llama (la firma de la hoja): si la hoja no cambió no se vuelve a pedir. Lo
 * que se le pide a Google cuenta contra un cupo diario por distribuidora (429);
 * OSRM y la caché no cuentan.
 * Con Redis caído no hay caché y el cupo se cuenta en memoria.
 */
@Injectable()
export class RoutePathService {
  private readonly logger = new Logger(RoutePathService.name);
  private readonly enMemoria = new Map<
    string,
    { cuenta: number; vence: number }
  >();
  /** El mismo recorrido pedido dos veces a la vez se calcula una sola (por proceso). */
  private readonly enCurso = new Map<string, Promise<RecorridoCalculado>>();

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Inject(ROUTES_FETCH) private readonly http: FetchFn,
  ) {}

  /**
   * `puntos` tiene que tener al menos dos. `clave` identifica el recorrido
   * (cambia si cambia cualquier punto o su orden).
   */
  async trazar(
    distributorId: string,
    clave: string,
    puntos: readonly PuntoDeRuta[],
  ): Promise<RecorridoCalculado> {
    if (puntos.length < 2) {
      throw new Error('Un recorrido necesita al menos dos puntos');
    }
    const claveDeCache = `routes:sheet-path:${clave}`;
    const guardado = await this.seguro(
      () => this.redis.get(claveDeCache),
      null,
    );
    if (guardado) {
      const valido = recorridoGuardado(guardado, puntos.length - 1);
      if (valido) return valido;
      // Roto o de otra forma (no coincide con los puntos): se descarta y se recalcula.
      await this.seguro(() => this.redis.del(claveDeCache), undefined);
    }
    const pendiente = this.enCurso.get(claveDeCache);
    if (pendiente) return pendiente;
    const calculo = this.calcularYGuardar(distributorId, claveDeCache, puntos);
    this.enCurso.set(claveDeCache, calculo);
    try {
      return await calculo;
    } finally {
      this.enCurso.delete(claveDeCache);
    }
  }

  private async calcularYGuardar(
    distributorId: string,
    claveDeCache: string,
    puntos: readonly PuntoDeRuta[],
  ): Promise<RecorridoCalculado> {
    const recorrido = await this.calcular(
      distributorId,
      partirEnTramos(puntos),
    );
    await this.seguro(
      () =>
        this.redis.setex(
          claveDeCache,
          recorrido.provider === 'google'
            ? TTL_DE_RECORRIDO_SEG
            : TTL_DE_RECORRIDO_OSRM_SEG,
          JSON.stringify(recorrido),
        ),
      undefined,
    );
    return recorrido;
  }

  /**
   * Todo el recorrido con un mismo proveedor: los tramos se piden a Google a la
   * vez y, si cualquiera falla, se rehace entero con OSRM. Sólo lo que va a
   * Google cuesta plata: el cupo cuenta esos pedidos (ni OSRM ni la caché).
   */
  private async calcular(
    distributorId: string,
    tramos: PuntoDeRuta[][],
  ): Promise<RecorridoCalculado> {
    const claveGoogle = this.config.get<string>('GOOGLE_DIRECTIONS_API_KEY');
    if (claveGoogle) {
      await this.contar(
        `routes:dia:recorridos:${distributorId}`,
        tramos.length,
      );
      try {
        const partes = await Promise.all(
          tramos.map((t) => this.conGoogle(t, claveGoogle)),
        );
        return unirTramos(partes);
      } catch (error) {
        const motivo = errorMessage(error).split(claveGoogle).join('***');
        this.logger.warn(
          `Google Routes falló en el recorrido, se usa OSRM: ${motivo}`,
        );
      }
    }
    const osrm = urlDeOsrm(this.config);
    if (!osrm) {
      this.logger.error(
        'Sin proveedor de rutas: falta GOOGLE_DIRECTIONS_API_KEY y OSRM_BASE_URL (el OSRM público sólo se usa en desarrollo)',
      );
      throw sinProveedorDeRutas();
    }
    try {
      const partes: RecorridoCalculado[] = [];
      for (const t of tramos) partes.push(await this.conOsrm(t, osrm));
      return unirTramos(partes);
    } catch (error) {
      this.logger.error(`OSRM falló en el recorrido: ${errorMessage(error)}`);
      throw proveedorDeRutasCaido();
    }
  }

  private async conGoogle(
    puntos: PuntoDeRuta[],
    clave: string,
  ): Promise<RecorridoCalculado> {
    const punto = (p: PuntoDeRuta) => ({
      location: { latLng: { latitude: p.lat, longitude: p.lng } },
    });
    const intermedios = puntos.slice(1, -1);
    const data = await pedirAlProveedor<GoogleRutaConTramos>(
      this.http,
      GOOGLE_ROUTES_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': clave,
          'X-Goog-FieldMask': GOOGLE_PATH_FIELD_MASK,
        },
        body: JSON.stringify({
          origin: punto(puntos[0]),
          destination: punto(puntos[puntos.length - 1]),
          ...(intermedios.length > 0
            ? { intermediates: intermedios.map(punto) }
            : {}),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
      },
    );
    const ruta = data.routes?.[0];
    const codificada = ruta?.polyline?.encodedPolyline;
    if (!ruta || !codificada) {
      throw new Error(ruta ? 'ruta sin polilínea' : 'sin rutas');
    }
    const tramos = ruta.legs ?? [];
    if (tramos.length !== puntos.length - 1) {
      throw new Error(
        `se esperaban ${puntos.length - 1} tramos y vinieron ${tramos.length}`,
      );
    }
    return {
      provider: 'google',
      distanceMeters: Math.round(ruta.distanceMeters ?? 0),
      durationSeconds: Math.round(segundosDeDuracion(ruta.duration)),
      encodedPolyline: codificada,
      legs: tramos.map((l) => ({
        distanceMeters: Math.round(l.distanceMeters ?? 0),
        durationSeconds: Math.round(segundosDeDuracion(l.duration)),
      })),
    };
  }

  private async conOsrm(
    puntos: PuntoDeRuta[],
    base: string,
  ): Promise<RecorridoCalculado> {
    const coordenadas = puntos.map((p) => `${p.lng},${p.lat}`).join(';');
    const url =
      `${base}/route/v1/driving/${coordenadas}` +
      '?overview=full&geometries=polyline';
    const data = await pedirAlProveedor<OsrmRutaConTramos>(this.http, url);
    const ruta = data.routes?.[0];
    if (data.code !== 'Ok' || !ruta?.geometry) {
      throw new Error(`code ${data.code}`);
    }
    const tramos = ruta.legs ?? [];
    if (tramos.length !== puntos.length - 1) {
      throw new Error(
        `se esperaban ${puntos.length - 1} tramos y vinieron ${tramos.length}`,
      );
    }
    return {
      provider: 'osrm',
      distanceMeters: Math.round(ruta.distance ?? 0),
      durationSeconds: Math.round(ruta.duration ?? 0),
      encodedPolyline: ruta.geometry,
      legs: tramos.map((l) => ({
        distanceMeters: Math.round(l.distance ?? 0),
        durationSeconds: Math.round(l.duration ?? 0),
      })),
    };
  }

  /** Suma `cuantas` consultas al cupo diario de la distribuidora y corta con 429 al pasarlo. */
  private async contar(clave: string, cuantas: number): Promise<void> {
    const tope = enteroPositivoDeEnv(
      'ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR',
      this.config.get<string>('ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR'),
      LIMITE_DIARIO_DE_RECORRIDOS,
    );
    let usados = 0;
    for (let i = 0; i < cuantas; i++) {
      usados = await this.seguro(
        () => this.redis.incrWithExpire(clave, TTL_DIARIO_SEG),
        () => this.contarEnMemoria(clave),
      );
    }
    if (usados > tope) throw cupoDeRecorridosAgotado();
  }

  private contarEnMemoria(clave: string): number {
    const ahora = Date.now();
    const actual = this.enMemoria.get(clave);
    if (!actual || actual.vence <= ahora) {
      this.enMemoria.set(clave, {
        cuenta: 1,
        vence: ahora + TTL_DIARIO_SEG * 1000,
      });
      return 1;
    }
    actual.cuenta += 1;
    return actual.cuenta;
  }

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
}
