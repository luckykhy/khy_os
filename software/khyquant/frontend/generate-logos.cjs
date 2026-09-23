'use strict';

/**
 * generate-logos.cjs — Convert prototype-C SVG to all required PNG sizes.
 * Uses @resvg/resvg-js (pure Rust, no native deps).
 */

const { Resvg } = require('@resvg/resvg-js');
const { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSyncSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const scriptDir = __dirname;
const protoPath = join(scriptDir, 'public', 'logo-prototypes', 'prototype-C-pulse-diamond.svg');
const publicDir = join(scriptDir, 'public');
const androidRes = join(scriptDir, '..', '..', '..', 'apps', 'khy-os-client-app', 'android', 'app', 'src', 'main', 'res');

const svgSource = readFileSync(protoPath, 'utf-8');

const MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bgC" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e3a5f"/>
    </linearGradient>
    <linearGradient id="diamondC" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="50%" stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="pulseC" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="30%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#dbeafe"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bgC)"/>
  <g transform="translate(51.2, 51.2) scale(0.8)">
    <polygon points="256,76 436,256 256,436 76,256" fill="none" stroke="url(#diamondC)" stroke-width="16" stroke-linejoin="round"/>
    <polygon points="256,120 392,256 256,392 120,256" fill="url(#diamondC)" opacity="0.08"/>
    <polyline points="120,256 180,256 200,190 230,330 260,220 290,280 332,256 392,256" fill="none" stroke="url(#pulseC)" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="230" cy="330" r="10" fill="#ffffff" opacity="0.9"/>
    <circle cx="260" cy="220" r="10" fill="#60a5fa" opacity="0.9"/>
    <circle cx="290" cy="280" r="10" fill="#ffffff" opacity="0.7"/>
    <polygon points="256,76 436,256 256,436 76,256" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" opacity="0.2"/>
  </g>
</svg>`;

function renderPng(svgStr, size, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const resvg = new Resvg(svgStr, {
    fitTo: { mode: 'width', value: size },
    background: 'transparent',
  });
  const png = resvg.render().asPng();
  writeFileSync(outputPath, png);
  const kb = (png.length / 1024).toFixed(1);
  console.log(`  OK  ${outputPath}  (${size}x${size}, ${kb} KB)`);
}

console.log('=== Copying SVG ===');
const logoSvgPath = join(publicDir, 'logo.svg');
copyFileSync(protoPath, logoSvgPath);
console.log(`  OK  ${logoSvgPath}`);

console.log('\n=== Generating Web/PWA PNGs ===');
const webSizes = [
  ['logo.png', 512],
  ['favicon-32x32.png', 32],
  ['apple-touch-icon-180x180.png', 180],
  ['pwa-192x192.png', 192],
  ['pwa-512x512.png', 512],
];
for (const [name, size] of webSizes) {
  renderPng(svgSource, size, join(publicDir, name));
}

console.log('\n=== Generating Maskable PWA PNG ===');
renderPng(MASKABLE_SVG, 512, join(publicDir, 'pwa-maskable-512x512.png'));

console.log('\n=== Generating Android Launcher Icons ===');
const androidSizes = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];
for (const [folder, size] of androidSizes) {
  renderPng(svgSource, size, join(androidRes, folder, 'ic_launcher.png'));
}

console.log('\n=== Cleaning up prototypes ===');
const protoDir = join(publicDir, 'logo-prototypes');
if (existsSync(protoDir)) {
  rmSyncSync ? rmSyncSync(protoDir, { recursive: true, force: true }) : (() => {
    const { rmSync } = require('node:fs');
    rmSync(protoDir, { recursive: true, force: true });
  })();
  console.log(`  OK  Removed ${protoDir}`);
}

console.log('\n=== Done! All logo files generated. ===');
