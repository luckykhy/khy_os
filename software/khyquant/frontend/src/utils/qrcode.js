let qrcodePromise

export function loadQRCode() {
  if (!qrcodePromise) {
    qrcodePromise = import('qrcode').then((module) => module.default || module)
  }
  return qrcodePromise
}
