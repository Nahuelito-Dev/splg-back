import type { Socket } from 'socket.io';
import type { IdentidadDeSocket } from './socket-identity.service';
import type { TokenDecodificado } from '../auth/auth.service';

/**
 * Lo que SPLG guarda en cada conexión, en `socket.data`: el lugar que socket.io
 * reserva para esto y que se puede tipar, en vez de colgarle propiedades
 * sueltas al socket.
 */
export interface DatosDeSocket {
  /** Identidad resuelta en el handshake (clientes y choferes). */
  identidad?: IdentidadDeSocket;
  /** Token verificado de un admin del panel. */
  admin?: TokenDecodificado;
  /** Chofer que hay que sacar del radar GEO al desconectarse. */
  choferId?: string;
}

// Los mapas de eventos por defecto de socket.io, sacados del propio tipo: el
// paquete no los exporta por su punto de entrada.
type EventosPorDefecto = Socket extends Socket<infer E> ? E : never;

export type SocketDeSplg = Socket<
  EventosPorDefecto,
  EventosPorDefecto,
  EventosPorDefecto,
  DatosDeSocket
>;

/** El token del handshake: en `auth.token` o en la cabecera Authorization. */
export function tokenDelHandshake(client: SocketDeSplg): string | null {
  const auth: unknown = client.handshake.auth;
  if (typeof auth === 'object' && auth !== null && 'token' in auth) {
    if (typeof auth.token === 'string' && auth.token) return auth.token;
  }
  const [, token] = client.handshake.headers.authorization?.split(' ') ?? [];
  return token || null;
}
