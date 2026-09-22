import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './password.js';

test('una contraseña correcta verifica y una incorrecta no', async () => {
  const hash = await hashPassword('Clave-segura-2026');
  assert.equal(await verifyPassword('Clave-segura-2026', hash), true);
  assert.equal(await verifyPassword('Clave-equivocada-2026', hash), false);
});

test('cada contraseña usa una sal diferente', async () => {
  const first = await hashPassword('Clave-segura-2026');
  const second = await hashPassword('Clave-segura-2026');
  assert.notEqual(first, second);
});

test('un formato de hash inválido se rechaza sin lanzar error', async () => {
  assert.equal(await verifyPassword('cualquiera', 'hash-invalido'), false);
});
