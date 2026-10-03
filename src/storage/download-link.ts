import { DownloadLinkResponseDto } from './dto/download-link.dto';
import type { SignedDownload } from './ports/storage.port';

/**
 * Arma la respuesta `{ url, expiresAt }`. Con S3 es la URL firmada; con el
 * driver local (sin URL propia) apunta al endpoint que sirve el archivo, que
 * se pide con el token de siempre.
 */
export function aEnlaceDeDescarga(
  signed: SignedDownload | null,
  rutaDelArchivo: string,
): DownloadLinkResponseDto {
  const dto = new DownloadLinkResponseDto();
  dto.url = signed?.url ?? rutaDelArchivo;
  dto.expiresAt = signed?.expiresAt ?? null;
  dto.requiresAuth = signed === null;
  return dto;
}
