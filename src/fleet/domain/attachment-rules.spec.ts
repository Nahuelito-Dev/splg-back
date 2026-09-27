import {
  esMimeTypePermitido,
  extensionParaMimeType,
  MAX_ATTACHMENT_SIZE_BYTES,
} from './attachment-rules';

describe('attachment-rules', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])(
    '%s está permitido',
    (mime) => {
      expect(esMimeTypePermitido(mime)).toBe(true);
    },
  );

  it.each(['application/msword', 'image/gif', 'text/plain', ''])(
    '%s no está permitido',
    (mime) => {
      expect(esMimeTypePermitido(mime)).toBe(false);
    },
  );

  it('mapea cada mime permitido a su extensión', () => {
    expect(extensionParaMimeType('application/pdf')).toBe('pdf');
    expect(extensionParaMimeType('image/jpeg')).toBe('jpg');
    expect(extensionParaMimeType('image/png')).toBe('png');
    expect(extensionParaMimeType('image/webp')).toBe('webp');
  });

  it('el límite de tamaño es 10 MB', () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
});
