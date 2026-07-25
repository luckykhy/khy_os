/**
 * @pattern Flyweight
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.khy.quant.mobile',
  appName: 'KHY-Quant',
  webDir: 'dist',
  server: {
    // Load from local webDir (dist/). Users configure backend URL on login page.
    // Supports: offline local mode, LAN mode (http://192.168.x.x:3000), cloud mode.
    cleartext: true, // Allow HTTP for local network connections
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      androidSplashResourceName: 'splash',
      showSpinner: false,
      spinnerColor: '#409eff',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1f2d3d',
    },
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
