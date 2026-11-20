const listeners = new Set();

export function subscribeLogs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(level, message) {
  const entry = {level, message: String(message)};
  for (const fn of listeners) fn(entry);
  if (listeners.size === 0) {
    console.log(`[${level.toUpperCase()}] ${entry.message}`);
  }
}

export const logger = {
  info(message) {
    emit('info', message);
  },
  warn(message) {
    emit('warn', message);
  },
  error(message) {
    emit('error', message);
  },
};
