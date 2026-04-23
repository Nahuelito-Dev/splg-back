// src/admin/helpers/admin-registration.helper.ts
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CreateUserDto } from '../../users/dto/create-user.dto';
import { UsersService } from '../../users/users.service';
import { AdminService } from '../admin.service';

const logger = new Logger('AdminRegistrationHelper');

export async function validateUniqueness(
  dto: CreateUserDto,
  userService: UsersService,
) {
  logger.debug('Verificando unicidad de email y teléfono...');

  // ✅ VALIDAR que email y phone_number existan
  if (!dto.email || !dto.phone_number) {
    throw new HttpException(
      'Email and phone number are required',
      HttpStatus.BAD_REQUEST,
    );
  }

  const userExists = await userService.findOneByEmail(dto.email);
  const phoneExists = await userService.findOneByPhone(dto.phone_number);

  if (userExists || phoneExists) {
    logger.warn(`⚠️ Email o teléfono ya en uso.`);
    throw new HttpException('Email o teléfono ya en uso', HttpStatus.CONFLICT);
  }
}

export async function createUserInFirebase(
  dto: CreateUserDto,
  userService: UsersService,
) {
  try {
    logger.debug('Intentando crear usuario en Firebase...');
    const firebaseUser = await userService.createFirebaseUser(dto);
    logger.log(`✅ Usuario Firebase creado con UID: ${firebaseUser.uid}`);
    return firebaseUser;
  } catch (error) {
    logger.error(`❌ Error creando usuario en Firebase: ${error.message}`);
    throw new HttpException(
      `Error creando usuario en Firebase: ${error.message}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export async function createUserInDatabase(
  dto: CreateUserDto,
  firebaseUid: string,
  userService: UsersService,
) {
  logger.debug('Creando User en base de datos...');

  const createUserDto = {
    ...dto,
    firebase_uid: firebaseUid,
  };

  const user = await userService.create(createUserDto);
  logger.log(`✅ Usuario local creado con ID: ${user.user_id}`);
  return user;
}
