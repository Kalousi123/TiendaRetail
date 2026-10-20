/* Ignores repeated camera frames until the reader loses the code briefly. */
function createScanGate(timeoutMs = 650) {
  let lastCode = '';
  let lastSeen = 0;
  return {
    accept(code, now = Date.now()) {
      if (!code) {
        if (lastCode && now - lastSeen >= timeoutMs) lastCode = '';
        return '';
      }
      if (code === lastCode) {
        lastSeen = now;
        return '';
      }
      lastCode = code;
      lastSeen = now;
      return code;
    },
    reset() { lastCode = ''; lastSeen = 0; },
  };
}
