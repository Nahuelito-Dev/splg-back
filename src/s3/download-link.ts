import { DownloadLinkResponseDto } from './dto/download-link.dto';
import type { SignedDownload } from './s3.service';

/**
 * Arma la respuesta `{ url, expiresAt, requiresAuth }` con la URL firmada de
 * S3, que se abre sin token (`requiresAuth` queda en el contrato por las apps
 * y el panel).
 */
export function aEnlaceDeDescarga(
  signed: SignedDownload,
): DownloadLinkResponseDto {
  const dto = new DownloadLinkResponseDto();
  dto.url = signed.url;
  dto.expiresAt = signed.expiresAt;
  dto.requiresAuth = false;
  return dto;
}
