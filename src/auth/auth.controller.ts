import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto';
import { Public } from '../common/decorators/isPublic.decorator';
import type { Response, Request } from 'express'; // ← AGREGAR Request

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  checkToken() {
    return this.authService.checkIfTokenValid();
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async Login(@Body() dto: LoginDto) {
    return await this.authService.login(dto);
  }

  @Public()
  @Post('login/dashboard')
  @HttpCode(HttpStatus.OK)
  async DashboardLogin(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request, 
  ) {
    const requestSource = req.headers['x-client-source'] as string;

    const creds = await this.authService.login(dto, requestSource);

    const accessToken = (creds.user as any).stsTokenManager.accessToken;

    await this.authService.loginDashboard(accessToken);

    res.cookie('token', accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 1000 * 60 * 60,
    });

    return creds;
  }
}
