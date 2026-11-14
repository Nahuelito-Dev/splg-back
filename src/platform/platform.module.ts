import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';

/** Lo de la plataforma dueña del sistema (E0: nombre y contacto). */
@Module({ controllers: [PlatformController] })
export class PlatformModule {}
