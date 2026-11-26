import { Injectable } from '@nestjs/common';
import { ClockPort } from '../domain/ports/clock.port';

/** Adaptador del reloj: la hora del servidor. */
@Injectable()
export class SystemClockAdapter extends ClockPort {
  ahora(): Date {
    return new Date();
  }
}
