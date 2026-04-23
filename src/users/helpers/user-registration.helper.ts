import { HttpException, HttpStatus } from '@nestjs/common';
import { CreateUserDto } from '../../users/dto/create-user.dto';
import { UsersService } from '../../users/users.service';

export async function validateUniqueness(
  dto: CreateUserDto,
  userService: UsersService,
) {
  if (!dto.email || !dto.phone_number) {
    throw new HttpException(
      'Email and phone number are required',
      HttpStatus.BAD_REQUEST,
    );
  }

  const exists = await userService.checkUserExists(dto.email, dto.phone_number);

  // Nota: Si checkUserExists devuelve un objeto { exists: boolean },
  // asegúrate de que esto sea if (exists.exists)
  if (exists && (typeof exists === 'boolean' ? exists : exists['exists'])) {
    throw new HttpException('Email o teléfono ya en uso', HttpStatus.CONFLICT);
  }
}

export async function createUserInFirebase(
  dto: CreateUserDto,
  userService: UsersService,
) {
  try {
    if (!dto.password) {
      throw new Error('Password is required for Firebase registration');
    }
    if (!dto.email) {
      throw new Error('Email is required for Firebase registration');
    }

    const firebaseUser = await userService.createFirebaseUser(dto);
    return firebaseUser;
  } catch (error) {
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
  if (!dto.email || !dto.phone_number) {
    throw new HttpException(
      'Email and phone number are required',
      HttpStatus.BAD_REQUEST,
    );
  }

  const createUserDto = {
    ...dto,
    firebase_uid: firebaseUid,
  };

  const user = await userService.create(createUserDto);
  return user;
}
