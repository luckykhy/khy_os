import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.khyos.companion',
  appName: 'Khy-OS Companion',
  webDir: 'dist',
  server: { cleartext: true },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
