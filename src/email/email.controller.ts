import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { EmailService } from './email.service';
import { Public } from '../common/decorators/isPublic.decorator';
import { SendPasswordResetDto } from './dto/send-password-reset.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { TestEmailDto } from './dto/test-email.dto';
import {
  EmailCambiadoResponseDto,
  PruebaDeEmailResponseDto,
} from './dto/email-response.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';

@ApiTags('Email')
@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Public()
  @Post('password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send password reset email' })
  @ApiOkResponse({
    type: MessageResponseDto,
    description: 'Mismo mensaje exista o no la cuenta',
  })
  @ApiBadRequestResponse({ description: 'Demasiados intentos' })
  sendPasswordReset(
    @Body() body: SendPasswordResetDto,
  ): Promise<MessageResponseDto> {
    return this.emailService.sendPasswordResetEmail(body.email);
  }

  @Post('change-email')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change user email' })
  @ApiCreatedResponse({ type: EmailCambiadoResponseDto })
  @ApiBadRequestResponse({
    description: 'Token inválido, no coincide o el correo nuevo ya existe',
  })
  changeEmail(@Body() body: ChangeEmailDto): Promise<EmailCambiadoResponseDto> {
    return this.emailService.changeEmail(
      body.currentEmail,
      body.newEmail,
      body.idToken,
    );
  }

  // Prueba del servicio de correo: manda un mail real y genera un link de
  // reseteo para la dirección que se le pase. Sólo la plataforma (H-58).
  @Post('test')
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Test email service functionality' })
  @ApiCreatedResponse({ type: PruebaDeEmailResponseDto })
  testEmailService(
    @Body() body: TestEmailDto,
  ): Promise<PruebaDeEmailResponseDto> {
    return this.emailService.testEmailService(body.email);
  }
}
