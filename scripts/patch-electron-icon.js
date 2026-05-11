'use strict';

/**
 * patch-electron-icon.js
 *
 * Patches the Electron dev binary with Deplao's icon and version metadata.
 * Run once after `npm install` or any time the electron package is updated.
 *
 * Only applicable on Windows — on macOS/Linux the app bundle handles icons.
 */

const path = require('path');
const fs   = require('fs');

async function main() {
  if (process.platform !== 'win32') {
    console.log('[patch-icon] Non-Windows platform — skipping exe patch');
    return;
  }

  // require('electron') resolves to the path of the electron binary
  let electronExePath;
  try {
    electronExePath = require('electron');
  } catch {
    console.warn('[patch-icon] Could not resolve electron binary path');
    return;
  }

  if (!fs.existsSync(electronExePath)) {
    console.warn('[patch-icon] electron.exe not found at:', electronExePath);
    return;
  }

  const iconPath = path.resolve(__dirname, '../resources/icons/icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.warn('[patch-icon] icon.ico not found at:', iconPath);
    return;
  }

  try {
    const { rcedit } = require('rcedit');
    const pkg    = require('../package.json');

    await rcedit(electronExePath, {
      icon: iconPath,
      'version-string': {
        ProductName:     pkg.build?.productName || 'Deplao',
        FileDescription: pkg.build?.productName || 'Deplao',
        CompanyName:     'Deplao',
      },
      'file-version':    pkg.version,
      'product-version': pkg.version,
    });

    console.log('[patch-icon] ✅ electron.exe patched with Deplao icon');
  } catch (err) {
    console.error('[patch-icon] ❌ rcedit failed:', err.message);
    console.error('             Try running as Administrator if permission denied.');
  }
}

main();


