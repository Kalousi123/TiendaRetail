/* Preguntas de terminal para las claves de administrador.

   La clave se escribe a ciegas (nada de eco, un asterisco por tecla) y se pide
   dos veces, como en scripts/create-admin.js. Este módulo existe para que los
   dos scripts compartan exactamente el mismo comportamiento: si el terminal
   entrega las dos líneas en un mismo trozo —un pegado, una tubería, teclear muy
   rápido— lo que sobra de la primera se guarda para la siguiente en vez de
   perderse, que dejaba la segunda pregunta esperando para siempre. */

import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, output: process.stdout });

export const ask = prompt => new Promise(resolve => input.question(prompt, resolve));

/* Bytes que Ya se leyeron y pertenecen a la pregunta siguiente. */
let pendientes = [];

export function hidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('La creación de contraseña requiere una terminal interactiva'));
      return;
    }
    let value = '';
    let onData;
    const done = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    /* 3 (Ctrl+C) cancela, 13/10 terminan la línea, 127/8 borran el último tecla. */
    const consumir = (bytes) => {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 3) { pendientes = []; done(new Error('Cancelado')); return; }
        if (b === 13 || b === 10) { pendientes.push(...bytes.slice(i + 1)); done(); return; }
        if (b === 127 || b === 8) { value = value.slice(0, -1); process.stdout.write('\b \b'); continue; }
        if (b >= 32) { value += String.fromCharCode(b); process.stdout.write('*'); }
      }
    };
    input.pause();
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    onData = chunk => consumir([...chunk]);
    stdin.on('data', onData);
    if (pendientes.length) {
      const sobrantes = pendientes;
      pendientes = [];
      consumir(sobrantes);
    }
  });
}

export function cerrar() { input.close(); }
