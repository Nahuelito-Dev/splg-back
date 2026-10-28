import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { redisConnectionOptions } from '../common/redis/redis-connection';
import {
  origenDeSocketPermitido,
  origenesPermitidos,
} from '../common/config/cors-origins';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor!: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  connectToRedis(): void {
    const options = redisConnectionOptions();
    const pubClient = new Redis(options);
    const subClient = pubClient.duplicate();

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(
      `✅ Redis Adapter conectado a ${options.host}:${options.port}`,
    );
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    // Los mismos orígenes que HTTP para los tres namespaces (comparten este
    // servidor), en vez del `origin: '*'` de cada gateway.
    const permitidos = origenesPermitidos();
    const opciones: Partial<ServerOptions> = {
      ...options,
      cors: {
        origin: permitidos.length > 0 ? permitidos : false,
        credentials: true,
      },
      allowRequest: (req, callback) => {
        callback(null, origenDeSocketPermitido(req.headers.origin, permitidos));
      },
    };
    const server = super.createIOServer(port, opciones) as Server;
    server.adapter(this.adapterConstructor);
    return server;
  }
}
