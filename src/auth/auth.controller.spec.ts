import {
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SesionAuditService } from '../audit/data/sesion-audit.service';
import { AuthController } from './auth.controller';
import { AuthService, MENSAJE_CREDENCIALES } from './auth.service';
import { LoginDto, SesionIniciadaDto } from './dto';

describe('AuthController: auditoría de ingresos', () => {
  let authService: { login: jest.Mock; loginDashboard: jest.Mock };
  let registrarIngreso: jest.Mock;
  let controller: AuthController;
  const dto = { email: 'a@b.com', password: 'secreta' } as LoginDto;
  const req = {
    ip: '10.0.0.1',
    headers: { 'x-client-source': 'dashboard' },
  } as unknown as Request;
  const res = { cookie: jest.fn() } as unknown as Response;
  const sesion = { accessToken: 'tok' } as SesionIniciadaDto;

  beforeEach(() => {
    authService = {
      login: jest.fn().mockResolvedValue(sesion),
      loginDashboard: jest.fn().mockResolvedValue(undefined),
    };
    registrarIngreso = jest.fn().mockResolvedValue(undefined);
    controller = new AuthController(
      authService as unknown as AuthService,
      { registrarIngreso } as unknown as SesionAuditService,
    );
  });

  it('un login correcto asienta el ingreso con ip y origen', async () => {
    await controller.login(dto, req);
    expect(registrarIngreso).toHaveBeenCalledWith({
      ok: true,
      email: 'a@b.com',
      canal: 'app',
      origen: 'dashboard',
      ip: '10.0.0.1',
    });
  });

  it('un login fallido asienta el intento y vuelve a tirar el error', async () => {
    authService.login.mockRejectedValue(
      new UnauthorizedException(MENSAJE_CREDENCIALES),
    );
    await expect(controller.login(dto, req)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(registrarIngreso).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        motivo: 'credenciales incorrectas',
      }),
    );
    expect(JSON.stringify(registrarIngreso.mock.calls)).not.toContain(
      'secreta',
    );
  });

  it('los demasiados intentos quedan con su motivo', async () => {
    authService.login.mockRejectedValue(
      new HttpException('x', HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(controller.login(dto, req)).rejects.toThrow(HttpException);
    expect(registrarIngreso).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: 'demasiados intentos' }),
    );
  });

  it('el panel: una cuenta que no es admin es un ingreso fallido del canal panel', async () => {
    authService.loginDashboard.mockRejectedValue(
      new UnauthorizedException('Admin not found'),
    );
    await expect(controller.dashboardLogin(dto, req, res)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(registrarIngreso).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        canal: 'panel',
        motivo: 'la cuenta no es de un administrador',
      }),
    );
  });

  it('el panel: un admin entra y queda asentado una sola vez', async () => {
    await controller.dashboardLogin(dto, req, res);
    expect(registrarIngreso).toHaveBeenCalledTimes(1);
    expect(registrarIngreso).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, canal: 'panel' }),
    );
  });
});
