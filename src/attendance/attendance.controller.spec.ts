import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { JornadaConLegajo } from './attendance.mapper';
import { AttendanceSource } from './entities/employee-attendance.entity';
import { Employee } from '../employee/entities/employee.entity';

describe('AttendanceController · jornada abierta del chofer', () => {
  let attendance: { jornadaAbierta: jest.Mock };
  let controller: AttendanceController;
  let res: { status: jest.Mock };

  beforeEach(() => {
    attendance = { jornadaAbierta: jest.fn() };
    controller = new AttendanceController(
      attendance as unknown as AttendanceService,
    );
    res = { status: jest.fn() };
  });

  it('devuelve la jornada abierta del chofer', async () => {
    attendance.jornadaAbierta.mockResolvedValue({
      attendanceId: 'a1',
      distributorId: 'd1',
      employeeId: 'e1',
      workDate: '2026-10-17',
      checkInAt: new Date('2026-10-17T11:00:00Z'),
      checkOutAt: null,
      source: AttendanceSource.DRIVER_APP,
      notes: null,
      employee: {
        employeeId: 'e1',
        firstName: 'Ana',
        lastName: 'Pérez',
        fileNumber: '0001',
      } as Employee,
    } as unknown as JornadaConLegajo);

    const dto = await controller.current('u1', res as unknown as Response);

    expect(attendance.jornadaAbierta).toHaveBeenCalledWith('u1');
    expect(dto?.attendanceId).toBe('a1');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sin jornada abierta responde 204 sin cuerpo', async () => {
    attendance.jornadaAbierta.mockResolvedValue(null);

    const dto = await controller.current('u1', res as unknown as Response);

    expect(dto).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
  });
});
