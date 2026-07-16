import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * `ThrottlerGuard` es GLOBAL (APP_GUARD) → corre para TODOS los execution
 * contexts, no solo HTTP: esta app también tiene gateways de Socket.io
 * (`drivers`, `customers`, `admin`) con `@SubscribeMessage`. El rate limiting
 * de `@nestjs/throttler` está pensado para requests HTTP (usa
 * `context.switchToHttp()` para leer IP/headers); en un contexto `ws` esos
 * campos no existen y la app se rompe. Igual que HTTP: el rate limiting de
 * WS (si hiciera falta) se maneja en la capa de socket, no acá.
 *
 * Se salta (no throttlea, deja pasar) cualquier context que NO sea HTTP.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.shouldSkip(context);
  }
}
